# Agent Steward development

Build a personal, self-hosted task coordinator. Reuse official agent runtimes; do not build a model proxy or extract subscription credentials.

- Read README.md and docs/architecture.md before changing behavior.
- Node 24, TypeScript, SQLite; keep one process, bounded task concurrency (default 2), and at most one code/Git execution. Never overlap the same task, topic or Codex session.
- Run `npm run check`. Unit tests must not call providers or Feishu. `npm run smoke:codex` is an explicit live subscription check only.
- Preserve owner checks, message idempotency, task/session ownership, one-shot approvals, and durable outbox semantics.
- Reject unknown protocol permission requests. Never auto-approve an action on timeout or missing input.
- Never log raw auth responses, credentials, complete environment variables, or private task transcripts in public issues/CI.
- Keep `.env`, private config, runtime databases and logs untracked. Examples must use generic values and paths.
- Distinguish implementation, simulated validation, live-provider validation, live-Feishu acceptance and publication.
- Changes to the task state machine need behavioral tests and matching architecture docs.
- Prepare changes through feature branches and PRs. Never merge PRs, enable auto-merge, or directly push existing remote main/staging.
- For new AI-assisted commits, preserve the human Git author and add the actual coding agent's co-author identity. Codex uses `Co-authored-by: Codex <codex@openai.com>`; do not label other executors as Codex. Do not rewrite existing shared commits to add attribution.
- Claude Code, other providers and A2A remain roadmap items. Worktree and configured-check tests do not establish live Feishu publication acceptance.
