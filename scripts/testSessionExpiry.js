// Exercise deployed entry points with an offline SDK, including legacy date forms.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Module = require('node:module');
const path = require('node:path');

const functions = [
  'addWork', 'applyJob', 'changePassword', 'changeEnterprisePassword',
  'genWxaCode', 'getArchive', 'issueCertification', 'listTalents',
  'manageJobApplication', 'postJob', 'respondInvitation', 'sendInvitation',
  'submitEvaluation', 'updateProfile',
];
const now = Date.UTC(2026, 9, 24, 12);
const token = 'offline-session-token';
const uid = 'stu-expiry-test';
const accountId = 'MOCK-ACCOUNT';
const event = {
  uid, sessionToken: token, enterpriseSessionToken: token, privateView: true,
  name: 'Test Student', school: 'Test School', major: 'Data', skillTags: ['SQL'],
  talentPoolVisible: false, profilePublic: false,
  title: 'Test work', desc: 'Test description', content: 'Test evaluation',
  requestId: 'expiry-request-0001', certName: 'Test certificate', level: '初级',
  score: 80, jobId: 'job-expiry-test', applicationId: `application-${'a'.repeat(32)}`,
  invitationId: 'invitation-test', action: 'accepted',
};

function loadFunction(name, expiresAt) {
  let accountReads = 0;
  const session = {
    uid, openid: 'mock-openid', role: 'enterprise', account: accountId,
    companyId: 'mock-company', companyName: 'Mock company',
    passwordVersion: 1, expiresAt,
  };
  const account = { uid, companyId: session.companyId, status: 'active', passwordVersion: 1 };
  const db = {
    command: { in: (values) => values },
    collection(collection) {
      return {
        doc(id) {
          return {
            async get() {
              if (['sessions', 'enterprise_sessions'].includes(collection)) {
                assert.equal(id, crypto.createHash('sha256').update(token).digest('hex'));
                return { data: session };
              }
              if (['campus_accounts', 'company_accounts'].includes(collection)) {
                assert.equal(id, accountId);
                accountReads += 1;
                return { data: account };
              }
              if (collection === 'users') return { data: { _id: uid, profilePublic: false } };
              return { data: null };
            },
          };
        },
        where() { return this; },
        orderBy() { return this; },
        skip() { return this; },
        limit() { return this; },
        async get() { return { data: [] }; },
      };
    },
    async runTransaction() { throw new Error('Offline test stops before business writes'); },
  };
  const originalLoad = Module._load;
  const file = path.resolve(__dirname, '..', 'cloudfunctions', name, 'index.js');
  let main;
  Module._load = function mockSdk(request, parent, isMain) {
    if (request === 'wx-server-sdk') {
      return {
        DYNAMIC_CURRENT_ENV: 'test', init() {}, database: () => db,
        getWXContext: () => ({ OPENID: 'mock-openid' }),
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(file)];
    main = require(file).main;
  } finally {
    Module._load = originalLoad;
  }
  return { main, accountReads: () => accountReads };
}

async function run() {
  const originalNow = Date.now;
  const originalError = console.error;
  Date.now = () => now;
  console.error = () => {};
  let scenarios = 0;
  try {
    const rejected = [
      undefined, null, {}, 'not-a-date', { $date: 'not-a-date' }, new Date(NaN),
      Infinity, NaN, now - 1, now,
    ];
    const future = now + 60_000;
    const accepted = [future, new Date(future), new Date(future).toISOString(),
      { $date: new Date(future).toISOString() }];
    for (const name of functions) {
      for (const expiresAt of rejected) {
        const fixture = loadFunction(name, expiresAt);
        const result = await fixture.main(event);
        assert.equal(result.code, 401, `${name} must reject an invalid or expired session`);
        assert.equal(fixture.accountReads(), 0, `${name} must reject before account access`);
        scenarios += 1;
      }
      for (const expiresAt of accepted) {
        const fixture = loadFunction(name, expiresAt);
        let result;
        try {
          result = await fixture.main(event);
        } catch (error) {
          // The stub does not provide business writes/services beyond authentication.
          assert.ok(fixture.accountReads() > 0, `${name}: ${error.message}`);
        }
        if (result) {
          assert.notEqual(result.code, 401, `${name} must accept a valid future expiration`);
        }
        assert.ok(fixture.accountReads() > 0, `${name} must validate the account`);
        scenarios += 1;
      }
    }
  } finally {
    Date.now = originalNow;
    console.error = originalError;
  }
  console.log(`Session expiry tests passed: ${functions.length} cloud functions, ${scenarios} scenarios`);
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
