# Sentry 监控接入

这是本地常驻服务中的可选监控入口：轮询可独立运行，也可增加 Sentry Webhook 和官方只读 MCP。项目、来源凭证、环境、执行模式和通知私聊都由本机主人配置。新项目复用同一条队列、Codex 执行器、隔离工作区与 PR 确认流程；Sentry 连接器不直接调用模型、Git 或飞书。

## 配置

先按 [项目交付](project-delivery.md) 授权已有 Codex 项目。把以下内容合并进私人 `steward.config.json`，不要提交私人配置。

```json
{
  "alertSources": {
    "my-web-errors": {
      "kind": "sentry",
      "enabled": false,
      "project": "myproject",
      "chatId": "oc_OWNER_BOT_PRIVATE_CHAT",
      "mode": "workspace-write",
      "pollSeconds": 300,
      "maxTasksPerDay": 5,
      "sentry": {
        "region": "us",
        "organization": "your-org",
        "projectId": "123456789",
        "environment": "production",
        "tokenEnv": "STEWARD_SENTRY_MY_WEB_TOKEN"
      }
    }
  }
}
```

`project` 必须是配置中的代码项目授权键，不是 Sentry slug 或文件路径。`workspace-write` 必须配置隔离 worktree；不会接受 direct 工作目录。`read-only` 只分析。先核对 `chatId` 确实是主人与当前机器人在同一组织中的私聊；它是本机配置授予的通知目的地，不从告警正文推断，也不授予聊天参与者控制权。多个实例不能同时执行重叠的代码/Git 任务；启用前明确每个项目由哪一个实例负责。

在同目录私人 `.env` 填写 `STEWARD_SENTRY_MY_WEB_TOKEN=...`，保持文件权限 `0600`。创建只读 Sentry API token，所用 API 需要 `event:read`，不需要写入 issue 或管理组织权限。不要将值贴到聊天或提交仓库。变量名必须为 `STEWARD_SENTRY_*_TOKEN`；既有子进程环境过滤会移除它。服务仍作为本机用户运行，环境过滤不是文件系统沙箱。

`region` 仅接受 `us`、`eu`、`global`，分别访问 `us.sentry.io`、`de.sentry.io`、`sentry.io`；不接受自定义 API 地址或重定向。当前不支持 self-hosted Sentry。必须指定单个数字项目 ID 和明确环境，不能用 `-1` 读取全部项目。

```sh
npm run alerts -- check my-web-errors
npm run alerts -- status
```

`check` 读取最近 24 小时第一页及一个代表事件，只输出连通性和数量；即使来源停用也可诊断，不创建任务、不发送消息、不调用 Codex。`status` 只读本机状态。若没有匹配问题，列表连通不代表事件详情权限或实际诊断成功。填好凭证后重启服务加载环境变量，检查通过再把 `enabled` 改为 `true`；Feishu 服务会热更新配置。terminal/demo 模式不启动轮询。

## Webhook 主动触发（可选）

在来源上增加 `webhook`，在私人 `.env` 中配置独立监听端口和 Sentry Internal Integration 的 Client Secret：

```json
"webhook": {
  "secretEnv": "STEWARD_SENTRY_MY_WEB_WEBHOOK_SECRET",
  "installationId": "YOUR_INSTALLATION_UUID"
}
```

```dotenv
STEWARD_ALERT_WEBHOOK_PORT=17833
STEWARD_SENTRY_MY_WEB_WEBHOOK_SECRET=YOUR_PRIVATE_CLIENT_SECRET
```

接收路径为 `http://127.0.0.1:17833/sentry/my-web-errors`。用固定 HTTPS 反向代理/隧道仅暴露这个端口；不得暴露控制台端口。配置 Sentry 内部集成的 Webhook URL 为对应 HTTPS 路径，启用 Alert Rule Action，并在目标项目的 production Issue Alert Rule 中选择该集成。创建/授权内部集成需要管理员的明确批准。随机临时隧道只适合验证，不是持续服务的固定入口。

接收器校验原始请求体的 HMAC-SHA256、安装 UUID、项目 ID 和环境，限制请求体 1 MB、请求时间 10 秒和并发连接 32。只接受 `event_alert` / `triggered`，不支持 metric alert。其他已签名事件返回空成功。它仅保存 issue ID、来源授权和接收时间；不保存原始事件，也不把正文当任务指令。ACK 在 SQLite 入队之后返回，模型/API 查询在后台发生。最多 1000 条待处理 issue，满时返回 503 让发送方重试；这是容量限制，不是无损归档承诺。

消费时再用只读 API 核对项目/环境并获取脱敏证据，与轮询共用事务去重和配额。读取失败保留队列并指数退避（30 秒至 1 小时），容量不足一分钟后再试。来源撤销时丢弃旧授权收件；现有任务仍保留。`npm run alerts -- status` 显示待消费数及最大重试次数。轮询继续作为补漏入口；它不等同于 Alert Rule 的阈值语义。两种入口对同一来源/issue 最多建一个任务，重复投递不自动重跑已完成的问题。

## 官方 Sentry MCP 补查（可选）

