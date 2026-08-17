// 云函数 recoverAccount：通过当前微信的 OpenID 找回已绑定账号并安全重置密码。
const cloud = require('wx-server-sdk');
const crypto = require('crypto');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const PASSWORD_ITERATIONS = 120000;
const RESET_COOLDOWN_MS = 30 * 1000;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
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

function derivePasswordHash(accountData, password) {
  if (!accountData) return '';
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

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
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

function validateNewPassword(password) {
  if (password.length < 8 || password.length > 32) return '密码长度应为 8—32 位';
  if (/\s/.test(password)) return '密码不能包含空格';
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    return '密码必须同时包含字母和数字';
  }
  return '';
}

function dateValue(value) {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  if (value.$date) return new Date(value.$date).getTime();
  return new Date(value).getTime();
}

function roleConfig(role) {
  if (role === 'enterprise') {
    return {
      accountCollection: 'company_accounts',
      subjectKey: 'companyId',
      roleName: '企业',
    };
  }
  return {
    accountCollection: 'campus_accounts',
    subjectKey: 'uid',
    roleName: '学生',
  };
}

function normalizeAccount(role, value) {
  const account = String(value || '').trim();
  return role === 'enterprise' ? account.toUpperCase() : account;
}

function isAccountUsable(role, accountData) {
  if (!accountData) return false;
  if (role === 'enterprise') {
    return accountData.status === 'active' || accountData.status === 'pending';
  }
  return !accountData.status || accountData.status === 'active';
}

function loginAttemptIds(role, account, openidHash) {
  return [
    `account-${sha256(`${role}|${account}|${openidHash}`)}`,
    `wechat-${openidHash}`,
  ];
}

function identityBindingMatches(binding, type, role, account, subjectId, openidHash) {
  return Boolean(binding
    && binding.type === type
    && binding.role === role
    && binding.account === account
    && String(binding.subjectId || '') === subjectId
    && binding.openidHash === openidHash
    && binding.status === 'active');
}

async function findBoundAccount(openid, role, account) {
  const config = roleConfig(role);
  const openidHash = sha256(openid);
  if (!account) {
    return { error: { code: 400, msg: '请输入要找回的账号' } };
  }

  const principalId = `principal-${role}-${sha256(account)}`;
  const [accountRes, principalRes] = await Promise.all([
    getOptionalDocument(db.collection(config.accountCollection).doc(account)),
    getOptionalDocument(db.collection('identity_bindings').doc(principalId)),
  ]);
  const accountData = accountRes.data;
  if (!accountData) {
    return {
      error: {
        code: 404,
        msg: `没有找到${config.roleName}账号「${account}」，请确认账号是否正确`,
      },
    };
  }

  const principalBinding = principalRes.data;
  const subjectId = String(accountData[config.subjectKey] || '');
  const bindingIsComplete = Boolean(subjectId
    && accountData.boundOpenidHash === openidHash
    && (!accountData.bindingStatus || accountData.bindingStatus === 'active')
    && identityBindingMatches(
    principalBinding, 'principal', role, account, subjectId, openidHash,
    ));
  if (!bindingIsComplete) {
    return {
      error: {
        code: 409,
        msg: '当前微信与该账号的安全绑定不一致，请使用注册或最近登录该账号的微信找回',
      },
    };
  }

  return {
    config,
    account,
    openidHash,
    principalId,
    principalBinding,
    accountData,
  };
}

