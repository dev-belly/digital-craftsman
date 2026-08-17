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
        data: { role: 'enterprise', account: 'COM1001', password: 'Zl@2026' },
        success: (r) => resolve({ ok: true, result: r.result }),
        fail: (e) => resolve({ ok: false, error: e }),
      });
    }));
    const r = res && res.result;
    if (!r || r.code !== 0) {
      console.log('FAIL enterprise login', JSON.stringify(res));
      process.exitCode = 1;
      return;
    }
    console.log('PASS enterprise login ->', {
      code: r.code,
      company: r.company && r.company.companyName,
      account: r.company && r.company.account,
      hasSession: Boolean(r.enterpriseSessionToken),
    });
  } catch (err) {
    console.error('[automator error]', err && err.stack ? err.stack : err);
    process.exitCode = 1;
  } finally {
    if (miniProgram) {
      try { await miniProgram.close(); } catch (e) { /* ignore */ }
    }
  }
})();
