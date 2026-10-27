# 试用与问题反馈 / Support

运行与云端配置按 [README](README.md) 完成；准备提审时继续使用其中的上线操作清单。需要微信开发者工具、相应 AppID 和云开发环境，云函数、数据库权限与工具内交互要单独验收。

先在本地运行：

```bash
npm run check
```

这只检查语法、完整性、策略一致性和无云端 Mock 回归；不会连接数据库、调用云函数或部署，也不能代替开发者工具和真实云环境的验收。

在[项目 Issues](https://github.com/dev-belly/digital-craftsman/issues)提供 commit、开发者工具版本、页面或云函数名、最小操作步骤、预期结果和脱敏日志。说明问题发生在 Mock、本地工具还是真实云函数；只使用专用测试环境与虚构档案复现。管理初始化遵守 README 的身份校验与授权步骤。

不要公开账号密码、会话、学生档案或企业资料；相关问题先读 [安全反馈](SECURITY.md)。

Include the developer-tools version and distinguish local checks from cloud acceptance. Local checks do not upload or deploy the application.
