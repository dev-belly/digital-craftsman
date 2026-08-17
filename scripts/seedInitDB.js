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
        name: 'initDB',
        data: { seed: true },
        success: (r) => resolve({ ok: true, result: r.result }),
        fail: (e) => resolve({ ok: false, error: e }),
      });
    }));
    console.log('[initDB result]', JSON.stringify(res, null, 2));
  } catch (err) {
    console.error('[automator error]', err && err.stack ? err.stack : err);
    process.exitCode = 1;
  } finally {
    if (miniProgram) {
      try { await miniProgram.close(); } catch (e) { /* ignore */ }
    }
  }
})();
