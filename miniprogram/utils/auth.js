const STUDENT_STORAGE_KEYS = ['uid', 'sessionToken', 'campusAccount'];
const ENTERPRISE_STORAGE_KEYS = ['company', 'enterpriseSessionToken', 'enterpriseAccount'];

function removeStorageKeys(keys) {
  keys.forEach((key) => wx.removeStorageSync(key));
}

function clearRoleMarker(role) {
  if (wx.getStorageSync('loginRole') === role) {
    wx.removeStorageSync('loginRole');
  }
}

function clearStudentSession() {
  removeStorageKeys(STUDENT_STORAGE_KEYS);
  clearRoleMarker('student');
}

function clearEnterpriseSession() {
  removeStorageKeys(ENTERPRISE_STORAGE_KEYS);
  clearRoleMarker('enterprise');
}

function getSession() {
  const uid = wx.getStorageSync('uid');
  const sessionToken = wx.getStorageSync('sessionToken');
  if (!uid || !sessionToken) {
    clearStudentSession();
    wx.reLaunch({ url: '/pages/login/login' });
    return null;
  }
  return { uid, sessionToken, privateView: true };
}

function getEnterpriseSession() {
  const company = wx.getStorageSync('company');
  const enterpriseSessionToken = wx.getStorageSync('enterpriseSessionToken');
  if (!company || !enterpriseSessionToken) {
    clearEnterpriseSession();
    wx.reLaunch({ url: '/pages/login/login' });
    return null;
  }
  return { company, enterpriseSessionToken };
}

function handleExpired(result) {
  if (result && result.code === 403) {
    wx.reLaunch({ url: '/pages/password/password?firstSetup=1' });
    return true;
  }
  if (result && result.code === 401) {
    clearStudentSession();
    wx.reLaunch({ url: '/pages/login/login' });
    return true;
  }
  return false;
}

module.exports = {
  getSession,
  getEnterpriseSession,
  handleExpired,
  clearStudentSession,
  clearEnterpriseSession,
};
