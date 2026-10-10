# Agent Steward

**Your own digital coworker, backed by your coding-agent subscription.**

[中文说明](README.zh-CN.md) · [Architecture](docs/architecture.md) · [Feishu setup](docs/feishu-setup.md) · [Roadmap](docs/roadmap.md) · [Group and thread setup](docs/group-context.md)

Send work from Feishu. Steward keeps the task, runs Codex on your machine, brings permission requests back to you, and returns the result for review. Each person deploys their own instance with their own account, projects and data.

**Status: early preview, v0.1.** A runnable owner-only vertical slice with opt-in group threads, not a production service. Codex is the only implemented real executor. Claude Code, domestic coding plans and agent-to-agent delegation are planned.

```text
Feishu DM / local terminal
          ↕
Owner gate → task service → SQLite tasks, events, requests and outbox
                 ↕
        Codex App Server (local, ChatGPT login)
                 ↕
          An allowlisted project
```

## Try it without accounts

Requires **Node.js 24.x**. macOS and Linux are the initial targets.

```sh
git clone https://github.com/jgchenu/agent-steward.git
cd agent-steward
npm ci
npm run demo
```

Type a task, then answer the simulated permission request with `/approve <request-id>`. Inspect with `/status <task-id>`, and accept with `/done <task-id>`.

The demo uses a clearly labeled simulator, stores state in a temporary directory, makes no model calls and changes no project files. It does not prove a live integration.

## Use your Codex subscription

Install the official Codex CLI separately and sign in using `codex login` with ChatGPT. Steward does not read or copy its authentication file. It drives the official App Server over stdio and checks `account/read` for ChatGPT authentication before inference. It forces the OpenAI provider and ChatGPT login mode, removes API-key variables from the child environment, and has **no API fallback**.

Subscription limits and provider terms still apply. App Server protocol compatibility was smoke-tested with Codex CLI 0.160.0; changes upstream may require adapter updates. Model execution uses the local Codex configuration and its available model. Do not treat a subscription as unlimited capacity.

### Create a dedicated Feishu bot

On a fresh installation, before copying `.env.example`, run:

```sh
npm run setup:feishu
```

Open the official authorization URL and confirm the new app in your Feishu organization. Setup requests a minimal bot with private-message receive/send permissions. Verify the permissions shown by Feishu; platform rollout differences can affect the preset. No existing app is selected or modified.

After authorization, credentials go directly into a local `.env` file with mode `0600`. The authorizing user's app-scoped `open_id`, when returned, is bound as the owner. No credentials are printed. A missing owner or unsupported Lark tenant leaves the service disabled. Existing `.env` files are never overwritten.

Setup also creates a read-only `sandbox` project in `playground/` if no config exists. It does not start model execution, send messages, or establish that your bot is published and reachable. Verify long-connection event settings and application availability in the console, then follow the [Feishu acceptance guide](docs/feishu-setup.md).

### Manual configuration / terminal-only use

Use the following copy commands only if you have not completed automatic setup:

```sh
cp .env.example .env
cp steward.config.example.json steward.config.json
mkdir -p playground
```

Edit `.env` locally and set `STEWARD_OWNER_ID` to your bot application's Feishu `open_id`. For terminal-only evaluation, a private local identifier such as `local-owner` is sufficient. Feishu credentials are only needed for the Feishu mode.

Edit the private config:

```json
{
  "stateDir": ".steward",
  "codexCommand": "codex",
  "maxRunMinutes": 60,
  "projects": {
    "sandbox": { "path": "./playground", "sandbox": "read-only" }
  }
}
```

Paths are resolved relative to the config file. The project must already exist. Start with a disposable directory. To allow edits, configure `workspace-write` **and** an isolated Git `worktree`, then choose modification mode for each task. See [project setup and PR delivery](docs/project-delivery.md). A run can request additional permissions; only you can answer those requests. The timeout includes time spent waiting for you.

```sh
npm run doctor  # Checks configuration, App Server and ChatGPT auth; no inference
npm run local   # Real Codex, terminal transport
```

Then enter `/new sandbox inspect this directory and report what you find`.

For Feishu, follow [the setup guide](docs/feishu-setup.md), then:

```sh
npm run build
npm start
```

Keep the process and machine awake. Closing the service interrupts active work; it is not a hosted cloud agent. Start manually for initial evaluation; OS service installers are planned.

## Commands

