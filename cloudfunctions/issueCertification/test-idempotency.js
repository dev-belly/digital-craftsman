// Deterministic transaction interleavings with an offline cloud SDK stub.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Module = require('node:module');

const token = 'mock-enterprise-token';
const companyId = 'mock-company';
const requestId = 'cert-request-0001';
const digest = crypto.createHash('sha256').update(`${companyId}|${requestId}`).digest('hex');
const certificationId = `cert-${digest.slice(0, 24)}`;
const event = {
  enterpriseSessionToken: token, requestId, uid: 'stu-one',
  certName: 'Data analysis', level: '高级', serialNo: 'REQUESTED-SERIAL',
};
const saved = {
  uid: 'stu-one', issuerId: companyId, certName: 'Earlier certificate',
  level: '初级', serialNo: 'STORED-SERIAL', evidenceHash: 'stored-evidence-hash',
};

function fixture({ existing, interleaved, readError } = {}) {
  const documents = {
    enterprise_sessions: {
      [crypto.createHash('sha256').update(token).digest('hex')]: {
        openid: 'mock-openid', role: 'enterprise', account: 'MOCK-ACCOUNT', companyId,
        companyName: 'Mock company', passwordVersion: 1, expiresAt: Date.now() + 60_000,
      },
    },
    company_accounts: {
      'MOCK-ACCOUNT': { companyId, status: 'active', passwordVersion: 1 },
    },
    users: { 'stu-one': { name: 'One', talentPoolVisible: false } },
    certifications: existing ? { [certificationId]: { ...existing } } : {},
    attestations: {}, stages: {}, works: {}, evaluations: {},
  };
  const writes = [];
  const db = {
    collection(name) {
      const records = documents[name];
      assert.ok(records, `Unexpected collection: ${name}`);
      return {
        doc(id) {
          return {
            async get() {
              if (readError && name === 'certifications') throw new Error('permission denied');
              return { data: records[id] ? { ...records[id] } : null };
            },
            async set({ data }) {
              writes.push({ name, id, operation: 'set' });
              records[id] = { ...data };
            },
            async update({ data }) {
              assert.ok(records[id], `Missing document: ${name}/${id}`);
              writes.push({ name, id, operation: 'update' });
              Object.assign(records[id], data);
            },
          };
        },
        where(query) {
          return {
            limit() {
              return {
                async get() {
                  return { data: Object.entries(records)
                    .filter(([, value]) => Object.entries(query)
                      .every(([key, expected]) => value[key] === expected))
                    .map(([id, value]) => ({ ...value, _id: id })) };
                },
              };
            },
          };
        },
      };
    },
    async runTransaction(callback) {
      // Another caller commits after the preflight read, before the transaction.
      if (interleaved) documents.certifications[certificationId] = { ...interleaved };
      return callback(db);
    },
  };
  const originalLoad = Module._load;
  Module._load = function mockSdk(request, parent, isMain) {
    if (request === 'wx-server-sdk') {
      return {
        DYNAMIC_CURRENT_ENV: 'test', init() {}, database: () => db,
        getWXContext: () => ({ OPENID: 'mock-openid' }),
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  let certification;
  try {
    delete require.cache[require.resolve('./index.js')];
    certification = require('./index.js');
  } finally {
    Module._load = originalLoad;
  }
  return { main: certification.main, documents, writes };
}

async function run() {
  const created = fixture();
  const first = await created.main(event);
  assert.equal(first.code, 0);
  assert.equal(first.evidenceHash, created.documents.certifications[certificationId].evidenceHash);
  assert.equal(first.serialNo, 'REQUESTED-SERIAL');
  assert.equal(created.writes.filter((write) => write.name === 'certifications').length, 1);
  assert.equal(created.writes.filter((write) => write.name === 'attestations').length, 1);

  for (const state of [{ interleaved: saved }, { existing: saved }]) {
    const duplicate = fixture(state);
    const result = await duplicate.main(event);
    assert.equal(result.code, 0);
    assert.equal(result.duplicated, true, 'A committed retry must be reported as a duplicate');
    assert.equal(result.evidenceHash, saved.evidenceHash, 'Return the committed evidence hash');
    assert.equal(result.serialNo, saved.serialNo, 'Return the committed certificate serial');
    assert.equal(duplicate.writes.filter((write) => write.name !== 'users').length, 0);
    assert.deepEqual(duplicate.documents.certifications[certificationId], saved);
  }

  for (const conflict of [
    { ...saved, uid: 'stu-other' },
    { ...saved, issuerId: 'other-company' },
  ]) {
    for (const state of [{ existing: conflict }, { interleaved: conflict }]) {
      const duplicate = fixture(state);
      const result = await duplicate.main(event);
      assert.equal(result.code, 409, 'A reused request must not succeed for a different owner');
      assert.equal(result.evidenceHash, undefined);
      assert.deepEqual(duplicate.writes, []);
    }
  }

  const unauthenticated = fixture();
  assert.equal((await unauthenticated.main({ ...event, enterpriseSessionToken: '' })).code, 401);
  assert.deepEqual(unauthenticated.writes, []);

  const broken = fixture({ readError: true });
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.equal((await broken.main(event)).code, 99);
    assert.deepEqual(broken.writes, []);
  } finally {
    console.error = originalError;
  }
  console.log('issueCertification idempotency tests passed (9 scenarios, no cloud calls)');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
