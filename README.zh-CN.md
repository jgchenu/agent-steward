# Agent Steward

**属于你的数字员工，使用你自己的编码代理订阅。**

[English](README.md) · [架构](docs/architecture.md) · [飞书接入](docs/feishu-setup.md) · [路线图](docs/roadmap.md)

你在飞书派活，Steward 记录任务并调用本机 Codex；需要你决定时回来提问，结束后交付结果。每个人部署自己的实例，使用自己的订阅、项目和数据。

当前为 **0.1 早期预览**：支持主人私聊、单任务串行执行。已实现的真实执行器只有 Codex；Claude Code、国产 Coding Plan、他人派活和跨实例协作尚未实现。

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

```sh
cp .env.example .env
cp steward.config.example.json steward.config.json
mkdir -p playground
```

在本地编辑 `.env` 的 `STEWARD_OWNER_ID`。飞书模式使用该应用下你自己的 `open_id`；只体验本地终端时可填 `local-owner`。不要把密码、Cookie、Token 或应用 Secret 发到聊天里。

在 `steward.config.json` 配置项目别名和已有目录。默认 `read-only`；确认要允许修改后，才改为 `workspace-write`。先用一次性测试目录。Codex 的本地工具、插件、MCP 配置仍影响实际权限，Steward 不能替代系统隔离和仓库保护。

```sh
npm run doctor
npm run local
```

输入 `/new sandbox 查看当前目录并给出说明`。真实飞书接入见[操作指南](docs/feishu-setup.md)。

## 你可以怎么用

| 指令 | 作用 |
| --- | --- |
| `/projects` | 查看允许工作的项目 |
| `/new <项目> <要求>` | 派活；只有一个项目时也可直接发普通文本 |
| `/list`、`/status <任务ID>` | 查看状态、最近记录的进度、结果和待处理请求 |
| `/cancel <任务ID>` | 停止执行；不回滚已经产生的文件修改 |
| `/continue <任务ID> <补充要求>` | 在保存的 Codex 会话里继续工作 |
| `/approve <请求ID>`、`/deny <请求ID>` | 对一次具体权限请求作决定 |
| `/answer <请求ID> <回答>` | 回答问题；多问题用 `{"问题ID":"答案"}` |
| `/done <任务ID>` | 确认验收 |

首版使用文本指令，没有交互卡片。确认必须指明请求 ID；普通的“好的”不会被当作批准。每个实例同一时刻只执行一个任务。

## 可靠性与限制

任务、事件、消息去重、执行会话 ID 和待发送消息保存在 SQLite。重启后，队列保留；执行中的任务标记为中断，旧确认失效，需要你检查已有修改后明确继续。任务不会因重启自动重做。

消息发送失败会重试，使用稳定的飞书消息 UUID。但飞书去重有时间窗口，长时间断线后仍可能出现重复通知。真实任务会话保存在 Codex 自己的数据目录，单独恢复 Steward 数据库无法恢复已经丢失的 Codex 会话。

`review` 只代表执行器给出了结果，尚不代表独立验证通过。修改、测试、浏览器验收、PR、发布和人工接受是不同的完成条件。生产分支保护需要在 GitHub 等平台落实，发给模型的 Git 规则不等于强制执行控制。

当前只接受主人的私聊，忽略群聊和机器人消息。机器必须在线、进程必须运行。会话等待你回答的时间也计入 `maxRunMinutes` 超时限制。首次运行请先在终端启动，常驻服务安装器后续再提供。

## 开发与分享

```sh
npm run check
```

测试不依赖账号、不调用模型、不向飞书发送消息。`npm run smoke:codex` 是单独的真实订阅检查，会消耗少量额度；不在 CI 中运行。

分享源码和配置示例即可。`.env`、私人配置、数据库、任务历史以及 Codex 认证文件不能随项目分发。

项目使用 [MIT](LICENSE) 许可证。欢迎通过 Issue / PR 参与，见[贡献指南](CONTRIBUTING.md)。
