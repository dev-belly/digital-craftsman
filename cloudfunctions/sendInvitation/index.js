// 云函数 sendInvitation:企业向学生发送面试/实习邀约
const cloud = require('wx-server-sdk');
const crypto = require('crypto');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

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

exports.main = async (event) => {
  try {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      return { code: 1, msg: '请求参数格式不正确' };
    }
    if (typeof event.uid !== 'string'
      || typeof event.enterpriseSessionToken !== 'string'
      || (event.type != null && typeof event.type !== 'string')
      || (event.message != null && typeof event.message !== 'string')) {
      return { code: 1, msg: '请求参数格式不正确' };
    }

    const uid = event.uid.trim();
    const type = typeof event.type === 'string' ? event.type.trim() : '';
    const message = typeof event.message === 'string' ? event.message.trim() : '';
    const enterpriseSessionToken = event.enterpriseSessionToken.trim();
    const { OPENID } = cloud.getWXContext();
    const enterprise = await validateEnterpriseSession(enterpriseSessionToken, OPENID);
    if (!enterprise) return { code: 401, msg: '企业登录已失效，请重新登录' };
    const companyName = String(enterprise.companyName || '').trim();

    if (!uid || !companyName) return { code: 1, msg: '缺少学生或企业信息' };
    if (message.length > 300) return { code: 1, msg: '邀约说明不能超过 300 个字' };
    const invitationType = type === '实习' ? '实习' : '面试';

    // 确认学生存在
    const userRes = await db.collection('users').doc(uid).get().catch(() => ({ data: null }));
    if (!userRes.data) return { code: 2, msg: '学生档案不存在' };

    // 同一企业已向该学生发送过同类型且尚未结束（pending/accepted）的邀约时，
    // 直接返回已存在的邀约，避免重复邀约刷屏；已被婉拒的可重新发送。
    const existingRes = await db.collection('invitations')
      .where({
        companyId: enterprise.companyId,
        uid,
        type: invitationType,
        status: _.in(['pending', 'accepted']),
      })
      .limit(1)
      .get()
      .catch(() => ({ data: [] }));
    if (existingRes.data && existingRes.data.length) {
      const existing = existingRes.data[0];
      return {
        code: 0,
        msg: existing.status === 'accepted' ? '已向该学生发送过邀约并获接受' : '已向该学生发送过邀约，请等待学生回应',
        invitationId: existing._id,
        duplicated: true,
      };
    }

    const now = new Date();
    const addRes = await db.collection('invitations').add({
      data: {
        companyId: enterprise.companyId,
        companyName,
        uid,
        studentName: userRes.data.name || '',
        type: invitationType,
        message,
        status: 'pending', // pending / accepted / declined
        createdAt: now,
      },
    });

    return {
      code: 0,
      msg: `已发送${invitationType}邀约`,
      invitationId: addRes._id,
    };
  } catch (error) {
    console.error('发送企业邀约失败', error);
    return { code: 99, msg: '邀约服务暂时不可用，请稍后重试' };
  }
};
