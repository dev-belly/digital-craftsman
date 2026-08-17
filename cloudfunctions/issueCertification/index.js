// 云函数 issueCertification：已登录企业向学生签发技能认证。
// 认证由企业签发，学生不能自行把未核验内容写成“已认证”。
const cloud = require('wx-server-sdk');
const crypto = require('crypto');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const LEVELS = new Set(['初级', '中级', '高级']);
const REQUIRED_STAGES = ['学习', '认证', '作品', '企业好评'];

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function dateValue(value) {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  if (value.$date) return new Date(value.$date).getTime();
  return new Date(value).getTime();
}

function isDocumentNotFound(error) {
  const message = String((error && (error.errMsg || error.message)) || error || '');
  return message.includes('document with _id ') && message.includes(' does not exist');
}

async function getOptionalDocument(documentReference) {
  try {
    return await documentReference.get();
  } catch (error) {
    if (isDocumentNotFound(error)) return { data: null };
    throw error;
  }
}

function normalizeText(value, label, maxLength, required = true) {
  if (value === undefined || value === null) {
    return required ? { error: `请填写${label}` } : { value: '' };
  }
  if (typeof value !== 'string') return { error: `${label}格式不正确` };
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (required && !normalized) return { error: `请填写${label}` };
  if (normalized.length > maxLength) return { error: `${label}不能超过 ${maxLength} 个字符` };
  return { value: normalized };
}

async function validateEnterpriseSession(sessionToken, openid) {
  if (!sessionToken || !openid) return null;
  const sessionRes = await getOptionalDocument(
    db.collection('enterprise_sessions').doc(sha256(sessionToken)),
  );
  const session = sessionRes.data;
  if (!session || session.openid !== openid || session.role !== 'enterprise'
    || dateValue(session.expiresAt) <= Date.now() || !session.account) {
    return null;
  }
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
  const evalAverage = scores.length
    ? scores.reduce((sum, score) => sum + score, 0) / scores.length
    : 0;
  const index = Math.round(
    certLevelScore * 40
    + (Math.min(works.data.length, 5) * 10) / 5
    + (evalAverage / 100) * 30
    + (evalAverage / 100) * 20,
  );
  await db.collection('users').doc(uid).update({
    data: { talentIndex: index, updatedAt: new Date() },
  });
  return index;
}

