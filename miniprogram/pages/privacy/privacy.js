// pages/privacy/privacy.js
Page({
  data: { type: 'privacy' },

  onLoad(options) {
    const type = options.type === 'agreement' ? 'agreement' : 'privacy';
    this.setData({ type });
    wx.setNavigationBarTitle({ title: type === 'agreement' ? '用户协议' : '隐私政策' });
  },

  onBack() {
    wx.navigateBack({
      fail: () => wx.reLaunch({ url: '/pages/login/login' }),
    });
  },
});
