// 云函数 getArchive：根据 uid 聚合公开档案。
const cloud = require('wx-server-sdk');
const crypto = require('crypto');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

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

async function validateSession(uid, sessionToken, openid) {
  if (!uid || !sessionToken || !openid) return { valid: false, setupRequired: false };
  const tokenHash = sha256(sessionToken);
  const sessionRes = await db.collection('sessions').doc(tokenHash).get()
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

function normalizeStages(uid, stageDocs) {
  const stageMap = {};
  stageDocs.forEach((item) => {
    if (STAGE_NAMES.includes(item.stage) && !stageMap[item.stage]) stageMap[item.stage] = item;
  });

  // 公开读取必须保持只读。旧档案缺少的阶段仅在响应里补齐，不反向写入数据库。
  return STAGE_NAMES.map((stage) => {
    const source = stageMap[stage] || {};
    const status = ['done', 'doing', 'pending'].includes(source.status)
      ? source.status : 'pending';
    return {
      stage,
      status,
      completedAt: source.completedAt || null,
      startedAt: source.startedAt || null,
    };
  });
}

function toPublicUser(user) {
  return {
    _id: user._id,
    name: user.name || '',
    school: user.school || '',
    major: user.major || '',
    avatar: user.avatar || '',
    skillTags: Array.isArray(user.skillTags) ? user.skillTags : [],
    talentIndex: Number(user.talentIndex) || 0,
    talentPoolVisible: Boolean(user.talentPoolVisible),
    profilePublic: user.profilePublic !== false,
    isDemo: Boolean(user.isDemo),
    createdAt: user.createdAt || null,
    updatedAt: user.updatedAt || null,
  };
}

function toPublicWork(work) {
  return {
    _id: work._id,
    title: work.title || '',
    desc: work.desc || '',
    coverUrl: work.coverUrl || '',
    createdAt: work.createdAt || null,
    copyrightHash: work.copyrightHash || '',
  };
}

function toPublicCertification(certification) {
  return {
    _id: certification._id,
    certName: certification.certName || '',
    issuer: certification.issuer || '',
    level: certification.level || '',
    issueAt: certification.issueAt || certification.issueDate || certification.issuedAt || null,
    certHash: certification.certHash || certification.evidenceHash || '',
    serialNo: certification.serialNo || '',
    verificationStatus: certification.verificationStatus || '',
  };
}

function toPublicEvaluation(evaluation) {
  return {
    _id: evaluation._id,
    companyName: evaluation.companyName || '',
    mentorName: evaluation.mentorName || '',
    content: evaluation.content || '',
    score: Number(evaluation.score) || 0,
    signedAt: evaluation.signedAt || null,
    evidenceHash: evaluation.evidenceHash || '',
  };
}

function toOwnerInvitation(invitation) {
  return {
    _id: invitation._id,
    companyName: invitation.companyName || '',
    type: invitation.type === '实习' ? '实习' : '面试',
    message: invitation.message || '',
    status: invitation.status || 'pending',
    createdAt: invitation.createdAt || null,
    respondedAt: invitation.respondedAt || null,
  };
}

function toOwnerApplication(application) {
  return {
    _id: application._id,
    jobId: application.jobId || '',
    companyName: application.companyName || '',
    jobTitle: application.jobTitle || '',
    jobType: application.jobType || '实习',
    message: application.message || '',
    status: application.status || 'pending',
    createdAt: application.createdAt || null,
    respondedAt: application.respondedAt || null,
  };
}

function toOpportunity(job, application) {
  return {
    _id: job._id,
    companyName: job.companyName || '',
    title: job.title || '',
    type: ['实训', '实习', '正式岗位'].includes(job.type) ? job.type : '实习',
    desc: job.desc || '',
    location: job.location || '',
    createdAt: job.createdAt || null,
    applicationId: (application && application._id) || '',
    applicationStatus: (application && application.status) || '',
  };
}

exports.main = async (event) => {
  const {
    uid, trackScan = false, privateView = false, sessionToken = '',
  } = event || {};
  if (typeof uid !== 'string' || !uid.trim()) return { code: 1, msg: '缺少 uid' };
  const targetUid = uid.trim();

  try {
    const { OPENID } = cloud.getWXContext();
    const privateSession = privateView
      ? await validateSession(targetUid, sessionToken, OPENID)
      : { valid: false, setupRequired: false };
    if (privateView && !privateSession.valid) {
      return { code: 401, msg: '登录已失效，请重新登录' };
    }
    if (privateView && privateSession.setupRequired) {
      return { code: 403, msg: '请先设置个人登录密码' };
    }
    const hasPrivateSession = privateSession.valid;

    const [userRes, works, certs, evals, stages] = await Promise.all([
      db.collection('users').doc(targetUid).get().catch(() => ({ data: null })),
      db.collection('works').where({ uid: targetUid }).orderBy('createdAt', 'desc').limit(100).get(),
      db.collection('certifications').where({ uid: targetUid }).orderBy('issueAt', 'desc').limit(100).get(),
      db.collection('evaluations').where({ uid: targetUid }).orderBy('signedAt', 'desc').limit(100).get(),
      db.collection('stages').where({ uid: targetUid }).limit(20).get(),
    ]);
    if (!userRes.data) return { code: 2, msg: '用户不存在' };
    if (!hasPrivateSession && userRes.data.profilePublic === false) {
      return { code: 4031, msg: '档案主人已暂停公开分享' };
    }

    // 私密邀约只认有效会话。仅凭同一个微信 OpenID 不能绕过密码版本与会话失效校验。
    const [invites, applications, opportunityRows] = hasPrivateSession
      ? await Promise.all([
        db.collection('invitations').where({ uid: targetUid }).limit(100).get(),
        db.collection('job_applications').where({ uid: targetUid }).limit(100).get()
          .catch(() => ({ data: [] })),
        db.collection('jobs').where({ status: 'open' }).limit(50).get()
          .catch(() => ({ data: [] })),
      ])
      : [{ data: [] }, { data: [] }, { data: [] }];

    const sortedInvites = invites.data
      .sort((left, right) => dateValue(right.createdAt) - dateValue(left.createdAt));
    const sortedApplications = applications.data
      .sort((left, right) => dateValue(right.createdAt) - dateValue(left.createdAt));
    const applicationsByJob = new Map(
      sortedApplications.map((application) => [application.jobId, application]),
    );
    const opportunities = opportunityRows.data
      .sort((left, right) => dateValue(right.createdAt) - dateValue(left.createdAt))
      .map((job) => toOpportunity(job, applicationsByJob.get(job._id)));

    if (trackScan) {
      db.collection('qrcodes').where({ uid: targetUid }).update({
        data: { scanCount: db.command.inc(1), lastScannedAt: new Date() },
      }).catch(() => {});
    }

    const sortedStages = normalizeStages(targetUid, stages.data);
    // 只返回档案展示需要的明确字段，避免未来新增的内部字段被意外公开。
    const publicUser = toPublicUser(userRes.data);
    return {
      code: 0,
      data: {
        user: publicUser,
        works: works.data.map(toPublicWork),
        certifications: certs.data.map(toPublicCertification),
        evaluations: evals.data.map(toPublicEvaluation),
        stages: sortedStages,
        invitations: sortedInvites.map(toOwnerInvitation),
        applications: sortedApplications.map(toOwnerApplication),
        opportunities,
      },
    };
  } catch (error) {
    console.error('聚合档案失败', error);
    return { code: 99, msg: '档案加载失败，请稍后重试' };
  }
};