async function completeTalentStageIfEligible(uid, now) {
  const [userRes, stageRes] = await Promise.all([
    getOptionalDocument(db.collection('users').doc(uid)),
    db.collection('stages').where({ uid }).limit(20).get(),
  ]);
  if (!userRes.data || !userRes.data.talentPoolVisible) return false;
  const stageMap = new Map(stageRes.data.map((stage) => [stage.stage, stage]));
  if (!REQUIRED_STAGES.every((stage) => stageMap.get(stage)
    && stageMap.get(stage).status === 'done')) return false;

  const current = stageMap.get('人才');
  if (current && current.status === 'done') return true;
  if (current) {
    await db.collection('stages').doc(current._id).update({
      data: { status: 'done', completedAt: now, updatedAt: now },
    });
  } else {
    await db.collection('stages').doc(`${uid}-stage-5`).set({
      data: {
        uid,
        stage: '人才',
        status: 'done',
        startedAt: now,
        completedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    });
  }
  return true;
}

exports.main = async (event) => {
  try {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      return { code: 1, msg: '请求参数格式不正确' };
    }
    const uidResult = normalizeText(event.uid, '学生', 80);
    const nameResult = normalizeText(event.certName, '认证名称', 80);
    const serialResult = normalizeText(event.serialNo, '证书编号', 50, false);
    const requestResult = normalizeText(event.requestId, '请求编号', 100);
    const level = typeof event.level === 'string' ? event.level.trim() : '';
    if (uidResult.error || nameResult.error || serialResult.error || requestResult.error) {
      return {
        code: 2,
        msg: uidResult.error || nameResult.error || serialResult.error || requestResult.error,
      };
    }
    if (!/^(?:demo|stu)-[a-z0-9_-]+$/i.test(uidResult.value)) {
      return { code: 2, msg: '学生档案编号格式不正确' };
    }
    if (!LEVELS.has(level)) return { code: 2, msg: '请选择初级、中级或高级认证' };
    if (!/^[A-Za-z0-9._:-]{12,100}$/.test(requestResult.value)) {
      return { code: 2, msg: '请求编号格式不正确' };
    }

    const { OPENID } = cloud.getWXContext();
    const enterprise = await validateEnterpriseSession(
      String(event.enterpriseSessionToken || '').trim(),
      OPENID,
    );
    if (!enterprise) return { code: 401, msg: '企业登录已失效，请重新登录' };

    const uid = uidResult.value;
    const digest = sha256(`${enterprise.companyId}|${requestResult.value}`);
    const certificationId = `cert-${digest.slice(0, 24)}`;
    const attestationId = `att-${digest.slice(0, 24)}`;
    const existingRes = await getOptionalDocument(
      db.collection('certifications').doc(certificationId),
    );
    if (existingRes.data) {
      if (existingRes.data.uid !== uid || existingRes.data.issuerId !== enterprise.companyId) {
        return { code: 409, msg: '请求编号已被使用，请重新打开签发窗口' };
      }
      const talentIndex = await recalcTalentIndex(uid).catch(() => null);
      return {
        code: 0,
        msg: '该认证已签发，请勿重复提交',
        certificationId,
        evidenceHash: existingRes.data.evidenceHash || '',
        talentIndex,
        duplicated: true,
      };
    }

    const userRes = await getOptionalDocument(db.collection('users').doc(uid));
    if (!userRes.data) return { code: 404, msg: '学生档案不存在' };

    const now = new Date();
    const serialNo = serialResult.value || `DC-${digest.slice(0, 12).toUpperCase()}`;
    const issuer = String(enterprise.companyName || '企业签发方').trim();
    const evidencePayload = JSON.stringify({
      version: 1,
      uid,
      issuerId: enterprise.companyId,
      issuer,
      certName: nameResult.value,
      level,
      serialNo,
      issuedAt: now.toISOString(),
    });
    const evidenceHash = sha256(evidencePayload);
    const stageQuery = await db.collection('stages')
      .where({ uid, stage: '认证' })
      .limit(1)
      .get();
    const stageId = stageQuery.data[0] ? stageQuery.data[0]._id : `${uid}-stage-2`;

    await db.runTransaction(async (transaction) => {
      const [freshCertRes, freshUserRes, stageRes] = await Promise.all([
        getOptionalDocument(transaction.collection('certifications').doc(certificationId)),
        getOptionalDocument(transaction.collection('users').doc(uid)),
        getOptionalDocument(transaction.collection('stages').doc(stageId)),
      ]);
      if (freshCertRes.data) return;
      if (!freshUserRes.data) throw new Error('STUDENT_NOT_FOUND');

      await transaction.collection('certifications').doc(certificationId).set({
        data: {
          uid,
          certName: nameResult.value,
          issuer,
          issuerId: enterprise.companyId,
          issuerType: 'enterprise',
          level,
          serialNo,
          issueDate: now,
          issueAt: now,
          issuedAt: now,
          evidenceHash,
          verificationStatus: 'enterprise_issued',
          requestId: requestResult.value,
          createdAt: now,
          updatedAt: now,
        },
      });
      await transaction.collection('attestations').doc(attestationId).set({
        data: {
          targetType: 'certification',
          targetId: certificationId,
          hash: evidenceHash,
          timestamp: now,
          chainTxId: null,
          verificationMethod: 'sha256',
        },
      });
      if (stageRes.data) {
        await transaction.collection('stages').doc(stageId).update({
          data: {
            status: 'done',
            startedAt: stageRes.data.startedAt || now,
            completedAt: now,
            updatedAt: now,
          },
        });
      } else {
        await transaction.collection('stages').doc(stageId).set({
          data: {
            uid,
            stage: '认证',
            status: 'done',
            startedAt: now,
            completedAt: now,
            createdAt: now,
            updatedAt: now,
          },
        });
      }
    });

    const talentIndex = await recalcTalentIndex(uid).catch((error) => {
      console.error('认证已写入，但人才指数重算失败', error);
      return null;
    });
    const talentStageCompleted = await completeTalentStageIfEligible(uid, now)
      .catch((error) => {
        console.error('认证已写入，但人才阶段更新失败', error);
        return false;
      });

    return {
      code: 0,
      msg: '认证已签发并生成哈希校验记录',
      certificationId,
      evidenceHash,
      serialNo,
      talentIndex,
      talentStageCompleted,
    };
  } catch (error) {
    if (String(error && error.message).includes('STUDENT_NOT_FOUND')) {
      return { code: 404, msg: '学生档案不存在' };
    }
    console.error('企业签发认证失败', error);
    return { code: 99, msg: '认证签发服务暂时不可用，请稍后重试' };
  }
};
