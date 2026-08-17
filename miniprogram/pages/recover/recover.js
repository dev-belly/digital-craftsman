const auth = require('../../utils/auth.js');
const app = getApp();

function normalizeAccount(value, role) {
  const account = String(value || '').trim();
  return role === 'enterprise' ? account.toUpperCase() : account;
}

function normalizeFoundAccounts(result, role) {
  const source = result && Array.isArray(result.accounts) ? result.accounts : [];
  const seen = Object.create(null);
  return source.map((item) => {
    const detail = typeof item === 'string' ? { account: item } : (item || {});
    const account = normalizeAccount(detail.account, role);
    if (!/^[0-9A-Za-z_-]{6,20}$/.test(account) || seen[account]) return null;
    seen[account] = true;
    return {
      account,
      displayName: String(detail.displayName || detail.name || '').trim(),
    };
  }).filter(Boolean);
}

function getLookupErrorTitle(code) {
  if (code === 404) return '没有找到该账号';
  if (code === 409) return '当前微信无法验证';
  if (code === 403) return '账号暂时不可用';
  return '账号查询失败';
}

function getInitialAccount(options, role) {
  let value = options && options.account;

  // 登录页目前只传角色；若用户已在登录框输入账号，自动带入找回页。
  if (!value) {
    try {
      const pages = getCurrentPages();
      const previousPage = pages.length > 1 ? pages[pages.length - 2] : null;
      value = previousPage && previousPage.data && previousPage.data.account;
    } catch (error) {}
  }

  // 兼容从其他入口直接打开找回页的情况。
  if (!value) {
    try {
      value = wx.getStorageSync(role === 'enterprise' ? 'enterpriseAccount' : 'campusAccount');
    } catch (error) {}
  }

  return normalizeAccount(value, role);
}

