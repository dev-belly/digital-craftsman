// 学生申请企业发布的实训、实习或正式岗位。
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
  const message = String((error && (error.errMsg || error.message)) || error || '');
  return /-502004|does not exist|not found|文档不存在/i.test(message);
}

async function getOptionalDocument(reference) {
  try {
    return await reference.get();
  } catch (error) {
    if (isDocumentNotFound(error)) return { data: null };
    throw error;
  }
}

async function validateStudentSession(uid, sessionToken, openid) {
  if (!uid || !sessionToken || !openid) return null;
  const sessionRes = await getOptionalDocument(
    db.collection('sessions').doc(sha256(sessionToken)),
  );
  const session = sessionRes.data;
  if (!session || session.uid !== uid || session.openid !== openid
    || dateValue(session.expiresAt) <= Date.now() || !session.account) return null;
  const accountRes = await getOptionalDocument(
    db.collection('campus_accounts').doc(session.account),
  );
  const account = accountRes.data;
  if (!account || (account.status && account.status !== 'active')
    || Number(account.passwordVersion) !== Number(session.passwordVersion)) return null;
  return session;
}

exports.main = async (event) => {
  try {
    const uid = String((event && event.uid) || '').trim();
    const sessionToken = String((event && event.sessionToken) || '').trim();
    const jobId = String((event && event.jobId) || '').trim();
    const message = String((event && event.message) || '').trim();
    const { OPENID } = cloud.getWXContext();
    const session = await validateStudentSession(uid, sessionToken, OPENID);
    if (!session) return { code: 401, msg: '登录已失效，请重新登录' };
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(jobId)) return { code: 1, msg: '岗位编号无效' };
    if (message.length > 300) return { code: 2, msg: '申请说明不能超过 300 个字' };

    const applicationId = `application-${sha256(`${jobId}|${uid}`).slice(0, 32)}`;
    const result = await db.runTransaction(async (transaction) => {
      const [jobRes, userRes, existingRes] = await Promise.all([
        getOptionalDocument(transaction.collection('jobs').doc(jobId)),
        getOptionalDocument(transaction.collection('users').doc(uid)),
        getOptionalDocument(transaction.collection('job_applications').doc(applicationId)),
      ]);
      const job = jobRes.data;
      const user = userRes.data;
      const existing = existingRes.data;
      if (!job || job.status !== 'open') {
        return { code: 404, msg: '该岗位已下线或不存在' };
      }
      if (!user) return { code: 404, msg: '学生档案不存在' };
      if (existing) {
        return {
          code: 0,
          msg: '你已经申请过这个岗位',
          applicationId,
          status: existing.status || 'pending',
          duplicated: true,
        };
      }

      const now = new Date();
      await transaction.collection('job_applications').doc(applicationId).set({
        data: {
          jobId,
          companyId: job.companyId,
          companyName: job.companyName || '',
          jobTitle: job.title || '',
          jobType: job.type || '实习',
          uid,
          studentName: user.name || '',
          message,
          status: 'pending',
          createdAt: now,
          updatedAt: now,
        },
      });
      return {
        code: 0,
        msg: '申请已发送给企业',
        applicationId,
        status: 'pending',
      };
    });
    return result;
  } catch (error) {
    console.error('学生申请岗位失败', error);
    return { code: 99, msg: '申请服务暂时不可用，请稍后重试' };
  }
};
