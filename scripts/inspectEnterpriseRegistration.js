const automator = require('miniprogram-automator');

const CLI_PATH = '/Applications/wechatwebdevtools.app/Contents/MacOS/cli';
const PROJECT_PATH = '/Users/guoyuanyuan/digital-craftsman';
const TARGET_ACCOUNT = 'TECHHR';

(async () => {
  let miniProgram;
  try {
    miniProgram = await automator.launch({
      cliPath: CLI_PATH,
      projectPath: PROJECT_PATH,
    });
    const result = await miniProgram.evaluate((account) => new Promise((resolve) => {
      const db = wx.cloud.database();
      const read = (collection, id) => new Promise((done) => {
        db.collection(collection).doc(id).get({
          success: (response) => done({
            exists: true,
            account: response.data && response.data.account,
            status: response.data && response.data.status,
            companyId: response.data && response.data.companyId,
            registrationSource: response.data && response.data.registrationSource,
          }),
          fail: (error) => done({ exists: false, error: error.errMsg || String(error) }),
        });
      });
      Promise.all([
        read('company_accounts', account),
        read('enterprise_bindings', `account-${account}`),
      ]).then(([accountRecord, bindingRecord]) => {
        wx.cloud.callFunction({
          name: 'recoverAccount',
          data: { action: 'findAccounts', role: 'enterprise' },
          success: (response) => resolve({
            accountRecord,
            bindingRecord,
            currentWechatAccounts: response.result && response.result.accounts,
          }),
          fail: (error) => resolve({
            accountRecord,
            bindingRecord,
            recoverError: error.errMsg || String(error),
          }),
        });
      });
    }), TARGET_ACCOUNT);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  } finally {
    if (miniProgram) {
      try { await miniProgram.close(); } catch (error) {}
    }
  }
})();
