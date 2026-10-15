# LangGraph.js orchestration and collaboration

Accepted on 2026-10-12; default adoption requested on 2026-10-14. Implementation status: LangGraph orchestrates new task executions and business questions by default; Engine remains the only scheduler. Existing tasks retain their recorded runtime. See [operation and validation boundaries](../architecture.md#langgraph-orchestration).

Agent Steward will use TypeScript and embedded LangGraph.js for task orchestration, retaining official agent runtimes behind executor adapters. The initial pilot has become the default new-task path within the modular monolith, with an explicit legacy intake fallback. SQLite remains the local database. Human collaboration and agent delegation will share explicit task ownership, scoped authority and delivery records.

## Motivation

A conversation must retain enough task context to interpret project confirmations, corrections and requests to continue. Adding a separate phrase matcher and execution path for each operation makes this harder to maintain. Future collaboration also requires tasks to wait for people or delegated work, receive new information and resume without repeating completed effects.

LangGraph provides graph state, checkpoints, interrupts and subgraphs. Natural-language understanding still belongs to the model; identity, authority and evidence checks belong to Steward. Installing a framework alone does not resolve intent, grant permission or make external actions safe to replay.

## Technology choices

| Responsibility | Choice | Boundary |
| --- | --- | --- |
| Application | Node.js 24 and TypeScript | Keep the modular monolith and existing channels. |
| Orchestration | Embedded LangGraph.js | Coordinate interpretation, validated operations, waiting, delegation and results. No hosted graph service is required by this decision. |
| Agent execution | Official Codex App Server adapter | Retain subscription authentication and runtime-owned sessions. Additional official executors require separate compatibility validation. |
| Business data | SQLite locally | Retain task ownership, grants, operation receipts, evidence, inbox and outbox. Evaluate PostgreSQL when deploying a shared service with concurrent workers. |
| Tool interoperability | MCP | Connect tools and data through supported executor interfaces. |
| Independent agent interoperability | A2A in a later phase | Exchange delegated tasks and artifacts across independently authorized instances. |

Do not add Mastra or Temporal alongside LangGraph to manage the same workflow. Mastra remains an alternative if the pilot shows a concrete integration advantage. Reconsider Temporal only when distributed workers, timers and recovery requirements justify a separate durable service. Such a change requires a new decision about state ownership and operations.

This decision does not introduce an API model fallback, a model proxy, shared subscription accounts or credential extraction. Codex is a complete execution runtime, not a drop-in LangChain chat model. The adapter must preserve that boundary.

## Task execution boundary

Tasks are the primary unit; spaces, knowledge bases, tools and code projects are resources used only when necessary. See [domain terminology](../../CONTEXT.md). The task-first implementation starts natural requests without code bindings and enrolls resource-free business questions in the same durable graph. Code access is a structured semantic proposal validated against owner grants. A uniquely owner-named matching resource can continue under its configured mode; inferred targets require a scoped choice. Business wording or product names alone do not select code resources. Multi-user roles and non-code resource connectors remain follow-up work rather than pretending a code workspace is required for every role.

The orchestration loop is:

```text
Authenticated input and current task facts
  -> model proposes a typed next operation
  -> Steward validates scope, authority and preconditions
  -> execute, delegate, ask for information or wait for approval
  -> persist observations and evidence
  -> continue the task or present a result for human acceptance
```

Operation definitions should keep their input schema, capability requirement, executor and outcome together. Existing project, publication and merge controllers can be adapted behind this interface. Commands remain optional shortcuts into the same validated operations. Free-form model output must never become an authorization flag.

The model receives the current task, relevant conversation, available operations, pending questions and existing authorization facts. Quoted messages, attachments, tool results and another agent's claims are reference material. Clarification is needed when targets or meanings remain ambiguous; a project confirmation must not silently authorize publication or merge.

Steward's domain records remain authoritative for ownership, grants, approval validity and externally observed results. LangGraph checkpoints record where execution can resume and reference those records. A checkpoint must not create an independent copy of authoritative permissions or a second competing task scheduler. The implementation defines transaction and reconciliation boundaries between checkpoint writes and domain updates.

Persist an operation identity and attempt before externally visible effects. On uncertain outcomes, inspect the existing effect and record a receipt before deciding whether a retry is allowed. Retain inbox deduplication and the durable outbox; retrying a notification must never rerun model or Git operations. Checkpoint recovery alone does not provide exactly-once external effects.

## Human collaboration

Treat clarification, requirement changes, permission decisions and acceptance as distinct task inputs. Record who supplied each input and which task or operation it addresses. Previously granted authority may be reused only within its actual scope and validity, subject to repository and operation-specific rules.

Persist business-level waits so an inactive task can eventually release execution capacity. Keep bounded execution concurrency: default two tasks, with all code/Git tasks still serial. A saved graph interrupt cannot restore a live Codex RPC approval callback: the adapter must establish whether a session can reconnect or needs an explicit new turn. Existing process-bound permission requests still expire on restart until a separately reviewed implementation establishes a valid replacement flow.

Task completion continues to distinguish executor output, independent checks, publication, deployment and human acceptance. A graph reaching its end does not establish all of these outcomes.

## Agent collaboration

Within one instance, delegate through explicit child tasks or subgraphs. Each delegation records its parent, responsible executor, goal, allowed capabilities, bounded context, artifact expectations and outcome. Preserve separate runtime sessions and workspaces. The parent must handle failed, cancelled and incomplete children and enforce a bounded delegation depth and work budget.

An agent result is evidence for the parent to assess; it is not an instruction with the parent's authority. Start with serial delegation under the existing execution limit. General conversations may overlap code work under the bounded scheduler; parallel code execution still requires separately tested workspace isolation, scheduling and cancellation behavior.

Across independent instances, use A2A after task delegation works locally. The receiving instance validates its own owner grants, caller identity and artifact visibility. Delegation does not propagate credentials or automatically extend authority. Internal calls do not need a network protocol merely to use multiple agents.

## Adoption and remaining validation

The owner requested default adoption on 2026-10-14. New tasks use LangGraph; existing tasks keep their recorded runtime. The historical `langGraphPilot: false` option selects legacy intake only. It does not disable recovery of already-enrolled graph tasks or replay them through the old runtime. Business clarification defers workspace delivery checks until the task can produce a completed result.

Default adoption is a product choice, not evidence that every live acceptance gate has passed. Keep the following validation boundaries explicit; local delegation remains a future feature, and live Feishu/write-workspace acceptance is still outstanding:

1. Paraphrases, contextual confirmations, negation, ambiguous targets and quoted instructions route correctly without new keyword lists.
2. The chosen persistent checkpointer works with Node.js 24 and local SQLite deployment, including concurrent domain writes, backup and restart. An in-memory saver is not sufficient. Package versions and any native dependencies must be pinned and tested.
3. Business waits survive restart; stale runtime permission requests cannot authorize a resumed action. Waiting time and active execution time are accounted for separately.
4. A crash after an external effect but before its receipt triggers reconciliation, with no duplicate publication or other mutation. Checkpoint and domain-write failures receive the same treatment.
5. Duplicate inbound events, new human instructions, cancellation and grant revocation preserve task ownership and reject stale decisions.
6. Local delegated work returns traceable artifacts; child failure and cancellation propagate without losing the parent task or exceeding its authority.
7. Existing behavior tests and checks pass. Live Codex session recovery and live Feishu continuation are accepted separately from simulated tests.

Migrate other operations incrementally after their corresponding checks and acceptance pass. Add another executor and local delegation before exposing A2A endpoints. PostgreSQL, distributed scheduling and parallel execution remain conditional follow-up decisions.

## Reference designs

- [LangGraph.js overview](https://docs.langchain.com/oss/javascript/langgraph/overview): embedded orchestration with model-driven and deterministic steps.
- [Interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts): pause and resume; node code before an interrupt can execute again on resumption.
- [Persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence): checkpoints and durable storage.
- [Subgraphs](https://docs.langchain.com/oss/javascript/langgraph/use-subgraphs): composing agents with explicit state interfaces.
- [MCP](https://modelcontextprotocol.io/docs/getting-started/intro) and [A2A](https://a2a-protocol.org/latest/topics/what-is-a2a/): tool integration and independent agent interoperability.
- [Mastra suspension](https://mastra.ai/docs/workflows/suspend-and-resume) and [Temporal workflow messages](https://docs.temporal.io/encyclopedia/workflow-message-passing): alternatives considered for waiting and continuation.
