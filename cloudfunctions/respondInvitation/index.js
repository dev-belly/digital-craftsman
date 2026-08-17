// 学生处理企业邀约：仅邀约本人可接受或婉拒。
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

async function validateStudentSession(uid, sessionToken, openid) {
  if (!uid || !sessionToken || !openid) return null;

  let sessionRes;
  try {
    sessionRes = await db.collection('sessions').doc(sha256(sessionToken)).get();
  } catch (error) {
    return null;
  }
  const session = sessionRes.data;
  if (!session || session.uid !== uid || session.openid !== openid
    || dateValue(session.expiresAt) <= Date.now() || !session.account) {
    return null;
  }

  let accountRes;
  try {
    accountRes = await db.collection('campus_accounts').doc(session.account).get();
  } catch (error) {
    return null;
  }
  const account = accountRes.data;
  if (!account || (account.status && account.status !== 'active')
    || Number(account.passwordVersion) !== Number(session.passwordVersion)) {
    return null;
  }
  return session;
}

// 事务内安全读取：文档不存在时返回 null，不抛出非业务异常（避免触发事务重试后才落到 99）。
async function getInTx(transaction, documentReference) {
  try {
    const res = await documentReference.get();
    return res.data || null;
  } catch (error) {
    return null;
  }
}

// 事务遇到并发冲突（-501001 / TransactionBusy）时有限指数退避重试；
// 不重试集合缺失、权限等确定性错误。与 changePassword / register 等保持一致。
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

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const uid = String((event && event.uid) || '').trim();
  const sessionToken = String((event && event.sessionToken) || '');
  const invitationId = String((event && event.invitationId) || '').trim();
  const action = event && event.action === 'accepted' ? 'accepted'
    : event && event.action === 'declined' ? 'declined' : '';

  const session = await validateStudentSession(uid, sessionToken, OPENID);
  if (!session) return { code: 401, msg: '登录已失效，请重新登录' };
  if (!invitationId || !action) return { code: 1, msg: '邀约操作无效' };

  try {
    const response = await runTxWithRetry(async (transaction) => {
      const invitationRef = transaction.collection('invitations').doc(invitationId);
      const invitation = await getInTx(transaction, invitationRef);
      if (!invitation || invitation.uid !== uid) {
        return { code: 403, msg: '无权处理该邀约' };
      }
      if (invitation.status && invitation.status !== 'pending') {
        if (invitation.status === action) {
          return { code: 0, status: action, msg: '该邀约已处理' };
        }
        return { code: 409, msg: '该邀约已经处理，无法重复操作' };
      }

      const now = new Date();
      await invitationRef.update({
        data: {
          status: action,
          respondedAt: now,
          updatedAt: now,
        },
      });

      let talentStageCompleted = false;
      // 接受邀约本身不能越过前四个成长阶段。只有学习、认证、作品、企业好评
      // 均已完成且学生主动开放人才池时，才在同一事务内点亮“人才”阶段。
      if (action === 'accepted') {
        const prerequisiteRefs = [1, 2, 3, 4].map((number) => (
          transaction.collection('stages').doc(`${uid}-stage-${number}`)
        ));
        const [user, ...prerequisites] = await Promise.all([
          getInTx(transaction, transaction.collection('users').doc(uid)),
          ...prerequisiteRefs.map((reference) => getInTx(transaction, reference)),
        ]);
        const eligible = Boolean(user && user.talentPoolVisible
          && prerequisites.every((stage) => stage && stage.status === 'done'));
        if (eligible) {
          const stageRef = transaction.collection('stages').doc(`${uid}-stage-5`);
          const stage = await getInTx(transaction, stageRef);
          if (stage) {
            if (stage.status !== 'done') {
              await stageRef.update({ data: { status: 'done', completedAt: now, updatedAt: now } });
            }
          } else {
            await stageRef.set({
              data: {
                uid,
                stage: '人才',
                status: 'done',
                startedAt: now,
                completedAt: now,
                createdAt: now,
                updatedAt: now,
              },
            });
          }
          talentStageCompleted = true;
        }
      }

      return {
        code: 0,
        status: action,
        talentStageCompleted,
        msg: action === 'accepted' ? '已接受企业邀约' : '已婉拒企业邀约',
      };
    });
    return response;
  } catch (error) {
    console.error('处理企业邀约失败', error);
    return { code: 99, msg: '邀约处理失败，请稍后重试' };
  }
};
