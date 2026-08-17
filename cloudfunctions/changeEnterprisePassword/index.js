// 企业账号修改密码：校验当前会话与原密码，并旋转会话令牌。
const cloud = require('wx-server-sdk');
const crypto = require('crypto');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const SESSION_DAYS = 7;
const PASSWORD_ITERATIONS = 120000;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function derivePasswordHash(accountData, password) {
  if (accountData.passwordAlgorithm === 'pbkdf2-sha256') {
    return crypto.pbkdf2Sync(
      String(password),
      String(accountData.salt || ''),
      Number(accountData.passwordIterations) || PASSWORD_ITERATIONS,
      32,
      'sha256',
    ).toString('hex');
  }
  return sha256(`${accountData.salt}:${password}`);
}

function createPasswordHash(password, salt) {
  return crypto.pbkdf2Sync(
    String(password),
    String(salt),
    PASSWORD_ITERATIONS,
    32,
    'sha256',
  ).toString('hex');
}

function dateValue(value) {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  if (value.$date) return new Date(value.$date).getTime();
  return new Date(value).getTime();
}

function validateNewPassword(password) {
  if (password.length < 8 || password.length > 32) return '密码长度应为 8—32 位';
  if (/\s/.test(password)) return '密码不能包含空格';
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    return '密码必须同时包含字母和数字';
  }
  return '';
}

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

function isDocumentNotFound(error) {
  const message = [
    error && error.code,
    error && error.errCode,
    error && error.errMsg,
    error && error.message,
    error,
  ].filter(Boolean).join(' ').toLowerCase();
  return message.includes('-502004')
    || message.includes('document does not exist')
    || message.includes('does not exist')
    || message.includes('not found')
    || message.includes('文档不存在');
}

async function getOptionalDocument(documentReference) {
  try {
    return await documentReference.get();
  } catch (error) {
    if (isDocumentNotFound(error)) return { data: null };
    throw error;
  }
}

function isRetryableTransactionError(error) {
  return /-501001|TransactionBusy|transaction[^\n]*(?:conflict|aborted)|\bABORTED\b/i
    .test(errorText(error));
}

// 事务遇到并发冲突时有限指数退避；不重试集合缺失、权限等确定性错误。
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

async function getEnterpriseAuth(sessionToken, openid) {
  if (!sessionToken || !openid) return null;
  let sessionRes;
  try {
    sessionRes = await db.collection('enterprise_sessions').doc(sha256(sessionToken)).get();
  } catch (error) {
    return null;
  }
  const session = sessionRes.data;
  if (!session || session.openid !== openid || session.role !== 'enterprise'
    || dateValue(session.expiresAt) <= Date.now() || !session.account || !session.companyId) {
    return null;
  }

  let accountRes;
  try {
    accountRes = await db.collection('company_accounts').doc(session.account).get();
  } catch (error) {
    return null;
  }
  const account = accountRes.data;
  if (!account || account.status !== 'active' || account.companyId !== session.companyId
    || (Number(account.passwordVersion) || 1) !== (Number(session.passwordVersion) || 1)) {
    return null;
  }
  return { session, account };
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const sessionToken = String((event && event.enterpriseSessionToken) || '');
  const currentPassword = String((event && event.currentPassword) || '');
  const newPassword = String((event && event.newPassword) || '');

  const auth = await getEnterpriseAuth(sessionToken, OPENID);
  if (!auth) return { code: 401, msg: '企业登录已失效，请重新登录' };

  const passwordError = validateNewPassword(newPassword);
  if (passwordError) return { code: 2, msg: passwordError };
  if (!currentPassword) return { code: 3, msg: '请输入原密码' };

  const { account, session } = auth;
  const currentHash = derivePasswordHash(account, currentPassword);
  if (!safeEqual(currentHash, account.passwordHash)) {
    return { code: 3, msg: '原密码不正确' };
  }
  if (safeEqual(derivePasswordHash(account, newPassword), account.passwordHash)) {
    return { code: 4, msg: '新密码不能与原密码相同' };
  }

  const now = new Date();
  const newSalt = crypto.randomBytes(16).toString('hex');
  const newPasswordHash = createPasswordHash(newPassword, newSalt);
  const nextVersion = (Number(account.passwordVersion) || 1) + 1;
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = sha256(rawToken);
  const expiresAt = new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000);

  try {
    await runTxWithRetry(async (transaction) => {
      const freshRes = await getOptionalDocument(transaction.collection('company_accounts').doc(session.account));
      const fresh = freshRes.data;
      if (!fresh || fresh.status !== 'active'
        || (Number(fresh.passwordVersion) || 1) !== (Number(account.passwordVersion) || 1)) {
        throw new Error('PASSWORD_STATE_CHANGED');
      }

      await transaction.collection('company_accounts').doc(session.account).update({
        data: {
          salt: newSalt,
          passwordHash: newPasswordHash,
          passwordAlgorithm: 'pbkdf2-sha256',
          passwordIterations: PASSWORD_ITERATIONS,
          passwordVersion: nextVersion,
          updatedAt: now,
        },
      });
      await transaction.collection('enterprise_sessions').doc(tokenHash).set({
        data: {
          account: session.account,
          companyId: session.companyId,
          companyName: session.companyName || account.companyName,
          contact: session.contact || account.contact || '',
          role: 'enterprise',
          openid: OPENID,
          passwordVersion: nextVersion,
          createdAt: now,
          expiresAt,
        },
      });
    });
  } catch (error) {
    if (String(error && error.message).includes('PASSWORD_STATE_CHANGED')) {
      return { code: 409, msg: '密码状态已变化，请重新登录' };
    }
    console.error('修改企业密码失败', error);
    return { code: 99, msg: '密码修改失败，请稍后重试' };
  }

  return {
    code: 0,
    msg: '企业密码修改成功',
    enterpriseSessionToken: rawToken,
    expiresAt,
  };
};
