const auth = require('../../utils/auth');

Page({
  data: {
    firstSetup: false,
    role: 'student',
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
    currentVisible: false,
    newVisible: false,
    confirmVisible: false,
    saving: false,
  },

  onLoad(options) {
    const firstSetup = options.firstSetup === '1';
    const role = options.role === 'enterprise' ? 'enterprise' : 'student';
    this.setData({ firstSetup, role });
    wx.setNavigationBarTitle({
      title: firstSetup ? '设置个人密码' : role === 'enterprise' ? '修改企业密码' : '修改登录密码',
    });
  },

  onCurrentInput(event) { this.setData({ currentPassword: event.detail.value }); },
  onNewInput(event) { this.setData({ newPassword: event.detail.value }); },
  onConfirmInput(event) { this.setData({ confirmPassword: event.detail.value }); },
  toggleCurrent() { this.setData({ currentVisible: !this.data.currentVisible }); },
  toggleNew() { this.setData({ newVisible: !this.data.newVisible }); },
  toggleConfirm() { this.setData({ confirmVisible: !this.data.confirmVisible }); },

  async submitPassword() {
    if (this.data.saving) return;
    const {
      firstSetup, role, currentPassword, newPassword, confirmPassword,
    } = this.data;
    if (!firstSetup && !currentPassword) {
      wx.showToast({ title: '请输入原密码', icon: 'none' });
      return;
    }
    if (newPassword.length < 8 || newPassword.length > 32) {
      wx.showToast({ title: '新密码应为 8—32 位', icon: 'none' });
      return;
    }
    if (!/[A-Za-z]/.test(newPassword) || !/\d/.test(newPassword) || /\s/.test(newPassword)) {
      wx.showToast({ title: '密码需包含字母和数字且不能有空格', icon: 'none' });
      return;
    }
    if (newPassword !== confirmPassword) {
      wx.showToast({ title: '两次输入的新密码不一致', icon: 'none' });
      return;
    }

    const session = role === 'enterprise' ? auth.getEnterpriseSession() : auth.getSession();
    if (!session) return;
    this.setData({ saving: true });
    try {
      const res = await wx.cloud.callFunction({
        name: role === 'enterprise' ? 'changeEnterprisePassword' : 'changePassword',
        data: role === 'enterprise'
          ? {
            enterpriseSessionToken: session.enterpriseSessionToken,
            currentPassword,
            newPassword,
          }
          : {
            sessionToken: session.sessionToken,
            currentPassword,
            newPassword,
          },
      });
      const result = res.result || {};
      if (result.code === 401 || result.code === 409) {
        if (role === 'enterprise') auth.clearEnterpriseSession();
        else auth.clearStudentSession();
        wx.showToast({ title: result.msg || '请重新登录', icon: 'none' });
        setTimeout(() => wx.reLaunch({ url: '/pages/login/login' }), 700);
        return;
      }
      const nextToken = role === 'enterprise'
        ? result.enterpriseSessionToken
        : result.sessionToken;
      if (result.code !== 0 || !nextToken) {
        wx.showToast({ title: result.msg || '密码修改失败', icon: 'none', duration: 2600 });
        return;
      }

      wx.setStorageSync(
        role === 'enterprise' ? 'enterpriseSessionToken' : 'sessionToken',
        nextToken,
      );
      wx.showToast({ title: firstSetup ? '密码设置成功' : '密码修改成功', icon: 'success' });
      setTimeout(() => {
        if (firstSetup) {
          wx.reLaunch({ url: '/pages/home/home' });
        } else if (role === 'enterprise') {
          wx.reLaunch({ url: '/pages/enterprise/home/home' });
        } else {
          wx.navigateBack({ fail: () => wx.reLaunch({ url: '/pages/profile/profile' }) });
        }
      }, 600);
    } catch (error) {
      console.error('修改密码失败', error);
      wx.showToast({ title: '密码服务暂时不可用', icon: 'none' });
    } finally {
      this.setData({ saving: false });
    }
  },
});
