// 云函数 genWxaCode：生成官方小程序码，扫码直达公开档案页。
const cloud = require('wx-server-sdk');
const crypto = require('crypto');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const VALID_ENV_VERSIONS = ['develop', 'trial', 'release'];

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function dateValue(value) {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  if (value.$date) return new Date(value.$date).getTime();
  return new Date(value).getTime();
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

async function getCachedUrl(fileID) {
  if (!fileID) return '';
  const { fileList = [] } = await cloud.getTempFileURL({ fileList: [fileID] });
  const file = fileList[0];
  return file && file.status === 0 ? file.tempFileURL : '';
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const uid = String(event.uid || '');
  const sessionToken = String(event.sessionToken || '');
  const envVersion = VALID_ENV_VERSIONS.includes(event.envVersion)
    ? event.envVersion
    : 'develop';

  if (!uid) return { code: 1, msg: '缺少 uid' };
  // getUnlimited 的 scene 最长 32 个可见字符。直接使用 uid，避免 uid= 前缀超长。
  if (uid.length > 32 || !/^[0-9A-Za-z_-]+$/.test(uid)) {
    return { code: 2, msg: '档案编号不符合小程序码 scene 规则' };
  }

  try {
    const userRes = await db.collection('users').doc(uid).get().catch(() => ({ data: null }));
    if (!userRes.data) return { code: 3, msg: '档案不存在' };
    const session = await validateSession(uid, sessionToken, OPENID);
    if (!session.valid) {
      return { code: 401, msg: '登录已失效，请重新登录' };
    }
    if (session.setupRequired) return { code: 403, msg: '请先设置个人登录密码' };

    const qrRes = await db.collection('qrcodes').where({ uid }).limit(1).get()
      .catch(() => ({ data: [] }));
    const qrDoc = qrRes.data[0] || null;
    const cachedFileID = qrDoc && qrDoc.wxaCodes && qrDoc.wxaCodes[envVersion];
    const cachedURL = await getCachedUrl(cachedFileID).catch(() => '');
    if (cachedURL) {
      return { code: 0, fileID: cachedFileID, tempURL: cachedURL, envVersion, cached: true };
    }

    const result = await cloud.openapi.wxacode.getUnlimited({
      scene: uid,
      page: 'pages/archive/archive',
      checkPath: false,
      envVersion,
      width: 360,
      autoColor: false,
      lineColor: { r: 31, g: 75, b: 170 },
      isHyaline: false,
    });
    if (!result || !result.buffer) throw new Error('微信接口未返回小程序码图片');

    const cloudPath = `wxacode/${envVersion}/${uid}.jpg`;
    const { fileID } = await cloud.uploadFile({
      cloudPath,
      fileContent: result.buffer,
    });
    const tempURL = await getCachedUrl(fileID);

    const wxaCodes = { ...((qrDoc && qrDoc.wxaCodes) || {}), [envVersion]: fileID };
    if (qrDoc) {
      await db.collection('qrcodes').doc(qrDoc._id).update({
        data: { wxaCodes, codeUpdatedAt: new Date() },
      });
    } else {
      await db.collection('qrcodes').add({
        data: { uid, sceneStr: uid, scanCount: 0, wxaCodes, codeUpdatedAt: new Date() },
      });
    }

    return { code: 0, fileID, tempURL, envVersion, cached: false };
  } catch (error) {
    console.error('生成小程序码失败', error);
    return { code: 99, msg: error.message || '生成小程序码失败' };
  }
};
