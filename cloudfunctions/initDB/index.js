// 云函数 initDB：创建集合并幂等写入三份不同成长阶段的演示档案。
const cloud = require('wx-server-sdk');
const crypto = require('crypto');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const COLLECTIONS = [
  'users', 'qrcodes', 'works', 'certifications',
  'evaluations', 'stages', 'attestations', 'companies', 'invitations', 'jobs',
  'job_applications',
  'sessions', 'login_attempts', 'account_bindings', 'campus_accounts',
  'company_accounts', 'enterprise_sessions', 'enterprise_bindings', 'user_consents',
  'enterprise_identity_index', 'identity_bindings',
];

function sha256(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function isDocumentNotFound(error) {
  const message = [
    error && error.code,
    error && error.errCode,
    error && error.errMsg,
    error && error.message,
    error,
  ].filter(Boolean).join(' ').toLowerCase();
  return message.includes('-502004')
    || message.includes('document does not exist')
    || message.includes('does not exist')
    || message.includes('not found')
    || message.includes('文档不存在');
}

async function getOptionalDocument(documentReference) {
  try {
    return await documentReference.get();
  } catch (error) {
    if (isDocumentNotFound(error)) return { data: null };
    throw error;
  }
}

function errorText(error) {
  return [
    error && error.code,
    error && error.errCode,
    error && error.errMsg,
    error && error.message,
    error && error.cause && error.cause.code,
    error && error.cause && error.cause.message,
    error,
  ].filter(Boolean).join(' ');
}

function isRetryableTransactionError(error) {
  return /-501001|TransactionBusy|transaction[^\n]*(?:conflict|aborted)|\bABORTED\b/i
    .test(errorText(error));
}

// 事务遇到并发冲突时有限指数退避；不重试集合缺失、权限等确定性错误。
async function runTxWithRetry(executor, retries = 4) {
  let lastError;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      return await db.runTransaction(executor);
    } catch (error) {
      lastError = error;
      if (isRetryableTransactionError(error) && attempt < retries - 1) {
        const delay = 200 * (2 ** attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

// 初始化只负责补齐缺失的演示数据。事务可防止并发 seed 覆盖刚创建的真实数据。
async function createDocumentIfMissing(collectionName, documentId, data) {
  let created = false;
  await runTxWithRetry(async (transaction) => {
    const documentReference = transaction.collection(collectionName).doc(documentId);
    const existing = await getOptionalDocument(documentReference);
    if (existing.data) {
      created = false;
      return;
    }
    await documentReference.set({ data });
    created = true;
  });
  return created;
}

function date(value) {
  return new Date(`${value}T08:00:00+08:00`);
}

const DEMO_PROFILES = [
  {
    uid: 'demo-wangfang',
    order: 1,
    user: {
      name: '王芳',
      school: '苏州工业职业技术学院',
      major: '数字媒体技术',
      skillTags: ['UI 视觉设计', 'AIGC 内容创作', '短视频制作'],
      talentIndex: 63,
      createdAt: date('2024-09-01'),
    },
    works: [],
    certifications: [
      {
        id: 'demo-wangfang-cert-1',
        certName: '数字媒体设计基础认证',
        level: '初级',
        issuer: '数字创意人才发展中心',
        issueAt: date('2024-10-26'),
      },
    ],
    evaluations: [],
    stages: [
      { stage: '学习', status: 'done', completedAt: date('2024-09-28') },
      { stage: '认证', status: 'done', completedAt: date('2024-10-26') },
      { stage: '作品', status: 'doing', startedAt: date('2024-11-02'), completedAt: null },
      { stage: '企业好评', status: 'pending', completedAt: null },
      { stage: '人才', status: 'pending', completedAt: null },
    ],
  },
  {
    uid: 'demo-liming',
    order: 2,
    user: {
      name: '李明',
      school: '江南理工大学',
      major: '智能制造工程',
      skillTags: ['AI 应用开发', 'Prompt 工程', '数据标注', 'RAG'],
      talentIndex: 85,
      createdAt: date('2023-09-01'),
    },
    works: [
      {
        id: 'demo-liming-work-1',
        title: 'AI 智能客服系统',
        desc: '基于 RAG 的企业知识库问答，完成需求分析、流程设计与核心功能开发。',
        createdAt: new Date('2023-11-12T10:30:00+08:00'),
      },
      {
        id: 'demo-liming-work-2',
        title: '智能质检数据看板',
        desc: '将生产质检数据转化为可视化指标，帮助团队快速定位异常环节。',
        createdAt: new Date('2023-11-28T15:20:00+08:00'),
      },
    ],
    certifications: [
      {
        id: 'demo-liming-cert-1',
        certName: 'NGF AI 应用工程师',
        level: '中级',
        issuer: 'NGF 国际认证',
        issueAt: new Date('2023-10-20T09:00:00+08:00'),
      },
    ],
    evaluations: [
      {
        id: 'demo-liming-eval-1',
        companyId: 'demo-company-zhilian',
        companyName: '智联科技',
        mentorName: '李工',
        content: '学习能力强，项目思路清晰，交付质量高，具备良好的协作意识。',
        score: 92,
        signedAt: new Date('2023-12-18T14:20:00+08:00'),
      },
    ],
    stages: [
      { stage: '学习', status: 'done', completedAt: new Date('2023-09-28T18:00:00+08:00') },
      { stage: '认证', status: 'done', completedAt: new Date('2023-10-20T09:00:00+08:00') },
      { stage: '作品', status: 'done', completedAt: new Date('2023-11-12T10:30:00+08:00') },
      { stage: '企业好评', status: 'doing', startedAt: date('2023-12-01'), completedAt: null },
      { stage: '人才', status: 'pending', completedAt: null },
    ],
  },
  {
    uid: 'demo-chenhao',
    order: 3,
    user: {
      name: '陈浩',
      school: '南京工程学院',
      major: '机器人工程',
      skillTags: ['工业机器人', 'PLC 控制', '机器视觉', '数字孪生'],
      talentIndex: 94,
      createdAt: date('2024-03-01'),
    },
    works: [
      {
        id: 'demo-chenhao-work-1',
        title: '协作机器人分拣工作站',
        desc: '完成机械臂轨迹规划、视觉定位与现场联调，使分拣节拍提升 18%。',
        createdAt: new Date('2024-05-18T11:10:00+08:00'),
      },
      {
        id: 'demo-chenhao-work-2',
        title: '产线数字孪生仿真',
        desc: '建立生产节拍仿真模型，在部署前验证设备布局和异常处理流程。',
        createdAt: new Date('2024-06-22T16:40:00+08:00'),
      },
      {
        id: 'demo-chenhao-work-3',
        title: '视觉缺陷检测模块',
        desc: '训练轻量化缺陷识别模型，并完成边缘端部署与检测结果可视化。',
        createdAt: new Date('2024-07-12T09:20:00+08:00'),
      },
    ],
    certifications: [
      {
        id: 'demo-chenhao-cert-1',
        certName: '工业机器人系统操作员',
        level: '中级',
        issuer: '智能制造职业能力中心',
        issueAt: date('2024-04-26'),
      },
      {
        id: 'demo-chenhao-cert-2',
        certName: '机器视觉应用工程师',
        level: '高级',
        issuer: '工业视觉认证中心',
        issueAt: date('2024-06-08'),
      },
    ],
    evaluations: [
      {
        id: 'demo-chenhao-eval-1',
        companyId: 'demo-company-jingyi',
        companyName: '精益智造',
        mentorName: '赵工',
        content: '现场动手能力突出，能够快速定位设备问题并给出可落地的优化方案。',
        score: 96,
        signedAt: new Date('2024-07-26T14:00:00+08:00'),
      },
      {
        id: 'demo-chenhao-eval-2',
        companyId: 'demo-company-qihang',
        companyName: '启航自动化',
        mentorName: '周经理',
        content: '项目交付完整，文档规范，具备独立负责自动化项目模块的能力。',
        score: 94,
        signedAt: new Date('2024-08-10T10:30:00+08:00'),
      },
    ],
    stages: [
      { stage: '学习', status: 'done', completedAt: date('2024-03-29') },
      { stage: '认证', status: 'done', completedAt: date('2024-04-26') },
      { stage: '作品', status: 'done', completedAt: date('2024-05-18') },
      { stage: '企业好评', status: 'done', completedAt: date('2024-07-26') },
      { stage: '人才', status: 'done', completedAt: date('2024-08-16') },
    ],
  },
];

const DEMO_COMPANIES = [
  {
    account: 'COM1001',
    companyId: 'demo-company-zhilian',
    companyName: '智联科技',
    contact: '李经理',
    salt: 'dc-zhilian-2026',
    passwordHash: '2993e85fe81d6a0bf60a3724b83deffc72cb3325f79fcbfb3b3108097d0c7ced',
  },
  {
    account: 'COM1002',
    companyId: 'demo-company-jingyi',
    companyName: '精益智造',
    contact: '赵经理',
    salt: 'dc-jingyi-2026',
    passwordHash: '0c155b4bc39839c8e737f4199183936fd6f72c807ea649753beb9e8cd0c756f4',
  },
  {
    account: 'COM1003',
    companyId: 'demo-company-qihang',
    companyName: '启航自动化',
    contact: '周经理',
    salt: 'dc-qihang-2026',
    passwordHash: 'a624074bd047c5d7b33dfbebb0ea2a6c2580931fdb3ea928ce8ff8f9b06c777d',
  },
];

// 校园演示账号（与 cloudfunctions/login 的 CAMPUS_ACCOUNT_DEFAULTS 保持一致）
// 哈希算法为 sha256(salt:password)，passwordAlgorithm 留空，与首次自动建号一致。
const DEMO_CAMPUS_ACCOUNTS = [
  {
    account: '20240001',
    uid: 'demo-wangfang',
    salt: 'dc-wangfang-2026',
    passwordHash: '311ea9a573310d9d0552921d6c323fbbe7c4fb50cc60147f8a4f236879d5bc61',
  },
  {
    account: '20240002',
    uid: 'demo-liming',
    salt: 'dc-liming-2026',
    passwordHash: '1ae89305059557e3115bf98e8017474536ac76eb710257728dc02006044ec41b',
  },
  {
    account: '20240003',
    uid: 'demo-chenhao',
    salt: 'dc-chenhao-2026',
    passwordHash: 'ab1b625107ec68a6e4da896ca5bdfe36030c9ccfdf05b6de6610649109a4223c',
  },
];

async function seedCampusAccount(item) {
  const now = new Date();
  return createDocumentIfMissing('campus_accounts', item.account, {
    account: item.account,
    uid: item.uid,
    salt: item.salt,
    passwordHash: item.passwordHash,
    passwordVersion: 1,
    mustChangePassword: false,
    createdAt: now,
    updatedAt: now,
  });
}

async function seedCompany(company) {
  const now = new Date();
  const accountCreated = await createDocumentIfMissing('company_accounts', company.account, {
    account: company.account,
    companyId: company.companyId,
    companyName: company.companyName,
    contact: company.contact,
    salt: company.salt,
    passwordHash: company.passwordHash,
    passwordVersion: 1,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });
  const companyCreated = await createDocumentIfMissing('companies', company.companyId, {
    companyName: company.companyName,
    contact: company.contact,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });
  return Number(accountCreated) + Number(companyCreated);
}

async function seedProfile(profile) {
  const user = {
    ...profile.user,
    avatar: '',
    profilePublic: true,
    openid: `demo-openid-${profile.uid}`,
    isDemo: true,
    demoOrder: profile.order,
  };
  let createdCount = 0;
  createdCount += Number(await createDocumentIfMissing('users', profile.uid, user));
  createdCount += Number(await createDocumentIfMissing(
    'qrcodes',
    `${profile.uid}-code`,
    { uid: profile.uid, sceneStr: profile.uid, scanCount: 0 },
  ));

  for (const item of profile.works) {
    const { id, ...workData } = item;
    const work = {
      uid: profile.uid,
      ...workData,
      coverUrl: '',
      fileUrls: [],
    };
    work.copyrightHash = sha256(work);
    createdCount += Number(await createDocumentIfMissing('works', id, work));
    createdCount += Number(await createDocumentIfMissing(
      'attestations',
      `${id}-attestation`,
      {
        targetType: 'work',
        targetId: id,
        hash: work.copyrightHash,
        timestamp: work.createdAt,
        chainTxId: null,
      },
    ));
  }

  for (const item of profile.certifications) {
    const { id, ...certData } = item;
    const cert = { uid: profile.uid, ...certData };
    cert.certHash = sha256(cert);
    createdCount += Number(await createDocumentIfMissing('certifications', id, cert));
  }

  for (const item of profile.evaluations) {
    const { id, ...evaluationData } = item;
    const evaluation = { uid: profile.uid, ...evaluationData };
    evaluation.evidenceHash = sha256(evaluation);
    evaluation.signature = sha256({ hash: evaluation.evidenceHash, signer: 'demo-platform' });
    createdCount += Number(await createDocumentIfMissing('evaluations', id, evaluation));
    createdCount += Number(await createDocumentIfMissing(
      'attestations',
      `${id}-attestation`,
      {
        targetType: 'evaluation',
        targetId: id,
        hash: evaluation.evidenceHash,
        signature: evaluation.signature,
        timestamp: evaluation.signedAt,
        chainTxId: null,
      },
    ));
  }

  for (let index = 0; index < profile.stages.length; index += 1) {
    createdCount += Number(await createDocumentIfMissing(
      'stages',
      `${profile.uid}-stage-${index + 1}`,
      { uid: profile.uid, ...profile.stages[index] },
    ));
  }
  return createdCount;
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const adminOpenids = String(process.env.ADMIN_OPENIDS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (!OPENID || !adminOpenids.includes(OPENID)) {
    console.warn('拒绝未授权的数据库初始化请求');
    return { code: 403, msg: '该管理功能未授权' };
  }

  const log = [];
  for (const name of COLLECTIONS) {
    try {
      await db.createCollection(name);
      log.push(`创建集合 ${name}`);
    } catch (error) {
      log.push(`集合 ${name} 已存在`);
    }
  }

  if (!event || !event.seed) return { code: 0, log };

  for (const profile of DEMO_PROFILES) {
    try {
      const createdCount = await seedProfile(profile);
      log.push(`已检查演示档案：${profile.user.name}（新建 ${createdCount} 项，已存在数据保持不变）`);
    } catch (error) {
      console.error('演示档案写入失败', error);
      log.push(`演示档案写入失败：${profile.user.name}`);
    }
  }
  for (const company of DEMO_COMPANIES) {
    try {
      const createdCount = await seedCompany(company);
      log.push(`已检查企业演示数据：${company.companyName}（新建 ${createdCount} 项）`);
    } catch (error) {
      console.error('企业演示数据写入失败', error);
      log.push(`企业演示数据写入失败：${company.companyName}`);
    }
  }
  for (const campusAccount of DEMO_CAMPUS_ACCOUNTS) {
    try {
      const created = await seedCampusAccount(campusAccount);
      log.push(`已检查校园演示账号：${campusAccount.account}（${created ? '新建' : '已存在，凭证保持不变'}）`);
    } catch (error) {
      console.error('校园演示账号写入失败', error);
      log.push(`校园演示账号写入失败：${campusAccount.account}`);
    }
  }

  return {
    code: 0,
    log,
    demoUid: 'demo-liming',
    demoUids: DEMO_PROFILES.map((profile) => profile.uid),
    demoCompanyAccounts: DEMO_COMPANIES.map((company) => company.account),
  };
};
