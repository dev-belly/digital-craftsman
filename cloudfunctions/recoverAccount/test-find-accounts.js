const assert = require('assert');
const Module = require('module');

const originalLoad = Module._load;

function createDocument(data) {
  return {
    async get() {
      if (data === undefined) throw new Error('document does not exist');
      return { data };
    },
  };
}

const currentOpenid = 'openid-current-wechat';
const crypto = require('crypto');
const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const currentHash = hash(currentOpenid);
const studentAccount = 'STU10001';
const enterpriseAccount = 'HR_TECH001';

const documents = {
  campus_accounts: {
    [studentAccount]: {
      account: studentAccount,
      uid: 'student-1',
      boundOpenidHash: currentHash,
      bindingStatus: 'active',
      status: 'active',
    },
  },
  company_accounts: {
    [enterpriseAccount]: {
      account: enterpriseAccount,
      companyId: 'company-1',
      companyName: '测试科技',
      boundOpenidHash: currentHash,
      bindingStatus: 'active',
      status: 'active',
    },
    LEAKED_COMPANY: {
      account: 'LEAKED_COMPANY',
      companyId: 'company-other',
      companyName: '不应泄露的企业',
      boundOpenidHash: hash('other-wechat'),
      bindingStatus: 'active',
      status: 'active',
    },
  },
  users: {
    'student-1': { name: '测试学生' },
  },
};

const bindings = [
  {
    _id: `principal-student-${hash(studentAccount)}`,
    type: 'principal', role: 'student', account: studentAccount,
    subjectId: 'student-1', openidHash: currentHash, status: 'active',
  },
  {
    _id: `principal-enterprise-${hash(enterpriseAccount)}`,
    type: 'principal', role: 'enterprise', account: enterpriseAccount,
    subjectId: 'company-1', openidHash: currentHash, status: 'active',
  },
  {
    _id: `principal-enterprise-${hash('LEAKED_COMPANY')}`,
    type: 'principal', role: 'enterprise', account: 'LEAKED_COMPANY',
    // 即使损坏的 principal 错写成当前微信，也必须被账号侧 boundOpenidHash 拦下。
    subjectId: 'company-other', openidHash: currentHash, status: 'active',
  },
];

function collection(name) {
  return {
    doc(id) {
      return createDocument(documents[name] && documents[name][id]);
    },
    where(query) {
      return {
        limit(limit) {
          return {
            async get() {
              const data = bindings.filter((binding) => Object.entries(query).every(
                ([key, value]) => binding[key] === value,
              )).slice(0, limit);
              return { data };
            },
          };
        },
      };
    },
  };
}

Module._load = function mockLoad(request, parent, isMain) {
  if (request === 'wx-server-sdk') {
    return {
      DYNAMIC_CURRENT_ENV: 'test',
      init() {},
      getWXContext() { return { OPENID: currentOpenid }; },
      database() { return { collection }; },
    };
  }
  return originalLoad(request, parent, isMain);
};

const recoverAccount = require('./index.js');

(async () => {
  const student = await recoverAccount.main({ action: 'findAccounts', role: 'student' });
  assert.deepStrictEqual(student, {
    code: 0,
    role: 'student',
    accounts: [{ account: studentAccount, displayName: '测试学生' }],
  });

  const enterprise = await recoverAccount.main({ action: 'findAccounts', role: 'enterprise' });
  assert.deepStrictEqual(enterprise, {
    code: 0,
    role: 'enterprise',
    accounts: [{ account: enterpriseAccount, displayName: '测试科技' }],
  });
  assert(!enterprise.accounts.some(({ account }) => account === 'LEAKED_COMPANY'));

  console.log('findAccounts tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
