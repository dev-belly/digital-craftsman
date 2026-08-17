// pages/home/home.js
const app = getApp();
const auth = require('../../utils/auth');

function invitationMeta(status) {
  if (status === 'accepted') return { statusLabel: '已接受', statusClass: 'accepted' };
  if (status === 'declined') return { statusLabel: '已婉拒', statusClass: 'declined' };
  return { statusLabel: '待处理', statusClass: 'pending' };
}

function applicationMeta(status) {
  if (status === 'accepted') return { applicationLabel: '企业已接受', applicationClass: 'accepted' };
  if (status === 'declined') return { applicationLabel: '企业未通过', applicationClass: 'declined' };
  if (status === 'pending') return { applicationLabel: '已申请 · 待回复', applicationClass: 'pending' };
  return { applicationLabel: '申请岗位', applicationClass: 'available' };
}

function formatDate(value) {
  if (!value) return '近期发布';
  const date = value.$date ? new Date(value.$date) : new Date(value);
  if (Number.isNaN(date.getTime())) return '近期发布';
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

Page({
  data: {
    user: null,
    userInitial: '匠',
    stages: [],
    invitations: [],
    opportunities: [],
    stats: { works: 0, certifications: 0, evaluations: 0 },
    currentStage: null,
    completedStageCount: 0,
    loading: true,
    error: '',
    wxaCodeUrl: '',
    wxaCodeLoading: false,
    wxaCodeError: '',
    codeVersionLabel: '',
    respondingInvitationId: '',
    respondingInvitationAction: '',
    applyingJobId: '',
  },

  onLoad() {
    this.refreshSession();
  },

  onShow() {
    if (!this.refreshSession()) return;
    this.loadData();
  },

  refreshSession() {
    const session = auth.getSession();
    if (!session) return false;
    this.uid = session.uid;
    this.sessionToken = session.sessionToken;
    return true;
  },

  async loadData() {
    if (!this.uid || !this.sessionToken) return;
    this.setData({ loading: !this.data.user, error: '' });
    try {
      const res = await wx.cloud.callFunction({
        name: 'getArchive',
        data: {
          uid: this.uid,
          sessionToken: this.sessionToken,
          privateView: true,
          trackScan: false,
        },
      });
      const result = res.result || {};
      if (auth.handleExpired(result)) return;
      if (result.code !== 0 || !result.data) {
        this.setData({ loading: false, error: result.msg || '档案加载失败，请稍后重试' });
        return;
      }

      const archive = result.data;
      const user = {
        ...(archive.user || {}),
        skillTags: Array.isArray(archive.user && archive.user.skillTags)
          ? archive.user.skillTags : [],
      };
      const stages = Array.isArray(archive.stages) ? archive.stages : [];
      const invitations = (archive.invitations || []).map((invitation) => ({
        ...invitation,
        typeClass: invitation.type === '实习' ? 'intern' : 'interview',
        ...invitationMeta(invitation.status),
      }));
      const opportunities = (archive.opportunities || []).map((job) => ({
        ...job,
        createdLabel: formatDate(job.createdAt),
        typeClass: job.type === '实训' ? 'training'
          : job.type === '正式岗位' ? 'fulltime' : 'intern',
        ...applicationMeta(job.applicationStatus),
      }));
      const currentStage = stages.find((stage) => stage.status === 'doing')
        || stages.find((stage) => stage.status === 'pending')
        || stages[stages.length - 1]
        || null;

      app.globalData.user = user;
      this.setData({
        user,
        userInitial: (user.name || '匠').slice(0, 1),
        stages,
        invitations,
        opportunities,
        stats: {
          works: (archive.works || []).length,
          certifications: (archive.certifications || []).length,
          evaluations: (archive.evaluations || []).length,
        },
        currentStage,
        completedStageCount: stages.filter((stage) => stage.status === 'done').length,
        loading: false,
        error: '',
      });
      if (!this.data.wxaCodeUrl) this.loadWxaCode();
    } catch (error) {
      console.error('首页加载失败', error);
      this.setData({ loading: false, error: '云端连接失败，请检查网络后重试' });
    }
  },

  retryLoad() {
    if (!this.refreshSession()) return;
    this.loadData();
  },

  getEnvVersion() {
    try {
      const info = wx.getAccountInfoSync();
      const version = info && info.miniProgram && info.miniProgram.envVersion;
      return ['develop', 'trial', 'release'].includes(version) ? version : 'develop';
    } catch (error) {
      return 'develop';
    }
  },

  getVersionLabel(version) {
    return version === 'release' ? '正式版' : version === 'trial' ? '体验版' : '开发版';
  },

  async loadWxaCode() {
    if (this.data.wxaCodeLoading || !this.uid || !this.sessionToken) return;
    const envVersion = this.getEnvVersion();
    this.setData({
      wxaCodeLoading: true,
      wxaCodeError: '',
      codeVersionLabel: this.getVersionLabel(envVersion),
    });

    try {
      const res = await wx.cloud.callFunction({
        name: 'genWxaCode',
        data: { uid: this.uid, sessionToken: this.sessionToken, envVersion },
      });
      const result = res.result || {};
      if (auth.handleExpired(result)) return;
      if (result.code !== 0 || !result.tempURL) {
        throw new Error(result.msg || '暂时无法生成小程序码');
      }
      this.setData({ wxaCodeUrl: result.tempURL, wxaCodeLoading: false });
    } catch (error) {
      console.error('小程序码加载失败', error);
      this.setData({
        wxaCodeUrl: '',
        wxaCodeLoading: false,
        wxaCodeError: error.message || '小程序码生成失败，点击重试',
      });
    }
  },

  previewCode() {
    if (!this.data.wxaCodeUrl) {
      this.loadWxaCode();
      return;
    }
    wx.previewImage({
      current: this.data.wxaCodeUrl,
      urls: [this.data.wxaCodeUrl],
      fail: () => wx.showToast({ title: '图片预览失败', icon: 'none' }),
    });
  },

  handleWxaCodeError() {
    this.setData({
      wxaCodeUrl: '',
      wxaCodeLoading: false,
      wxaCodeError: '档案码图片加载失败，点击重新生成',
    });
  },

  goArchive() {
    wx.navigateTo({
      url: `/pages/archive/archive?uid=${encodeURIComponent(this.uid)}&privateView=1`,
      fail: () => wx.showToast({ title: '页面打开失败，请重试', icon: 'none' }),
    });
  },

  goModule(event) {
    const target = event.currentTarget.dataset.target;
    if (target === 'works') {
      wx.switchTab({ url: '/pages/works/works' });
      return;
    }
    if (target === 'evaluations') {
      wx.switchTab({ url: '/pages/evaluations/evaluations' });
      return;
    }
    if (target === 'certifications') {
      wx.navigateTo({
        url: '/pages/certs/certs',
        fail: () => wx.showToast({ title: '认证页面打开失败', icon: 'none' }),
      });
    }
  },

  respondInvitation(event) {
    if (this.data.respondingInvitationId) return;
    const invitationId = event.currentTarget.dataset.id;
    const action = event.currentTarget.dataset.action;
    const accepting = action === 'accepted';
    wx.showModal({
      title: accepting ? '接受邀约' : '婉拒邀约',
      content: accepting ? '确认接受这份企业邀约吗？' : '确认婉拒这份企业邀约吗？',
      confirmText: accepting ? '接受' : '婉拒',
      confirmColor: accepting ? '#2457d6' : '#c73d3d',
      success: (modalResult) => {
        if (modalResult.confirm) this.submitInvitationResponse(invitationId, action);
      },
    });
  },

  async submitInvitationResponse(invitationId, action) {
    this.setData({
      respondingInvitationId: invitationId,
      respondingInvitationAction: action,
    });
    try {
      const res = await wx.cloud.callFunction({
        name: 'respondInvitation',
        data: {
          uid: this.uid,
          sessionToken: this.sessionToken,
          invitationId,
          action,
        },
      });
      const result = res.result || {};
      if (auth.handleExpired(result)) return;
      if (result.code !== 0) {
        wx.showToast({ title: result.msg || '邀约处理失败', icon: 'none' });
        return;
      }
      const invitations = this.data.invitations.map((invitation) => (
        invitation._id === invitationId
          ? { ...invitation, status: action, ...invitationMeta(action) }
          : invitation
      ));
      this.setData({ invitations });
      wx.showToast({ title: action === 'accepted' ? '已接受邀约' : '已婉拒邀约', icon: 'success' });
    } catch (error) {
      console.error('处理企业邀约失败', error);
      wx.showToast({ title: '服务暂时不可用，请重试', icon: 'none' });
    } finally {
      this.setData({
        respondingInvitationId: '',
        respondingInvitationAction: '',
      });
    }
  },

  applyJob(event) {
    if (this.data.applyingJobId) return;
    const jobId = event.currentTarget.dataset.id;
    const job = this.data.opportunities.find((item) => item._id === jobId);
    if (!job) return;
    if (job.applicationStatus) {
      wx.showToast({ title: job.applicationLabel, icon: 'none' });
      return;
    }
    wx.showModal({
      title: `申请${job.type}`,
      content: `确认向${job.companyName || '该企业'}申请“${job.title}”吗？企业会在工作台看到你的申请。`,
      confirmText: '确认申请',
      success: (result) => {
        if (result.confirm) this.submitJobApplication(jobId);
      },
    });
  },

  async submitJobApplication(jobId) {
    this.setData({ applyingJobId: jobId });
    try {
      const res = await wx.cloud.callFunction({
        name: 'applyJob',
        data: {
          uid: this.uid,
          sessionToken: this.sessionToken,
          jobId,
          message: '',
        },
      });
      const result = res.result || {};
      if (auth.handleExpired(result)) return;
      if (result.code !== 0) {
        wx.showToast({ title: result.msg || '申请失败', icon: 'none' });
        return;
      }
      const opportunities = this.data.opportunities.map((job) => (
        job._id === jobId
          ? {
            ...job,
            applicationId: result.applicationId || job.applicationId,
            applicationStatus: result.status || 'pending',
            ...applicationMeta(result.status || 'pending'),
          }
          : job
      ));
      this.setData({ opportunities });
      wx.showToast({ title: result.duplicated ? '已经申请过了' : '申请已发送', icon: 'success' });
    } catch (error) {
      console.error('申请企业岗位失败', error);
      wx.showToast({ title: '申请服务暂时不可用', icon: 'none' });
    } finally {
      this.setData({ applyingJobId: '' });
    }
  },
});