async function findAccountsForCurrentWechat(openid, role) {
  const openidHash = sha256(openid);
  const config = roleConfig(role);
  const bindingRes = await db.collection('identity_bindings').where({
    type: 'principal',
    role,
    openidHash,
    status: 'active',
  }).limit(20).get();
  const bindings = Array.isArray(bindingRes.data) ? bindingRes.data : [];
  const seen = new Set();
  const results = [];

  // 兼容历史上同一微信留下多条 principal 的数据，但每条都要
  // 与账号文档双向交叉校验。不使用可被覆盖的 wechat/legacy 单槽记录。
  for (const binding of bindings) {
    if (results.length >= 10) break;
    const account = normalizeAccount(role, binding && binding.account);
    if (!account || seen.has(account)) continue;
    seen.add(account);

    const principalId = `principal-${role}-${sha256(account)}`;
    if (binding._id && binding._id !== principalId) continue;
    const accountRes = await getOptionalDocument(
      db.collection(config.accountCollection).doc(account),
    );
    const accountData = accountRes.data;
    const subjectId = String((accountData && accountData[config.subjectKey]) || '');
    const bindingIsComplete = Boolean(accountData
      && subjectId
      && isAccountUsable(role, accountData)
      && accountData.boundOpenidHash === openidHash
      && (!accountData.bindingStatus || accountData.bindingStatus === 'active')
      && identityBindingMatches(
        binding, 'principal', role, account, subjectId, openidHash,
      ));
    if (!bindingIsComplete) continue;

    let displayName = '';
    try {
      displayName = await getDisplayName(role, binding, accountData);
    } catch (error) {
      console.warn('读取已绑定账号名称失败', error);
    }
    results.push({ account, displayName });
  }
  return results;
}

