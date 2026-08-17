// 云函数 login：学生/企业账号登录，并签发短期会话。
const cloud = require('wx-server-sdk');
const crypto = require('crypto');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const SESSION_DAYS = 7;
const MAX_ACCOUNT_ATTEMPTS = 5;
const MAX_WECHAT_ATTEMPTS = 20;
const LOCK_MINUTES = 10;
const ATTEMPT_WINDOW_MS = LOCK_MINUTES * 60 * 1000;
// 与 register 云函数保持一致：内部体验阶段自动开通待审核企业。
// 正式对外运营前应改为 false，并接入管理员审核后台。
const ENTERPRISE_TEST_AUTO_APPROVE = true;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
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

function derivePasswordHash(accountData, password) {
  if (!accountData) return '';
  if (accountData.passwordAlgorithm === 'pbkdf2-sha256') {
    const iterations = Number(accountData.passwordIterations) || 120000;
    if (!Number.isInteger(iterations) || iterations < 10000 || iterations > 1000000) {
      return '';
    }
    return crypto.pbkdf2Sync(
      String(password),
      String(accountData.salt || ''),
      iterations,
      32,
      'sha256',
    ).toString('hex');
  }
  // 兼容原有测试账号及历史导入账号。
  return sha256(`${accountData.salt}:${password}`);
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function dateValue(value) {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  if (value.$date) return new Date(value.$date).getTime();
  return new Date(value).getTime();
}

async function getCompanyAccount(account) {
  const existingRes = await getOptionalDocument(
    db.collection('company_accounts').doc(account),
  );
  const existing = existingRes.data || null;
  if (existing) {
    // 已存在账号：保留用户当前的密码（含算法 / 版本），不强制改回演示哈希。
    // 否则一旦用户重置或修改过密码（算法变为 pbkdf2-sha256），下次登录会被悄悄改回初始密码。
    return existing;
  }
  // 演示账号也只能由 initDB 显式创建；登录绝不自动复活已删除的账号。
  return null;
}

async function getCampusAccount(account) {
  const existingRes = await getOptionalDocument(
    db.collection('campus_accounts').doc(account),
  );
  const existing = existingRes.data || null;
  if (existing) {
    // 已存在账号：保留用户当前的密码（含算法 / 版本），不强制改回演示哈希。
    // 否则一旦用户重置或修改过密码（算法变为 pbkdf2-sha256），下次登录会被悄悄改回初始密码。
    return existing;
  }
  // 演示账号也只能由 initDB 显式创建；登录绝不自动复活已删除的账号。
  return null;
}

// 账号密码为主：同一账号可在多个微信登录，同一微信也可登录多个账号。
// 登录成功后仅刷新身份记录（identity_bindings / legacy bindings），不再做
// "一个微信一账号"或"必须用注册时微信首次绑定"的拦截。boundOpenidHash
// 仅表示该账号最近一次登录的微信，用于找回密码等辅助场景。
async function ensureIdentityBinding({
  role, account, subjectId, openid, accountData,
}) {
  const openidHash = sha256(openid);
  const config = role === 'enterprise'
    ? {
      accountCollection: 'company_accounts',
      legacyCollection: 'enterprise_bindings',
      legacySubjectKey: 'companyId',
    }
    : {
      accountCollection: 'campus_accounts',
      legacyCollection: 'account_bindings',
      legacySubjectKey: 'uid',
    };
  const wechatId = `wechat-${openidHash}-${account}`;
  const principalId = `principal-${role}-${sha256(account)}`;
  const legacyAccountId = `account-${account}`;
  const legacyWechatId = `openid-${openidHash}`;

  const allowedStatuses = role === 'enterprise' ? ['active', 'pending'] : ['active'];
  const status = accountData && (accountData.status || 'active');
  if (!accountData || !allowedStatuses.includes(status)) {
    return { code: 9, msg: '该账号当前不可用，请联系管理员' };
  }

  try {
    const [wechatRes, principalRes] = await Promise.all([
      getOptionalDocument(db.collection('identity_bindings').doc(wechatId)),
      getOptionalDocument(db.collection('identity_bindings').doc(principalId)),
    ]);
    const wechatBinding = wechatRes.data;
    const principalBinding = principalRes.data;

    const now = new Date();
    const boundAt = (wechatBinding && wechatBinding.boundAt)
      || (principalBinding && principalBinding.boundAt)
      || now;
    const shared = {
      role, account, subjectId, openidHash, status: 'active', boundAt, updatedAt: now,
    };

    await Promise.all([
      db.collection('identity_bindings').doc(wechatId).set({
        data: { type: 'wechat', ...shared, lastLoginAt: now },
      }),
      db.collection('identity_bindings').doc(principalId).set({
        data: { type: 'principal', ...shared, lastLoginAt: now },
      }),
      db.collection(config.accountCollection).doc(account).update({
        data: {
          boundOpenidHash: openidHash,
          bindingStatus: 'active',
          boundAt,
          lastLoginAt: now,
          updatedAt: now,
        },
      }),
      (async () => {
        const legacyData = {
          type: 'account', account, [config.legacySubjectKey]: subjectId,
          openid, boundAt, lastLoginAt: now,
        };
        await db.collection(config.legacyCollection).doc(legacyAccountId).set({
          data: legacyData,
        });
        await db.collection(config.legacyCollection).doc(legacyWechatId).set({
          data: { ...legacyData, type: 'wechat' },
        });
      })(),
    ]);

    return { code: 0, openidHash };
  } catch (error) {
    console.error('身份记录更新失败', error);
    return { code: 12, msg: '账号登录失败，请稍后重试' };
  }
}

async function activatePendingEnterpriseForTest(account, companyAccount) {
  const now = new Date();
  const companyId = companyAccount.companyId;
  const identityIndexId = companyAccount.creditCode
    ? `credit-${sha256(companyAccount.creditCode)}`
    : '';

  try {
    await runTxWithRetry(async (transaction) => {
      const [accountRes, companyRes, identityRes] = await Promise.all([
        getOptionalDocument(transaction.collection('company_accounts').doc(account)),
        getOptionalDocument(transaction.collection('companies').doc(companyId)),
        identityIndexId
          ? getOptionalDocument(
            transaction.collection('enterprise_identity_index').doc(identityIndexId),
          )
          : Promise.resolve({ data: null }),
      ]);
      const latestAccount = accountRes.data;
      if (!latestAccount) throw new Error('ENTERPRISE_ACCOUNT_NOT_FOUND');
      if (!['pending', 'active'].includes(latestAccount.status)) {
        throw new Error('ENTERPRISE_ACCOUNT_DISABLED');
      }

      const approvalData = {
        status: 'active',
        auditStatus: 'auto_approved_test',
        reviewMethod: 'test_auto_approve',
        reviewedAt: now,
        updatedAt: now,
      };
      await transaction.collection('company_accounts').doc(account).update({
        data: approvalData,
      });
      if (companyRes.data) {
        await transaction.collection('companies').doc(companyId).update({
          data: approvalData,
        });
      } else {
        await transaction.collection('companies').doc(companyId).set({
          data: {
            companyName: companyAccount.companyName || '',
            contact: companyAccount.contact || '',
            contactPhone: companyAccount.contactPhone || '',
            creditCode: companyAccount.creditCode || '',
            ...approvalData,
            createdAt: now,
          },
        });
      }
      if (identityIndexId) {
        if (identityRes.data) {
          await transaction.collection('enterprise_identity_index').doc(identityIndexId).update({
            data: approvalData,
          });
        } else {
          await transaction.collection('enterprise_identity_index').doc(identityIndexId).set({
            data: {
              companyId,
              account,
              ...approvalData,
              createdAt: now,
            },
          });
        }
      }
    });

    return { code: 0 };
  } catch (error) {
    const message = String(error && error.message);
    if (message.includes('ENTERPRISE_ACCOUNT_DISABLED')) {
      return { code: 9, msg: '企业账号当前不可用，请联系管理员' };
    }
    console.error('体验版企业账号自动开通失败', error);
    return { code: 13, msg: '企业账号开通失败，请稍后重试' };
  }
}

function loginAttemptKeys(role, account, openid) {
  const openidHash = sha256(openid);
  return [
    {
      id: `account-${sha256(`${role}|${account}|${openidHash}`)}`,
      maxAttempts: MAX_ACCOUNT_ATTEMPTS,
    },
    {
      id: `wechat-${openidHash}`,
      maxAttempts: MAX_WECHAT_ATTEMPTS,
    },
  ];
}

async function getBlockedAttempt(keys) {
  const rows = await Promise.all(keys.map(({ id }) => (
    getOptionalDocument(db.collection('login_attempts').doc(id))
  )));
  return rows.map((row) => row.data || {}).find(
    (attempt) => dateValue(attempt.blockedUntil) > Date.now(),
  ) || null;
}

async function recordFailure(keys) {
  await runTxWithRetry(async (transaction) => {
    const rows = await Promise.all(keys.map(({ id }) => (
      getOptionalDocument(transaction.collection('login_attempts').doc(id))
    )));
    const now = new Date();
    for (let index = 0; index < keys.length; index += 1) {
      const { id, maxAttempts } = keys[index];
      const previous = rows[index].data || {};
      if (dateValue(previous.blockedUntil) > now.getTime()) continue;
      const sameWindow = now.getTime() - dateValue(previous.windowStartedAt) < ATTEMPT_WINDOW_MS;
      const attempts = (sameWindow ? Number(previous.attempts) || 0 : 0) + 1;
      const blockedUntil = attempts >= maxAttempts
        ? new Date(now.getTime() + ATTEMPT_WINDOW_MS)
        : null;
      await transaction.collection('login_attempts').doc(id).set({
        data: {
          attempts: blockedUntil ? 0 : attempts,
          blockedUntil,
          windowStartedAt: sameWindow && previous.windowStartedAt
            ? previous.windowStartedAt : now,
          lastAttemptAt: now,
        },
      });
    }
  });
}

async function createSessionWithAttemptReset(collectionName, tokenHash, sessionData, keys) {
  await runTxWithRetry(async (transaction) => {
    await transaction.collection(collectionName).doc(tokenHash).set({ data: sessionData });
    const now = new Date();
    for (const { id } of keys) {
      await transaction.collection('login_attempts').doc(id).set({
        data: {
          attempts: 0,
          blockedUntil: null,
          windowStartedAt: now,
          lastAttemptAt: now,
        },
      });
    }
  });
}

exports.main = async (event) => {
  try {
    const { OPENID } = cloud.getWXContext();
  const role = (event && event.role) === 'enterprise' ? 'enterprise' : 'student';
  const rawAccount = String((event && event.account) || '').trim();
  const account = role === 'enterprise' ? rawAccount.toUpperCase() : rawAccount;
  const password = String((event && event.password) || '');

  if (!OPENID) return { code: 1, msg: '无法识别当前微信用户' };
  if (!account || !password) return { code: 2, msg: role === 'enterprise' ? '请输入企业账号和密码' : '请输入校园账号和密码' };

  // 同时限制“当前微信尝试当前账号”和“当前微信尝试所有账号”。这样既避免
  // 他人仅凭账号名远程锁死真实用户，也限制同一微信轮换账号进行密码喷洒。
  const attemptKeys = loginAttemptKeys(role, account, OPENID);
  const blockedAttempt = await getBlockedAttempt(attemptKeys);
  if (blockedAttempt) {
    return { code: 429, msg: '当前微信尝试次数过多，请十分钟后再试' };
  }

  if (role === 'enterprise') {
    const companyAccount = await getCompanyAccount(account);
    const candidateHash = derivePasswordHash(companyAccount, password);
    if (!companyAccount || !safeEqual(candidateHash, companyAccount.passwordHash)) {
      await recordFailure(attemptKeys).catch((error) => {
        console.error('记录企业登录失败次数异常', error);
      });
      return { code: 3, msg: '企业账号或密码不正确' };
    }

    const enterpriseBinding = await ensureIdentityBinding({
      role: 'enterprise',
      account,
      subjectId: companyAccount.companyId,
      openid: OPENID,
      accountData: companyAccount,
    });
    if (enterpriseBinding.code !== 0) return enterpriseBinding;

    if (companyAccount.status === 'pending' && ENTERPRISE_TEST_AUTO_APPROVE) {
      // 内部体验版：当前微信凭正确密码登录后，即可自动开通待审核企业（账号密码为主模型，不限制登录微信）。
      const approvalResult = await activatePendingEnterpriseForTest(account, companyAccount);
      if (approvalResult.code !== 0) return approvalResult;
      companyAccount.status = 'active';
      companyAccount.auditStatus = 'auto_approved_test';
    } else if (companyAccount.status === 'pending') {
      return { code: 8, msg: '企业资料正在审核，审核通过后即可登录' };
    }
    if (companyAccount.status !== 'active') {
      return { code: 9, msg: '企业账号当前不可用，请联系管理员' };
    }

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = sha256(rawToken);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000);
    await createSessionWithAttemptReset(
      'enterprise_sessions',
      tokenHash,
      {
        account,
        companyId: companyAccount.companyId,
        companyName: companyAccount.companyName,
        contact: companyAccount.contact || '',
        role: 'enterprise',
        openid: OPENID,
        passwordVersion: Number(companyAccount.passwordVersion) || 1,
        createdAt: now,
        expiresAt,
      },
      attemptKeys,
    );

    return {
      code: 0,
      role: 'enterprise',
      company: {
        companyId: companyAccount.companyId,
        companyName: companyAccount.companyName,
        contact: companyAccount.contact || '',
        account,
      },
      enterpriseSessionToken: rawToken,
      expiresAt,
    };
  }

  const campusAccount = await getCampusAccount(account);
  const candidateHash = derivePasswordHash(campusAccount, password);
  if (!campusAccount || !safeEqual(candidateHash, campusAccount.passwordHash)) {
    await recordFailure(attemptKeys).catch((error) => {
      console.error('记录学生登录失败次数异常', error);
    });
    return { code: 3, msg: '账号或密码不正确' };
  }
  if (campusAccount.status && campusAccount.status !== 'active') {
    return { code: 9, msg: '该学生账号当前不可用，请联系管理员' };
  }

  const userRes = await getOptionalDocument(
    db.collection('users').doc(campusAccount.uid),
  );
  if (!userRes.data) return { code: 4, msg: '该账号档案尚未初始化' };

  const bindingResult = await ensureIdentityBinding({
    role: 'student',
    account,
    subjectId: campusAccount.uid,
    openid: OPENID,
    accountData: campusAccount,
  });
  if (bindingResult.code !== 0) return bindingResult;

  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = sha256(rawToken);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await createSessionWithAttemptReset(
    'sessions',
    tokenHash,
    {
      uid: campusAccount.uid,
      account,
      openid: OPENID,
      passwordVersion: Number(campusAccount.passwordVersion) || 1,
      mustChangePassword: Boolean(campusAccount.mustChangePassword),
      createdAt: now,
      expiresAt,
    },
    attemptKeys,
  );

  const { openid, ...publicUser } = userRes.data;
  return {
    code: 0,
    role: 'student',
    user: { _id: campusAccount.uid, ...publicUser },
    sessionToken: rawToken,
    expiresAt,
    mustChangePassword: Boolean(campusAccount.mustChangePassword),
  };
  } catch (error) {
    console.error('登录处理异常', error);
    return { code: 99, msg: '登录失败，请稍后重试' };
  }
};
