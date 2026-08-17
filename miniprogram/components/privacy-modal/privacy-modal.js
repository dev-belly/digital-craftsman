Component({
  data: {
    show: false,
  },

  lifetimes: {
    attached() {
      try {
        wx.onNeedPrivacyAuthorization((resolve) => {
          this.setData({ show: true });
          this._resolve = resolve;
        });
      } catch (error) {
        // 开发者工具基础库较低时可能不支持该接口，忽略即可。
      }
    },
  },

  methods: {
    onAgree() {
      if (this._resolve) {
        try {
          this._resolve({ event: 'agree' });
        } catch (error) {
          console.error('隐私授权回调失败', error);
        }
      }
      try {
        wx.setStorageSync('privacyAgreed', true);
      } catch (error) {}
      this.setData({ show: false });
    },

    onDisagree() {
      if (this._resolve) {
        try {
          this._resolve({ event: 'disagree' });
        } catch (error) {
          console.error('隐私拒绝回调失败', error);
        }
      }
      this.setData({ show: false });
    },

    openPrivacy() {
      wx.navigateTo({ url: '/pages/privacy/privacy?type=privacy' });
    },

    openAgreement() {
      wx.navigateTo({ url: '/pages/privacy/privacy?type=agreement' });
    },
  },
});
