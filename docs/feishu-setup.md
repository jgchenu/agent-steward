# 飞书接入与首次验收

首版只处理你与机器人的私聊，使用飞书官方 Node SDK 的长连接，不需要公网回调地址。

## 推荐：扫码创建专用机器人

首次部署、尚未创建 `.env` 时运行：

```sh
npm run setup:feishu
```

打开命令返回的官方链接（可以用飞书扫码），确认应用名称、所属组织和申请权限。程序使用官方 SDK 的 `registerApp`，仅允许创建新应用，预设名为 Agent Steward；不复用或修改现有应用。

它请求 `im:message:send_as_bot`、`im:message.p2p_msg:readonly` 和 `im.message.receive_v1` 事件，不请求用户业务资源权限。平台是否支持这些预设与租户发布进度有关，请检查确认页实际展示的权限。

授权完成后，应用身份直接写入本机 `.env`，不会出现在终端输出；本次授权返回的 `open_id` 被设置为主人。配置文件默认仅当前 OS 用户可读写。没有返回主人身份时，需按下面的手动配置步骤补齐，不能默认把第一个发消息的人设成主人。

安装器不覆盖已有 `.env`，已有应用请走手动配置。授权过期或取消后，可重新运行命令获取新链接。若应用已创建但本地写入失败，应先在控制台检查该应用并手动完成配置，避免反复创建重复应用。

**扫码创建后仍要确认**：事件订阅采用长连接、消息事件和权限生效、应用已发布且你在可用范围。SDK 的扫码预设不能保证这些部署条件全部满足。下方首次验收步骤仍需执行。

## 手动配置已有应用

## 1. 创建你自己的应用

在[飞书开放平台](https://open.feishu.cn/)创建企业自建应用，启用机器人能力。不同组织的审批流程可能不同；发布应用版本并确保你在应用可用范围内。

在权限和事件配置中，为机器人启用发送消息、接收用户发给机器人的单聊消息所需的权限。常用对应权限为 `im:message:send_as_bot` 和 `im:message.p2p_msg:readonly`；以控制台订阅 `im.message.receive_v1` 时提示的要求为准。

在事件订阅中选择**使用长连接接收事件**，添加 `im.message.receive_v1`。首次保存可能要求先启动本地长连接。应用只需要处理私聊文本，首版不需要云文档、通讯录全量读取或群消息权限。

## 2. 本地配置

从该应用控制台取得 App ID / App Secret，并在控制台 API 调试工具或测试事件中确认你在**该应用下**的 `open_id`。不同应用的用户 ID 不能混用。

将这些值写入本机 `.env`：

```dotenv
FEISHU_APP_ID=your_app_id
FEISHU_APP_SECRET=your_app_secret
STEWARD_OWNER_ID=your_app_scoped_open_id
STEWARD_CONFIG=steward.config.json
```

不要将真实值提交到 Git，也不要发给机器人、开发者或公开 Issue。程序没有“第一个发消息的人自动成为主人”的机制。

复制并编辑项目配置，用一个测试目录作为最初的允许工作目录：

```sh
cp steward.config.example.json steward.config.json
mkdir -p playground
npm run doctor
npm run build
npm start
```

先在本机通过 `codex login` 登录 ChatGPT。`doctor` 只验证配置与 Codex 登录，不证明飞书身份或消息链路正确。

## 3. 逐项验收

1. 主人私聊 `/help`，收到指令列表。
2. `/projects` 只显示你配置的项目。
3. `/new sandbox 只回复 STEWARD_OK，不使用工具`，收到任务 ID、开始通知和结果。
4. `/status <任务ID>` 应显示 `review`；发送 `/done <任务ID>` 后才显示 `completed`。
5. 在一次性测试项目中触发需要人工决定的操作，确认通知包含具体动作，并验证 `/deny <请求ID>` 不批准操作。真实权限触发取决于 Codex 与平台能力，不要用生产发布测试。
6. 测试 `/cancel`，确认运行结束且已有修改不会被宣称已回滚。
7. 执行期间重启服务，确认任务为 `interrupted`，旧请求不可批准；明确 `/continue` 后才恢复。
8. 让非主人发送消息，并在群中发消息，确认没有创建任务、披露任务信息或执行操作。

这些是部署验收步骤，不是仓库已经替你完成的现场验收。发布初始代码时，真实 Codex 冒烟测试和协议/存储测试已执行；专用飞书应用的端到端验收仍需配置后完成。

## 排障

- 机器人无回应：检查可用范围、事件订阅、长连接状态，以及 OWNER_ID 是否属于同一个应用。
- 登录失败：在本机运行 `codex login`。不要上传 Codex 认证文件。
- 队列不动：查看是否有运行中、等待权限或等待回答的任务；首版一次只运行一个任务。
- 显示额度限制：保留任务，等待订阅额度恢复后明确继续。不会自动购买额度或切换 API。
- 通知延迟：网络失败会进入 SQLite outbox 重试。不要通过重复发送任务来“重发通知”。

参考：[飞书官方 Node SDK 长连接说明](https://github.com/larksuite/node-sdk#subscribing-to-events-using-long-connection-mode)。
