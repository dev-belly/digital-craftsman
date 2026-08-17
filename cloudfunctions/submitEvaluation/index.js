// 企业提交评价：会话校验 → 幂等事务写评价/哈希记录/阶段 → 重算人才指数。
const cloud = require('wx-server-sdk');
const crypto = require('crypto');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 没有配置服务端密钥时只生成 SHA256 内容哈希，不再使用源码中公开的测试密钥伪装签名。
const SIGN_SECRET = String(process.env.SIGN_SECRET || '').trim();

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function hmac(value) {
  return SIGN_SECRET
    ? crypto.createHmac('sha256', SIGN_SECRET).update(String(value)).digest('hex')
    : '';
}

function dateValue(value) {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  if (value.$date) return new Date(value.$date).getTime();
  return new Date(value).getTime();
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

async function validateEnterpriseSession(sessionToken, openid) {
  if (!sessionToken || !openid) return null;
  const sessionRes = await getOptionalDocument(
    db.collection('enterprise_sessions').doc(sha256(sessionToken)),
  );
  const session = sessionRes.data;
  if (!session || session.openid !== openid || session.role !== 'enterprise'
    || dateValue(session.expiresAt) <= Date.now() || !session.account) return null;
  const accountRes = await getOptionalDocument(
    db.collection('company_accounts').doc(session.account),
  );
  const account = accountRes.data;
  if (!account || account.companyId !== session.companyId || account.status !== 'active'
    || (Number(account.passwordVersion) || 1) !== (Number(session.passwordVersion) || 1)) {
    return null;
  }
  return session;
}

function certificationLevelScore(level) {
  if (level === '高级') return 1;
  if (level === '中级') return 0.5;
  return 0.3;
}

async function recalcTalentIndex(uid) {
  const [certs, works, evaluations] = await Promise.all([
    db.collection('certifications').where({ uid }).limit(100).get(),
    db.collection('works').where({ uid }).limit(100).get(),
    db.collection('evaluations').where({ uid }).limit(100).get(),
  ]);
  const certLevelScore = certs.data.reduce(
    (highest, cert) => Math.max(highest, certificationLevelScore(cert.level)),
    0,
  );
  const scores = evaluations.data
    .map((evaluation) => Number(evaluation.score))
    .filter(Number.isFinite);
  const average = scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : 0;
  const index = Math.round(
    certLevelScore * 40
    + (Math.min(works.data.length, 5) * 10) / 5
    + (average / 100) * 30
    + (average / 100) * 20,
  );
  await db.collection('users').doc(uid).update({
    data: { talentIndex: index, updatedAt: new Date() },
  });
  return index;
}

async function completeTalentStageIfEligible(uid) {
  const [userRes, stageRes] = await Promise.all([
    getOptionalDocument(db.collection('users').doc(uid)),
    db.collection('stages').where({ uid }).limit(20).get(),
  ]);
  if (!userRes.data || !userRes.data.talentPoolVisible) return false;
  const stageMap = new Map(stageRes.data.map((stage) => [stage.stage, stage]));
  if (!['学习', '认证', '作品', '企业好评'].every((name) => (
    stageMap.get(name) && stageMap.get(name).status === 'done'
  ))) return false;
  const stage = stageMap.get('人才');
  if (stage && stage.status === 'done') return true;
  const now = new Date();
  if (stage) {
    await db.collection('stages').doc(stage._id).update({
      data: { status: 'done', completedAt: now, updatedAt: now },
    });
  } else {
    await db.collection('stages').doc(`${uid}-stage-5`).set({
      data: {
        uid, stage: '人才', status: 'done', startedAt: now,
        completedAt: now, createdAt: now, updatedAt: now,
      },
    });
  }
  return true;
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
  try {
    if (!event || typeof event !== 'object' || Array.isArray(event)
      || typeof event.uid !== 'string'
      || typeof event.content !== 'string'
      || typeof event.enterpriseSessionToken !== 'string'
      || typeof event.requestId !== 'string'
      || (event.mentorName != null && typeof event.mentorName !== 'string')) {
      return { code: 1, msg: '请求参数格式不正确' };
    }

    const uid = event.uid.trim();
    const content = event.content.trim();
    const mentorName = String(event.mentorName || '').trim();
    const requestId = event.requestId.trim();
    const score = Number(event.score);
    if (!/^(?:demo|stu)-[a-z0-9_-]+$/i.test(uid)) return { code: 1, msg: '学生档案编号无效' };
    if (!content) return { code: 1, msg: '请填写评价内容' };
    if (content.length > 500) return { code: 2, msg: '评价内容不能超过 500 个字' };
    if (mentorName.length > 30) return { code: 2, msg: '导师姓名不能超过 30 个字' };
    if (!Number.isFinite(score) || score < 0 || score > 100) {
      return { code: 2, msg: '评分需为 0-100' };
    }
    if (!/^[A-Za-z0-9._:-]{12,100}$/.test(requestId)) {
      return { code: 2, msg: '请求编号格式不正确，请重新打开评价窗口' };
    }

    const { OPENID } = cloud.getWXContext();
    const enterprise = await validateEnterpriseSession(
      event.enterpriseSessionToken.trim(),
      OPENID,
    );
    if (!enterprise) return { code: 401, msg: '企业登录已失效，请重新登录' };
    const companyName = String(enterprise.companyName || '').trim();
    const digest = sha256(`${enterprise.companyId}|${requestId}`);
    const evaluationId = `evaluation-${digest.slice(0, 32)}`;
    const attestationId = `attestation-${digest.slice(0, 32)}`;
    const stageId = `${uid}-stage-4`;
    const now = new Date();
    const evidencePayload = JSON.stringify({
      version: 1,
      uid,
      companyId: enterprise.companyId,
      companyName,
      mentorName,
      content,
      score,
      signedAt: now.toISOString(),
    });
    const evidenceHash = sha256(evidencePayload);
    const signature = hmac(evidenceHash);

    const transactionResult = await runTxWithRetry(async (transaction) => {
      const [existingRes, userRes, stageRes] = await Promise.all([
        getOptionalDocument(transaction.collection('evaluations').doc(evaluationId)),
        getOptionalDocument(transaction.collection('users').doc(uid)),
        getOptionalDocument(transaction.collection('stages').doc(stageId)),
      ]);
      const existing = existingRes.data;
      if (existing) {
        if (existing.uid !== uid || existing.companyId !== enterprise.companyId) {
          return { error: { code: 409, msg: '请求编号冲突，请重新打开评价窗口' } };
        }
        return { duplicated: true, evaluation: existing };
      }
      if (!userRes.data) return { error: { code: 404, msg: '学生档案不存在' } };

      const evaluation = {
        uid,
        companyId: enterprise.companyId,
        companyName,
        mentorName,
        content,
        score,
        signedAt: now,
        evidenceHash,
        signature,
        signatureMethod: signature ? 'hmac-sha256' : 'none',
        requestId,
        createdAt: now,
      };
      await transaction.collection('evaluations').doc(evaluationId).set({ data: evaluation });
      await transaction.collection('attestations').doc(attestationId).set({
        data: {
          targetType: 'evaluation',
          targetId: evaluationId,
          hash: evidenceHash,
          signature,
          signatureMethod: signature ? 'hmac-sha256' : 'none',
          timestamp: now,
          chainTxId: null,
        },
      });
      if (stageRes.data) {
        if (stageRes.data.status !== 'done') {
          await transaction.collection('stages').doc(stageId).update({
            data: {
              status: 'done',
              startedAt: stageRes.data.startedAt || now,
              completedAt: now,
              updatedAt: now,
            },
          });
        }
      } else {
        await transaction.collection('stages').doc(stageId).set({
          data: {
            uid, stage: '企业好评', status: 'done', startedAt: now,
            completedAt: now, createdAt: now, updatedAt: now,
          },
        });
      }
      return { duplicated: false, evaluation };
    });
    if (transactionResult.error) return transactionResult.error;

    const newIndex = await recalcTalentIndex(uid);
    const talentStageCompleted = await completeTalentStageIfEligible(uid).catch((error) => {
      console.error('评价已保存，但人才阶段更新失败', error);
      return false;
    });
    const evaluation = transactionResult.evaluation;
    return {
      code: 0,
      msg: transactionResult.duplicated ? '该评价已提交，请勿重复操作'
        : signature ? '评价已提交并生成哈希与平台校验签名'
          : '评价已提交并生成 SHA256 内容哈希',
      evalId: evaluationId,
      evidenceHash: evaluation.evidenceHash,
      signature: evaluation.signature || '',
      signatureMethod: evaluation.signatureMethod || 'none',
      talentIndex: newIndex,
      talentStageCompleted,
      duplicated: transactionResult.duplicated,
    };
  } catch (error) {
    console.error('提交企业评价失败', error);
    return { code: 99, msg: '评价服务暂时不可用，请稍后重试' };
  }
};
