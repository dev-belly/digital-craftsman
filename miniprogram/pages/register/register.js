const app = getApp();

function emptyRegisterError() {
  return {
    registerErrorType: '',
    registerErrorLabel: '',
    registerErrorIcon: '!',
    registerErrorTitle: '',
    registerErrorMessage: '',
    registerErrorHint: '',
    registerErrorAction: '',
    registerErrorActionText: '',
  };
}

function errorDetails(result, error) {
  return [
    result && result.reason,
    result && result.errorType,
    result && result.msg,
    error && error.code,
    error && error.errCode,
    error && error.errMsg,
    error && error.message,
    error && error.cause && error.cause.message,
  ].filter(Boolean).join(' ');
}

function classifyRegisterFailure(result = {}, error) {
  const code = Number(result.code);
  const reason = String(result.reason || result.errorType || '').toLowerCase();
  const detail = errorDetails(result, error);
  const message = String(result.msg || '').trim();

  if (/timeout|超时/i.test(detail)) {
    return {
      type: 'timeout', label: '请求超时', icon: '时', title: '注册处理时间较长',
      message: '系统暂时没有确认注册结果，当前填写内容已完整保留。',
      hint: '请稍等几秒后重新提交；如果账号已经创建，系统会提示你直接登录。',
      action: 'retry', actionText: '重新提交',
    };
  }

  const databaseConfigError = /database[_-]?(?:config|permission)|db[_-]?config|collection[_-]?(?:missing|not[_-]?exist)|environment[_-]?not[_-]?found/i.test(reason)
    || /-502003|-502005|COLLECTION_NOT_EXIST|collection[^\n]*(?:not exist|not found)|数据库[^\n]*(?:未配置|权限)|集合[^\n]*(?:不存在|未创建)|云环境[^\n]*(?:不存在|未配置)|permission denied/i.test(detail);
  if (databaseConfigError) {
    return {
      type: 'database', label: '云数据库配置', icon: '库', title: '云端数据库尚未配置完成',
      message: '注册资料目前无法安全写入云端，表单内容已保留。',
      hint: '请联系管理员检查云环境、数据库集合和云函数访问权限，修复后再提交。',
      action: 'retry', actionText: '配置完成后重试',
    };
  }

  if (reason === 'wechat_has_account'
    || reason === 'wechat_bound'
    || reason === 'openid_exists'
    || /当前微信[^\n]*(?:已有|已经|绑定)[^\n]*账号|一个微信[^\n]*一个账号/i.test(detail)) {
    return {
      type: 'binding', label: '微信绑定冲突', icon: '微', title: '当前微信已经绑定过账号',
      message: message || '当前微信已关联账号，请直接登录或找回该账号。',
      hint: '可以查询当前微信已绑定的账号，再使用原账号登录或重置密码。',
      action: 'recover', actionText: '查询已绑定账号',
    };
  }

  if (reason === 'enterprise_identity_exists'
    || /企业(?:资质|身份)[^\n]*(?:已经|已)[^\n]*(?:提交|注册|存在)/i.test(detail)) {
    return {
      type: 'exists', label: '企业资料重复', icon: '企', title: '这份企业资料已经注册',
      message: message || '该企业资质已经关联过企业账号。',
      hint: '请使用原企业账号登录；如果忘记账号，可用当前微信查询。',
      action: 'recover', actionText: '找回企业账号',
    };
  }

  if (/系统预留账号|账号[^\n]*预留/i.test(detail)) {
    return {
      type: 'form', label: '账号不可用', icon: '号', title: '这个账号不能注册',
      message: message || '该账号由系统预留，请更换一个账号。',
      hint: '其他已经填写的企业资料和密码均已保留，只需修改登录账号。',
      action: '', actionText: '',
    };
  }

  if (reason === 'account_exists'
    || (code === 409 && /账号[^\n]*(?:已经|已)[^\n]*注册/i.test(detail))) {
    return {
      type: 'exists', label: '账号已存在', icon: '号', title: '这个账号已经注册',
      message: message || '该登录账号已经存在，无需重复注册。',
      hint: '可以直接返回登录；本页填写的其他资料不会覆盖原账号。',
      action: 'login', actionText: '使用此账号登录',
    };
  }

  if (code === 409) {
    return {
      type: 'exists', label: '资料已存在', icon: '!', title: '注册资料与已有记录冲突',
      message: message || '账号或企业资料已经存在，无法重复注册。',
      hint: '请确认账号后返回登录，或修改注册资料再试。',
      action: 'login', actionText: '返回登录',
    };
  }

  if (code === 2) {
    return {
      type: 'form', label: '资料校验', icon: '!', title: '请检查注册资料',
      message: message || '部分注册资料不符合要求。',
      hint: '当前填写内容已保留，修改对应内容后即可重新提交。',
      action: '', actionText: '',
    };
  }

  if (code === 1 || /无法识别当前微信/i.test(detail)) {
    return {
      type: 'identity', label: '微信身份', icon: '微', title: '暂时无法识别当前微信',
      message: message || '微信身份校验没有完成，注册资料尚未确认保存。',
      hint: '请确认在微信内打开小程序，并检查网络后重新提交。',
      action: 'retry', actionText: '重新验证并提交',
    };
  }

  if (Number.isFinite(code) && code === 99) {
    return {
      type: 'cloud', label: '云端保存异常', icon: '云', title: '云端保存没有完成',
      message: message || '注册服务暂时未能保存这份资料。',
      hint: '表单内容已保留。请稍后重试；若持续失败，需要管理员检查数据库集合、权限和云函数日志。',
      action: 'retry', actionText: '重新提交',
    };
  }

  if (error) {
    return {
      type: 'network', label: '网络或服务异常', icon: '网', title: '暂时无法连接注册服务',
      message: '系统没有确认注册结果，当前填写内容已完整保留。',
      hint: '请检查网络后重新提交；重复提交不会覆盖已存在的账号。',
      action: 'retry', actionText: '检查网络并重试',
    };
  }

  return {
    type: 'cloud', label: '注册未完成', icon: '!', title: '这次注册没有完成',
    message: message || '注册服务返回了未识别的错误。',
    hint: '表单内容已保留，请稍后重试。',
    action: 'retry', actionText: '重新提交',
  };
}

