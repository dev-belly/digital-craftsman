// 主动退出：撤销当前云端会话，再由客户端清理本地凭据。
const cloud = require('wx-server-sdk');
const crypto = require('crypto');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function isDocumentNotFound(error) {
  const message = String(
    (error && (error.errMsg || error.message)) || error || '',
  );
  return message.includes('document with _id ') && message.includes(' does not exist');
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const role = event && event.role === 'enterprise' ? 'enterprise' : 'student';
  const token = role === 'enterprise'
    ? String((event && event.enterpriseSessionToken) || '')
    : String((event && event.sessionToken) || '');
  if (!OPENID || !token) return { code: 1, msg: '缺少有效登录会话' };

  const collectionName = role === 'enterprise' ? 'enterprise_sessions' : 'sessions';
  const tokenHash = sha256(token);
  try {
    const sessionRes = await db.collection(collectionName).doc(tokenHash).get();
    if (!sessionRes.data || sessionRes.data.openid !== OPENID) {
      return { code: 403, msg: '无权撤销该登录会话' };
    }
    await db.collection(collectionName).doc(tokenHash).remove();
  } catch (error) {
    if (isDocumentNotFound(error)) return { code: 0 };
    console.error('撤销会话失败', error);
    return { code: 99, msg: '安全退出失败，请稍后重试' };
  }
  return { code: 0 };
};
