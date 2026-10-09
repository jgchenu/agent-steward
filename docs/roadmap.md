# Roadmap

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

- [ ] Guided setup and diagnostics, with locally completed authentication
- [ ] Interactive Feishu cards and reply-to-task routing
- [ ] Git worktree lifecycle, artifact inventory and evidence-based completion checks
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
