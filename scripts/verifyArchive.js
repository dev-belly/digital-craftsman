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

    const loginRes = await miniProgram.evaluate(() => new Promise((resolve) => {
      wx.cloud.callFunction({
        name: 'login',
        data: { role: 'student', account: '20240002', password: 'Lm@2026' },
        success: (r) => resolve({ ok: true, result: r.result }),
        fail: (e) => resolve({ ok: false, error: e }),
      });
    }));
    const login = loginRes && loginRes.result;
    if (!login || login.code !== 0) {
      console.log('FAIL login', JSON.stringify(loginRes));
      process.exitCode = 1;
      return;
    }
    console.log('PASS login ->', login.user.name, login.user._id, 'mustChange=', login.mustChangePassword);

    const archRes = await miniProgram.evaluate((token, uid) => new Promise((resolve) => {
      wx.cloud.callFunction({
        name: 'getArchive',
        data: { sessionToken: token, uid },
        success: (r) => resolve({ ok: true, result: r.result }),
        fail: (e) => resolve({ ok: false, error: e }),
      });
    }), login.sessionToken, login.user._id);
    const arch = archRes && archRes.result;
    if (!arch || arch.code !== 0) {
      console.log('FAIL getArchive', JSON.stringify(archRes));
      process.exitCode = 1;
      return;
    }
    const u = (arch.data && arch.data.user) || {};
    console.log('PASS getArchive ->', {
      name: u.name,
      school: u.school,
      stageCount: (arch.data.stages || []).length,
      workCount: (arch.data.works || []).length,
      evaluationCount: (arch.data.evaluations || []).length,
      talentIndex: u.talentIndex,
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
