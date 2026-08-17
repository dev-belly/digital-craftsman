const automator = require('miniprogram-automator');

const CLI_PATH = '/Applications/wechatwebdevtools.app/Contents/MacOS/cli';
const PROJECT_PATH = '/Users/guoyuanyuan/digital-craftsman';

async function callFindAccounts(miniProgram, role) {
  return miniProgram.evaluate((selectedRole) => new Promise((resolve) => {
    wx.cloud.callFunction({
      name: 'recoverAccount',
      data: { action: 'findAccounts', role: selectedRole },
      success: (response) => resolve({ ok: true, result: response.result }),
      fail: (error) => resolve({ ok: false, error: error.errMsg || String(error) }),
    });
  }), role);
}

(async () => {
  let miniProgram;
  try {
    miniProgram = await automator.launch({
      cliPath: CLI_PATH,
      projectPath: PROJECT_PATH,
    });
    const [student, enterprise] = await Promise.all([
      callFindAccounts(miniProgram, 'student'),
      callFindAccounts(miniProgram, 'enterprise'),
    ]);
    await miniProgram.reLaunch('/pages/recover/recover?role=enterprise');
    const page = await miniProgram.currentPage();
    const findTrigger = await page.$('.account-find-trigger');
    if (!findTrigger) throw new Error('找回页面缺少当前微信查询入口');
    await findTrigger.tap();
    await page.waitFor(1800);
    const pageData = await page.data();

    console.log(JSON.stringify({
      student,
      enterprise,
      page: {
        role: pageData.role,
        accountInput: pageData.accountInput,
        bindingFound: pageData.bindingFound,
        accountFinderState: pageData.accountFinderState,
        errorMessage: pageData.errorMessage,
      },
    }, null, 2));

    for (const response of [student, enterprise]) {
      if (!response.ok || !response.result || response.result.code !== 0) {
        process.exitCode = 1;
      }
    }
    if (pageData.role !== 'enterprise'
      || !pageData.accountInput
      || !pageData.bindingFound
      || pageData.errorMessage) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  } finally {
    if (miniProgram) {
      try { await miniProgram.close(); } catch (error) {}
    }
  }
})();
