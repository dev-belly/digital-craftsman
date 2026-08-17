// pages/archive/archive.js
// 数字档案公开/私有查看页。
// 数据来自 getArchive 云函数：{ code, data: { user, stages, works, certifications, evaluations } }
// 私有查看（学生本人）需携带 sessionToken；扫码/分享进入为公开查看，仅需 uid。
const auth = require('../../utils/auth');

function compactHash(hash) {
  if (!hash) return '';
  const value = String(hash).startsWith('0x') ? String(hash) : `0x${hash}`;
  return value.length > 30 ? `${value.slice(0, 14)}...${value.slice(-10)}` : value;
}

function formatDate(value) {
  if (!value) return '近期';
  const date = value.$date ? new Date(value.$date) : new Date(value);
  if (Number.isNaN(date.getTime())) return '近期';
  return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, '0')}.${String(date.getDate()).padStart(2, '0')}`;
}

function stageStatusLabel(status) {
  if (status === 'done') return '已完成';
  if (status === 'doing') return '进行中';
  return '待解锁';
}

function scoreLevel(index) {
  if (index >= 85) return '卓越工匠';
  if (index >= 70) return '优秀';
  if (index >= 50) return '进阶中';
  if (index >= 25) return '成长中';
  return '新起航';
}

function decodeValue(value) {
  let text = String(value || '');
  try {
    text = decodeURIComponent(text);
  } catch (error) {
    // 非 URL 编码内容，原样返回
  }
  return text;
}

// options 可能携带 uid（直接跳转）或 scene（扫码进入的 querystring）
function parseUidFromOptions(options) {
  const raw = options && (options.uid || options.scene);
  if (!raw) return '';
  let text = decodeValue(raw);
  const match = text.match(/[?&#]uid=([^&#]+)/i);
  if (match) text = decodeValue(match[1]);
  return text.trim();
}

Page({
  data: {
    uid: '',
    privateView: false,
    loading: true,
    notFound: false,
    error: '',
    errorMessage: '',
    user: null,
    userInitial: '匠',
    talentIndexDisplay: 0,
    talentProgress: 0,
    scoreLevel: '新起航',
    works: [],
    certifications: [],
    evaluations: [],
    timeline: [],
    completedStageCount: 0,
  },

  onLoad(options) {
    const privateView = !!(options && options.privateView === '1');
    let uid = parseUidFromOptions(options);

    // 学生查看自己的档案但未带 uid 时，回退到本机会话。
    if (!uid && privateView) {
      const session = auth.getSession();
      if (!session) return; // getSession 会跳转到登录页
      uid = session.uid;
      this.sessionToken = session.sessionToken;
    }

    this.privateView = privateView;
    this.uid = uid;
    this.setData({ uid, privateView });

    if (!uid) {
      this.setData({ loading: false, notFound: true });
      return;
    }
    this.load();
  },

  load() {
    if (!this.uid) {
      this.setData({ loading: false, notFound: true });
      return;
    }

    let sessionToken = '';
    if (this.privateView) {
      const session = auth.getSession();
      if (!session) return;
      sessionToken = session.sessionToken;
      this.sessionToken = sessionToken;
    }

    const data = {
      uid: this.uid,
      privateView: this.privateView,
      trackScan: !this.privateView,
    };
    if (sessionToken) data.sessionToken = sessionToken;

    this.setData({ loading: true, notFound: false, error: '', errorMessage: '' });

    wx.cloud.callFunction({ name: 'getArchive', data })
      .then((res) => {
        const result = (res && res.result) || {};
        if (this.privateView && auth.handleExpired(result)) return;

        if (result.code === 404 || result.code === 403) {
          this.setData({ loading: false, notFound: true });
          return;
        }
        if (result.code !== 0 || !result.data) {
          this.setData({
            loading: false,
            error: true,
            errorMessage: result.msg || '档案加载失败，请稍后重试',
          });
          return;
        }
        this.renderArchive(result.data);
      })
      .catch((error) => {
        console.error('档案加载失败', error);
        this.setData({
          loading: false,
          error: true,
          errorMessage: '云端连接失败，请检查网络后重试',
        });
      });
  },

  renderArchive(archive) {
    const user = {
      ...(archive.user || {}),
      skillTags: Array.isArray(archive.user && archive.user.skillTags)
        ? archive.user.skillTags : [],
    };
    const talentIndex = Number(user.talentIndex) || 0;

    const works = (archive.works || []).map((work) => ({
      ...work,
      createdLabel: formatDate(work.createdAt),
      titleInitial: String(work.title || '作').slice(0, 1),
      coverUrl: work.coverUrl || '',
      displayHash: compactHash(work.copyrightHash),
      hashVisible: false,
    }));

    const certifications = (archive.certifications || []).map((cert) => ({ ...cert }));
    const evaluations = (archive.evaluations || []).map((item) => ({ ...item }));

    const stages = Array.isArray(archive.stages) ? archive.stages : [];
    const timeline = stages.map((stage, index) => ({
      stage: stage.stage,
      status: stage.status,
      statusLabel: stageStatusLabel(stage.status),
      dateLabel: stage.dateLabel || '',
      title: stage.title || stage.stage,
      description: stage.description || '',
      lineDone: index < stages.length - 1 && stage.status === 'done',
    }));
    const completedStageCount = stages.filter((stage) => stage.status === 'done').length;

    this.setData({
      user,
      userInitial: (user.name || '匠').slice(0, 1),
      talentIndexDisplay: talentIndex,
      talentProgress: talentIndex,
      scoreLevel: scoreLevel(talentIndex),
      works,
      certifications,
      evaluations,
      timeline,
      completedStageCount,
      loading: false,
      notFound: false,
      error: false,
      errorMessage: '',
    });
  },

  retryLoad() {
    this.load();
  },

  toggleHash(event) {
    const index = Number(event.currentTarget.dataset.index);
    if (!Number.isInteger(index) || !this.data.works[index]) return;
    const works = this.data.works.map((work, workIndex) => ({
      ...work,
      hashVisible: workIndex === index ? !work.hashVisible : false,
    }));
    this.setData({ works });
  },

  copyHash(event) {
    const index = Number(event.currentTarget.dataset.index);
    const work = this.data.works[index];
    if (!work || !work.copyrightHash) {
      wx.showToast({ title: '暂无可复制的哈希', icon: 'none' });
      return;
    }
    const value = String(work.copyrightHash).startsWith('0x')
      ? String(work.copyrightHash) : `0x${work.copyrightHash}`;
    wx.setClipboardData({
      data: value,
      success: () => wx.showToast({ title: '完整哈希已复制', icon: 'success' }),
      fail: () => wx.showToast({ title: '复制失败，请重试', icon: 'none' }),
    });
  },
});
