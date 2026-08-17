const crypto = require('crypto');

const [account, password, companyId, companyName, contact = ''] = process.argv.slice(2);

if (!account || !password || !companyId || !companyName) {
  console.log('用法: node scripts/make-company-account.js 企业账号 初始密码 companyId 企业名称 联系人');
  console.log('示例: node scripts/make-company-account.js COM2001 Test@2026 company-demo-001 苏州智能科技 张经理');
  process.exit(1);
}

const salt = crypto.randomBytes(16).toString('hex');
const passwordIterations = 120000;
const passwordHash = crypto.pbkdf2Sync(password, salt, passwordIterations, 32, 'sha256').toString('hex');
const now = new Date();

console.log(JSON.stringify({
  _id: account,
  account,
  companyId,
  companyName,
  contact,
  salt,
  passwordHash,
  passwordAlgorithm: 'pbkdf2-sha256',
  passwordIterations,
  passwordVersion: 1,
  status: 'active',
  createdAt: now,
  updatedAt: now,
}, null, 2));
