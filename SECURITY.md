# Security

Agent Steward is an early personal-use preview for a trusted local machine. It is not a multi-tenant service or a hardened sandbox. Do not expose it as a public agent endpoint; this release has no such endpoint.

## Current controls

- Owner-only human direct-message admission and project aliases configured locally
- One-shot live approval/input request correlation, expiry on restart, unknown requests rejected
- Read-only default project sandbox; explicit opt-in to workspace writes
- Subscription-auth preflight without reading or copying Codex's credential file
- Local private state directory, gitignored private configuration, no raw protocol logging

## Limits you should understand

Codex runs as your OS user and uses its local configuration, tools, extensions and credentials. The adapter's sandbox selection is not a guarantee that all external tools have equivalent restrictions. A user-approved permission request can expand the runtime's access. The `read-only` setting is not a prohibition on all network or external side effects.

Git and publishing rules are sent as agent instructions. They cannot prevent every shell or external-tool action. Enforce important limits using OS isolation, restricted accounts, repository protections and least-privilege service access. Do not use the first deployment with production administration credentials.

Project contents and incoming model/tool output are untrusted. The owner gate does not prevent prompt injection in a repository or document. Review concrete permission requests and check the actual result.

SQLite records task text, model reports, questions and your answers in plaintext on the local filesystem. Private Codex session history is stored separately by Codex. Protect both, include them only in private backups, and do not include either in shared deployment packages. Retention automation and encrypted application storage are not implemented.

Do not share state across hosts/containers. The process lock is designed for a single local PID namespace. Existing filesystem permissions remain the operator's responsibility. Cancelling a task or stopping the process does not roll back completed actions.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting feature in the repository's Security tab when enabled. If it is unavailable, open an issue requesting a private contact without posting exploit details, credentials or private data. Avoid public disclosure of an active credential; revoke it with the provider first.

Only the current development version is maintained. There is no response-time or security-support SLA.
