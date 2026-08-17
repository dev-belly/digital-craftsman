// 云函数 listTalents:人才池检索
// 支持按技能标签关键词过滤 + 最低人才指数过滤,按指数降序返回
const cloud = require('wx-server-sdk');
const crypto = require('crypto');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const STAGE_NAMES = ['学习', '认证', '作品', '企业好评', '人才'];

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function dateValue(value) {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  if (value.$date) return new Date(value.$date).getTime();
  return new Date(value).getTime();
}

function skillTagsOf(user) {
  return Array.isArray(user && user.skillTags)
    ? user.skillTags.map((tag) => String(tag || '').trim()).filter(Boolean)
    : [];
}

function matchesKeyword(user, keyword) {
  if (!keyword) return true;
  const target = keyword.toLocaleLowerCase();
  return skillTagsOf(user).some((tag) => tag.toLocaleLowerCase().includes(target));
}

async function loadStageMap(uids) {
  const result = {};
  // 云数据库一次查询最多返回 100 条。每位学生固定五阶段，因此每批最多 20 人。
  for (let offset = 0; offset < uids.length; offset += 20) {
    const batch = uids.slice(offset, offset + 20);
    try {
      const stageRes = await db.collection('stages')
        .where({ uid: _.in(batch) })
        .limit(100)
        .get();
      stageRes.data.forEach((stage) => {
        if (!result[stage.uid]) result[stage.uid] = {};
        result[stage.uid][stage.stage] = stage;
      });
    } catch (error) {
      // 阶段摘要是附加信息，缺集合或临时查询失败时不能拖垮人才主列表。
      console.error('人才阶段摘要加载失败，已降级为空摘要', error);
      break;
    }
  }
  return result;
}

async function loadCompanyJobs(companyId) {
  try {
    const jobsRes = await db.collection('jobs')
      .where({ companyId })
      .limit(20)
      .get();
    return jobsRes.data
      .sort((left, right) => dateValue(right.createdAt) - dateValue(left.createdAt))
      .slice(0, 5)
      .map((job) => ({
        _id: job._id,
        title: job.title || '',
        type: ['实训', '实习', '正式岗位'].includes(job.type) ? job.type : '实习',
        location: job.location || '',
        status: job.status === 'closed' ? 'closed' : 'open',
        createdAt: job.createdAt || null,
      }));
  } catch (error) {
    // 体验环境可能尚未创建 jobs 集合；岗位为空不应影响人才池。
    console.error('企业岗位加载失败，已降级为空列表', error);
    return [];
  }
}

async function loadCompanyActivity(companyId) {
  try {
    const [invitationRes, applicationRes] = await Promise.all([
      db.collection('invitations').where({ companyId }).limit(100).get(),
      db.collection('job_applications').where({ companyId }).limit(100).get()
        .catch(() => ({ data: [] })),
    ]);
    const invitations = invitationRes.data
      .sort((left, right) => dateValue(right.createdAt) - dateValue(left.createdAt))
      .slice(0, 20)
      .map((invitation) => ({
        _id: invitation._id,
        uid: invitation.uid || '',
        studentName: invitation.studentName || '',
        companyName: invitation.companyName || '',
        type: invitation.type === '实习' ? '实习' : '面试',
        message: invitation.message || '',
        status: invitation.status || 'pending',
        createdAt: invitation.createdAt || null,
        respondedAt: invitation.respondedAt || null,
      }));
    const applications = applicationRes.data
      .sort((left, right) => dateValue(right.createdAt) - dateValue(left.createdAt))
      .slice(0, 30)
      .map((application) => ({
        _id: application._id,
        jobId: application.jobId || '',
        jobTitle: application.jobTitle || '',
        jobType: application.jobType || '实习',
        uid: application.uid || '',
        studentName: application.studentName || '',
        message: application.message || '',
        status: application.status || 'pending',
        createdAt: application.createdAt || null,
        respondedAt: application.respondedAt || null,
      }));
    return { invitations, applications };
  } catch (error) {
    console.error('企业活动记录加载失败，已降级为空列表', error);
    return { invitations: [], applications: [] };
  }
}

async function validateEnterpriseSession(sessionToken, openid) {
  if (!sessionToken || !openid) return null;
  const res = await db.collection('enterprise_sessions').doc(sha256(sessionToken)).get()
    .catch(() => ({ data: null }));
  const session = res.data;
  if (!session || session.openid !== openid || session.role !== 'enterprise'
    || dateValue(session.expiresAt) <= Date.now()) {
    return null;
  }

  const account = String(session.account || '').trim();
  if (!account) return null;
  const accountRes = await db.collection('company_accounts').doc(account).get()
    .catch(() => ({ data: null }));
  const companyAccount = accountRes.data;
  if (!companyAccount || companyAccount.companyId !== session.companyId
    || companyAccount.status !== 'active'
    || (Number(companyAccount.passwordVersion) || 1) !== (Number(session.passwordVersion) || 1)) {
    return null;
  }
  return session;
}

