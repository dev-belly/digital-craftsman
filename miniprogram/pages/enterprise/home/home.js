const auth = require('../../../utils/auth.js');

function safeDecode(value) {
  let text = String(value || '').trim();
  for (let index = 0; index < 2; index += 1) {
    try {
      const decoded = decodeURIComponent(text);
      if (decoded === text) break;
      text = decoded;
    } catch (error) {
      break;
    }
  }
  return text;
}

function normalizeArchiveUid(value) {
  const text = safeDecode(value);
  return /^(?:demo|stu)-[a-z0-9_-]+$/i.test(text) ? text : '';
}

function parseArchiveUid(value) {
  if (!value) return '';

  const queue = [String(value)];
  const visited = {};
  while (queue.length) {
    const source = queue.shift();
    const text = safeDecode(source);
    if (!text || visited[text]) continue;
    visited[text] = true;

    const directUid = normalizeArchiveUid(text);
    if (directUid) return directUid;

    const params = [];
    const paramPattern = /(?:^|[?&#])(uid|scene)=([^&#]+)/gi;
    let match = paramPattern.exec(text);
    while (match) {
      params.push({ key: match[1].toLowerCase(), value: match[2] });
      match = paramPattern.exec(text);
    }

    // uid 比 scene 更明确，优先取 uid；scene 仍可继续解析 uid=xxx 或直接 uid。
    params.sort((left, right) => (left.key === 'uid' ? -1 : 1)
      - (right.key === 'uid' ? -1 : 1));
    for (let index = 0; index < params.length; index += 1) {
      const candidate = normalizeArchiveUid(params[index].value);
      if (candidate) return candidate;
      queue.push(params[index].value);
    }
  }

  return '';
}

function getEnterpriseSession() {
  return auth.getEnterpriseSession();
}

function formatDate(value) {
  if (!value) return '刚刚发布';
  const date = value.$date ? new Date(value.$date) : new Date(value);
  if (Number.isNaN(date.getTime())) return '近期发布';
  return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, '0')}.${String(date.getDate()).padStart(2, '0')}`;
}

function responseMeta(status) {
  if (status === 'accepted') return { statusLabel: '已接受', statusClass: 'accepted' };
  if (status === 'declined') return { statusLabel: '已婉拒', statusClass: 'declined' };
  return { statusLabel: '待处理', statusClass: 'pending' };
}

Page({
  data: {
    company: null,
    keyword: '',
    minIndex: '',
    talents: [],
    jobs: [],
    invitations: [],
    applications: [],
    loading: true,
    error: '',
    showEvalSheet: false,
    showInviteSheet: false,
    showCertSheet: false,
    showJobSheet: false,
    selectedTalent: null,
    evalScore: 90,
    evalMentor: '',
    evalContent: '',
    evalRequestId: '',
    inviteType: '面试',
    inviteMessage: '',
    certName: '',
    certLevel: '初级',
    certSerialNo: '',
    certRequestId: '',
    jobTitle: '',
    jobType: '实习',
    jobDesc: '',
    jobLocation: '',
    submitting: false,
    managingApplicationId: '',
    managingApplicationAction: '',
  },

  onShow() {
    const session = getEnterpriseSession();
    if (!session) return;
    this.company = session.company;
    this.enterpriseSessionToken = session.enterpriseSessionToken;
    this.setData({ company: session.company });
    this.loadTalents();
  },

  onUnload() {
    this.talentRequestSeq = (this.talentRequestSeq || 0) + 1;
  },

  onPullDownRefresh() {
    this.loadTalents().finally(() => wx.stopPullDownRefresh());
  },

  handleAuthExpired(result) {
    if (result && result.code === 401) {
      wx.showToast({ title: '企业登录已失效', icon: 'none' });
      auth.clearEnterpriseSession();
      wx.reLaunch({ url: '/pages/login/login' });
      return true;
    }
    return false;
  },

  onKeywordInput(event) { this.setData({ keyword: event.detail.value }); },
  onMinIndexInput(event) { this.setData({ minIndex: event.detail.value }); },
  onEvalMentorInput(event) { this.setData({ evalMentor: event.detail.value }); },
  onEvalContentInput(event) { this.setData({ evalContent: event.detail.value }); },
  onEvalScoreChange(event) { this.setData({ evalScore: Number(event.detail.value) }); },
  onInviteMessageInput(event) { this.setData({ inviteMessage: event.detail.value }); },
  onInviteTypeChange(event) {
    this.setData({ inviteType: Number(event.detail.value) === 1 ? '实习' : '面试' });
  },
  onCertNameInput(event) { this.setData({ certName: event.detail.value }); },
  onCertSerialInput(event) { this.setData({ certSerialNo: event.detail.value }); },
  onCertLevelChange(event) {
    const levels = ['初级', '中级', '高级'];
    this.setData({ certLevel: levels[Number(event.detail.value)] || '初级' });
  },
  onJobTitleInput(event) { this.setData({ jobTitle: event.detail.value }); },
  onJobDescInput(event) { this.setData({ jobDesc: event.detail.value }); },
  onJobLocationInput(event) { this.setData({ jobLocation: event.detail.value }); },
  onJobTypeChange(event) {
    const types = ['实训', '实习', '正式岗位'];
    this.setData({ jobType: types[Number(event.detail.value)] || '实训' });
  },
  noop() {},

  async loadTalents() {
    const session = getEnterpriseSession();
    if (!session) return;
    this.company = session.company;
    this.enterpriseSessionToken = session.enterpriseSessionToken;
    const requestSeq = (this.talentRequestSeq || 0) + 1;
    this.talentRequestSeq = requestSeq;
    this.setData({ loading: true, error: '' });
    try {
      const res = await wx.cloud.callFunction({
        name: 'listTalents',
        data: {
          enterpriseSessionToken: session.enterpriseSessionToken,
          keyword: this.data.keyword.trim(),
          minIndex: Number(this.data.minIndex) || 0,
          includeStageSummary: true,
          demoOnly: false,
        },
      });
      if (requestSeq !== this.talentRequestSeq) return;
      const result = res.result || {};
      if (this.handleAuthExpired(result)) return;
      if (result.code !== 0) {
        wx.showToast({ title: result.msg || '人才池加载失败', icon: 'none' });
        this.setData({ loading: false, error: result.msg || '人才池加载失败' });
        return;
      }
      const jobs = (result.jobs || []).map((job) => ({
        ...job,
        createdLabel: formatDate(job.createdAt),
        statusLabel: job.status === 'closed' ? '已关闭' : '招聘中',
      }));
      const talents = (result.talents || []).map((talent) => ({
        ...talent,
        displayName: String(talent.name || '未命名学生'),
        initial: String(talent.name || '匠').slice(0, 1),
      }));
      const invitations = (result.invitations || []).map((invitation) => ({
        ...invitation,
        createdLabel: formatDate(invitation.createdAt),
        ...responseMeta(invitation.status),
      }));
      const applications = (result.applications || []).map((application) => ({
        ...application,
        createdLabel: formatDate(application.createdAt),
        ...responseMeta(application.status),
      }));
      this.setData({
        talents,
        jobs,
        invitations,
        applications,
        loading: false,
        error: '',
      });
    } catch (error) {
      if (requestSeq !== this.talentRequestSeq) return;
      console.error('企业人才池加载失败', {
        requestID: error && (error.requestID || error.requestId),
        errMsg: error && error.errMsg,
        error,
      });
      this.setData({ loading: false, error: '企业服务暂时不可用，请检查网络后重试' });
      wx.showToast({ title: '企业服务暂时不可用', icon: 'none' });
    }
  },

  search() {
    this.loadTalents();
  },

  goChangePassword() {
    wx.navigateTo({
      url: '/pages/password/password?role=enterprise',
      fail: () => wx.showToast({ title: '密码页面打开失败', icon: 'none' }),
    });
  },

  scanArchive() {
    wx.scanCode({
      onlyFromCamera: false,
      success: (res) => {
        const uid = parseArchiveUid(res.path) || parseArchiveUid(res.result);
        if (!uid) {
          wx.showToast({ title: '未识别到学生档案码', icon: 'none' });
          return;
        }
        const talent = this.data.talents.find((item) => item._id === uid)
          || { _id: uid, name: '该学生' };
        wx.showActionSheet({
          itemList: ['查看档案', '颁发技能认证', '发送邀约', '提交企业评价'],
          success: (actionResult) => {
            if (actionResult.tapIndex === 0) {
              wx.navigateTo({ url: `/pages/archive/archive?uid=${encodeURIComponent(uid)}` });
              return;
            }
            this.setData({ selectedTalent: talent }, () => {
              const eventLike = { currentTarget: { dataset: { uid } } };
              if (actionResult.tapIndex === 1) this.openCert(eventLike);
              if (actionResult.tapIndex === 2) this.openInvite(eventLike);
              if (actionResult.tapIndex === 3) this.openEval(eventLike);
            });
          },
        });
      },
      fail: (error) => {
        const message = String((error && error.errMsg) || '').toLowerCase();
        if (message.includes('cancel')) {
          wx.showToast({ title: '已取消扫码', icon: 'none' });
          return;
        }
        if (message.includes('auth deny')
          || message.includes('authorize')
          || message.includes('permission')) {
          wx.showModal({
            title: '需要相机权限',
            content: '请在小程序设置中允许使用相机后重试。',
            confirmText: '去设置',
            success: (modalResult) => {
              if (modalResult.confirm) wx.openSetting();
            },
          });
          return;
        }
        wx.showToast({ title: '扫码失败，请稍后重试', icon: 'none' });
      },
    });
  },

  viewArchive(event) {
    const uid = event.currentTarget.dataset.uid;
    wx.navigateTo({ url: `/pages/archive/archive?uid=${uid}` });
  },

  openEval(event) {
    const uid = event.currentTarget.dataset.uid;
    const talent = this.data.talents.find((item) => item._id === uid)
      || (this.data.selectedTalent && this.data.selectedTalent._id === uid
        ? this.data.selectedTalent : { _id: uid, name: '该学生' });
    this.setData({
      selectedTalent: talent || null,
      showEvalSheet: true,
      evalScore: 90,
      evalMentor: this.data.company && this.data.company.contact ? this.data.company.contact : '',
      evalContent: '',
      evalRequestId: `evaluation.${Date.now()}.${Math.random().toString(36).slice(2, 10)}`,
    });
  },

  closeEval() {
    if (this.data.submitting) return;
    this.setData({ showEvalSheet: false });
  },

  async submitEval() {
    if (this.data.submitting || !this.data.selectedTalent) return;
    if (!this.data.evalContent.trim()) {
      wx.showToast({ title: '请填写评价内容', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'submitEvaluation',
        data: {
          enterpriseSessionToken: this.enterpriseSessionToken,
          uid: this.data.selectedTalent._id,
          mentorName: this.data.evalMentor.trim(),
          content: this.data.evalContent.trim(),
          score: this.data.evalScore,
          requestId: this.data.evalRequestId,
        },
      });
      const result = res.result || {};
      if (this.handleAuthExpired(result)) return;
      if (result.code !== 0) {
        wx.showToast({ title: result.msg || '评价提交失败', icon: 'none' });
        return;
      }
      wx.showToast({ title: '评价已生成校验记录', icon: 'success' });
      this.setData({ showEvalSheet: false });
      this.loadTalents();
    } catch (error) {
      console.error('提交企业评价失败', error);
      wx.showToast({ title: '提交失败', icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },

  openInvite(event) {
    const uid = event.currentTarget.dataset.uid;
    const talent = this.data.talents.find((item) => item._id === uid)
      || (this.data.selectedTalent && this.data.selectedTalent._id === uid
        ? this.data.selectedTalent : { _id: uid, name: '该学生' });
    this.setData({
      selectedTalent: talent || null,
      showInviteSheet: true,
      inviteType: '面试',
      inviteMessage: '',
    });
  },

  closeInvite() {
    if (this.data.submitting) return;
    this.setData({ showInviteSheet: false });
  },

  openCert(event) {
    const uid = event.currentTarget.dataset.uid;
    const talent = this.data.talents.find((item) => item._id === uid)
      || (this.data.selectedTalent && this.data.selectedTalent._id === uid
        ? this.data.selectedTalent : { _id: uid, name: '该学生' });
    this.setData({
      selectedTalent: talent || null,
      showCertSheet: true,
      certName: '',
      certLevel: '初级',
      certSerialNo: '',
      certRequestId: `cert.${Date.now()}.${Math.random().toString(36).slice(2, 10)}`,
    });
  },

  closeCert() {
    if (this.data.submitting) return;
    this.setData({ showCertSheet: false });
  },

  async submitCert() {
    if (this.data.submitting || !this.data.selectedTalent) return;
    const certName = this.data.certName.trim();
    if (!certName) {
      wx.showToast({ title: '请填写认证名称', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'issueCertification',
        data: {
          enterpriseSessionToken: this.enterpriseSessionToken,
          uid: this.data.selectedTalent._id,
          certName,
          level: this.data.certLevel,
          serialNo: this.data.certSerialNo.trim(),
          requestId: this.data.certRequestId,
        },
      });
      const result = res.result || {};
      if (this.handleAuthExpired(result)) return;
      if (result.code !== 0) {
        wx.showToast({ title: result.msg || '认证签发失败', icon: 'none' });
        return;
      }
      wx.showModal({
        title: result.duplicated ? '认证已存在' : '认证签发成功',
        content: result.evidenceHash
          ? `已生成哈希校验记录：${result.evidenceHash.slice(0, 18)}…`
          : '认证已经保存到学生数字档案。',
        showCancel: false,
      });
      this.setData({ showCertSheet: false });
      this.loadTalents();
    } catch (error) {
      console.error('企业签发认证失败', error);
      wx.showToast({ title: '签发失败，请稍后重试', icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },

  async submitInvite() {
    if (this.data.submitting || !this.data.selectedTalent) return;
    this.setData({ submitting: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'sendInvitation',
        data: {
          enterpriseSessionToken: this.enterpriseSessionToken,
          uid: this.data.selectedTalent._id,
          type: this.data.inviteType,
          message: this.data.inviteMessage.trim(),
        },
      });
      const result = res.result || {};
      if (this.handleAuthExpired(result)) return;
      if (result.code !== 0) {
        wx.showToast({ title: result.msg || '邀约发送失败', icon: 'none' });
        return;
      }
      wx.showToast({ title: '邀约已发送', icon: 'success' });
      this.setData({ showInviteSheet: false });
      this.loadTalents();
    } catch (error) {
      console.error('发送邀约失败', error);
      wx.showToast({ title: '发送失败', icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },

  openJob() {
    this.setData({
      showJobSheet: true,
      jobTitle: '',
      jobType: '实训',
      jobDesc: '',
      jobLocation: '',
    });
  },

  manageApplication(event) {
    if (this.data.managingApplicationId) return;
    const applicationId = event.currentTarget.dataset.id;
    const action = event.currentTarget.dataset.action;
    const accepting = action === 'accepted';
    wx.showModal({
      title: accepting ? '接受申请' : '婉拒申请',
      content: accepting ? '确认接受这位学生的申请吗？' : '确认婉拒这位学生的申请吗？',
      confirmText: accepting ? '接受' : '婉拒',
      confirmColor: accepting ? '#2457d6' : '#c73d3d',
      success: (result) => {
        if (result.confirm) this.submitApplicationResponse(applicationId, action);
      },
    });
  },

  async submitApplicationResponse(applicationId, action) {
    this.setData({
      managingApplicationId: applicationId,
      managingApplicationAction: action,
    });
    try {
      const res = await wx.cloud.callFunction({
        name: 'manageJobApplication',
        data: {
          enterpriseSessionToken: this.enterpriseSessionToken,
          applicationId,
          action,
        },
      });
      const result = res.result || {};
      if (this.handleAuthExpired(result)) return;
      if (result.code !== 0) {
        wx.showToast({ title: result.msg || '申请处理失败', icon: 'none' });
        return;
      }
      const applications = this.data.applications.map((application) => (
        application._id === applicationId
          ? { ...application, status: action, ...responseMeta(action) }
          : application
      ));
      this.setData({ applications });
      wx.showToast({ title: action === 'accepted' ? '已接受申请' : '已婉拒申请', icon: 'success' });
    } catch (error) {
      console.error('处理学生岗位申请失败', error);
      wx.showToast({ title: '申请处理服务暂时不可用', icon: 'none' });
    } finally {
      this.setData({ managingApplicationId: '', managingApplicationAction: '' });
    }
  },

  closeJob() {
    if (this.data.submitting) return;
    this.setData({ showJobSheet: false });
  },

  async submitJob() {
    if (this.data.submitting) return;
    if (!this.data.jobTitle.trim() || !this.data.jobDesc.trim()) {
      wx.showToast({ title: '请填写岗位名称和说明', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'postJob',
        data: {
          enterpriseSessionToken: this.enterpriseSessionToken,
          title: this.data.jobTitle.trim(),
          type: this.data.jobType,
          desc: this.data.jobDesc.trim(),
          location: this.data.jobLocation.trim(),
        },
      });
      const result = res.result || {};
      if (this.handleAuthExpired(result)) return;
      if (result.code !== 0) {
        wx.showToast({ title: result.msg || '岗位发布失败', icon: 'none' });
        return;
      }
      wx.showToast({ title: '岗位已发布', icon: 'success' });
      this.setData({ showJobSheet: false });
      this.loadTalents();
    } catch (error) {
      console.error('发布岗位失败', error);
      wx.showToast({ title: '发布失败', icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },

  logout() {
    wx.showModal({
      title: '退出企业端',
      content: '确认撤销本机企业登录并返回登录页吗？',
      confirmText: '退出',
      confirmColor: '#c73d3d',
      success: (result) => {
        if (result.confirm) this.performLogout();
      },
    });
  },

  async performLogout() {
    let revokeTask = null;
    if (this.enterpriseSessionToken) {
      try {
        revokeTask = wx.cloud.callFunction({
          name: 'logout',
          data: {
            role: 'enterprise',
            enterpriseSessionToken: this.enterpriseSessionToken,
          },
        })
          .then((res) => {
            const result = res.result || {};
            if (result.code !== 0) console.warn('云端企业会话撤销未完成', result.msg || result.code);
          })
          .catch((error) => console.warn('云端企业会话撤销未完成，本机已退出', error));
      } catch (error) {
        console.warn('云端企业会话撤销调用失败，本机继续退出', error);
      }
    }
    // 本机退出优先完成，云端令牌撤销作为后台安全操作。
    auth.clearEnterpriseSession();
    wx.reLaunch({ url: '/pages/login/login' });
    return revokeTask;
  },
});
