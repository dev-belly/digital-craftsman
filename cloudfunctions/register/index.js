// 云函数 register：学生/企业自主注册。所有账号、档案、绑定和会话只写入云数据库。
const cloud = require('wx-server-sdk');
const crypto = require('crypto');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const SESSION_DAYS = 7;
const PASSWORD_ITERATIONS = 120000;
const PRIVACY_VERSION = '2026-07';
// 内部体验阶段没有管理员审核后台，企业注册后直接开通。
// 正式对外运营前应改为 false，并接入真实的企业资质审核流程。
const ENTERPRISE_TEST_AUTO_APPROVE = true;
const STUDENT_RESERVED_ACCOUNTS = new Set(['20240001', '20240002', '20240003']);
const ENTERPRISE_RESERVED_ACCOUNTS = new Set(['COM1001', 'COM1002', 'COM1003']);
const STAGES = ['学习', '认证', '作品', '企业好评', '人才'];

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

function isDocumentNotFound(error) {
  const message = [
    error && error.code,
    error && error.errCode,
    error && error.errMsg,
    error && error.message,
    error,
  ].filter(Boolean).join(' ');
  return /-502004|document[^\n]*(?:does not exist|not exist|not found)|文档不存在/i.test(message);
}

async function getOptionalDocument(documentReference) {
  try {
    return await documentReference.get();
  } catch (error) {
    if (isDocumentNotFound(error)) return { data: null };
    throw error;
  }
}

function passwordHash(password, salt) {
  return crypto.pbkdf2Sync(
    String(password),
    String(salt),
    PASSWORD_ITERATIONS,
    32,
    'sha256',
  ).toString('hex');
}

function cleanText(value, maxLength) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function normalizeAccount(value, role) {
  const account = String(value || '').trim();
  return role === 'enterprise' ? account.toUpperCase() : account;
}

function validatePassword(password) {
  if (password.length < 8 || password.length > 32) return '密码长度应为 8—32 位';
  if (/\s/.test(password)) return '密码不能包含空格';
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    return '密码必须同时包含字母和数字';
  }
  return '';
}

function validateCommon(event, role, account, password) {
  if (!event || event.agreementAccepted !== true) return '请先阅读并同意用户协议与隐私政策';
  if (!/^[0-9A-Za-z_-]{6,20}$/.test(account)) return '账号须为 6—20 位字母、数字、下划线或短横线';
  return validatePassword(password);
}

function mapTransactionError(error) {
  const message = errorText(error);
  if (message.includes('ACCOUNT_EXISTS')) {
    return { code: 409, reason: 'account_exists', msg: '该账号已经注册，请直接登录' };
  }
  if (message.includes('REGISTRATION_REPAIR_REQUIRED')) {
    return {
      code: 409,
      reason: 'registration_repair_required',
      msg: '该账号已有注册记录，但云端资料不完整，请联系管理员处理',
    };
  }
  if (message.includes('ENTERPRISE_IDENTITY_EXISTS')) {
    return {
      code: 409,
      reason: 'enterprise_identity_exists',
      msg: '该企业资质信息已经提交过注册，请使用原企业账号登录',
    };
  }
  if (isRetryableTransactionError(error)) {
    return {
      code: 503,
      reason: 'transaction_busy',
      msg: '当前注册人数较多，云端处理繁忙，请稍后重试',
    };
  }
  if (/-502005|collection[^\n]*(?:does not exist|not exist|not found)|集合不存在/i.test(message)) {
    return {
      code: 503,
      reason: 'database_not_initialized',
      msg: '注册数据库尚未完成初始化，请联系管理员',
    };
  }
  if (/permission|not authorized|unauthorized|权限/i.test(message)) {
    return {
      code: 503,
      reason: 'database_permission_error',
      msg: '注册服务权限配置异常，请联系管理员',
    };
  }
  if (/timeout|deadline|timed out|超时/i.test(message)) {
    return {
      code: 504,
      reason: 'registration_timeout',
      msg: '注册处理超时，账号可能已保存，请用刚才的账号和密码重试一次',
    };
  }
  const errorId = crypto.randomBytes(4).toString('hex');
  console.error(`注册事务失败 [${errorId}]`, error);
  return {
    code: 99,
    reason: 'registration_storage_error',
    errorId,
    msg: `注册资料未能安全写入云端，请稍后重试（错误编号 ${errorId}）`,
  };
}

