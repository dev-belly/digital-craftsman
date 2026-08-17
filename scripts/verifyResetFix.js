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

function check(label, result, expectCode) {
  const ok = result && result.code === expectCode;
  console.log(`${ok ? '✅' : '❌'} ${label}: code=${result && result.code} msg=${(result && result.msg) || ''}`);
  return ok;
}

(async () => {
  const miniProgram = await automator.launch({ cliPath: CLI, projectPath: PROJECT });
  try {
    console.log('=== 验证：重置密码后新密码能否登录（核心修复） ===\n');

    check('1) 初始密码登录 20240001/Wf@2026', await call(miniProgram, 'login', { role: 'student', account: '20240001', password: 'Wf@2026' }), 0);
    check('2) 找回 lookup', await call(miniProgram, 'recoverAccount', { action: 'lookup', role: 'student' }), 0);
    check('3) 重置密码 -> Newpass123', await call(miniProgram, 'recoverAccount', { action: 'resetPassword', role: 'student', newPassword: 'Newpass123' }), 0);
    check('4) 用【新密码】Newpass123 登录', await call(miniProgram, 'login', { role: 'student', account: '20240001', password: 'Newpass123' }), 0);
    check('5) 用【旧密码】Wf@2026 登录 (应失败=正确)', await call(miniProgram, 'login', { role: 'student', account: '20240001', password: 'Wf@2026' }), 3);

    console.log('\n=== 顺带验证企业端初始密码仍可登录 ===');
    check('6) 企业初始密码 COM1001/Zl@2026', await call(miniProgram, 'login', { role: 'enterprise', account: 'COM1001', password: 'Zl@2026' }), 0);
  } catch (e) {
    console.error('SCRIPT ERROR', e);
  } finally {
    await miniProgram.close();
  }
})();