| Command | Behavior |
| --- | --- |
| `/help`, `/projects` | Usage and configured project aliases |
| `/new <project> <task>` | Create a read-only task |
| `/edit <project> <task>` | Modify an allowlisted project in an isolated Git worktree |
| `/publish <task>` | Open the Feishu PR preview; publication needs the card confirmation |
| Plain text | Use the named authorized project, default workspace or sole project; ask only when ambiguous |
| `/list`, `/status <task>` | View status, latest recorded progress, result and outstanding request IDs |
| `/cancel <task>` | Stop execution; existing changes are retained |
| `/continue <task> <instructions>` | Queue another turn using the saved Codex thread |
| `/approve <request>`, `/deny <request>` | Answer one live permission request |
| `/answer <request> <answer>` | Answer a question; multiple questions require JSON keyed by question ID |
| `/done <task>` | Record the owner's acceptance of a result in `review` |

Git project tasks retain their own worktree and continuation session. Modification tasks run locally configured checks after Codex finishes; delivery cards show actual changed files and check exit results. Passing checks enables an explicit draft PR preview and confirmation. Validation binds to file contents and check configuration; target-branch movement stops publication. The publisher reuses an existing open PR and never merges it.

In Feishu, directly @mention the bot with your request. Configure [workspace grants and the default analysis space](docs/workspaces.md) with `npm run workspaces`. The optional `工作台` or `/help` entry opens the manual task form. Group answers and clarifying questions are ordinary threaded posts with Markdown and complete long-answer splitting; reply naturally to continue. Explicit permission requests and on-demand task management retain their cards. Commands remain available in Feishu and the terminal. A generic “yes” never grants permission. Each instance runs one task at a time.

Enable `card.action.trigger` under the application’s **callback configuration**, using the existing long connection. An existing installation must verify this separately. Ordinary progress refreshes update a card in place; requests for input, results and failures produce a fresh notification so they are not silently hidden in an old message. Forms accept up to 1,000 characters; longer tasks can still be sent as text.

## Group conversations

With group mode enabled, owner @mentions directly start tasks using an explicitly named authorized project or the default workspace. Ambiguous requests get a one-click project choice without retyping. An OnIt reaction acknowledges execution before inference; results and human questions reply in the thread. Replies within a bound topic continue the same task and Codex session. Cards retain their originating topic, and results are posted as thread replies. Steward reads bounded text/rich-text/card context from that group or topic before inference; missing permissions stop execution explicitly. Other members cannot control tasks. Group results and human requests are visible to group participants.

## What survives a restart

- Tasks, session IDs, events, inbound message deduplication and outbound notifications live in SQLite.
- Queued work remains queued. Interrupted work requires an explicit `/continue`; it is not automatically replayed.
- Old permission requests expire. They cannot authorize a new run.
- Outbound messages retry with the same Feishu UUID. Delivery is at-least-once; Feishu's deduplication window is finite, so duplicates after long outages remain possible.
- Codex thread data remains in Codex's own local storage. Restoring only Steward's database is not enough to resume a missing Codex thread.

`review` means **the executor returned a result**, not that tests, a browser check, deployment, or independent review passed. Check the reported evidence before `/done`.

## Boundaries

- Only the configured owner can control this release. Set `groupChats: true` to enable owner @mentions, thread replies and group cards; other members contribute reference context but cannot dispatch or approve. See [group setup](docs/group-context.md). Bot-authored events never dispatch tasks.
- Project aliases are configured locally; message text cannot supply an arbitrary working directory.
- Credentials, private config and runtime state are gitignored. Never share them with a deployment template.
- Run on a trusted machine. Steward is not a security boundary against a malicious local user or process. Codex's configured tools, MCP servers, plugins and repository instructions still matter.
- The Git/PR guidance passed to Codex is an instruction, **not a shell-level enforcement mechanism**. Use repository branch protection and narrowly scoped credentials. Do not give a preview deployment production authority.
- No GUI automation, credential extraction, account sharing, automatic paid-provider fallback or automatic retry of potentially completed actions.

Read [SECURITY.md](SECURITY.md) before enabling real project writes.

## Development

```sh
npm ci
npm run check
```

Tests use fake executors, temporary databases, real temporary Git repositories and simulated GitHub responses. `npm run smoke:workspace` is an opt-in live subscription edit and validation smoke test, outside CI. They do not require credentials or send messages. GitHub Actions runs these checks on Linux and macOS.

Optional live check, deliberately outside CI:

```sh
npm run smoke:codex
```

This consumes a small amount of your subscription quota in a read-only temporary directory. It verifies authentication, thread creation, inference and final-message handling; it does not verify live Feishu delivery or interactive approval behavior.

Contributions: [CONTRIBUTING.md](CONTRIBUTING.md). License: [MIT](LICENSE).
