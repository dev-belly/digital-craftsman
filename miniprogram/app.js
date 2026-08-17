// app.js
App({
  onLaunch() {
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力');
      return;
    }
    wx.cloud.init({
      // 部署后把这里换成你自己的云开发环境 ID
      env: 'cloud1-d9g3gsolf1c9841d7',
      traceUser: true,
    });
  },
  globalData: {
    // 当前登录用户,登录后写入
    user: null,
    // 云开发环境 ID(与上方保持一致)
    envId: 'cloud1-d9g3gsolf1c9841d7',
  },
});
