// 云函数 addWork:新增作品
// 图片已由小程序端上传到云存储,这里只存 fileID + 元信息 + 版权哈希 + 存证 + 重算指数
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const crypto = require('crypto');

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

function isDocumentNotFound(error) {
  return /-502004|does not exist|not found|文档不存在/i.test(
    String((error && (error.errMsg || error.message)) || error || ''),
  );
}

async function getOptionalDocument(reference) {
  try {
    return await reference.get();
  } catch (error) {
    if (isDocumentNotFound(error)) return { data: null };
    throw error;
  }
}

function dateValue(value) {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  if (value.$date) return new Date(value.$date).getTime();
  return new Date(value).getTime();
}

function normalizeRequiredText(value, label, maxLength) {
  if (typeof value !== 'string') return { error: `${label}格式不正确` };
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized) return { error: `请填写${label}` };
  if (normalized.length > maxLength) return { error: `${label}不能超过 ${maxLength} 个字符` };
  return { value: normalized };
}

function normalizeOptionalText(value, label, maxLength) {
  if (value === undefined || value === null) return { value: '' };
  if (typeof value !== 'string') return { error: `${label}格式不正确` };
  const normalized = value.trim();
  if (normalized.length > maxLength) return { error: `${label}不能超过 ${maxLength} 个字符` };
  return { value: normalized };
}

function isOwnedWorkFile(fileId, uid) {
  if (!fileId) return true;
  try {
    const parsed = new URL(fileId);
    const path = decodeURIComponent(parsed.pathname || '').replace(/^\/+/, '');
    return parsed.protocol === 'cloud:'
      && path.startsWith(`works/${uid}/`)
      && path.length > `works/${uid}/`.length
      && !path.includes('../');
  } catch (error) {
    return false;
  }
}

async function verifyCloudFile(fileId) {
  if (!fileId) return true;
  try {
    const result = await cloud.getTempFileURL({ fileList: [fileId] });
    const item = result && result.fileList && result.fileList[0];
    return Boolean(item && Number(item.status) === 0 && item.tempFileURL);
  } catch (error) {
    console.error('校验作品图片失败', error);
    return false;
  }
}

async function validateSession(uid, sessionToken, openid) {
  if (!sessionToken) return { valid: false, setupRequired: false };
  const sessionRes = await db.collection('sessions').doc(sha256(sessionToken)).get()
    .catch(() => ({ data: null }));
  const session = sessionRes.data;
  if (!session || session.uid !== uid || session.openid !== openid
    || dateValue(session.expiresAt) <= Date.now() || !session.account) {
    return { valid: false, setupRequired: false };
  }
  const accountRes = await db.collection('campus_accounts').doc(session.account).get()
    .catch(() => ({ data: null }));
  const account = accountRes.data;
  if (!account || (account.status && account.status !== 'active')
    || Number(account.passwordVersion) !== Number(session.passwordVersion)) {
    return { valid: false, setupRequired: false };
  }
  return { valid: true, setupRequired: Boolean(account.mustChangePassword) };
}

// 与 submitEvaluation 保持一致的人才指数公式
function calcTalentIndex({ certLevelScore, worksCount, evalAvg, trainScore }) {
  const certPart = certLevelScore * 40;
  const worksPart = (Math.min(worksCount, 5) * 10) / 5;
  const evalPart = (evalAvg / 100) * 30;
  const trainPart = (trainScore / 100) * 20;
  return Math.round(certPart + worksPart + evalPart + trainPart);
}

async function recalcTalentIndex(uid) {
  const [certs, works, evals] = await Promise.all([
    db.collection('certifications').where({ uid }).get(),
    db.collection('works').where({ uid }).get(),
    db.collection('evaluations').where({ uid }).get(),
  ]);
  let certLevelScore = 0;
  for (const c of certs.data) {
    const s = c.level === '高级' ? 1 : c.level === '中级' ? 0.5 : 0.3;
    certLevelScore = Math.max(certLevelScore, s);
  }
  const scores = evals.data.map((e) => e.score || 0);
  const evalAvg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  const index = calcTalentIndex({
    certLevelScore,
    worksCount: works.data.length,
    evalAvg,
    trainScore: evalAvg,
  });
  await db.collection('users').doc(uid).update({ data: { talentIndex: index } });
  return index;
}

// 事务遇到并发冲突（-501001 / TransactionBusy）时有限指数退避重试；
// 不重试集合缺失、权限等确定性错误。与 changePassword / register 等保持一致。
function errorText(error) {
  return [
    error && error.code,
    error && error.errCode,
    error && error.errMsg,
    error && error.message,
    error && error.cause && error.cause.code,
    error && error.cause && error.cause.message,
    error,
  ].filter(Boolean).join(' ');
}

function isRetryableTransactionError(error) {
  return /-501001|TransactionBusy|transaction[^\n]*(?:conflict|aborted)|\bABORTED\b/i
    .test(errorText(error));
}

