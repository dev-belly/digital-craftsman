// pages/evaluations/evaluations.js
const auth = require('../../utils/auth');

function normalizeHash(hash) {
  if (!hash) return '';
  const value = String(hash);
  return value.startsWith('0x') ? value : `0x${value}`;
}

Page({
  data: { evals: [], loading: true, error: '' },
  onShow() { this.load(); },
  async load() {
    const session = auth.getSession();
    if (!session) return;
    this.setData({ loading: true, error: '' });
    try {
      const res = await wx.cloud.callFunction({
        name: 'getArchive',
        data: { ...session, privateView: true },
      });
      const result = res.result || {};
      if (auth.handleExpired(result)) return;
      if (result.code !== 0 || !result.data) {
        this.setData({ loading: false, error: result.msg || '评价记录加载失败' });
        return;
      }
      const evaluationRows = Array.isArray(result.data.evaluations)
        ? result.data.evaluations : [];
      const evals = evaluationRows.map((evaluation) => ({
        ...evaluation,
        fullHash: normalizeHash(evaluation.evidenceHash),
        hashVisible: false,
      }));
      this.setData({ evals, loading: false, error: '' });
    } catch (error) {
      console.error('企业评价加载失败', error);
      this.setData({ loading: false, error: '网络连接失败，请检查后重试' });
    }
  },

  toggleHash(event) {
    const index = Number(event.currentTarget.dataset.index);
    const evaluation = this.data.evals[index];
    if (!Number.isInteger(index) || !evaluation) return;
    if (!evaluation.evidenceHash) {
      wx.showToast({ title: '该评价的哈希记录待生成', icon: 'none' });
      return;
    }
    const evals = this.data.evals.map((item, itemIndex) => ({
      ...item,
      hashVisible: itemIndex === index ? !item.hashVisible : false,
    }));
    this.setData({ evals });
  },

  copyHash(event) {
    const index = Number(event.currentTarget.dataset.index);
    const evaluation = this.data.evals[index];
    if (!Number.isInteger(index) || !evaluation || !evaluation.fullHash) {
      wx.showToast({ title: '暂无可复制的哈希', icon: 'none' });
      return;
    }
    wx.setClipboardData({
      data: evaluation.fullHash,
      success: () => wx.showToast({ title: '完整哈希已复制', icon: 'success' }),
      fail: () => wx.showToast({ title: '复制失败，请重试', icon: 'none' }),
    });
  },
});
