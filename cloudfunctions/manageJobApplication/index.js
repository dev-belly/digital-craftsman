// 企业处理学生的岗位申请。
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

exports.main = async (event) => {
  try {
    const applicationId = String((event && event.applicationId) || '').trim();
    const action = event && event.action === 'accepted' ? 'accepted'
      : event && event.action === 'declined' ? 'declined' : '';
    const token = String((event && event.enterpriseSessionToken) || '').trim();
    const { OPENID } = cloud.getWXContext();
    const enterprise = await validateEnterpriseSession(token, OPENID);
    if (!enterprise) return { code: 401, msg: '企业登录已失效，请重新登录' };
    if (!/^application-[a-f0-9]{32}$/.test(applicationId) || !action) {
      return { code: 1, msg: '申请处理参数无效' };
    }

    return await db.runTransaction(async (transaction) => {
      const applicationRef = transaction.collection('job_applications').doc(applicationId);
      const applicationRes = await getOptionalDocument(applicationRef);
      const application = applicationRes.data;
      if (!application || application.companyId !== enterprise.companyId) {
        return { code: 403, msg: '无权处理该申请' };
      }
      if (application.status && application.status !== 'pending') {
        if (application.status === action) {
          return { code: 0, status: action, msg: '该申请已处理' };
        }
        return { code: 409, msg: '该申请已经处理，不能重复修改' };
      }
      const now = new Date();
      await applicationRef.update({
        data: {
          status: action,
          respondedAt: now,
          updatedAt: now,
          reviewedBy: enterprise.account,
        },
      });
      return {
        code: 0,
        status: action,
        msg: action === 'accepted' ? '已接受学生申请' : '已婉拒学生申请',
      };
    });
  } catch (error) {
    console.error('企业处理岗位申请失败', error);
    return { code: 99, msg: '申请处理服务暂时不可用，请稍后重试' };
  }
};
