# Agent Steward

**你的 Agent 分身，使用你自己的编码代理订阅，在已授权的工作空间里持续协作。**

[English](README.md) · [架构](docs/architecture.md) · [飞书接入](docs/feishu-setup.md) · [路线图](docs/roadmap.md) · [群聊与话题](docs/group-context.md)

你在飞书派活，Steward 记录任务并调用本机 Codex；需要你决定时回来提问，结束后交付结果。每个人部署自己的实例，使用自己的订阅、项目和数据。

当前为 **0.1 早期预览**：支持主人私聊、可选的群聊与话题派活、单任务串行执行。已实现的真实执行器只有 Codex；Claude Code、国产 Coding Plan、他人派活和跨实例协作尚未实现。

## 先体验流程，不需要账号

使用 Node.js 24.x，首批目标系统为 macOS / Linux。

```sh
git clone https://github.com/jgchenu/agent-steward.git
cd agent-steward
npm ci
npm run demo
```

输入一段任务，按提示发送 `/approve <请求ID>`，收到结果后用 `/done <任务ID>` 验收。演示会明确标注“模拟”，不调用模型、不修改项目。

## 接上真实 Codex

先自行安装官方 Codex CLI，用 `codex login` 完成 ChatGPT 登录。Steward 通过官方 App Server 驱动执行，不读取或复制认证文件；启动推理前检查登录类型，默认不回退到按量付费 API。

首次接入飞书，可在尚未创建 `.env` 时直接运行：

```sh
npm run setup:feishu
```

打开官方授权链接，在飞书中确认创建专用机器人。程序预设仅申请私聊收发消息能力；确认页中的权限以飞书实际展示为准。授权成功后，应用身份直接写入本机 `.env`（权限 `0600`），并使用本次授权返回的用户 `open_id` 绑定主人。密钥不会打印到终端，也不会修改已有应用。

已有 `.env` 时安装流程会拒绝覆盖。若平台没有返回主人身份，或识别为尚未支持的 Lark 租户，服务保持不可启动。默认生成只读 `sandbox` 项目，仍需按[接入指南](docs/feishu-setup.md)检查长连接事件与应用发布状态。扫码成功不等于消息链路已验收。

若使用已有应用或只体验本地终端，可手动配置；已完成扫码配置时不要再次覆盖文件：

```sh
cp .env.example .env
cp steward.config.example.json steward.config.json
mkdir -p playground
```

在本地编辑 `.env` 的 `STEWARD_OWNER_ID`。飞书模式使用该应用下你自己的 `open_id`；只体验本地终端时可填 `local-owner`。不要把密码、Cookie、Token 或应用 Secret 发到聊天里。

在 `steward.config.json` 配置项目别名和已有目录。默认 `read-only`；允许修改时必须配置 `workspace-write` 和独立 Git `worktree`，派活时再明确选择“允许修改”。具体配置见[真实项目与 PR 交付](docs/project-delivery.md)。Codex 的本地工具、插件、MCP 配置仍影响实际权限，Steward 不能替代系统隔离和仓库保护。

```sh
npm run doctor
npm run local
```

输入 `/new sandbox 查看当前目录并给出说明`。真实飞书接入见[操作指南](docs/feishu-setup.md)。

## 你可以怎么用

| 指令 | 作用 |
| --- | --- |
| `/projects` | 查看允许工作的项目 |
| `/new <项目> <要求>` | 只读分析；普通文本按已授权项目名、默认空间或唯一项目路由 |
| `/edit <项目> <要求>` | 在独立 Git worktree 里执行修改任务 |
| `/publish <任务ID>` | 打开飞书 PR 预览，点击确认后才发布 |
| `/list`、`/status <任务ID>` | 查看状态、最近记录的进度、结果和待处理请求 |
| `/cancel <任务ID>` | 停止执行；不回滚已经产生的文件修改 |
| `/continue <任务ID> <补充要求>` | 在保存的 Codex 会话里继续工作 |
| `/approve <请求ID>`、`/deny <请求ID>` | 对一次具体权限请求作决定 |
| `/answer <请求ID> <回答>` | 回答问题；多问题用 `{"问题ID":"答案"}` |
| `/done <任务ID>` | 确认验收 |

飞书中直接 **@机器人 + 需求** 即可开始；用 `npm run workspaces` 打开[本地工作空间授权页](docs/workspaces.md)，选择它可访问的项目和默认分析空间。收到任务先回复“在做了”表情，有结果后在线程里回复。只有项目不明确时才需点选；“工作台”和 `/help` 保留为可选表单入口。日常回答和补充问题直接在线程里说，长回复自动分段；你直接接话即可继续。需要授权时才显示“允许本次／拒绝”卡片。主动打开任务管理时仍可查看状态、停止或交付代码。上表指令继续兼容终端和飞书。

普通进度更新复用卡片；需要你决定、结果产出和失败时会发出新卡片通知，避免更新埋在旧消息里。表单最多 1,000 字，更长的任务仍可直接发送文本。普通“好的”不会被当作权限批准，每个实例同一时刻只执行一个任务。

已有应用需在“事件与回调 → 回调配置”检查 `card.action.trigger` 长连接订阅，详见[升级与验收](docs/feishu-setup.md)。

修改任务完成后，Steward 会独立统计改动并运行配置中的验证命令。通过“查看交付”检查文件和验证状态；全部通过后可以预览并确认创建草稿 PR。验证后的文件变化、检查配置变化、远端目标分支变化都会拦截交付。已有开放 PR 会复用，不自动合并或部署。

## 可靠性与限制

任务、事件、消息去重、执行会话 ID 和待发送消息保存在 SQLite。重启后，队列保留；执行中的任务标记为中断，旧确认失效，需要你检查已有修改后明确继续。任务不会因重启自动重做。

消息发送失败会重试，使用稳定的飞书消息 UUID。但飞书去重有时间窗口，长时间断线后仍可能出现重复通知。真实任务会话保存在 Codex 自己的数据目录，单独恢复 Steward 数据库无法恢复已经丢失的 Codex 会话。

`review` 只代表执行器给出了结果，尚不代表独立验证通过。修改、测试、浏览器验收、PR、发布和人工接受是不同的完成条件。生产分支保护需要在 GitHub 等平台落实，发给模型的 Git 规则不等于强制执行控制。

默认仅主人私聊；配置 `groupChats: true` 并开通群消息权限后，可在群里 @机器人派活，并在原话题继续。其他成员消息仅作为参考，不能派活或授权；机器人消息不触发任务。详见[群聊配置与验收](docs/group-context.md)。机器必须在线、进程必须运行。会话等待你回答的时间也计入 `maxRunMinutes` 超时限制。首次运行请先在终端启动，常驻服务安装器后续再提供。

## 开发与分享

```sh
npm run check
```

测试不依赖账号、不调用模型、不向飞书发送消息。`npm run smoke:codex` 是单独的真实订阅检查，会消耗少量额度；`npm run smoke:workspace` 则会在临时 Git 仓库里做一次真实修改和独立验证。两者都不在 CI 中运行。

分享源码和配置示例即可。`.env`、私人配置、数据库、任务历史以及 Codex 认证文件不能随项目分发。

项目使用 [MIT](LICENSE) 许可证。欢迎通过 Issue / PR 参与，见[贡献指南](CONTRIBUTING.md)。

群聊中的截图、语音、视频和 PDF 读取与部署方式见[媒体支持](docs/media.md)。音频使用本地转写，不调用计费语音 API。
