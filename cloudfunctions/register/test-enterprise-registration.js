/* eslint-disable no-console */
// 本地最小回归测试：不连接微信云、不创建真实账号。
const assert = require('assert').strict;
const Module = require('module');

const COLLECTIONS = [
  'company_accounts',
  'companies',
  'enterprise_bindings',
  'enterprise_identity_index',
  'identity_bindings',
  'account_bindings',
  'user_consents',
];

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function createHarness() {
  let store = {};
  let currentOpenid = 'openid-enterprise-one';
  let transactionAttempts = 0;
  const missingCollections = new Set();
  const permissionCollections = new Set();
  const failSetCollections = new Set();
  let busyFailures = 0;

  function reset() {
    store = Object.fromEntries(COLLECTIONS.map((name) => [name, {}]));
    currentOpenid = 'openid-enterprise-one';
    transactionAttempts = 0;
    missingCollections.clear();
    permissionCollections.clear();
    failSetCollections.clear();
    busyFailures = 0;
  }

  function checkCollection(name) {
    if (missingCollections.has(name)) {
      const error = new Error(`collection ${name} does not exist`);
      error.errCode = -502005;
      throw error;
    }
    if (permissionCollections.has(name)) {
      const error = new Error(`permission denied for collection ${name}`);
      error.errCode = -502003;
      throw error;
    }
  }

  function documentReference(view, collectionName, id) {
    return {
      async get() {
        checkCollection(collectionName);
        if (!Object.prototype.hasOwnProperty.call(view[collectionName], id)) {
          const error = new Error(`document ${id} does not exist`);
          error.errCode = -502004;
          throw error;
        }
        return { data: clone(view[collectionName][id]) };
      },
      async set({ data }) {
        checkCollection(collectionName);
        if (failSetCollections.has(collectionName)) {
          throw new Error(`injected storage failure for ${collectionName}`);
        }
        view[collectionName][id] = clone(data);
        return { _id: id };
      },
    };
  }

  function collectionReference(view, collectionName) {
    return {
      doc(id) {
        return documentReference(view, collectionName, id);
      },
    };
  }

  const db = {
    collection(name) {
      return collectionReference(store, name);
    },
    async runTransaction(executor) {
      transactionAttempts += 1;
      if (busyFailures > 0) {
        busyFailures -= 1;
        const error = new Error('TransactionBusy: transaction conflict');
        error.errCode = -501001;
        throw error;
      }
      const draft = clone(store);
      const result = await executor({
        collection(name) {
          return collectionReference(draft, name);
        },
      });
      store = draft;
      return result;
    },
  };

  reset();
  return {
    cloud: {
      DYNAMIC_CURRENT_ENV: 'test',
      init() {},
      database() { return db; },
      getWXContext() { return { OPENID: currentOpenid }; },
    },
    reset,
    setOpenid(value) { currentOpenid = value; },
    setBusyFailures(value) { busyFailures = value; },
    missingCollections,
    permissionCollections,
    failSetCollections,
    get transactionAttempts() { return transactionAttempts; },
    get store() { return store; },
  };
}

function enterpriseEvent(account = 'TECHHR', overrides = {}) {
  return {
    role: 'enterprise',
    account,
    password: 'Secure1234',
    companyName: '测试科技有限公司',
    contact: '李明',
    contactPhone: '13800138000',
    creditCode: '',
    agreementAccepted: true,
    ...overrides,
  };
}