async function runTxWithRetry(executor, retries = 4) {
  let lastError;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      return await db.runTransaction(executor);
    } catch (error) {
      lastError = error;
      if (isRetryableTransactionError(error) && attempt < retries - 1) {
        const delay = 200 * (2 ** attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const {
    uid, sessionToken, title, desc, coverFileId, requestId,
  } = event || {};

  if (typeof uid !== 'string' || !uid.trim()) return { code: 1, msg: '参数错误' };
  const normalizedTitle = normalizeRequiredText(title, '作品标题', 80);
  if (normalizedTitle.error) return { code: 1, msg: normalizedTitle.error };
  const normalizedDesc = normalizeOptionalText(desc, '作品描述', 1000);
  if (normalizedDesc.error) return { code: 1, msg: normalizedDesc.error };
  const normalizedCover = normalizeOptionalText(coverFileId, '作品图片', 1024);
  if (normalizedCover.error) return { code: 1, msg: normalizedCover.error };
  const normalizedRequest = normalizeRequiredText(requestId, '请求编号', 100);
  if (normalizedRequest.error
    || !/^[A-Za-z0-9._:-]{12,100}$/.test(normalizedRequest.value || '')) {
    return { code: 1, msg: '请求编号格式不正确，请重新打开作品窗口' };
  }
  try {
    // 只能使用当前账号的有效会话给自己添加作品。
    const session = await validateSession(uid, sessionToken, OPENID);
    if (!session.valid) {
      return { code: 401, msg: '登录已失效，请重新登录' };
    }
    if (session.setupRequired) return { code: 403, msg: '请先设置个人登录密码' };
    if (!isOwnedWorkFile(normalizedCover.value, uid)) {
      return { code: 1, msg: '作品图片必须由当前账号重新上传' };
    }
    if (!(await verifyCloudFile(normalizedCover.value))) {
      return { code: 1, msg: '作品图片不存在或已经失效，请重新选择' };
    }

    const digest = sha256(`${uid}|${normalizedRequest.value}`);
    const workId = `work-${digest.slice(0, 32)}`;
    const attestationId = `attestation-${digest.slice(0, 32)}`;
    const now = new Date();
    const work = {
      uid,
      title: normalizedTitle.value,
      desc: normalizedDesc.value,
      coverUrl: normalizedCover.value, // 云存储 fileID(小程序端可直接用作 <image src>)
      fileUrls: normalizedCover.value ? [normalizedCover.value] : [],
      createdAt: now,
      requestId: normalizedRequest.value,
    };
    // 作品信息哈希：对核心内容、图片 fileID 与时间生成完整性校验摘要。
    work.copyrightHash = sha256([
      uid,
      normalizedTitle.value,
      normalizedDesc.value,
      normalizedCover.value,
      now.toISOString(),
    ].join('|'));

    const transactionResult = await runTxWithRetry(async (transaction) => {
    const [existingRes, userRes, learningStageRes, workStageRes] = await Promise.all([
      getOptionalDocument(transaction.collection('works').doc(workId)),
      getOptionalDocument(transaction.collection('users').doc(uid)),
      getOptionalDocument(transaction.collection('stages').doc(`${uid}-stage-1`)),
      getOptionalDocument(transaction.collection('stages').doc(`${uid}-stage-3`)),
    ]);
    if (existingRes.data) {
      if (existingRes.data.uid !== uid) {
        return { error: { code: 409, msg: '请求编号冲突，请重新打开作品窗口' } };
      }
      return { duplicated: true, work: existingRes.data };
    }
    if (!userRes.data) return { error: { code: 2, msg: '档案不存在' } };

    await transaction.collection('works').doc(workId).set({ data: work });
    await transaction.collection('attestations').doc(attestationId).set({
      data: {
        targetType: 'work',
        targetId: workId,
        hash: work.copyrightHash,
        timestamp: now,
        chainTxId: null,
      },
    });
    const stageUpdates = [
      { id: `${uid}-stage-1`, name: '学习', row: learningStageRes.data },
      { id: `${uid}-stage-3`, name: '作品', row: workStageRes.data },
    ];
    for (const stage of stageUpdates) {
      if (stage.row) {
        if (stage.row.status !== 'done') {
          await transaction.collection('stages').doc(stage.id).update({
            data: {
              status: 'done',
              startedAt: stage.row.startedAt || now,
              completedAt: now,
              updatedAt: now,
            },
          });
        }
      } else {
        await transaction.collection('stages').doc(stage.id).set({
          data: {
            uid, stage: stage.name, status: 'done', startedAt: now,
            completedAt: now, createdAt: now, updatedAt: now,
          },
        });
      }
    }
    return { duplicated: false, work };
  });
  if (transactionResult.error) return transactionResult.error;

  const newIndex = await recalcTalentIndex(uid);

    return {
      code: 0,
      msg: transactionResult.duplicated ? '该作品已提交，请勿重复操作' : '作品已上传并生成哈希记录',
      workId,
      copyrightHash: transactionResult.work.copyrightHash,
      talentIndex: newIndex,
      duplicated: transactionResult.duplicated,
    };
  } catch (error) {
    console.error('新增作品失败', error);
    return { code: 99, msg: '作品上传失败，请稍后重试' };
  }
};
