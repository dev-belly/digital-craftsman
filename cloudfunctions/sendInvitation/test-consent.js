// Local cloud SDK stub: no account, database, or WeChat service is contacted.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Module = require('node:module');

const openid = 'mock-enterprise-openid';
const token = 'mock-enterprise-session';
const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
const users = {
  'stu-hidden': { name: '隐藏学生', talentPoolVisible: false, isDemo: false },
  'stu-visible': { name: '公开学生', talentPoolVisible: true, isDemo: false },
};
const invitations = [];
let failInvitationQuery = false;

const documents = {
  enterprise_sessions: {
    [tokenHash]: {
      openid, role: 'enterprise', account: 'MOCK-COMPANY', companyId: 'company-one',
      companyName: '模拟企业', passwordVersion: 1, expiresAt: Date.now() + 60_000,
    },
  },
  company_accounts: {
    'MOCK-COMPANY': { companyId: 'company-one', status: 'active', passwordVersion: 1 },
  },
  users,
};

const db = {
  command: { in: (values) => ({ oneOf: values }) },
  collection(name) {
    return {
      doc(id) {
        return {
          async get() {
            return { data: documents[name] && documents[name][id] || null };
          },
        };
      },
      where(query) {
        assert.equal(name, 'invitations');
        return {
          limit() {
            return {
              async get() {
                if (failInvitationQuery) throw new Error('permission denied');
                return {
                  data: invitations.filter((item) => item.companyId === query.companyId
                    && item.uid === query.uid && item.type === query.type
                    && query.status.oneOf.includes(item.status)),
                };
              },
            };
          },
        };
      },
      async add({ data }) {
        assert.equal(name, 'invitations');
        const id = `invitation-${invitations.length + 1}`;
        invitations.push({ ...data, _id: id });
        return { _id: id };
      },
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
let sendInvitation;
try {
  sendInvitation = require('./index.js');
} finally {
  Module._load = originalLoad;
}

async function run() {
  const event = (uid, extra = {}) => ({
    enterpriseSessionToken: token, uid, type: '面试', message: '模拟邀约', ...extra,
  });

  const unauthenticated = await sendInvitation.main(event('stu-visible', {
    enterpriseSessionToken: '',
  }));
  assert.equal(unauthenticated.code, 401);
  assert.equal(invitations.length, 0);

  const hidden = await sendInvitation.main(event('stu-hidden'));
  assert.equal(hidden.code, 403);
  assert.equal(invitations.length, 0);

  const visible = await sendInvitation.main(event('stu-visible'));
  assert.equal(visible.code, 0);
  assert.equal(invitations.length, 1);
  const duplicate = await sendInvitation.main(event('stu-visible'));
  assert.equal(duplicate.duplicated, true);
  assert.equal(invitations.length, 1);

  failInvitationQuery = true;
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const failedLookup = await sendInvitation.main(event('stu-visible', { type: '实习' }));
    assert.equal(failedLookup.code, 99);
    assert.equal(invitations.length, 1);
  } finally {
    console.error = originalConsoleError;
  }
  console.log('sendInvitation consent and lookup tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