先核对数字项目 ID 对应的 slug，在来源的 `sentry` 中增加 `"mcpProject": "your-project-slug"`。Steward 只为有有效 Sentry 来源绑定的任务注入固定官方地址 `https://mcp.sentry.dev/mcp/<organization>/<mcpProject>`，不为普通任务注册新工具。环境不是 MCP 的权限边界；执行器必须继续按配置过滤环境。

由官方 Codex 完成 OAuth，不复制、解析或转存它的认证文件。可用临时 CLI 配置登录，不修改全局 MCP 配置：

```sh
codex -c 'mcp_servers.steward_sentry.url="https://mcp.sentry.dev/mcp/your-org/your-project-slug"' mcp login steward_sentry --scopes org:read,project:read,team:read,event:read
```

**实际授权页优先于 CLI scopes 参数**：仅勾选 Inspect Issues & Events，取消 Seer、Triage Issues、Manage Projects & Teams，核对页面中的组织/项目范围后批准。不同来源 URL 需要各自完成官方 OAuth。MCP 是额外的诊断通道，不能用它代替接收服务所需的只读 API token。新授权失败时保留原来的轮询。

执行时 MCP 是 required，缺少授权/连接失败应明确失败；工具只开放读取 issue/event/resource 和查询，排除修改、Seer 与通用执行网关。运行时继承本机 Codex 的其他配置和工具，白名单仅约束 Steward 添加的这个 server。MCP 返回的数据由官方运行时消费，可能比轮询白名单更详细；应只授权允许向该执行器提供诊断数据的项目。不得在 PR/日志中复制原始个人数据或事件全文。为已有来源增加 Webhook/MCP 不改变来源授权键，因此保留历史任务、游标和去重；修改实际来源、接收人或代码授权仍会撤销旧任务执行资格。

官方依据：[Sentry MCP](https://mcp.sentry.dev/)、[Sentry Webhooks](https://docs.sentry.io/integrations/integration-platform/webhooks/)、[Issue Alert Webhooks](https://docs.sentry.io/integrations/integration-platform/webhooks/issue-alerts/)、[Codex MCP](https://developers.openai.com/codex/mcp)。

## 运行行为与边界

- 首次启用（或来源/项目授权发生变化）以当时为起点，不自动导入历史积压。之后读取指定环境中在窗口内发生过的未解决问题，包括旧问题的新发生事件。这是 issue 轮询，不是 Sentry Alert Rule 的逐次投递或阈值事件重放。
- 每页最多 20 个 issue，按 API cursor 分页；固定窗口在 SQLite 中保存，完成后留一分钟重叠。同一来源授权下每个 issue 最多创建一个任务，重启不会重复建单。重复发生不自动重新修复；在原任务由主人明确继续。已解决/忽略的问题不自动建单。
- 默认每个来源每天最多 5 个新任务（UTC 日期，可配置 1–20），全实例告警待处理任务最多 2 个。配额计数跨重启保留；容量不足保留当前页，下次重试。review/failed/cancelled/completed 不占待处理名额，但仍计当天的新任务数。API 失败不推进进度；错误变更时通过持久化 outbox 通知主人。可用 `status` 检查 `capacity_wait` 或最近 API 错误。
- 本地离线、Sentry 保留期、API 分页和问题状态变化会影响可见数据；这不是无损的逐事件归档。错误、过期 cursor 或长期积压会停留在可检查的状态，不以跳过窗口掩盖失败。
- 只保存经过字段白名单筛选的标题、计数、日期、版本、异常类型/值和最多 3×20 个源码栈帧。丢弃用户对象、请求、Cookie、breadcrumbs、frame vars 和源码上下文，对选中字符串去除常见 URL/邮箱/凭证样式。栈帧脚本地址例外保留协议、主机和脱敏路径，用于辨别插件注入；去掉 userinfo、查询参数和片段，不主动下载脚本。任意业务文本不能保证完全匿名化；只连接允许向当前执行器提供这些诊断字段的项目。
- 外部诊断数据明确标记为不可信，不能成为发布、授权或外发指令。模型需先区分插件/网络噪音、预期业务失败与代码缺陷，验证根因，再修复和测试。无充分证据只报告缺口。
- 新建任务和去重记录、来源绑定、飞书通知同事务提交。执行沿用 Engine 的并发与单代码执行限制。禁用来源或改变绑定会阻止排队任务，并中止已运行的相关任务；保留工作目录。恢复原授权后可由主人继续，不静默转换任务范围。
- 结果通过既有 outbox 发回配置私聊。修复完成后生成 PR 预览；提交/推送/创建草稿 PR 仍使用原有一次性确认，合并与部署不属于告警授权。

## 验证

`npm run check` 中的测试全部使用模拟 Sentry/执行器，不调用真实订阅或飞书。真实接入需分别记录：只读 API check、官方 MCP OAuth 与真实只读工具调用（若启用）、Sentry 实际投递和验签（若启用）、来源启用后的真实问题建单、Codex 根因分析/验证、私聊回执、PR 发布。单独一个 API 成功或本机测试不能代替这些验收。

接口依据：[组织 Issue 列表](https://docs.sentry.io/api/events/list-an-organizations-issues/)、[Issue 详情](https://docs.sentry.io/api/events/retrieve-an-issue/)、[Issue 事件](https://docs.sentry.io/api/events/retrieve-an-issue-event/)。
