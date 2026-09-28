const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Module = require('node:module');

const openid = 'mock-enterprise-openid';
const token = 'mock-enterprise-session';
const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
const users = [
  { _id: 'stu-hidden', name: '隐藏学生', isDemo: false, talentPoolVisible: false },
  { _id: 'stu-visible', name: '可见学生', isDemo: false, talentPoolVisible: true },
  { _id: 'demo-legacy', name: '旧演示', isDemo: true },
  { _id: 'demo-hidden', name: '退出演示', isDemo: true, talentPoolVisible: false },
];

function query(name, filter = {}) {
  return {
    skip() { return this; },
    limit() { return this; },
    async get() {
      if (name === 'users') {
        return { data: users.filter((user) => Object.entries(filter)
          .every(([key, value]) => user[key] === value)) };
      }
      return { data: [] };
    },
  };
}

const db = {
  command: {},
  collection(name) {
    return {
      doc(id) {
        return {
          async get() {
            const data = name === 'enterprise_sessions' && id === tokenHash
              ? {
                openid, role: 'enterprise', account: 'MOCK-COMPANY', companyId: 'company-one',
                passwordVersion: 1, expiresAt: Date.now() + 60_000,
              }
              : name === 'company_accounts' && id === 'MOCK-COMPANY'
                ? { companyId: 'company-one', status: 'active', passwordVersion: 1 }
                : null;
            return { data };
          },
        };
      },
      where(filter) { return query(name, filter); },
      skip() { return query(name); },
    };
  },
};

const originalLoad = Module._load;
Module._load = function mockCloudSdk(request, parent, isMain) {
  if (request === 'wx-server-sdk') {
    return {
      DYNAMIC_CURRENT_ENV: 'test', init() {}, database: () => db,
      getWXContext: () => ({ OPENID: openid }),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
let listTalents;
try {
  listTalents = require('./index.js');
} finally {
  Module._load = originalLoad;
}

async function run() {
  const normal = await listTalents.main({ enterpriseSessionToken: token });
  assert.equal(normal.code, 0);
  assert.deepEqual(normal.talents.map((row) => row._id).sort(), ['demo-legacy', 'stu-visible']);

  const demoOnly = await listTalents.main({ enterpriseSessionToken: token, demoOnly: true });
  assert.equal(demoOnly.code, 0);
  assert.deepEqual(demoOnly.talents.map((row) => row._id), ['demo-legacy']);

  const anonymous = await listTalents.main({ enterpriseSessionToken: '' });
  assert.equal(anonymous.code, 401);
  console.log('listTalents visibility tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