async function getDisplayName(role, binding, accountData) {
  if (role === 'enterprise') return String(accountData.companyName || '');
  if (!binding.subjectId) return '';
  const userRes = await getOptionalDocument(db.collection('users').doc(binding.subjectId));
  return String((userRes.data && userRes.data.name) || '');
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const role = (event && event.role) === 'enterprise' ? 'enterprise' : 'student';
  const action = String((event && event.action) || 'lookup');

  if (!OPENID) return { code: 1, msg: '无法识别当前微信用户' };
  if (!['findAccounts', 'lookup', 'resetPassword'].includes(action)) {
    return { code: 2, msg: '不支持的找回操作' };
  }

  if (action === 'findAccounts') {
    try {
      const accounts = await findAccountsForCurrentWechat(OPENID, role);
      return { code: 0, role, accounts };
    } catch (error) {
      console.error('查询当前微信已绑定账号失败', error);
      return { code: 99, msg: '账号查询失败，请稍后重试' };
    }
  }

  const account = normalizeAccount(role, event && event.account);
  let found;
  try {
    found = await findBoundAccount(OPENID, role, account);
  } catch (error) {
    console.error('查询账号绑定失败', error);
    return { code: 99, msg: '账号查询失败，请稍后重试' };
  }
  if (found.error) return found.error;

  const {
    config, openidHash, principalId, principalBinding, accountData,
  } = found;
  if (!isAccountUsable(role, accountData)) {
    return { code: 403, msg: '该账号当前不可用，请联系管理员' };
  }

  if (action === 'lookup') {
    let displayName = '';
    try {
      displayName = await getDisplayName(role, principalBinding, accountData);
    } catch (error) {
      console.warn('读取账号显示名称失败', error);
    }
    return {
      code: 0,
      role,
      account,
      displayName,
      msg: '已找到账号',
    };
  }

  const newPassword = String((event && event.newPassword) || '');
  const passwordError = validateNewPassword(newPassword);
  if (passwordError) return { code: 2, msg: passwordError };
  if (safeEqual(derivePasswordHash(accountData, newPassword), accountData.passwordHash)) {
    return { code: 4, msg: '新密码不能与原密码相同' };
  }
  const lastRecoveryAt = dateValue(principalBinding && principalBinding.lastRecoveryAt);
  if (Date.now() - lastRecoveryAt < RESET_COOLDOWN_MS) {
    return { code: 429, msg: '刚刚已经重置过密码，请稍后再试' };
  }

  const now = new Date();
  const newSalt = crypto.randomBytes(16).toString('hex');
  const newPasswordHash = createPasswordHash(newPassword, newSalt);
  const currentVersion = Number(accountData.passwordVersion) || 1;
  const currentPasswordHash = String(accountData.passwordHash || '');
  const nextVersion = currentVersion + 1;
  const attemptIds = loginAttemptIds(role, account, openidHash);

  try {
    await runTxWithRetry(async (transaction) => {
      const [freshPrincipal, freshAccountRes] = await Promise.all([
        getOptionalDocument(transaction.collection('identity_bindings').doc(principalId)),
        getOptionalDocument(transaction.collection(config.accountCollection).doc(account)),
      ]);
      const freshAccount = freshAccountRes.data;
      const freshPrincipalBinding = freshPrincipal.data;
      if (!freshAccount) throw new Error('ACCOUNT_GONE');
      const freshSubjectId = String(freshAccount[config.subjectKey] || '');
      const bindingStillMatches = freshPrincipalBinding
        && freshPrincipalBinding.type === 'principal'
        && freshPrincipalBinding.role === role
        && freshPrincipalBinding.account === account
        && String(freshPrincipalBinding.subjectId || '') === freshSubjectId
        && freshPrincipalBinding.status === 'active'
        && freshPrincipalBinding.openidHash === openidHash
        && freshAccount.boundOpenidHash === openidHash;
      if (!bindingStillMatches) {
        throw new Error('BINDING_CHANGED');
      }
      if (!isAccountUsable(role, freshAccount)) throw new Error('ACCOUNT_DISABLED');
      if ((Number(freshAccount.passwordVersion) || 1) !== currentVersion) {
        throw new Error('PASSWORD_CHANGED');
      }
      if (String(freshAccount.passwordHash || '') !== currentPasswordHash) {
        throw new Error('PASSWORD_CHANGED');
      }
      const freshLastRecoveryAt = dateValue(
        freshPrincipalBinding && freshPrincipalBinding.lastRecoveryAt,
      );
      if (Date.now() - freshLastRecoveryAt < RESET_COOLDOWN_MS) {
        throw new Error('RESET_TOO_FREQUENT');
      }

      const passwordData = {
        salt: newSalt,
        passwordHash: newPasswordHash,
        passwordAlgorithm: 'pbkdf2-sha256',
        passwordIterations: PASSWORD_ITERATIONS,
        passwordVersion: nextVersion,
        passwordResetAt: now,
        passwordResetMethod: 'bound_wechat',
        updatedAt: now,
      };
      if (role === 'student') passwordData.mustChangePassword = false;

      await transaction.collection(config.accountCollection).doc(account).update({
        data: passwordData,
      });
      await transaction.collection('identity_bindings').doc(principalId).update({
        data: { lastRecoveryAt: now },
      });
    });
  } catch (error) {
    const message = String(error && error.message);
    if (message.includes('ACCOUNT_DISABLED') || message.includes('ACCOUNT_GONE')) {
      return { code: 403, msg: '该账号当前不可用，请联系管理员' };
    }
    if (message.includes('BINDING_CHANGED') || message.includes('PASSWORD_CHANGED')) {
      return { code: 409, msg: '账号状态刚刚发生变化，请重新查询后再试' };
    }
    if (message.includes('SAME_PASSWORD')) {
      return { code: 4, msg: '新密码不能与原密码相同' };
    }
    if (message.includes('RESET_TOO_FREQUENT')) {
      return { code: 429, msg: '刚刚已经重置过密码，请稍后再试' };
    }
    console.error('微信身份重置密码失败', error);
    return { code: 99, msg: '密码重置失败，请稍后重试' };
  }

  // 密码已经安全更新后，再尽力清除登录失败计数。将这些派生写入移出
  // 核心事务，避免低配云函数因事务写入过多而超时。
  await Promise.all(attemptIds.map((attemptId) => (
    db.collection('login_attempts').doc(attemptId).set({
      data: {
        attempts: 0,
        blockedUntil: null,
        windowStartedAt: now,
        lastAttemptAt: now,
      },
    })
  ))).catch((error) => {
    console.warn('重置登录失败计数异常', error);
  });

  return {
    code: 0,
    role,
    account,
    msg: '密码已重置，请使用新密码登录',
  };
};