Page({
  data: {
    role: 'student',
    account: '',
    password: '',
    confirmPassword: '',
    passwordVisible: false,
    confirmVisible: false,
    name: '',
    school: '',
    major: '',
    companyName: '',
    contact: '',
    contactPhone: '',
    creditCode: '',
    agreed: false,
    loading: false,
    ...emptyRegisterError(),
  },

  onLoad(options) {
    this.setData({ role: options && options.role === 'enterprise' ? 'enterprise' : 'student' });

    // 隐私授权：若用户尚未同意，触发微信隐私弹窗（上架硬性要求）。
    try {
      if (!wx.getStorageSync('privacyAgreed')) {
        wx.requirePrivacyAuthorize({ success: () => {}, fail: () => {} });
      }
    } catch (error) {}
  },

  switchRole(event) {
    if (this.data.loading || this._registerSubmitting) return;
    const role = event.currentTarget.dataset.role === 'enterprise' ? 'enterprise' : 'student';
    this.setData({
      role,
      account: '',
      password: '',
      confirmPassword: '',
      ...emptyRegisterError(),
    });
  },

  onInput(event) {
    if (this.data.loading || this._registerSubmitting) return;
    const field = event.currentTarget.dataset.field;
    if (!field) return;
    const rawValue = String(event.detail.value || '');
    const value = this.data.role === 'enterprise' && (field === 'account' || field === 'creditCode')
      ? rawValue.toUpperCase()
      : rawValue;
    this.setData({ [field]: value, ...emptyRegisterError() });
  },

  togglePassword() { this.setData({ passwordVisible: !this.data.passwordVisible }); },
  toggleConfirm() { this.setData({ confirmVisible: !this.data.confirmVisible }); },
  toggleAgreement() {
    if (this.data.loading || this._registerSubmitting) return;
    this.setData({ agreed: !this.data.agreed, ...emptyRegisterError() });
  },
  goAgreement() { wx.navigateTo({ url: '/pages/privacy/privacy?type=agreement' }); },
  goPrivacy() { wx.navigateTo({ url: '/pages/privacy/privacy' }); },

  showRegisterError(failure) {
    this.setData({
      registerErrorType: failure.type,
      registerErrorLabel: failure.label,
      registerErrorIcon: failure.icon,
      registerErrorTitle: failure.title,
      registerErrorMessage: failure.message,
      registerErrorHint: failure.hint,
      registerErrorAction: failure.action,
      registerErrorActionText: failure.actionText,
    });
    if (typeof wx.nextTick === 'function' && typeof wx.pageScrollTo === 'function') {
      wx.nextTick(() => {
        wx.pageScrollTo({ selector: '#register-error', duration: 180 });
      });
    }
  },

  dismissRegisterError() {
    if (this.data.loading || this._registerSubmitting) return;
    this.setData(emptyRegisterError());
  },

  handleRegisterErrorAction() {
    if (this.data.loading || this._registerSubmitting) return;
    const role = this.data.role;
    const account = role === 'enterprise'
      ? this.data.account.trim().toUpperCase()
      : this.data.account.trim();
    if (this.data.registerErrorAction === 'login') {
      this.backToLogin(role, account);
      return;
    }
    if (this.data.registerErrorAction === 'recover') {
      wx.navigateTo({ url: `/pages/recover/recover?role=${role}` });
      return;
    }
    if (this.data.registerErrorAction === 'retry') {
      this.setData(emptyRegisterError());
      this.submitRegister();
    }
  },

  validateForm() {
    const data = this.data;
    const account = data.account.trim();
    if (!/^[0-9A-Za-z_-]{6,20}$/.test(account)) {
      return '账号须为 6—20 位字母、数字、下划线或短横线';
    }
    if (data.password.length < 8 || data.password.length > 32) return '密码长度应为 8—32 位';
    if (!/[A-Za-z]/.test(data.password) || !/\d/.test(data.password) || /\s/.test(data.password)) {
      return '密码需包含字母和数字，且不能有空格';
    }
    if (data.password !== data.confirmPassword) return '两次输入的密码不一致';
    if (data.role === 'student') {
      if (data.name.trim().length < 2) return '请填写真实姓名';
      if (!data.school.trim()) return '请填写学校名称';
      if (!data.major.trim()) return '请填写专业名称';
    } else {
      if (data.companyName.trim().length < 2) return '请填写完整的企业名称';
      if (!data.contact.trim()) return '请填写联系人姓名';
      if (!/^1\d{10}$/.test(data.contactPhone.trim())) return '请填写正确的 11 位联系人手机号';
      if (data.creditCode.trim() && !/^[0-9A-Za-z]{18}$/.test(data.creditCode.trim())) {
        return '统一社会信用代码应为 18 位';
      }
    }
    if (!data.agreed) return '请先阅读并同意用户协议与隐私政策';
    return '';
  },

  async submitRegister() {
    if (this.data.loading || this._registerSubmitting) return;
    const errorMessage = this.validateForm();
    if (errorMessage) {
      this.showRegisterError({
        type: 'form',
        label: '资料校验',
        icon: '!',
        title: '请完善注册资料',
        message: errorMessage,
        hint: '已经填写的内容不会丢失，修改后可继续提交。',
        action: '',
        actionText: '',
      });
      return;
    }

    this._registerSubmitting = true;
    const data = this.data;
    const account = data.role === 'enterprise'
      ? data.account.trim().toUpperCase()
      : data.account.trim();
    this.setData({ loading: true, account, ...emptyRegisterError() });

    try {
      const res = await wx.cloud.callFunction({
        name: 'register',
        data: {
          role: data.role,
          account,
          password: data.password,
          name: data.name.trim(),
          school: data.school.trim(),
          major: data.major.trim(),
          companyName: data.companyName.trim(),
          contact: data.contact.trim(),
          contactPhone: data.contactPhone.trim(),
          creditCode: data.creditCode.trim().toUpperCase(),
          agreementAccepted: data.agreed,
        },
      });
      const result = res.result || {};
      if (result.code !== 0) {
        this.showRegisterError(classifyRegisterFailure(result));
        return;
      }

      if (data.role === 'student') {
        if (result.user && result.sessionToken) {
          app.globalData.user = result.user;
          wx.setStorageSync('loginRole', 'student');
          wx.setStorageSync('uid', result.user._id);
          wx.setStorageSync('sessionToken', result.sessionToken);
          wx.setStorageSync('campusAccount', result.account || account);
          wx.showToast({ title: '注册成功', icon: 'success' });
          setTimeout(() => wx.reLaunch({ url: '/pages/home/home' }), 600);
          return;
        }
        wx.showModal({
          title: '账号已保存到云端',
          content: '注册已完成，但本次登录状态没有正确返回。请回到登录页使用刚设置的账号和密码登录。',
          showCancel: false,
          success: () => this.backToLogin('student', result.account || account),
        });
        return;
      }

      wx.showModal({
        title: result.pendingReview ? '资料已保存到云端' : '企业注册成功',
        content: result.msg || (
          result.pendingReview
            ? '企业资料已提交，审核通过后即可登录'
            : '企业账号已保存到云端，现在可以直接登录'
        ),
        showCancel: false,
        success: () => this.backToLogin('enterprise', result.account || account),
      });
    } catch (error) {
      console.error('云端注册失败', error);
      this.showRegisterError(classifyRegisterFailure({}, error));
    } finally {
      this._registerSubmitting = false;
      this.setData({ loading: false });
    }
  },

  backToLogin(role, account) {
    const pages = getCurrentPages();
    const previous = pages.length > 1 ? pages[pages.length - 2] : null;
    if (previous && previous.route === 'pages/login/login') {
      previous.setData({ role, account, password: '' });
      wx.navigateBack();
      return;
    }
    wx.reLaunch({ url: `/pages/login/login?role=${role}&account=${account}` });
  },
});