async function loadCandidateUsers(demoOnly) {
  const rows = [];
  const collection = db.collection('users');
  const query = demoOnly ? collection.where({ isDemo: true }) : collection;
  // 云数据库单次最多返回 100 条。体验期最多扫描 1000 条并在服务端过滤，
  // 避免只取首 100 条导致后注册的人才永远不可见。
  for (let offset = 0; offset < 1000; offset += 100) {
    const page = await query.skip(offset).limit(100).get();
    rows.push(...page.data);
    if (page.data.length < 100) break;
  }
  return rows;
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const {
    keyword = '', minIndex = 0, limit = 50, demoOnly = false, includeStageSummary = false,
    enterpriseSessionToken = '',
  } = event || {};

  const enterprise = await validateEnterpriseSession(enterpriseSessionToken, OPENID);
  if (!enterprise) return { code: 401, msg: '企业登录已失效，请重新登录' };

  if (typeof keyword !== 'string') return { code: 1, msg: '搜索关键词格式不正确' };
  const cleanKeyword = keyword.trim();
  if (cleanKeyword.length > 40) return { code: 1, msg: '搜索关键词不能超过 40 个字符' };

  const parsedMinIndex = Number(minIndex);
  const safeMinIndex = Number.isFinite(parsedMinIndex)
    ? Math.max(0, Math.min(parsedMinIndex, 100))
    : 0;
  const parsedLimit = Number(limit);
  const safeLimit = Number.isFinite(parsedLimit)
    ? Math.max(1, Math.min(Math.floor(parsedLimit), 100))
    : 50;

  try {
    // 人才池数据量在体验阶段较小。先取候选记录再在服务端过滤/排序，避免依赖
    // 组合索引、数组正则等容易因不同云环境配置而失败的查询能力。
    const candidateUsers = await loadCandidateUsers(demoOnly);
    const talentRows = candidateUsers
      .filter((user) => (demoOnly ? user.isDemo : user.isDemo || user.talentPoolVisible))
      .filter((user) => (Number(user.talentIndex) || 0) >= safeMinIndex)
      .filter((user) => matchesKeyword(user, cleanKeyword))
      .sort((left, right) => {
        if (demoOnly) return (left.demoOrder || 99) - (right.demoOrder || 99);
        return (Number(right.talentIndex) || 0) - (Number(left.talentIndex) || 0);
      })
      .slice(0, safeLimit)
      .map((user) => ({ ...user, skillTags: skillTagsOf(user) }));

    const stageMapByUid = includeStageSummary
      ? await loadStageMap(talentRows.map((user) => user._id))
      : {};

    const talents = talentRows.map((u) => {
      let stageStatuses = [];
      let completedStageCount = 0;
      let currentStage = '学习';
      let stageSummary = '学习阶段待开启';

      if (includeStageSummary) {
        const stageMap = stageMapByUid[u._id] || {};
        stageStatuses = STAGE_NAMES.map((stage) => ({
          stage,
          status: (stageMap[stage] && stageMap[stage].status) || 'pending',
        }));
        completedStageCount = stageStatuses.filter((stage) => stage.status === 'done').length;
        const doingStage = stageStatuses.find((stage) => stage.status === 'doing');
        const pendingStage = stageStatuses.find((stage) => stage.status === 'pending');
        currentStage = doingStage ? doingStage.stage : pendingStage ? pendingStage.stage : '人才';
        stageSummary = completedStageCount === STAGE_NAMES.length
          ? '已完成五阶段并进入人才池'
          : doingStage
            ? `${doingStage.stage}阶段进行中`
            : `${currentStage}阶段待开启`;
      }

      return {
        _id: u._id,
        name: u.name,
        school: u.school,
        major: u.major,
        skillTags: u.skillTags || [],
        talentIndex: u.talentIndex || 0,
        completedStageCount,
        currentStage,
        stageSummary,
        stageStatuses,
      };
    });

    const [jobs, activity] = await Promise.all([
      loadCompanyJobs(enterprise.companyId),
      loadCompanyActivity(enterprise.companyId),
    ]);

    const studentNameByUid = new Map(talents.map((talent) => [talent._id, talent.name]));
    const invitations = activity.invitations.map((invitation) => ({
      ...invitation,
      studentName: invitation.studentName || studentNameByUid.get(invitation.uid) || '学生',
    }));

    return {
      code: 0,
      total: talents.length,
      talents,
      jobs,
      invitations,
      applications: activity.applications,
    };
  } catch (e) {
    console.error('人才池检索失败', e);
    return { code: 99, msg: '人才池加载失败，请稍后重试' };
  }
};
