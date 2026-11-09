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

消费时再用只读 API 核对项目/环境并获取脱敏证据，与轮询共用事务去重和配额。读取失败保留队列并指数退避（30 秒至 1 小时），容量不足一分钟后再试。来源撤销时丢弃旧授权收件；现有任务仍保留。`npm run alerts -- status` 显示待消费数及最大重试次数。轮询继续作为补漏入口；它不等同于 Alert Rule 的阈值语义。两种入口共用取证和复发判断；相同证据不会重复建单，版本、堆栈、来源或累计影响变化按下述规则复查。已建过任务的 issue 仍可接收后续 Webhook。

## 官方 Sentry MCP 补查（可选）

先核对数字项目 ID 对应的 slug，在来源的 `sentry` 中增加 `"mcpProject": "your-project-slug"`。Steward 只为有有效 Sentry 来源绑定的任务注入固定官方地址 `https://mcp.sentry.dev/mcp/<organization>/<mcpProject>`，不为普通任务注册新工具。环境不是 MCP 的权限边界；执行器必须继续按配置过滤环境。

由官方 Codex 完成 OAuth，不复制、解析或转存它的认证文件。可用临时 CLI 配置登录，不修改全局 MCP 配置：

```sh
codex -c 'mcp_servers.steward_sentry.url="https://mcp.sentry.dev/mcp/your-org/your-project-slug"' mcp login steward_sentry --scopes org:read,project:read,team:read,event:read
```

**实际授权页优先于 CLI scopes 参数**：仅勾选 Inspect Issues & Events，取消 Seer、Triage Issues、Manage Projects & Teams，核对页面中的组织/项目范围后批准。不同来源 URL 需要各自完成官方 OAuth。MCP 是额外的诊断通道，不能用它代替接收服务所需的只读 API token。新授权失败时保留原来的轮询。

