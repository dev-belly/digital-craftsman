const app = getApp();
const auth = require('../../utils/auth.js');

Page({
  data: {
    role: 'student',
    account: '',
    password: '',
    passwordVisible: false,
    loading: false,
    agreed: false,
  },

  onLoad(options = {}) {
    const hasExplicitEntry = Object.prototype.hasOwnProperty.call(options, 'role')
      || Object.prototype.hasOwnProperty.call(options, 'account');
    const role = options && options.role === 'enterprise' ? 'enterprise' : 'student';
    const account = String((options && options.account) || '');
    this.setData({ role, account });

    // 隐私授权：若用户尚未同意，触发微信隐私弹窗（上架硬性要求）。
    try {
      if (!wx.getStorageSync('privacyAgreed')) {
        wx.requirePrivacyAuthorize({ success: () => {}, fail: () => {} });
      }
    } catch (error) {}

    // 从注册页或其他入口显式指定账号/角色时，保留登录页供用户操作。
    if (hasExplicitEntry) return;

    const savedRole = wx.getStorageSync('loginRole');
    if (savedRole === 'enterprise') {
      const company = wx.getStorageSync('company');
      const enterpriseSessionToken = wx.getStorageSync('enterpriseSessionToken');
      if (company && enterpriseSessionToken) {
        wx.reLaunch({ url: '/pages/enterprise/home/home' });
        return;
      }
      auth.clearEnterpriseSession();
    }

    if (savedRole === 'student') {
      const uid = wx.getStorageSync('uid');
      const sessionToken = wx.getStorageSync('sessionToken');
      if (uid && sessionToken) {
        wx.reLaunch({ url: '/pages/home/home' });
        return;
      }
      auth.clearStudentSession();
    }
  },

  goAgreement() { wx.navigateTo({ url: '/pages/privacy/privacy?type=agreement' }); },
  goPrivacy() { wx.navigateTo({ url: '/pages/privacy/privacy' }); },
  toggleAgreement() { this.setData({ agreed: !this.data.agreed }); },
  togglePassword() { this.setData({ passwordVisible: !this.data.passwordVisible }); },
  goRegister() {
    wx.navigateTo({ url: `/pages/register/register?role=${this.data.role}` });
  },
  goRecover() {
    wx.navigateTo({ url: `/pages/recover/recover?role=${this.data.role}` });
  },
  switchRole(event) {
    const role = event.currentTarget.dataset.role === 'enterprise' ? 'enterprise' : 'student';
    this.setData({ role, account: '', password: '' });
  },
  onAccountInput(event) { this.setData({ account: event.detail.value }); },
  onPasswordInput(event) { this.setData({ password: event.detail.value }); },

  async onLogin() {
    if (this.data.loading) return;
    const isEnterprise = this.data.role === 'enterprise';
    const account = isEnterprise
      ? this.data.account.trim().toUpperCase()
      : this.data.account.trim();
    const password = this.data.password;
    if (!account || !password) {
      wx.showToast({ title: isEnterprise ? '请输入企业账号和密码' : '请输入校园账号和密码', icon: 'none' });
      return;
    }
    if (!this.data.agreed) {
      wx.showToast({ title: '请先阅读并同意协议', icon: 'none' });
      return;
    }

    this.setData({ loading: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'login',
        data: { account, password, role: this.data.role },
      });
      const result = res.result || {};
      if (isEnterprise) {
        if (result.code !== 0 || !result.company || !result.enterpriseSessionToken) {
          wx.showToast({ title: result.msg || '登录失败', icon: 'none', duration: 2600 });
          return;
        }
        wx.setStorageSync('loginRole', 'enterprise');
        wx.setStorageSync('company', result.company);
        wx.setStorageSync('enterpriseSessionToken', result.enterpriseSessionToken);
        wx.setStorageSync('enterpriseAccount', account);
        wx.reLaunch({ url: '/pages/enterprise/home/home' });
        return;
      }

      if (result.code !== 0 || !result.user || !result.sessionToken) {
        wx.showToast({ title: result.msg || '登录失败', icon: 'none', duration: 2600 });
        return;
      }

      app.globalData.user = result.user;
      wx.setStorageSync('loginRole', 'student');
      wx.setStorageSync('uid', result.user._id);
      wx.setStorageSync('sessionToken', result.sessionToken);
      wx.setStorageSync('campusAccount', account);
      wx.reLaunch({
        url: result.mustChangePassword
          ? `/pages/password/password?firstSetup=1&role=${this.data.role}`
          : '/pages/home/home',
      });
    } catch (error) {
      console.error('账号登录失败', error);
      wx.showToast({ title: '登录服务暂时不可用', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },
});
