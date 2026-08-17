// 云函数 updateProfile: 小程序端保存档案
const cloud = require('wx-server-sdk');
const crypto = require('crypto');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function dateValue(value) {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  if (value.$date) return new Date(value.$date).getTime();
  return new Date(value).getTime();
}

function normalizeTextField(value, label, minLength, maxLength) {
  if (typeof value !== 'string') return { error: `${label}格式不正确` };
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (normalized.length < minLength) return { error: `请填写${label}` };
  if (normalized.length > maxLength) return { error: `${label}不能超过 ${maxLength} 个字符` };
  return { value: normalized };
}

function normalizeSkillTags(value) {
  if (!Array.isArray(value)) return { error: '技能标签格式不正确' };
  if (value.length > 12) return { error: '技能标签最多添加 12 个' };

  const normalized = [];
  for (const item of value) {
    if (typeof item !== 'string') return { error: '技能标签格式不正确' };
    const tag = item.trim().replace(/\s+/g, ' ');
    if (!tag) return { error: '技能标签不能为空' };
    if (tag.length > 24) return { error: '单个技能标签不能超过 24 个字符' };
    if (!normalized.includes(tag)) normalized.push(tag);
  }
  return { value: normalized };
}

async function validateSession(uid, sessionToken, openid) {
  if (!sessionToken) return { valid: false, setupRequired: false };
  const sessionRes = await db.collection('sessions').doc(sha256(sessionToken)).get()
    .catch(() => ({ data: null }));
  const session = sessionRes.data;
  if (!session || session.uid !== uid || session.openid !== openid
    || dateValue(session.expiresAt) <= Date.now() || !session.account) {
    return { valid: false, setupRequired: false };
  }
  const accountRes = await db.collection('campus_accounts').doc(session.account).get()
    .catch(() => ({ data: null }));
  const account = accountRes.data;
  if (!account || (account.status && account.status !== 'active')
    || Number(account.passwordVersion) !== Number(session.passwordVersion)) {
    return { valid: false, setupRequired: false };
  }
  return { valid: true, setupRequired: Boolean(account.mustChangePassword) };
}

async function completeTalentStageIfEligible(uid) {
  const [userRes, stageRes] = await Promise.all([
    db.collection('users').doc(uid).get(),
    db.collection('stages').where({ uid }).limit(20).get(),
  ]);
  if (!userRes.data || !userRes.data.talentPoolVisible) return false;
  const stageMap = new Map(stageRes.data.map((stage) => [stage.stage, stage]));
  const prerequisites = ['学习', '认证', '作品', '企业好评'];
  if (!prerequisites.every((stage) => stageMap.get(stage)
    && stageMap.get(stage).status === 'done')) return false;
  const current = stageMap.get('人才');
  if (current && current.status === 'done') return true;
  const now = new Date();
  if (current) {
    await db.collection('stages').doc(current._id).update({
      data: { status: 'done', completedAt: now, updatedAt: now },
    });
  } else {
    await db.collection('stages').doc(`${uid}-stage-5`).set({
      data: {
        uid, stage: '人才', status: 'done', startedAt: now,
        completedAt: now, createdAt: now, updatedAt: now,
      },
    });
  }
  return true;
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const {
    uid, sessionToken, name, school, major, skillTags, talentPoolVisible, profilePublic,
  } = event || {};

  if (typeof uid !== 'string' || !uid.trim() || !OPENID) {
    return { code: -1, message: '参数错误' };
  }

  const normalizedName = normalizeTextField(name, '姓名', 2, 30);
  if (normalizedName.error) return { code: 2, message: normalizedName.error };
  const normalizedSchool = normalizeTextField(school, '学校', 1, 80);
  if (normalizedSchool.error) return { code: 2, message: normalizedSchool.error };
  const normalizedMajor = normalizeTextField(major, '专业', 1, 80);
  if (normalizedMajor.error) return { code: 2, message: normalizedMajor.error };
  const normalizedTags = normalizeSkillTags(skillTags);
  if (normalizedTags.error) return { code: 2, message: normalizedTags.error };
  if (typeof talentPoolVisible !== 'boolean') {
    return { code: 2, message: '人才池可见性设置不正确' };
  }
  if (typeof profilePublic !== 'boolean') {
    return { code: 2, message: '公开档案设置不正确' };
  }

  try {
    // 只能使用当前账号的有效会话修改自己的档案。
    const userRes = await db.collection('users').doc(uid).get();
    const session = await validateSession(uid, sessionToken, OPENID);
    if (!userRes.data || !session.valid) {
      return { code: 401, message: '登录已失效，请重新登录' };
    }
    if (session.setupRequired) return { code: 403, message: '请先设置个人登录密码' };

    await db.collection('users').doc(uid).update({
      data: {
        name: normalizedName.value,
        school: normalizedSchool.value,
        major: normalizedMajor.value,
        skillTags: normalizedTags.value,
        talentPoolVisible,
        profilePublic,
      },
    });

    const talentStageCompleted = talentPoolVisible
      ? await completeTalentStageIfEligible(uid).catch((error) => {
        console.error('档案已保存，但人才阶段更新失败', error);
        return false;
      })
      : false;

    return { code: 0, message: '保存成功', talentStageCompleted };
  } catch (error) {
    console.error('保存档案失败', error);
    return { code: 99, message: '保存失败，请稍后重试' };
  }
};