Page({
  data: {
    role: 'student',
    account: '',
    accountInput: '',
    displayName: '',
    bindingFound: false,
    lookupLoading: false,
    findAccountsLoading: false,
    resetLoading: false,
    errorMessage: '',
    lookupErrorTitle: '',
    accountFinderState: '',
    accountFinderMessage: '',
    foundAccounts: [],
    resetErrorMessage: '',
    newPassword: '',
    confirmPassword: '',
    passwordVisible: false,
    confirmPasswordVisible: false,
  },

  onLoad(options = {}) {
    const role = options.role === 'enterprise' ? 'enterprise' : 'student';
    this.setData({ role, accountInput: getInitialAccount(options, role) });
  },

  switchRole(event) {
    if (this.data.lookupLoading || this.data.findAccountsLoading || this.data.resetLoading) return;
    const role = event.currentTarget.dataset.role === 'enterprise' ? 'enterprise' : 'student';
    if (role === this.data.role) return;
    this.setData({
      role,
      account: '',
      accountInput: '',
      displayName: '',
      bindingFound: false,
      errorMessage: '',
      lookupErrorTitle: '',
      accountFinderState: '',
      accountFinderMessage: '',
      foundAccounts: [],
      resetErrorMessage: '',
      newPassword: '',
      confirmPassword: '',
    });
  },

  onAccountInput(event) {
    const rawValue = String(event.detail.value || '');
    const accountInput = this.data.role === 'enterprise' ? rawValue.toUpperCase() : rawValue;
    const normalizedInput = normalizeAccount(accountInput, this.data.role);
    const changedVerifiedAccount = this.data.bindingFound
      && normalizedInput !== this.data.account;
    this.setData({
      accountInput,
      errorMessage: '',
      lookupErrorTitle: '',
      accountFinderState: '',
      accountFinderMessage: '',
      foundAccounts: [],
      resetErrorMessage: '',
      ...(changedVerifiedAccount ? {
        account: '',
        displayName: '',
        bindingFound: false,
        newPassword: '',
        confirmPassword: '',
      } : {}),
    });
  },

  onNewPasswordInput(event) {
    this.setData({ newPassword: event.detail.value, resetErrorMessage: '' });
  },

  onConfirmPasswordInput(event) {
    this.setData({ confirmPassword: event.detail.value, resetErrorMessage: '' });
  },

  togglePassword() {
    this.setData({ passwordVisible: !this.data.passwordVisible });
  },

  toggleConfirmPassword() {
    this.setData({ confirmPasswordVisible: !this.data.confirmPasswordVisible });
  },

  copyAccount() {
    if (!this.data.account) return;
    wx.setClipboardData({ data: this.data.account });
  },

  goPrivacy() {
    wx.navigateTo({ url: '/pages/privacy/privacy' });
  },

  backToLogin() {
    const role = this.data.role;
    const account = encodeURIComponent(normalizeAccount(
      this.data.account || this.data.accountInput,
      role,
    ));
    wx.reLaunch({ url: `/pages/login/login?role=${role}&account=${account}` });
  },

  async useFoundAccount(account) {
    const normalized = normalizeAccount(account, this.data.role);
    if (!normalized) return;
    await new Promise((resolve) => {
      this.setData({
        account: '',
        accountInput: normalized,
        displayName: '',
        bindingFound: false,
        accountFinderState: '',
        accountFinderMessage: '',
        foundAccounts: [],
        errorMessage: '',
        lookupErrorTitle: '',
      }, resolve);
    });
    await this.lookupAccount();
  },

  async selectFoundAccount(event) {
    if (this.data.lookupLoading || this.data.findAccountsLoading || this.data.resetLoading) return;
    const index = Number(event.currentTarget.dataset.index);
    const selected = this.data.foundAccounts[index];
    if (!selected || !selected.account) return;
    await this.useFoundAccount(selected.account);
  },

  async findAccounts() {
    if (this.data.lookupLoading || this.data.findAccountsLoading || this.data.resetLoading) return;
    const role = this.data.role;
    let accountToVerify = '';
    this.setData({
      findAccountsLoading: true,
      accountFinderState: '',
      accountFinderMessage: '',
      foundAccounts: [],
      errorMessage: '',
      lookupErrorTitle: '',
      resetErrorMessage: '',
    });
    try {
      const res = await wx.cloud.callFunction({
        name: 'recoverAccount',
        data: { action: 'findAccounts', role },
      });
      const result = res.result || {};
      if (result.code !== 0) {
        this.setData({
          accountFinderState: 'error',
          accountFinderMessage: result.msg || '当前微信的账号查询失败，请稍后重试',
        });
        return;
      }

      const accounts = normalizeFoundAccounts(result, role);
      if (!accounts.length) {
        const roleName = role === 'enterprise' ? '企业' : '学生';
        this.setData({
          accountFinderState: 'empty',
          accountFinderMessage: result.msg
            || `当前微信暂未找到已绑定的${roleName}账号，请确认账号类型是否正确`,
        });
        return;
      }
      if (accounts.length === 1) {
        accountToVerify = accounts[0].account;
        return;
      }
      this.setData({
        accountFinderState: 'results',
        accountFinderMessage: `找到 ${accounts.length} 个已安全绑定的账号，请选择一个继续`,
        foundAccounts: accounts,
      });
    } catch (error) {
      console.error('按微信查询账号失败', error);
      const message = String((error && (error.errMsg || error.message)) || error || '');
      this.setData({
        accountFinderState: 'error',
        accountFinderMessage: /timeout|超时/i.test(message)
          ? '查询处理超时，请稍后重试'
          : '暂时无法连接账号查询服务，请检查网络后重试',
      });
    } finally {
      if (accountToVerify) {
        // 先直接关闭实例侧的互斥标记；再由 useFoundAccount 等待账号
        // 写入完成后继续验证，避免连续 setData 的时序竞争。
        this.data.findAccountsLoading = false;
        this.setData({ findAccountsLoading: false }, async () => {
          await this.useFoundAccount(accountToVerify);
        });
      } else {
        this.setData({ findAccountsLoading: false });
      }
    }
  },

  async lookupAccount() {
    if (this.data.lookupLoading || this.data.findAccountsLoading || this.data.resetLoading) return;
    const role = this.data.role;
    const account = normalizeAccount(this.data.accountInput, role);
    if (!account) {
      this.setData({
        lookupErrorTitle: '请先输入账号',
        errorMessage: '请输入要找回的账号',
      });
      return;
    }
    if (!/^[0-9A-Za-z_-]{6,20}$/.test(account)) {
      this.setData({
        accountInput: account,
        lookupErrorTitle: '账号格式不正确',
        errorMessage: '账号须为 6—20 位字母、数字、下划线或短横线',
      });
      return;
    }
    this.setData({
      accountInput: account,
      lookupLoading: true,
      errorMessage: '',
      lookupErrorTitle: '',
      accountFinderState: '',
      accountFinderMessage: '',
      foundAccounts: [],
      resetErrorMessage: '',
      bindingFound: false,
    });
    try {
      const res = await wx.cloud.callFunction({
        name: 'recoverAccount',
        data: { action: 'lookup', role, account },
      });
      const result = res.result || {};
      if (result.code !== 0 || !result.account) {
        const roleName = role === 'enterprise' ? '企业' : '学生';
        this.setData({
          account: '',
          displayName: '',
          lookupErrorTitle: getLookupErrorTitle(result.code),
          errorMessage: result.code === 404 && !result.msg
            ? `没有找到${roleName}账号「${account}」，请确认账号是否正确`
            : result.msg || '没有找到该账号',
        });
        return;
      }
      this.setData({
        account: normalizeAccount(result.account, role),
        accountInput: normalizeAccount(result.account, role),
        displayName: result.displayName || '',
        bindingFound: true,
        errorMessage: '',
      });
    } catch (error) {
      console.error('找回账号失败', error);
      const message = String((error && (error.errMsg || error.message)) || error || '');
      this.setData({
        lookupErrorTitle: /timeout|超时/i.test(message) ? '查询处理超时' : '无法连接找回服务',
        errorMessage: /timeout|超时/i.test(message)
          ? '查询处理超时，请重试'
          : '找回服务暂时不可用，请检查网络后重试',
      });
    } finally {
      this.setData({ lookupLoading: false });
    }
  },

  validatePassword() {
    const password = this.data.newPassword;
    if (password.length < 8 || password.length > 32) return '密码长度应为 8—32 位';
    if (/\s/.test(password)) return '密码不能包含空格';
    if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
      return '密码必须同时包含字母和数字';
    }
    if (password !== this.data.confirmPassword) return '两次输入的密码不一致';
    return '';
  },

  async resetPassword() {
    if (this.data.lookupLoading
      || this.data.findAccountsLoading
      || this.data.resetLoading
      || !this.data.bindingFound) return;
    const validationError = this.validatePassword();
    if (validationError) {
      this.setData({ resetErrorMessage: validationError });
      wx.showToast({ title: validationError, icon: 'none', duration: 2600 });
      return;
    }

    this.setData({ resetLoading: true, resetErrorMessage: '' });
    try {
      const res = await wx.cloud.callFunction({
        name: 'recoverAccount',
        data: {
          action: 'resetPassword',
          role: this.data.role,
          account: this.data.account,
          newPassword: this.data.newPassword,
        },
      });
      const result = res.result || {};
      if (result.code !== 0 || !result.account) {
        const message = result.msg || '密码重置失败';
        if (result.code === 404 || result.code === 409) {
          this.setData({
            bindingFound: false,
            account: '',
            displayName: '',
            newPassword: '',
            confirmPassword: '',
            lookupErrorTitle: getLookupErrorTitle(result.code),
            errorMessage: message,
            resetErrorMessage: '',
          });
        } else {
          this.setData({ resetErrorMessage: message });
        }
        wx.showToast({ title: message, icon: 'none', duration: 2800 });
        return;
      }

      if (this.data.role === 'enterprise') auth.clearEnterpriseSession();
      else {
        auth.clearStudentSession();
        app.globalData.user = null;
      }

      const role = this.data.role;
      const account = result.account;
      wx.showModal({
        title: '密码已重置',
        content: `账号：${account}\n请使用刚设置的新密码登录。`,
        showCancel: false,
        confirmText: '去登录',
        success: () => {
          wx.reLaunch({
            url: `/pages/login/login?role=${role}&account=${encodeURIComponent(account)}`,
          });
        },
      });
    } catch (error) {
      console.error('重置密码失败', error);
      const message = String((error && (error.errMsg || error.message)) || error || '');
      const resetErrorMessage = /timeout|超时/i.test(message)
        ? '重置处理超时，请重试'
        : '重置服务暂时不可用，请检查网络后重试';
      this.setData({ resetErrorMessage });
      wx.showToast({
        title: resetErrorMessage,
        icon: 'none',
        duration: 2800,
      });
    } finally {
      this.setData({ resetLoading: false });
    }
  },
});
