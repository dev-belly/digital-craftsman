# 首次初始化管理函数

`initDB` 和 `cleanupStages` 都要求服务端 `cloud.getWXContext().OPENID` 出现在各自的 `ADMIN_OPENIDS` 环境变量中。未配置、空身份、非管理员一律返回 `code: 403`，不会访问数据库。环境管理员权限和小程序调用者的微信身份是两回事。

## 1. 确认自己的 OpenID

OpenID 与小程序 AppID 相关，不能拿另一个小程序、公众号的 OpenID 代替，也不能从客户端请求参数中自报身份。已有可信服务端记录时可直接确认管理员本人的 OpenID；全新环境尚无记录时，可以临时部署一个只返回调用者身份的 `whoami` 云函数（依赖 `wx-server-sdk`）：

```js
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
exports.main = async () => ({ openid: cloud.getWXContext().OPENID || '' });
```

使用管理员本人的微信登录开发者工具，确认 `miniprogram/app.js` 已配置目标云环境并编译，在小程序调试器 Console 调用：

```js
wx.cloud.callFunction({ name: 'whoami', data: {} })
  .then(({ result }) => console.log(result.openid));
```

只取这次真实小程序调用返回的非空 OpenID，不使用没有微信上下文的云端测试结果。这个临时函数不读写数据库，也不返回其他人的身份；确认后可在云控制台移除。

身份传递方式见 [CloudBase 官方说明](https://docs.cloudbase.net/recipes/add-cloud-function-wechat-miniprogram)。

## 2. 配置并执行初始化

在目标环境的云函数配置中，为 `initDB` 设置 `ADMIN_OPENIDS` 为刚确认的管理员 OpenID；多位管理员可用英文逗号分隔。保存配置并确认已生效，再由同一个管理员微信在小程序调试器中调用：

```js
wx.cloud.callFunction({ name: 'initDB', data: { seed: true } })
  .then(({ result }) => console.log(result));
```

`seed: false` 只创建缺失集合，`seed: true` 还会补齐演示数据。检查 `code === 0` 后仍要逐条检查 `log` 是否有写入失败；仅有成功返回码不代表每份演示资料都已写入。随后按 [数据库安全规则](../数据库安全规则.md) 配置所有集合的客户端不可读写权限。

若返回 403，检查当前 AppID、环境、调用者微信及环境变量，不能通过修改请求中的 `OPENID`、删除授权判断或开放数据库权限解决。

## 3. 旧阶段清理

`cleanupStages` 使用自己独立的 `ADMIN_OPENIDS` 配置，仅在已备份、确认需要迁移时由管理员微信调用。它会删除不在五阶段名称中的旧记录；首次安装和日常运行无需执行。业务前端不提供这两个管理函数的入口，初始化完成后可移除临时管理授权，后续维护时再按实际需要配置。
