# 接入真实项目并交付草稿 PR

每次派活明确选择“只读分析”或“允许修改”。默认只读；修改能力还需要本机项目配置许可。任务创建后不能通过继续对话提升模式，请重新派一个修改任务。

## 配置一个 Git 项目

保留现有 `sandbox`，在私人 `steward.config.json` 的 `projects` 中加入自己的项目。下面以 Node 项目为例；命令必须对应项目实际使用的验证方式。

```json
{
  "myproject": {
    "path": "/absolute/path/to/myproject",
    "sandbox": "workspace-write",
    "worktree": {
      "baseRef": "origin/main",
      "checks": [
        { "name": "安装依赖", "command": "npm", "args": ["ci", "--ignore-scripts"], "timeoutSeconds": 300 },
        { "name": "项目验证", "command": "npm", "args": ["run", "check"], "timeoutSeconds": 300 }
      ],
      "github": { "repository": "YOUR_ACCOUNT/YOUR_REPO", "baseBranch": "main" }
    }
  }
}
```

项目路径必须是已有 Git 仓库的根目录。`baseRef` 使用 `origin/main` 时，每次新任务会先 fetch 对应远端分支。未提交改动不会带入任务。没有远端的本地试验可使用 `main` 并省略 `github`，但无法通过卡片创建 PR。只读项目也可以配置 worktree 来获得独立目录。

准备 PR 需要本机 Git 提交身份，以及自行完成 `gh auth login`。当前只支持标准 GitHub.com HTTPS/SSH origin URL，并要求 URL 与配置的仓库一致。不要把凭证写进 URL。

`checks` 是部署者配置的可信本地程序，逐条执行，不经过 shell 拼接。验证进程不继承飞书密钥、API Key 等服务环境变量，但仍作为本机用户运行，能够使用其文件和网络权限；worktree 只隔离 Git 工作文件，不是操作系统沙箱。只接入信任的仓库和检查命令。

新目录不复制主目录的 `.env`、`node_modules` 或未跟踪文件。需要安装依赖时配置适当的检查命令；`--ignore-scripts` 是否适合项目由部署者决定。不要复制生产密钥作为修复手段。旧版本仅设置 `workspace-write` 的配置需增加 `worktree` 才能启动。

## 从飞书完成任务

1. 发送“工作台”，选择项目和“允许修改”，写明要改什么以及验收标准。
2. Steward 建立 `.steward/worktrees/<任务ID>` 和 `steward/<任务ID>` 分支，Codex 在其中工作。需要扩展权限时仍通过独立请求确认。
3. Codex 返回后，Steward 自行统计真实文件改动，执行配置中的检查，记录退出码和本机日志。
4. 打开“查看交付”，核对文件列表和各项检查状态。工作目录和日志保留在本机，可以用编辑器查看完整 diff。
5. 验证全部通过且存在改动时，点击“预览 PR 交付”。卡片展示目标仓库、分支、标题和完整 PR 正文；确认后程序才提交和推送任务分支、创建草稿 PR。已有开放 PR 会复用。
6. 使用“打开 PR”在 GitHub 审查。合并和部署仍由人完成。“确认完成”只记录任务验收，不会发布。

验证失败、没有配置检查、验证命令修改了交付文件，或验证后又改动了文件，都会阻止 PR 交付。继续任务会使上一次验证失效。检查配置变化也必须重新验证。

如果远端目标分支已经前进，交付会停止，保留工作目录；当前需要基于最新版本新建任务并明确迁移所需改动，不自动 merge/rebase/reset。如果任务分支的 PR 已关闭或合并，也需要新建任务。取消和失败保留已有修改；不自动删除 worktree 或分支。

终端 `/new <项目> <要求>` 是只读，`/edit <项目> <要求>` 请求修改。飞书 `/publish <任务ID>` 仅打开预览，真正发布需要点击确认；终端暂不提供发布确认入口。

## 验证范围

`npm run check` 使用真实临时 Git 仓库、独立验证子进程和模拟 GitHub 响应，无外部账号依赖。`npm run smoke:workspace` 单独消耗少量 ChatGPT 订阅额度，在临时仓库做一次真实修改并检查原目录未变化；不会创建远端 PR，也不批准扩展权限。

模型声称运行过测试，不会替代程序记录的检查。配置检查通过、GitHub CI 通过、浏览器验收、人工接受、合并和部署分别判断。Steward 的发布器不会合并 PR；传给 Codex 的“不自行提交发布”等指令不构成外部工具权限防火墙，仍需配合仓库保护。
