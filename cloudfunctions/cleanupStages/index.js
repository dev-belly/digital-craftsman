const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

exports.main = async () => {
  const { OPENID } = cloud.getWXContext();
  const adminOpenids = String(process.env.ADMIN_OPENIDS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (!OPENID || !adminOpenids.includes(OPENID)) {
    console.warn('拒绝未授权的数据清理请求');
    return { code: 403, msg: '该管理功能未授权' };
  }

  const validStages = ['学习', '认证', '作品', '企业好评', '人才'];

  // 分批删除所有非法 stage 记录。
  // 云开发单次 where().remove() 有数量上限，必须循环 limit(100) 直到全部删干净。
  let deletedCount = 0;
  for (let round = 0; round < 200; round += 1) {
    const delRes = await db.collection('stages').where({
      stage: _.nin(validStages)
    }).limit(100).remove();
    const removed = (delRes.stats && delRes.stats.removed) || 0;
    deletedCount += removed;
    if (removed < 100) break;
  }

  // 重新统计：用 count 获取真实总数，再分页累计各 stage 数量，避免默认 100 条上限导致统计失真。
  const totalRes = await db.collection('stages').count();
  const total = (totalRes && totalRes.total) || 0;
  const remainByStage = {};
  let skipped = 0;
  while (skipped < total) {
    const listRes = await db.collection('stages').skip(skipped).limit(100).get();
    for (const doc of listRes.data) {
      remainByStage[doc.stage] = (remainByStage[doc.stage] || 0) + 1;
    }
    if (listRes.data.length < 100) break;
    skipped += listRes.data.length;
  }

  return {
    code: 0,
    deletedCount,
    remaining: total,
    remainByStage
  };
};
