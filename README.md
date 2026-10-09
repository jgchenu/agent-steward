# Agent Steward

**Your own digital coworker, backed by your coding-agent subscription.**

[中文说明](README.zh-CN.md) · [Architecture](docs/architecture.md) · [Feishu setup](docs/feishu-setup.md) · [Roadmap](docs/roadmap.md)

Send work from Feishu. Steward keeps the task, runs Codex on your machine, brings permission requests back to you, and returns the result for review. Each person deploys their own instance with their own account, projects and data.

**Status: early preview, v0.1.** A runnable owner-only vertical slice, not a production service. Codex is the only implemented real executor. Claude Code, domestic coding plans and agent-to-agent delegation are planned.

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

Paths are resolved relative to the config file. The project must already exist. Start with a disposable directory. To allow edits, explicitly select `workspace-write`. A run can request additional permissions; only you can answer those requests. The timeout includes time spent waiting for you.

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
| `/new <project> <task>` | Create a durable task |
| Plain text | Create a task when exactly one project is configured |
| `/list`, `/status <task>` | View status, latest recorded progress, result and outstanding request IDs |
| `/cancel <task>` | Stop execution; existing changes are retained |
| `/continue <task> <instructions>` | Queue another turn using the saved Codex thread |
| `/approve <request>`, `/deny <request>` | Answer one live permission request |
| `/answer <request> <answer>` | Answer a question; multiple questions require JSON keyed by question ID |
| `/done <task>` | Record the owner's acceptance of a result in `review` |

Use explicit task/request IDs. A generic “yes” must never approve the wrong action. This first release uses text commands instead of interactive cards. It has one active run per instance, not parallel workers.

## What survives a restart

- Tasks, session IDs, events, inbound message deduplication and outbound notifications live in SQLite.
- Queued work remains queued. Interrupted work requires an explicit `/continue`; it is not automatically replayed.
- Old permission requests expire. They cannot authorize a new run.
- Outbound messages retry with the same Feishu UUID. Delivery is at-least-once; Feishu's deduplication window is finite, so duplicates after long outages remain possible.
- Codex thread data remains in Codex's own local storage. Restoring only Steward's database is not enough to resume a missing Codex thread.

`review` means **the executor returned a result**, not that tests, a browser check, deployment, or independent review passed. Check the reported evidence before `/done`.

## Boundaries

- Only the configured owner can control this release, and only in direct messages. Group messages and bot-authored events are ignored.
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

Tests use fake executors and temporary databases. They do not require credentials or send messages. GitHub Actions runs these checks on Linux and macOS.

Optional live check, deliberately outside CI:

```sh
npm run smoke:codex
```

This consumes a small amount of your subscription quota in a read-only temporary directory. It verifies authentication, thread creation, inference and final-message handling; it does not verify live Feishu delivery or interactive approval behavior.

Contributions: [CONTRIBUTING.md](CONTRIBUTING.md). License: [MIT](LICENSE).