function deriveStoredPasswordHash(accountData, password) {
  if (!accountData) return '';
  if (accountData.passwordAlgorithm === 'pbkdf2-sha256') {
    const iterations = Number(accountData.passwordIterations);
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
  return sha256(`${accountData.salt}:${password}`);
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function registerStudent({ OPENID, account, password, name, school, major }) {
  if (STUDENT_RESERVED_ACCOUNTS.has(account)) {
    return { code: 409, msg: '该账号为系统预留账号，请更换一个账号' };
  }
  if (!name || name.length < 2) return { code: 2, msg: '请填写真实姓名' };
  if (!school) return { code: 2, msg: '请填写学校名称' };
  if (!major) return { code: 2, msg: '请填写专业名称' };

  const now = new Date();
  const uid = `stu-${crypto.randomBytes(12).toString('hex')}`;
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = passwordHash(password, salt);
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = sha256(rawToken);
  const expiresAt = new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  const accountBindingId = `account-${account}`;
  const openidBindingId = `openid-${sha256(OPENID)}`;
  const openidHash = sha256(OPENID);
  const identityWechatId = `wechat-${openidHash}-${account}`;
  const identityPrincipalId = `principal-student-${sha256(account)}`;

  const accountData = {
    account,
    uid,
    salt,
    passwordHash: hash,
    passwordAlgorithm: 'pbkdf2-sha256',
    passwordIterations: PASSWORD_ITERATIONS,
    passwordVersion: 1,
    boundOpenidHash: openidHash,
    mustChangePassword: false,
    status: 'active',
    registrationSource: 'mini_program',
    createdAt: now,
    updatedAt: now,
  };
  const userData = {
    name,
    school,
    major,
    avatar: '',
    skillTags: [],
    talentIndex: 0,
    talentPoolVisible: false,
    profilePublic: true,
    openid: OPENID,
    isDemo: false,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await runTxWithRetry(async (transaction) => {
      const [
        existingAccount,
        existingAccountBinding,
        existingIdentityPrincipal,
      ] = await Promise.all([
        getOptionalDocument(transaction.collection('campus_accounts').doc(account)),
        getOptionalDocument(transaction.collection('account_bindings').doc(accountBindingId)),
        getOptionalDocument(transaction.collection('identity_bindings').doc(identityPrincipalId)),
      ]);
      if (existingAccount.data || existingAccountBinding.data || existingIdentityPrincipal.data) {
        throw new Error('ACCOUNT_EXISTS');
      }

      await transaction.collection('campus_accounts').doc(account).set({ data: accountData });
      await transaction.collection('users').doc(uid).set({ data: userData });
      await transaction.collection('account_bindings').doc(accountBindingId).set({
        data: {
          type: 'account', account, uid, openid: OPENID, boundAt: now, lastLoginAt: now,
        },
      });
      await transaction.collection('account_bindings').doc(openidBindingId).set({
        data: {
          type: 'wechat', account, uid, openid: OPENID, boundAt: now, lastLoginAt: now,
        },
      });
      await transaction.collection('identity_bindings').doc(identityWechatId).set({
        data: {
          type: 'wechat', role: 'student', account, subjectId: uid,
          openidHash, status: 'active', boundAt: now, updatedAt: now,
        },
      });
      await transaction.collection('identity_bindings').doc(identityPrincipalId).set({
        data: {
          type: 'principal', role: 'student', account, subjectId: uid,
          openidHash, status: 'active', boundAt: now, updatedAt: now,
        },
      });
      await transaction.collection('sessions').doc(tokenHash).set({
        data: {
          uid,
          account,
          openid: OPENID,
          passwordVersion: 1,
          mustChangePassword: false,
          createdAt: now,
          expiresAt,
        },
      });
    });
  } catch (error) {
    return mapTransactionError(error);
  }

  // 事务外初始化档案辅助数据（非核心，失败不影响账号创建，降低事务体积避免 TransactionBusy）
  try {
    await db.collection('qrcodes').doc(`${uid}-code`).set({
      data: { uid, sceneStr: uid, scanCount: 0, createdAt: now },
    }).catch(() => {});
    for (let index = 0; index < STAGES.length; index += 1) {
      await db.collection('stages').doc(`${uid}-stage-${index + 1}`).set({
        data: {
          uid,
          stage: STAGES[index],
          status: index === 0 ? 'doing' : 'pending',
          startedAt: index === 0 ? now : null,
          completedAt: null,
          createdAt: now,
        },
      }).catch(() => {});
    }
    await db.collection('user_consents').doc(`student-${uid}`).set({
      data: {
        role: 'student', account, uid, openidHash,
        privacyVersion: PRIVACY_VERSION, agreementVersion: PRIVACY_VERSION,
        acceptedAt: now,
      },
    }).catch(() => {});
  } catch (warn) {
    console.warn('初始化档案辅助数据失败', warn);
  }

  return {
    code: 0,
    role: 'student',
    account,
    user: {
      _id: uid,
      name,
      school,
      major,
      avatar: '',
      skillTags: [],
      talentIndex: 0,
      talentPoolVisible: false,
      profilePublic: true,
      isDemo: false,
    },
    sessionToken: rawToken,
    expiresAt,
    msg: '注册成功',
  };
}

async function registerEnterprise({
  OPENID, account, password, companyName, contact, contactPhone, creditCode,
}) {
  if (ENTERPRISE_RESERVED_ACCOUNTS.has(account)) {
    return { code: 409, msg: '该账号为系统预留账号，请更换一个账号' };
  }
  if (companyName.length < 2) return { code: 2, msg: '请填写完整的企业名称' };
  if (!contact) return { code: 2, msg: '请填写联系人姓名' };
  if (!/^1\d{10}$/.test(contactPhone)) return { code: 2, msg: '请填写正确的 11 位联系人手机号' };
  if (creditCode && !/^[0-9A-Z]{18}$/.test(creditCode)) {
    return { code: 2, msg: '统一社会信用代码应为 18 位数字或大写字母' };
  }

  const now = new Date();
  const companyId = `company-${crypto.randomBytes(12).toString('hex')}`;
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = passwordHash(password, salt);
  const accountBindingId = `account-${account}`;
  const openidBindingId = `openid-${sha256(OPENID)}`;
  const openidHash = sha256(OPENID);
  const identityWechatId = `wechat-${openidHash}-${account}`;
  const identityPrincipalId = `principal-enterprise-${sha256(account)}`;
  const identityIndexId = creditCode ? `credit-${sha256(creditCode)}` : '';
  const status = ENTERPRISE_TEST_AUTO_APPROVE ? 'active' : 'pending';
  const auditStatus = ENTERPRISE_TEST_AUTO_APPROVE ? 'auto_approved_test' : 'pending';

  const accountData = {
    account,
    companyId,
    companyName,
    contact,
    contactPhone,
    creditCode,
    salt,
    passwordHash: hash,
    passwordAlgorithm: 'pbkdf2-sha256',
    passwordIterations: PASSWORD_ITERATIONS,
    passwordVersion: 1,
    boundOpenidHash: openidHash,
    bindingStatus: 'active',
    status,
    auditStatus,
    reviewMethod: ENTERPRISE_TEST_AUTO_APPROVE ? 'test_auto_approve' : '',
    reviewedAt: ENTERPRISE_TEST_AUTO_APPROVE ? now : null,
    registrationSource: 'mini_program',
    createdAt: now,
    updatedAt: now,
  };
  const companyData = {
    companyName,
    contact,
    contactPhone,
    creditCode,
    status,
    auditStatus,
    reviewMethod: ENTERPRISE_TEST_AUTO_APPROVE ? 'test_auto_approve' : '',
    reviewedAt: ENTERPRISE_TEST_AUTO_APPROVE ? now : null,
    createdAt: now,
    updatedAt: now,
  };

  let registrationResult;
  try {
    registrationResult = await runTxWithRetry(async (transaction) => {
      const [
        existingAccount,
        existingIdentity,
      ] = await Promise.all([
        getOptionalDocument(transaction.collection('company_accounts').doc(account)),
        identityIndexId
          ? getOptionalDocument(
            transaction.collection('enterprise_identity_index').doc(identityIndexId),
          )
          : Promise.resolve({ data: null }),
      ]);

      // 幂等：账号已存在。只要密码对、状态可用且企业资料完整，就视为重复提交并返回成功。
      // 同一微信可注册/登录多个账号，因此不再校验 boundOpenidHash 是否等于当前微信。
      if (existingAccount.data) {
        const storedAccount = existingAccount.data;
        const storedCompanyId = String(storedAccount.companyId || '');
        const derivedHash = deriveStoredPasswordHash(storedAccount, password);
        const passwordMatches = Boolean(derivedHash && storedAccount.passwordHash)
          && safeEqual(derivedHash, storedAccount.passwordHash);
        if (!passwordMatches) throw new Error('ACCOUNT_EXISTS');
        if (!storedCompanyId || !['active', 'pending'].includes(storedAccount.status)) {
          throw new Error('REGISTRATION_REPAIR_REQUIRED');
        }
        const existingCompany = await getOptionalDocument(
          transaction.collection('companies').doc(storedCompanyId),
        );
        if (!existingCompany.data || !['active', 'pending'].includes(existingCompany.data.status)) {
          throw new Error('REGISTRATION_REPAIR_REQUIRED');
        }
        return {
          idempotent: true,
          companyId: storedCompanyId,
          status: storedAccount.status,
        };
      }

      if (existingIdentity.data) throw new Error('ENTERPRISE_IDENTITY_EXISTS');

      await transaction.collection('company_accounts').doc(account).set({ data: accountData });
      await transaction.collection('companies').doc(companyId).set({ data: companyData });
      await transaction.collection('identity_bindings').doc(identityWechatId).set({
        data: {
          type: 'wechat', role: 'enterprise', account, subjectId: companyId,
          openidHash, status: 'active', boundAt: now, updatedAt: now,
        },
      });
      await transaction.collection('identity_bindings').doc(identityPrincipalId).set({
        data: {
          type: 'principal', role: 'enterprise', account, subjectId: companyId,
          openidHash, status: 'active', boundAt: now, updatedAt: now,
        },
      });
      return { idempotent: false, companyId, status };
    });
  } catch (error) {
    return mapTransactionError(error);
  }

  const savedCompanyId = registrationResult && registrationResult.companyId
    ? registrationResult.companyId
    : companyId;
  const savedStatus = registrationResult && registrationResult.status
    ? registrationResult.status
    : status;

  // 非核心索引与旧版兼容集合移出事务，降低事务体积，避免 TransactionBusy。
  try {
    await Promise.all([
      db.collection('user_consents').doc(`enterprise-${savedCompanyId}`).set({
        data: {
          role: 'enterprise', account, companyId: savedCompanyId, openidHash,
          privacyVersion: PRIVACY_VERSION, agreementVersion: PRIVACY_VERSION,
          acceptedAt: now,
        },
      }),
      identityIndexId
        ? db.collection('enterprise_identity_index').doc(identityIndexId).set({
          data: {
            companyId: savedCompanyId,
            account,
            openidHash,
            status: savedStatus,
            auditStatus,
            createdAt: now,
            updatedAt: now,
          },
        })
        : Promise.resolve(),
      db.collection('enterprise_bindings').doc(accountBindingId).set({
        data: {
          type: 'account', account, companyId: savedCompanyId,
          openid: OPENID, boundAt: now, lastLoginAt: null,
        },
      }),
      db.collection('enterprise_bindings').doc(openidBindingId).set({
        data: {
          type: 'wechat', account, companyId: savedCompanyId,
          openid: OPENID, boundAt: now, lastLoginAt: null,
        },
      }),
    ]);
  } catch (warn) {
    console.warn('企业辅助索引写入失败，核心注册已完成', warn);
  }

  return {
    code: 0,
    role: 'enterprise',
    account,
    companyId: savedCompanyId,
    status: savedStatus,
    idempotent: Boolean(registrationResult && registrationResult.idempotent),
    pendingReview: savedStatus === 'pending',
    msg: registrationResult && registrationResult.idempotent
      ? '账号此前已保存到云端，现在可以直接登录'
      : (ENTERPRISE_TEST_AUTO_APPROVE
        ? '企业账号注册成功，资料已保存到云端，现在可以直接登录'
        : '企业注册资料已保存到云端，审核通过后即可登录'),
  };
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const role = event && event.role === 'enterprise' ? 'enterprise' : 'student';
  const account = normalizeAccount(event && event.account, role);
  const password = String((event && event.password) || '');

  if (!OPENID) return { code: 1, msg: '无法识别当前微信用户' };
  const commonError = validateCommon(event, role, account, password);
  if (commonError) return { code: 2, msg: commonError };

  if (role === 'enterprise') {
    return registerEnterprise({
      OPENID,
      account,
      password,
      companyName: cleanText(event.companyName, 80),
      contact: cleanText(event.contact, 30),
      contactPhone: cleanText(event.contactPhone, 20),
      creditCode: cleanText(event.creditCode, 18).toUpperCase(),
    });
  }

  return registerStudent({
    OPENID,
    account,
    password,
    name: cleanText(event.name, 30),
    school: cleanText(event.school, 80),
    major: cleanText(event.major, 80),
  });
};
