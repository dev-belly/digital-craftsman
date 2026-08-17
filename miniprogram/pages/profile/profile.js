// pages/profile/profile.js
const app = getApp();
const auth = require('../../utils/auth');
Page({
  data: {
    user: null,
    tagInput: '',
    campusAccount: '',
    loading: true,
    error: '',
    saving: false,
    dirty: false,
  },
  onShow() {
    const session = auth.getSession();
    if (!session) return;
    this.uid = session.uid;
    this.sessionToken = session.sessionToken;
    this.setData({ campusAccount: wx.getStorageSync('campusAccount') || '' });
    // 返回密码或协议页时保留尚未保存的编辑内容；会话令牌仍会在上方刷新。
    if (!this.data.user || !this.data.dirty) this.load();
  },
  async load() {
    this.setData({ loading: !this.data.user, error: '' });
    try {
      const res = await wx.cloud.callFunction({
        name: 'getArchive',
        data: { uid: this.uid, sessionToken: this.sessionToken, privateView: true },
      });
      const result = res.result || {};
      if (auth.handleExpired(result)) return;
      if (result.code === 0 && result.data) {
        const user = {
          ...(result.data.user || {}),
          skillTags: Array.isArray(result.data.user && result.data.user.skillTags)
            ? result.data.user.skillTags : [],
        };
        this.setData({ user, loading: false, error: '', dirty: false });
      } else {
        this.setData({ loading: false, error: result.msg || '个人档案加载失败' });
      }
    } catch (error) {
      console.error('个人档案加载失败', error);
      this.setData({ loading: false, error: '网络连接失败，请检查后重试' });
    }
  },
  onInput(e) {
    const key = e.currentTarget.dataset.key;
    this.setData({ [`user.${key}`]: e.detail.value, dirty: true });
  },
  onTalentPoolVisibleChange(e) {
    this.setData({
      'user.talentPoolVisible': Boolean(e.detail.value),
      dirty: true,
    });
  },
  onProfilePublicChange(e) {
    this.setData({
      'user.profilePublic': Boolean(e.detail.value),
      dirty: true,
    });
  },
  onTagInput(e) { this.setData({ tagInput: e.detail.value }); },
  addTag() {
    if (!this.data.user) return;
    const t = this.data.tagInput.trim();
    if (!t) {
      wx.showToast({ title: '请输入技能标签', icon: 'none' });
      return;
    }
    if (t.length > 24) {
      wx.showToast({ title: '标签不能超过 24 个字', icon: 'none' });
      return;
    }
    const tags = [...(this.data.user.skillTags || [])];
    if (tags.includes(t)) {
      wx.showToast({ title: '这个标签已经添加过了', icon: 'none' });
      return;
    }
    if (tags.length >= 12) {
      wx.showToast({ title: '最多添加 12 个技能标签', icon: 'none' });
      return;
    }
    tags.push(t);
    this.setData({ 'user.skillTags': tags, tagInput: '', dirty: true });
  },
  removeTag(e) {
    if (!this.data.user) return;
    const i = e.currentTarget.dataset.index;
    const tags = [...this.data.user.skillTags];
    tags.splice(i, 1);
    this.setData({ 'user.skillTags': tags, dirty: true });
  },
  async save() {
    if (this.data.saving || !this.data.user) return;
    const name = this.data.user.name.trim();
    const school = this.data.user.school.trim();
    const major = this.data.user.major.trim();
    const skillTags = this.data.user.skillTags;
    const talentPoolVisible = Boolean(this.data.user.talentPoolVisible);
    const profilePublic = this.data.user.profilePublic !== false;
    if (name.length < 2) {
      wx.showToast({ title: '请填写完整姓名', icon: 'none' });
      return;
    }
    if (!school || !major) {
      wx.showToast({ title: '请填写学校和专业', icon: 'none' });
      return;
    }
    this.setData({ saving: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'updateProfile',
        data: {
          uid: this.uid,
          sessionToken: this.sessionToken,
          name,
          school,
          major,
          skillTags,
          talentPoolVisible,
          profilePublic,
        },
      });
      const result = res.result || {};
      if (auth.handleExpired(result)) return;
      if (result.code === 0) {
        wx.showToast({ title: '已保存' });
        const user = { ...this.data.user, name, school, major };
        this.setData({ user, dirty: false });
        app.globalData.user = user;
      } else {
        wx.showToast({ title: result.message || result.msg || '保存失败', icon: 'none' });
      }
    } catch (error) {
      console.error('个人档案保存失败', error);
      wx.showToast({ title: '保存失败', icon: 'none' });
    } finally {
      this.setData({ saving: false });
    }
  },
  goAgreement() {
    wx.navigateTo({ url: '/pages/privacy/privacy?type=agreement' });
  },
  goPrivacy() {
    wx.navigateTo({ url: '/pages/privacy/privacy?type=privacy' });
  },
  goChangePassword() {
    wx.navigateTo({ url: '/pages/password/password' });
  },
  logout() {
    wx.showModal({
      title: '退出登录',
      content: '退出后需要重新输入账号和密码，确认继续吗？',
      confirmText: '退出',
      confirmColor: '#c73d3d',
      success: (result) => {
        if (result.confirm) this.performLogout();
      },
    });
  },
  async performLogout() {
    const sessionToken = wx.getStorageSync('sessionToken');
    let revokeTask = null;
    if (sessionToken) {
      try {
        revokeTask = wx.cloud.callFunction({
          name: 'logout',
          data: { role: 'student', sessionToken },
        })
          .then((res) => {
            const result = res.result || {};
            if (result.code !== 0) console.warn('云端会话撤销未完成', result.msg || result.code);
          })
          .catch((error) => console.warn('云端会话撤销未完成，本机已退出', error));
      } catch (error) {
        console.warn('云端会话撤销调用失败，本机继续退出', error);
      }
    }
    // 退出本机不能依赖网络；云端撤销即使失败，也不能把用户困在当前页面。
    auth.clearStudentSession();
    const app = getApp();
    if (app && app.globalData) app.globalData.user = null;
    wx.reLaunch({ url: '/pages/login/login' });
    return revokeTask;
  },
});
