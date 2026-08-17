// pages/certs/certs.js
const auth = require('../../utils/auth');

function normalizeHash(hash) {
  if (!hash) return '';
  const value = String(hash);
  return value.startsWith('0x') ? value : `0x${value}`;
}

Page({
  data: { certs: [], loading: true, error: '' },
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
        this.setData({ loading: false, error: result.msg || '认证记录加载失败' });
        return;
      }
      const certificationRows = Array.isArray(result.data.certifications)
        ? result.data.certifications : [];
      const certs = certificationRows.map((cert) => ({
        ...cert,
        fullHash: normalizeHash(cert.certHash),
        hashVisible: false,
      }));
      this.setData({
        certs,
        loading: false,
        error: '',
      });
    } catch (error) {
      console.error('认证记录加载失败', error);
      this.setData({ loading: false, error: '网络连接失败，请检查后重试' });
    }
  },

  toggleHash(event) {
    const index = Number(event.currentTarget.dataset.index);
    const cert = this.data.certs[index];
    if (!Number.isInteger(index) || !cert) return;
    if (!cert.certHash) {
      wx.showToast({ title: '该凭证的哈希记录待生成', icon: 'none' });
      return;
    }
    const certs = this.data.certs.map((item, itemIndex) => ({
      ...item,
      hashVisible: itemIndex === index ? !item.hashVisible : false,
    }));
    this.setData({ certs });
  },

  copyHash(event) {
    const index = Number(event.currentTarget.dataset.index);
    const cert = this.data.certs[index];
    if (!Number.isInteger(index) || !cert || !cert.fullHash) {
      wx.showToast({ title: '暂无可复制的哈希', icon: 'none' });
      return;
    }
    wx.setClipboardData({
      data: cert.fullHash,
      success: () => wx.showToast({ title: '完整哈希已复制', icon: 'success' }),
      fail: () => wx.showToast({ title: '复制失败，请重试', icon: 'none' }),
    });
  },
});