async function run() {
  const harness = createHarness();
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'wx-server-sdk') return harness.cloud;
    return originalLoad.call(this, request, parent, isMain);
  };
  const registerPath = require.resolve('./index');
  delete require.cache[registerPath];
  const register = require(registerPath);
  Module._load = originalLoad;

  // 1. 合法企业资料完整落库，全局微信/账号双向绑定同时建立。
  const first = await register.main(enterpriseEvent());
  assert.equal(first.code, 0);
  assert.equal(first.account, 'TECHHR');
  assert.equal(first.status, 'active');
  assert.equal(first.idempotent, false);
  assert.equal(harness.store.company_accounts.TECHHR.bindingStatus, 'active');
  const firstCompanyId = first.companyId;
  assert.equal(harness.store.companies[firstCompanyId].companyName, '测试科技有限公司');
  const principal = Object.values(harness.store.identity_bindings)
    .find((item) => item.type === 'principal' && item.account === 'TECHHR');
  const wechat = Object.values(harness.store.identity_bindings)
    .find((item) => item.type === 'wechat' && item.account === 'TECHHR');
  assert.equal(principal.subjectId, firstCompanyId);
  assert.equal(wechat.subjectId, firstCompanyId);

  // 2. 模拟“云端已提交但客户端未收到响应”：同微信、账号、密码重试应幂等成功。
  const retry = await register.main(enterpriseEvent());
  assert.equal(retry.code, 0);
  assert.equal(retry.idempotent, true);
  assert.equal(retry.companyId, firstCompanyId);
  assert.equal(Object.keys(harness.store.company_accounts).length, 1);

  // 3. 同一微信注册第二个账号会被明确阻止，而不是覆盖旧绑定或返回模糊 code 99。
  const sameWechatSecondAccount = await register.main(enterpriseEvent('TECHH2'));
  assert.equal(sameWechatSecondAccount.code, 409);
  assert.equal(sameWechatSecondAccount.reason, 'wechat_has_account');
  assert.equal(harness.store.company_accounts.TECHH2, undefined);

  // 4. 其他微信抢同一账号只收到“账号已存在”，不泄露密码或绑定详情。
  harness.setOpenid('openid-enterprise-two');
  const otherWechatSameAccount = await register.main(enterpriseEvent());
  assert.equal(otherWechatSameAccount.code, 409);
  assert.equal(otherWechatSameAccount.reason, 'account_exists');
  assert.equal(otherWechatSameAccount.passwordMatches, undefined);

  // 5. 缺集合、权限错误分别映射为可定位的服务错误，且事务不留下半条账号。
  harness.reset();
  harness.missingCollections.add('enterprise_identity_index');
  const missingCollection = await register.main(enterpriseEvent('CREDIT1', {
    creditCode: '123456789012345678',
  }));
  assert.equal(missingCollection.code, 503);
  assert.equal(missingCollection.reason, 'database_not_initialized');
  assert.equal(harness.store.company_accounts.CREDIT1, undefined);

  harness.reset();
  harness.permissionCollections.add('identity_bindings');
  const permissionFailure = await register.main(enterpriseEvent('PERMIS1'));
  assert.equal(permissionFailure.code, 503);
  assert.equal(permissionFailure.reason, 'database_permission_error');
  assert.equal(harness.store.company_accounts.PERMIS1, undefined);

  // 6. 短暂事务冲突会自动重试并最终成功。
  harness.reset();
  harness.setBusyFailures(1);
  const retriedBusy = await register.main(enterpriseEvent('BUSY001'));
  assert.equal(retriedBusy.code, 0);
  assert.equal(harness.transactionAttempts, 2);

  // 7. 连续冲突超过上限会返回明确的繁忙状态，且没有半成品。
  harness.reset();
  harness.setBusyFailures(4);
  const exhaustedBusy = await register.main(enterpriseEvent('BUSY002'));
  assert.equal(exhaustedBusy.code, 503);
  assert.equal(exhaustedBusy.reason, 'transaction_busy');
  assert.equal(harness.transactionAttempts, 4);
  assert.equal(harness.store.company_accounts.BUSY002, undefined);

  // 8. 旧兼容集合写入失败不再把已成功的核心注册误报为失败。
  harness.reset();
  harness.failSetCollections.add('enterprise_bindings');
  const originalWarn = console.warn;
  console.warn = () => {};
  let legacyWriteFailure;
  try {
    legacyWriteFailure = await register.main(enterpriseEvent('LEGACY1'));
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(legacyWriteFailure.code, 0);
  assert.ok(harness.store.company_accounts.LEGACY1);
  assert.equal(Object.keys(harness.store.enterprise_bindings).length, 0);

  console.log('register enterprise mock tests: 8/8 passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
