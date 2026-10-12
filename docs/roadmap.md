# Roadmap

## Accepted orchestration direction

Use TypeScript with embedded LangGraph.js, official executor adapters and local SQLite. Preserve Steward's ownership, authorization, evidence and delivery boundaries. See the [architecture decision and pilot gates](decisions/langgraph-orchestration.md).

- [x] Validate a persistent SQLite checkpointer and read-only Codex session continuation in an isolated pilot
- [x] Implement opt-in project execution with structured business questions, human answers and durable waits
- [ ] Verify crash reconciliation, cancellation, revoked authority and live channel continuation before expanding adoption
- [ ] Introduce bounded local task delegation before cross-instance A2A collaboration

The pilot is off by default. Simulated recovery tests and read-only live Codex continuation pass; live Feishu and write-workspace acceptance remain outstanding. Shared PostgreSQL and distributed scheduling require demonstrated deployment needs.

## 0.1 — Personal vertical slice

- [x] Independent self-hosted repository with MIT license and reproducible npm lockfile
- [x] Owner-only Feishu DM adapter and terminal transport
- [x] Codex App Server executor with subscription authentication preflight
- [x] SQLite queue, task events, input deduplication and notification outbox
- [x] One-shot permission/input routing, cancellation and explicit continuation
- [x] Restart interruption handling and separate human acceptance state
- [x] Account-free demo and automated behavioral tests
- [x] Live Codex minimal inference smoke test
- [ ] Live Feishu end-to-end acceptance on an owner's dedicated app
- [ ] Live Codex permission/input round-trip and cancellation acceptance across supported versions

## Next — Make it useful every day

- [x] Local workspace grant UI, default workspace and direct natural-language dispatch
- [x] Group reaction acknowledgement before execution and threaded results
- [ ] Guided setup and diagnostics, with locally completed authentication
- [x] Interactive Feishu task forms, task cards, one-shot decisions and result pagination
- [ ] Live acceptance of every card form/permission path across desktop and mobile
- [x] Owner-only group @mention dispatch, topic-bound cards and natural-language task continuation
- [x] Bounded group/topic reference context with explicit failure and truncation reporting
- [ ] Live group and thread acceptance across normal and topic-style groups
- [x] Isolated Git task worktrees, artifact inventory and independent configured checks
- [x] Owner-confirmed draft PR delivery with source/head/base verification and PR reuse
- [ ] Worktree cleanup, retention and integration after target-branch movement
- [ ] Subscription quota visibility and opt-in wait/resume policy
- [ ] Checkpoint-aware crash recovery and operator-facing delivery failure status
- [ ] systemd / launchd service setup and explicit data retention / backup tools
- [ ] Action enforcement beyond agent instructions, integrated with GitHub protections

## Then — Bring another executor

- [ ] Official Claude Code runtime adapter with separately verified subscription behavior
- [ ] Selected domestic coding-plan adapter after checking its official supported integration
- [ ] Explicit task handoff records for cross-executor continuation
- [ ] Per-executor capability declarations and compatibility tests

## Later — Let other people deploy and collaborate

- [ ] Trusted requester identities and project-scoped delegation grants
- [ ] Per-instance capabilities and artifact visibility
- [ ] A2A task endpoint, authentication, revocation and reply routing
- [ ] Two independently deployed owners complete one delegated task with audit evidence

No centrally shared model accounts or credentials. No implicit authority propagation from another person's agent. Capabilities above remain planned until code and validation support them.
