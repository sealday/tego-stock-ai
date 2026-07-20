# tego-stock-ai

面向 A 股日线研究、公开开发的量化终端。它把 Tushare Pro 的历史行情、估值和财务数据规范化，
在浏览器中计算可解释指标，并允许用户用自己的 OpenAI-compatible 服务生成结构化研究报告。

> 所有内容仅供研究与教育使用，不构成投资建议、交易指令或收益保证。数据为历史日线收盘
> 口径，属于非实时行情；v1 不包含新闻、情绪分析或券商交易连接。

## 产品边界

- Tushare Pro 凭据只存在于 Vercel 服务端环境；浏览器只读取规范化的公共数据接口。
- 技术指标和评分是确定性计算，缺失输入会被剔除并说明原因，不会由 AI 补造。
- AI 是可选的 BYOK（用户自带 API key）能力。浏览器直接调用用户选择的端点，项目的
  Vercel Functions 不代理 AI 请求，也不承担 AI 费用。
- 无账户、无云同步、无 v1 遥测。自选股、界面设置和研究报告保存在当前浏览器的
  IndexedDB 中，并提供导出、删除报告、清除凭据和清除全部本地数据的控制。

## 本地开发

前置条件：

- Node.js `>=20.19.0`；CI 使用 Node.js 24。
- npm `11.13.0`，以 `package-lock.json` 为准安装。
- Chromium，用于 Playwright 浏览器测试。

安装并启动 Vite 前端：

```sh
npm ci
npx playwright install chromium
npm run dev
```

`npm run dev` 只启动 Vite。需要联调真实 `api/` Functions 时，应先在 Vercel 中配置开发
环境变量，再使用已登录并链接项目的 Vercel CLI 运行 `vercel dev`。固定测试和 CI 不需要
任何真实 Tushare 或 AI 密钥。

常用验证命令：

```sh
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run test:browser
npm run ci:portable
npm run ci
```

`npm run ci:portable` 可在常规开发/CI 环境运行。`npm run ci` 额外执行像素级视觉测试；本机
视觉通道要求 macOS arm64，合并门禁的权威基线由 GitHub `macos-26` runner 维护。

## 数据和 AI 使用

生产数据来自 Tushare Pro。运营者的 Token 权限决定可用字段；接口会返回 `source`、
`asOf`、`freshness`、`availability` 和 `limitations`，前端据此显示截止日期、陈旧状态和缺失
原因。`/api/health` 只确认服务端 Token 已配置，不代表所有 Tushare 接口权限都已开通。

AI 设置包含 Base URL、模型标识和 API key。API key 默认只在当前会话内使用；只有用户明确
选择记住后才写入当前设备。自定义端点会收到用户主动发起的有限研究上下文，因此只应选择
用户信任的 HTTPS 服务。详见[隐私说明](docs/privacy.md)。

## 文档

- [系统架构与数据边界](docs/architecture.md)
- [Vercel 部署、验证与回滚](docs/deployment.md)
- [本地数据与 BYOK 隐私](docs/privacy.md)
- [CSP 浏览器连接策略](docs/security-csp.md)
- [批准的产品设计](docs/superpowers/specs/2026-07-18-tego-stock-ai-design.md)

## 许可证状态

仓库当前尚未添加许可证文件。代码可以公开审阅，但在许可证确定前，不应假定已获得复制、
分发或再授权许可。