OAuth 可能有第二层 Sentry 应用授权页。已观察到第一层只选 Inspect 后，第二层仍请求 Teams/Projects/Events/Alerts 写权限；第一层工具范围不能证明底层 OAuth Token 是只读。只获准读取时，不得代为批准这个扩权页面。需核对实际应用授权，再分别记录 MCP 会话的工具限制与上游应用权限。官方实现目前在上游授权请求中使用完整 scope 列表，参见 [授权处理代码](https://github.com/getsentry/toolkit/blob/main/packages/mcp-cloudflare/src/server/oauth/routes/authorize.ts)。

执行时 MCP 是 required，缺少授权/连接失败应明确失败；工具只开放读取 issue/event/resource 和查询，排除修改、Seer 与通用执行网关。运行时继承本机 Codex 的其他配置和工具，白名单仅约束 Steward 添加的这个 server。MCP 返回的数据由官方运行时消费，可能比轮询白名单更详细；应只授权允许向该执行器提供诊断数据的项目。不得在 PR/日志中复制原始个人数据或事件全文。为已有来源增加 Webhook/MCP 不改变来源授权键，因此保留历史任务、游标和去重；修改实际来源、接收人或代码授权仍会撤销旧任务执行资格。

官方依据：[Sentry MCP](https://mcp.sentry.dev/)、[Sentry Webhooks](https://docs.sentry.io/integrations/integration-platform/webhooks/)、[Issue Alert Webhooks](https://docs.sentry.io/integrations/integration-platform/webhooks/issue-alerts/)、[Codex MCP](https://developers.openai.com/codex/mcp)。

没有服务器和自有域名时，见 [Worker + Queue 部署方案](alerts-deployment-plan.md)。该方案尚未实现部署；已有本地 Webhook 接收器不能直接等同于云端入口。

## 运行行为与边界

- 首次启用（或来源/项目授权发生变化）以当时为起点，不自动导入历史积压。之后读取指定环境中在窗口内发生过的未解决问题，包括旧问题的新发生事件。这是 issue 轮询，不是 Sentry Alert Rule 的逐次投递或阈值事件重放。
- 每页最多 20 个 issue，按 API cursor 分页；固定窗口在 SQLite 中保存，完成后留一分钟重叠。同一来源授权下保留首次任务绑定；相同证据不重复建单。发现未分析过的版本、堆栈或来源，或累计报错数翻倍且增加至少 100、累计用户数翻倍且增加至少 10，才创建隔离复查任务。对比上一次实际分析的基线，普通轮询不重置增长基线；计数是 issue API 返回的累计值，不是错误率，也不能归因于某个扩展样本。已分析过的签名不会仅因旧客户端版本交替出现而重复建单。已解决/忽略的问题不自动建单。
- 默认每个来源每天最多 5 个分析任务（含复发，UTC 日期，可配置 1–20），全实例告警待处理任务最多 2 个。配额计数跨重启保留；同一 issue 的任务或可信基线后继处于 queued/running/waiting_input/waiting_approval/interrupted 时不另建复发任务；复查最短间隔一小时。容量不足或等待冷却时保留当前页，下次重试，并继续处理该页其他 issue 的噪声采样。原补证、审批和交付状态不被覆盖。review/failed/cancelled/completed 不占待处理名额，但仍计当天的新任务数。API 失败不推进进度；错误变更时通过持久化 outbox 通知主人。可用 `status` 检查 `capacity_wait` 或最近 API 错误。
- 本地离线、Sentry 保留期、API 分页和问题状态变化会影响可见数据；这不是无损的逐事件归档。错误、过期 cursor 或长期积压会停留在可检查的状态，不以跳过窗口掩盖失败。
- 只保存经过字段白名单筛选的标题、计数、日期、版本、异常类型/值和最多 3×20 个源码栈帧，以及合法事件 ID/时间。额外只接收 `browser_extension_source.evidence=original_exception_stack` 下最多 3 个合法公开 Chromium 扩展 origin，不保留其他 contexts、扩展路径或 Firefox 用户配置 UUID。堆栈被截断时不可建立噪声规则。丢弃用户对象、请求、Cookie、breadcrumbs、frame vars 和源码上下文，对选中字符串去除常见 URL/邮箱/凭证样式。栈帧脚本地址例外保留协议、主机和脱敏路径，用于辨别插件注入；去掉 userinfo、查询参数和片段，不主动下载脚本。任意业务文本不能保证完全匿名化；只连接允许向当前执行器提供这些诊断字段的项目。
- 外部诊断数据明确标记为不可信，不能成为发布、授权或外发指令。模型需先区分插件/网络噪音、预期业务失败与代码缺陷，验证根因，再修复和测试。无充分证据只报告缺口。
- 新建任务和去重记录、来源绑定、飞书通知同事务提交。执行沿用 Engine 的并发与单代码执行限制。禁用来源或改变绑定会阻止排队任务，并中止已运行的相关任务；保留工作目录。恢复原授权后可由主人继续，不静默转换任务范围。
- 结果通过既有 outbox 发回配置私聊。修复完成后生成 PR 预览；提交/推送/创建草稿 PR 仍使用原有一次性确认，合并与部署不属于告警授权。

## 本机确认的噪声分流

告警标题、扩展 ID 和模型结论本身不能创建噪声规则。完成证据核对后，本机操作员可查看脱敏采样，再用对应签名确认：

```sh
npm run alerts -- inspect-noise my-web-errors 123456
npm run alerts -- confirm-noise my-web-errors 123456 SIGNATURE "已核对扩展源码与事件堆栈"
npm run alerts -- clear-noise my-web-errors 123456
```

`SIGNATURE` 是 inspect 返回的 SHA-256；证据变化后旧签名不能确认新样本。命令只改本地路由，不修改 Sentry 状态，也不直接调用模型或发送消息。规则绑定来源授权、issue、完整脱敏异常堆栈和公开扩展来源；包含普通 Web 脚本或缺失堆栈的样本不可确认。所有栈帧必须属于 `app:///` 或 Chromium 扩展地址，并且已由操作员查证。无法根据这些字段判定身份的事件继续分析。

匹配规则的样本不创建修复任务，经持久化 outbox 以普通聊天消息发到来源私聊汇总：首批立即发送，此后每来源最多一小时一次、每批最多 20 个 issue。重复采到同一事件不累加；无事件 ID 时使用 lastSeen/计数作为降级标识。汇总中的采样次数不是实际错误总数。版本变化而来源与堆栈仍完全一致时，确定性复核后仍走汇总；来源或堆栈变化、证据缺失、规则撤销时重新进入分析并保留配额/冷却限制。普通网络错误不能仅凭标题套用此规则。

升级为 schema 14 时，已有首次任务迁入分析台账，不重复消耗预算；首次重采样只建立旧 issue 基线，不重放历史任务。告警接单、追问和结果都直接在私聊里交流，不要求填写任务表单；授权操作仍需明确确认。新分析任务拥有独立工作区、会话和发布审批，携带历史任务/PR 及计数对比，不继承旧发布例外。轮询和 Webhook 都只复核最新样本，并非逐事件分类：不同来源混在同一 issue 时不能据此声称所有事件都来自扩展。

## 验证

`npm run check` 中的测试全部使用模拟 Sentry/执行器，不调用真实订阅或飞书。真实接入需分别记录：只读 API check、官方 MCP OAuth 与真实只读工具调用（若启用）、Sentry 实际投递和验签（若启用）、来源启用后的真实问题建单、Codex 根因分析/验证、私聊回执、PR 发布。单独一个 API 成功或本机测试不能代替这些验收。

接口依据：[组织 Issue 列表](https://docs.sentry.io/api/events/list-an-organizations-issues/)、[Issue 详情](https://docs.sentry.io/api/events/retrieve-an-issue/)、[Issue 事件](https://docs.sentry.io/api/events/retrieve-an-issue-event/)。


## 群话题协作（可选）

在来源上增加 `collaborationChatId: "oc_YOUR_AUTHORIZED_GROUP"`，并启用顶层 `groupChats: true`。
`chatId` 仍必须是主人与机器人的私聊，不要替换成群 ID；两者不能相同。配置群 ID 即授权向这个群分享下述有限进展，启用前核实群、成员范围、机器人可见性和发送权限。各项目可以配置不同的群。未配置时完全保留私聊流程。

- 配置后的新分析任务按来源授权 + issue + 群建立一个普通消息话题；后续复查和可信基线替换沿用它。启用时不会批量发布历史私聊任务，也不按相似标题把独立人类反馈猜测合并。已确认的噪声继续使用私聊摘要，不在群里逐条建话题。
- 群内仅发布控制器事实：问题链接、需要信息/授权、分析结束及配置检查通过数量、已记录 PR、已验证合并、执行停止。任务正文、私聊补充、模型分析全文、问题原文、日志、截图和审批控件不自动转发。当前没有自动生成可公开的根因摘要，也没有读取发布群并关联生产部署的能力；合并消息明确说明生产验证尚未确认。
- 群内回复机器人的已记录消息或在该话题 @机器人，可以用普通文字补充线索。仅主人及已有受信任发起人名单可提交；普通闲聊、其他机器人、未授权成员或跨话题引用不能发起/控制告警任务。图片和附件暂不从该协作入口读取，需在私聊任务中补充。每条文字最多 4000 字，每个话题累计最多 32000 字，超限明确拒收。
- 线索按消息 ID 去重并作为不可信参考材料加入原任务，不改变任务主人、代码范围、私聊焦点或审批目的地。主人向已结束分析（review/completed）补充线索时继续原任务和会话；受信任同事只贡献证据，不执行主人的任务。执行中、等待输入/授权、已中断或存在不确定外部操作时只保存线索并通知私聊，后续正常继续任务才读取；不会抢答原有请求。群内命令提示回私聊，普通“好的”不批准任何操作。
- 根消息和回复有独立持久消息绑定与稳定投递 UUID，根消息未成功送达时后续回复等待重试，不降级为新话题。状态去重与 outbox 同事务，服务重启不重复接单；飞书去重窗口以外仍可能出现重复网络投递。
- 更换/删除协作群或关闭群功能后，旧话题停止接收线索和发送尚未投递的通知。通知目的地不进入执行授权指纹，因此不会重置 Sentry 游标、复发预算或私聊审批；原有任务仍按原授权执行。已发出的群消息和正在进行的网络请求无法撤回。

上线验收需选定具体群，再验证机器人在群内的发送/回复权限、真实话题回复和私聊授权边界。模拟测试通过不代表已经在公司群启用。授权目的地的配置扩展不能替代群消息的发送授权。
