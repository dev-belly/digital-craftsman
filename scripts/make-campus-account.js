const crypto = require('crypto');

const [account, password, uid, name, school = '', major = ''] = process.argv.slice(2);

if (!account || !password || !uid || !name) {
  console.log('用法: node scripts/make-campus-account.js 学生账号 初始密码 uid 姓名 学校 专业');
  console.log('示例: node scripts/make-campus-account.js 20240004 Abc@2026 student-20240004 张三 江南理工大学 软件技术');
  process.exit(1);
}

const salt = crypto.randomBytes(16).toString('hex');
const passwordIterations = 120000;
const passwordHash = crypto.pbkdf2Sync(password, salt, passwordIterations, 32, 'sha256').toString('hex');
const now = new Date();

console.log('campus_accounts 文档：');
console.log(JSON.stringify({
  _id: account,
  account,
  uid,
  salt,
  passwordHash,
  passwordAlgorithm: 'pbkdf2-sha256',
  passwordIterations,
  passwordVersion: 1,
  mustChangePassword: true,
  status: 'active',
  createdAt: now,
  updatedAt: now,
}, null, 2));

console.log('\nusers 文档：');
console.log(JSON.stringify({
  _id: uid,
  name,
  school,
  major,
  avatar: '',
  skillTags: [],
  talentIndex: 0,
  createdAt: now,
}, null, 2));
