const automator = require('miniprogram-automator');

const CLI_PATH = '/Applications/wechatwebdevtools.app/Contents/MacOS/cli';
const PROJECT_PATH = '/Users/guoyuanyuan/digital-craftsman';

(async () => {
  let miniProgram;
  try {
    miniProgram = await automator.launch({
      cliPath: CLI_PATH,
      projectPath: PROJECT_PATH,
    });
    console.log('[automator] launched');

    const res = await miniProgram.evaluate(() => new Promise((resolve) => {
      wx.cloud.callFunction({
        name: 'login',
        data: { role: 'student', account: '20240001', password: 'Wf@2026' },
        success: (r) => resolve({ ok: true, result: r.result }),
        fail: (e) => resolve({ ok: false, error: e }),
      });
    }));
    console.log('[login result]', JSON.stringify(res, null, 2));

    if (res && res.ok && res.result && res.result.code === 0) {
      const { user, sessionToken, mustChangePassword } = res.result;
      console.log('PASS login ->', {
        code: res.result.code,
        name: user && user.name,
        uid: user && user._id,
        hasSession: Boolean(sessionToken),
        mustChangePassword,
      });
    } else {
      console.log('FAIL login');
      process.exitCode = 1;
    }
  } catch (err) {
    console.error('[automator error]', err && err.stack ? err.stack : err);
    process.exitCode = 1;
  } finally {
    if (miniProgram) {
      try { await miniProgram.close(); } catch (e) { /* ignore */ }
    }
  }
})();
