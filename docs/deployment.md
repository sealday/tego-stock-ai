# Vercel 部署与运行

本指南描述 GitHub 集成后的 Production 运维路径。任何示例都只给变量名，不给值；真实凭据
只在 Vercel Dashboard 或交互式 CLI 中录入，不写入仓库、命令历史、日志或 PR。

## 1. 前置条件

- 对 GitHub 仓库和目标 Vercel team/project 有管理权限；
- 有符合条款且权限足够的 Tushare Pro Token；
- Vercel 项目使用 `main` 作为 Production Branch；
- 已选择满足 Functions、Blob 和 Cron 需求的 Vercel 套餐；
- 本地需要 Node.js `>=20.19.0` 和 npm `11.13.0`。

Vercel 的 [Git 集成](https://vercel.com/docs/git)会为非生产分支创建 Preview deployment，并在
Production Branch 合并后创建 Production deployment。导入 GitHub 仓库时选择 Vite；仓库的
`vercel.json` 已固定 Vite framework、响应安全头、Cron 和 Vercel 官方推荐的 SPA rewrite。
按 Vercel 的路由规则，已有静态文件和 Functions 应先于 rewrite 解析；这仍属于部署期行为，
必须用部署 smoke 同时证明客户端深链接和 `/api` 路由没有被 catch-all rewrite 遮蔽。

公开仓库 fork 发起的 PR 默认需要 Vercel 项目成员授权后才部署，避免 Preview secrets 被未知
代码读取；不要为绕过该保护而开放生产凭据。

建议在 GitHub 中把本仓库 CI 的五个检查设为 `main` 分支保护的 required status checks，避免
Vercel 在代码质量证据完成前承担生产流量。

## 2. 连接私有 Blob store

在 Vercel 项目的 Storage 中创建 **Private** Blob store，然后在该 store 的 Projects 页连接
当前项目和需要的环境。Vercel 当前推荐连接项目后的 OIDC：平台管理 `BLOB_STORE_ID`，并在每次
部署提供和轮换 `VERCEL_OIDC_TOKEN`；应用使用的 `@vercel/blob` SDK 会优先解析这组凭据。

`BLOB_READ_WRITE_TOKEN` 是本地或 Vercel 之外运行时的静态回退。Production 不应手工复制该
长期 Token 来替代可用的 OIDC。需要本地联调 Blob 时，用 `vercel env pull` 获取 Development
环境，而不是提交 `.env` 文件。Vercel 的
[@vercel/blob 认证说明](https://vercel.com/docs/vercel-blob/using-blob-sdk)列出了完整解析顺序。

## 3. 环境变量

Vercel 为变量区分 Production、Preview 和 Development；修改变量只影响之后的新部署，需要
重新部署才能生效。变量清单：

| 变量                    | 来源                             | Production                     | Preview / Development              |
| ----------------------- | -------------------------------- | ------------------------------ | ---------------------------------- |
| `TUSHARE_TOKEN`         | 运营者在 Vercel 设置             | 必需；仅服务端                 | 使用独立的受限测试 Token，或不配置 |
| `CRON_SECRET`           | 运营者生成的高熵 secret          | 必需；仅服务端                 | 不复用生产值；无 Cron 联调可不配置 |
| `BLOB_STORE_ID`         | 连接 Blob store 后由 Vercel 管理 | 必需的集成元数据               | 连接独立 store/环境时自动提供      |
| `BLOB_READ_WRITE_TOKEN` | Blob 静态回退                    | OIDC 可用时不手工设置          | 仅本地或异平台回退                 |
| `PUBLIC_APP_ORIGIN`     | 运营者可选设置                   | 自定义域名跨源时设置；否则省略 | 分支域名需要跨源访问时单独设置     |

`VERCEL_OIDC_TOKEN` 由 Vercel 自动注入和轮换，不添加到 `.env.example` 的手工赋值清单。用户的
AI key 不是 Vercel 环境变量，它只存在于用户浏览器会话，或在用户明确选择后保存在该设备。

Production、Preview、Development 必须使用相互独立的敏感值和数据资源。Preview 是公开 PR
可触达的运行环境时尤其不能继承生产 Tushare 或 Cron 凭据。参见 Vercel 的
[环境变量作用域](https://vercel.com/docs/environment-variables)。

在支持的环境中把 `TUSHARE_TOKEN` 和 `CRON_SECRET` 标记为 Sensitive。`CRON_SECRET` 至少使用
32 个随机字符，既高于 Cron 的最低要求，也满足当前 Vercel 构建日志自动 redaction 的长度
前提。Development 变量不能标记 Sensitive，因此本地仅使用单独的开发值。

## 4. Cron 时间、保护和套餐差异

`vercel.json` 中的 `30 8 * * 1-5` 始终按 UTC 解释，即工作日预定在 Asia/Shanghai 16:30，
晚于 A 股 15:00 收盘。Vercel Cron 调用时会把 `CRON_SECRET` 自动放入 `Authorization` 请求头，
路由使用定时安全比较；无 secret 返回 503，未授权请求返回 401。

Vercel Cron 只调用 Production deployment，不调用 Preview deployment；Preview 中验证路由时
只能做无授权的 401 检查，不应手工携带生产 secret 调用刷新。

Cron 套餐差异必须纳入告警预期：Hobby 只允许每天一次，且可能在指定小时内任意时间触发，
因此该表达式在 Hobby 上实际可能落在 Asia/Shanghai 16:00–16:59；其他 team 通常在指定分钟
内触发。Cron 是尽力投递、失败不自动重试，也可能重复调用。实现以不可变快照和条件指针保持
幂等，并在失败时保留 last-good snapshot。以 Vercel 的
[Cron 管理文档](https://vercel.com/docs/cron-jobs/manage-cron-jobs)和当前套餐限制为准。

不要把 Cron 路由当作人工操作接口，也不要在 shell 历史中拼接 `CRON_SECRET`。在 Dashboard
的 Settings → Cron Jobs 查看触发状态和过滤后的 Function logs。

## 5. CSP 与自定义 AI 端点

BYOK 允许用户输入任意可信 OpenAI-compatible HTTPS Base URL，因此生产 CSP 使用
`connect-src 'self' https:`。这是有意的权衡：浏览器可以向任意 HTTPS origin 发起 `fetch`，
但远程脚本、frame、字体、样式、对象和 HTML 仍不能因此加载。用户主动生成报告时，自定义
端点会收到有限的股票研究上下文和用户 API key；端点的隐私政策和日志行为不受本项目控制。

如果运营者要把 `connect-src` 缩成固定 allowlist，必须同时取消任意自定义端点能力，或在产品
中限制为同一 allowlist；不能只改 CSP 而保留一个表面可配置但实际不可用的设置。

## 6. 部署后验证

Production deployment 进入 Ready 后，先运行无凭据烟测：

```sh
npm run smoke:deployment -- https://your-production-domain.example
```

该命令要求显式 HTTP(S) base URL，不读取或打印环境 secret，并验证：

1. `/api/health` 返回 200、JSON、`no-store`，且报告 provider 已配置；
2. 非法 API 输入返回安全的 typed error；
3. 股票搜索返回 Tushare envelope、正向公共缓存和可观察的 Vercel MISS/HIT；
4. SPA 深链接回退到包含 root 节点的 HTML；
5. 无 `Authorization` 的 `/api/cron/daily-close` 返回 401 和 `no-store`。

烟测通过只证明所查询路径和 Token 基础配置可用。Tushare 的接口权限可能因账号方案而异；
还应在 UI 中检查一只有完整历史/估值/财务数据的股票，并确认缺失字段显示原因而非伪造数值。
烟测不会执行已授权 Cron、不会证明 Blob 快照成功刷新，也不会覆盖全部股票路由或浏览器 AI；
这些项目必须结合 Cron logs、`/api/market/status` 和人工研究工作流分别确认。

## 7. 回滚与数据恢复

出现生产回归时：

1. 先记录故障 deployment URL 和受影响路由；
2. 在 Vercel Deployments 对上一个已通过 smoke 的 deployment 执行 Instant Rollback，或运行
   `vercel rollback`；
3. 再次运行部署 smoke，确认流量已回到 last-good deployment；
4. 在 Preview 修复并验证后，合并或 promote 新 deployment。

Hobby 只能回滚到紧邻的上一 Production deployment；Pro/Enterprise 可按 URL 选择更早版本。
Vercel 的 [rollback 指南](https://vercel.com/docs/deployments/rollback-production-deployment)
说明了 CLI 和套餐差异。

应用数据快照与代码 deployment 独立：Cron 失败不会删除上一成功快照。还要注意 Vercel 的
两份官方文档对 Instant Rollback 是否同步恢复 Cron 配置存在冲突，不能假设调度会自动回退。
每次 rollback 后都应在 Settings → Cron Jobs 核对 path/schedule；若故障来自调度配置，手动
禁用或随修复 deployment 更新，然后确认下一次运行和 `/api/market/status` freshness。

Instant Rollback 后还要检查 Production domain 的自动分配状态。修复版验证完成后，如项目仍
处于 rollback 状态，使用 `vercel promote` 恢复经过验证的 deployment，并重新运行 Production
smoke；Preview 与 Production 的环境变量不同，不能用 Preview 结果替代这一步。
