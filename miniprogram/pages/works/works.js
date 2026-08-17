// pages/works/works.js
const auth = require('../../utils/auth');

function compactHash(hash) {
  if (!hash) return '';
  const value = String(hash).startsWith('0x') ? String(hash) : `0x${hash}`;
  return value.length > 24 ? `${value.slice(0, 12)}...${value.slice(-8)}` : value;
}

function formatDate(value) {
  if (!value) return '近期上传';
  const date = value.$date ? new Date(value.$date) : new Date(value);
  if (Number.isNaN(date.getTime())) return '近期上传';
  return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, '0')}.${String(date.getDate()).padStart(2, '0')}`;
}

Page({
  data: {
    works: [],
    loading: true,
    error: '',
    showForm: false,
    title: '',
    desc: '',
    coverPath: '',
    coverFileId: '',
    uploading: false,
    submitting: false,
    requestId: '',
  },

  onShow() {
    this.load();
  },

  async load() {
    const session = auth.getSession();
    if (!session) return;
    this.uid = session.uid;
    this.sessionToken = session.sessionToken;
    this.setData({ loading: true, error: '' });
    try {
      const res = await wx.cloud.callFunction({
        name: 'getArchive',
        data: { ...session, privateView: true },
      });
      const result = res.result || {};
      if (auth.handleExpired(result)) return;
      if (result.code !== 0 || !result.data) {
        this.setData({ loading: false, error: result.msg || '作品加载失败，请稍后重试' });
        return;
      }
      const works = (result.data.works || []).map((work) => ({
        ...work,
        createdLabel: formatDate(work.createdAt),
        displayHash: compactHash(work.copyrightHash),
        hashVisible: false,
      }));
      this.setData({ works, loading: false, error: '' });
    } catch (error) {
      console.error('作品列表加载失败', error);
      this.setData({ loading: false, error: '网络连接失败，请检查后重试' });
    }
  },

  openForm() {
    this.setData({
      showForm: true,
      title: '',
      desc: '',
      coverPath: '',
      coverFileId: '',
      uploading: false,
      requestId: `work.${Date.now()}.${Math.random().toString(36).slice(2, 10)}`,
    });
  },

  closeForm() {
    if (this.data.submitting || this.data.uploading) {
      wx.showToast({ title: this.data.uploading ? '图片仍在上传，请稍候' : '作品正在提交', icon: 'none' });
      return;
    }
    const unusedFileId = this.data.coverFileId;
    this.setData({
      showForm: false,
      title: '',
      desc: '',
      coverPath: '',
      coverFileId: '',
      requestId: '',
    });
    if (unusedFileId) {
      wx.cloud.deleteFile({ fileList: [unusedFileId] }).catch(() => {});
    }
  },

  noop() {},
  onTitle(event) { this.setData({ title: event.detail.value }); },
  onDesc(event) { this.setData({ desc: event.detail.value }); },

  async chooseCover() {
    if (this.data.uploading || this.data.submitting) return;
    const previousFileId = this.data.coverFileId;
    const previousCoverPath = this.data.coverPath;
    let previewChanged = false;
    try {
      const chooseResult = await wx.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sizeType: ['compressed'],
      });
      if (!chooseResult.tempFiles || !chooseResult.tempFiles[0]) return;
      const tempFile = chooseResult.tempFiles[0];
      if (tempFile.size && tempFile.size > 10 * 1024 * 1024) {
        wx.showToast({ title: '图片不能超过 10MB', icon: 'none' });
        return;
      }

      const tempPath = tempFile.tempFilePath;
      previewChanged = true;
      // 新文件上传成功前保留旧 fileID；提交按钮在上传中会被拦截。
      this.setData({ coverPath: tempPath, uploading: true });
      const extensionMatch = tempPath.match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
      const extension = extensionMatch ? extensionMatch[1].toLowerCase() : 'jpg';
      const cloudPath = `works/${this.uid}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extension}`;
      const uploadResult = await wx.cloud.uploadFile({ cloudPath, filePath: tempPath });
      this.setData({ coverFileId: uploadResult.fileID, uploading: false });
      if (previousFileId) {
        wx.cloud.deleteFile({ fileList: [previousFileId] }).catch(() => {});
      }
      wx.showToast({ title: '封面已上传', icon: 'success' });
    } catch (error) {
      const message = String((error && error.errMsg) || '').toLowerCase();
      this.setData({
        uploading: false,
        ...(previewChanged
          ? { coverPath: previousCoverPath, coverFileId: previousFileId }
          : {}),
      });
      if (message.includes('cancel')) return;
      console.error('作品封面上传失败', error);
      wx.showToast({ title: '图片上传失败，请重试', icon: 'none' });
    }
  },

  async submit() {
    const title = this.data.title.trim();
    const desc = this.data.desc.trim();
    if (!title) {
      wx.showToast({ title: '请填写作品标题', icon: 'none' });
      return;
    }
    if (this.data.uploading) {
      wx.showToast({ title: '请等待封面上传完成', icon: 'none' });
      return;
    }
    if (this.data.submitting) return;

    this.setData({ submitting: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'addWork',
        data: {
          uid: this.uid,
          sessionToken: this.sessionToken,
          title,
          desc,
          coverFileId: this.data.coverFileId,
          requestId: this.data.requestId,
        },
      });
      const result = res.result || {};
      if (auth.handleExpired(result)) return;
      if (result.code !== 0) {
        wx.showToast({ title: result.msg || '作品提交失败', icon: 'none' });
        return;
      }
      wx.showToast({ title: '作品已生成哈希记录', icon: 'success' });
      this.setData({
        showForm: false,
        title: '',
        desc: '',
        coverPath: '',
        coverFileId: '',
        requestId: '',
      });
      this.load();
    } catch (error) {
      console.error('作品提交失败', error);
      wx.showToast({ title: '提交失败，请稍后重试', icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
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
