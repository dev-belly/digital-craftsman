// 云函数 postJob：企业发布实训、实习或正式岗位。
const cloud = require('wx-server-sdk');
const crypto = require('crypto');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function dateValue(value) {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  if (value.$date) return new Date(value.$date).getTime();
  return new Date(value).getTime();
}

async function validateEnterpriseSession(sessionToken, openid) {
  if (!sessionToken || !openid) return null;
  const res = await db.collection('enterprise_sessions').doc(sha256(sessionToken)).get()
    .catch(() => ({ data: null }));
  const session = res.data;
  if (!session || session.openid !== openid || session.role !== 'enterprise'
    || dateValue(session.expiresAt) <= Date.now()) {
    return null;
  }

  const account = String(session.account || '').trim();
  if (!account) return null;
  const accountRes = await db.collection('company_accounts').doc(account).get()
    .catch(() => ({ data: null }));
  const companyAccount = accountRes.data;
  if (!companyAccount || companyAccount.companyId !== session.companyId
    || companyAccount.status !== 'active'
    || (Number(companyAccount.passwordVersion) || 1) !== (Number(session.passwordVersion) || 1)) {
    return null;
  }
  return session;
}

function isMissingCollection(error) {
  const message = String((error && (error.errMsg || error.message || error.code)) || error || '');
  return /COLLECTION_NOT_EXIST|-502005|collection[^\n]*(?:not exist|not found)|集合不存在/i.test(message);
}

async function addJob(jobDoc) {
  try {
    return await db.collection('jobs').add({ data: jobDoc });
  } catch (error) {
    if (!isMissingCollection(error)) throw error;
    // 老的体验环境可能尚未运行过集合迁移。首次发布时安全地补建集合并重试。
    await db.createCollection('jobs').catch((createError) => {
      if (!/already exist|已存在/i.test(String(createError && (createError.errMsg || createError.message)))) {
        throw createError;
      }
    });
    return db.collection('jobs').add({ data: jobDoc });
  }
}

exports.main = async (event) => {
  try {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      return { code: 1, msg: '请求参数格式不正确' };
    }
    if (typeof event.enterpriseSessionToken !== 'string'
      || typeof event.title !== 'string'
      || typeof event.desc !== 'string'
      || (event.type != null && typeof event.type !== 'string')
      || (event.location != null && typeof event.location !== 'string')) {
      return { code: 1, msg: '请求参数格式不正确' };
    }

    const enterpriseSessionToken = event.enterpriseSessionToken.trim();
    const title = event.title.trim();
    const desc = event.desc.trim();
    const typeText = typeof event.type === 'string' ? event.type.trim() : '';
    const type = ['实训', '实习', '正式岗位'].includes(typeText) ? typeText : '实训';
    const location = typeof event.location === 'string' ? event.location.trim() : '';
    const { OPENID } = cloud.getWXContext();
    const enterprise = await validateEnterpriseSession(enterpriseSessionToken, OPENID);
    if (!enterprise) return { code: 401, msg: '企业登录已失效，请重新登录' };

    if (!title || !desc) return { code: 1, msg: '请填写岗位名称和岗位说明' };
    if (title.length > 40) return { code: 2, msg: '岗位名称不能超过 40 个字' };
    if (desc.length > 600) return { code: 3, msg: '岗位说明不能超过 600 个字' };
    if (location.length > 80) return { code: 4, msg: '工作地点不能超过 80 个字' };

    const now = new Date();
    const jobDoc = {
      companyId: enterprise.companyId,
      companyName: enterprise.companyName,
      title,
      type,
      desc,
      location,
      status: 'open',
      createdAt: now,
      updatedAt: now,
    };
    const addRes = await addJob(jobDoc);

    return {
      code: 0,
      msg: '岗位已发布',
      jobId: addRes._id,
    };
  } catch (error) {
    console.error('发布企业岗位失败', error);
    return { code: 99, msg: '岗位服务暂时不可用，请稍后重试' };
  }
};
