# Contributing

Start by opening an issue describing the concrete workflow and expected behavior. Small, complete changes are easier to review than framework rewrites.

1. Use Node.js 24.x and `npm ci`.
2. Read `docs/architecture.md` and `AGENTS.md`.
3. Create a feature branch. Keep private configuration and task data out of commits.
4. Add behavioral tests for changes to authorization, persistence, approvals, delivery or execution.
5. Run `npm run check` and update English/Chinese usage docs when behavior changes.
6. Submit a PR describing the problem, resulting behavior, validation and any limitations.

Do not add live model calls or Feishu messages to CI. Live-provider checks must be opt-in and describe whether they use subscription quota or paid usage. Mocked tests are not evidence of live-platform acceptance.

Provider adapters must use officially supported interfaces, declare authentication expectations and reject unsupported permission requests. Do not contribute subscription credential extraction, session-cookie proxies or silent paid fallback.

Never paste credentials, private code, `.env`, databases or full transcripts into public issues. Use a minimal disposable project and sanitized evidence.

By contributing you agree that your contribution is available under this repository's MIT license. Please communicate respectfully and focus review on the work.
