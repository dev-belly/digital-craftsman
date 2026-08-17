const automator = require('miniprogram-automator');

const CLI = '/Applications/wechatwebdevtools.app/Contents/MacOS/cli';
const PROJECT = '/Users/guoyuanyuan/digital-craftsman';

async function call(miniProgram, name, data) {
  return miniProgram.evaluate((name, data) => {
    return new Promise((resolve) => {
      wx.cloud.callFunction({ name, data, success: (r) => resolve(r.result), fail: (e) => resolve({ __fail: e }) });
    });
  }, name, data);
}

(async () => {
  const miniProgram = await automator.launch({ cliPath: CLI, projectPath: PROJECT });
  try {
    console.log('--- 1) login 20240001 ---');
    const loginRes = await call(miniProgram, 'login', { role: 'student', account: '20240001', password: 'Wf@2026' });
    console.log(JSON.stringify(loginRes).slice(0, 300));

    console.log('\n--- 2) dump account_bindings where openid=current ---');
    const bindings = await miniProgram.evaluate(() => {
      return new Promise((resolve) => {
        const db = wx.cloud.database();
        db.collection('account_bindings').where({}).get({
          success: (r) => resolve(r.data),
          fail: (e) => resolve({ __fail: e.errMsg || String(e) }),
        });
      });
    });
    console.log(JSON.stringify(bindings, null, 2).slice(0, 1500));

    console.log('\n--- 3) recoverAccount lookup (student) ---');
    const lookup = await call(miniProgram, 'recoverAccount', { action: 'lookup', role: 'student' });
    console.log(JSON.stringify(lookup).slice(0, 400));

    console.log('\n--- 4) recoverAccount resetPassword (student, Newpass123) ---');
    const reset = await call(miniProgram, 'recoverAccount', { action: 'resetPassword', role: 'student', newPassword: 'Newpass123' });
    console.log(JSON.stringify(reset).slice(0, 500));

    console.log('\n--- 5) after reset, try login with NEW password ---');
    const loginNew = await call(miniProgram, 'login', { role: 'student', account: '20240001', password: 'Newpass123' });
    console.log(JSON.stringify(loginNew).slice(0, 300));
  } catch (e) {
    console.error('SCRIPT ERROR', e);
  } finally {
    await miniProgram.close();
  }
})();
