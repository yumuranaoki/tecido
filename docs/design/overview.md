# Tecido Design Overview

## Purpose and guarantees

Tecido accepts events on explicitly addressed Threads and manages Agent execution as Runs. It persists conversation history, Run state, checkpoints, and stream events, and orders execution within each Thread. An Agent is a code-defined configuration, separate from a Thread's persistent state.

The persistence guarantees cover accepted input and Run identity, completed internal processing, and replay of stored stream events. LLM provider and external Tool calls happen outside storage transactions, so exactly-once execution of provider charges or external side effects is not guaranteed. Tecido does not automatically repeat an external operation whose outcome is uncertain; callers can explicitly retry or reconcile the result through the application.

## Architecture and responsibilities

```text
Application
  ├── Agent / Tool / Thread API and Run semantics       Tecido Core
  ├── durable execution and host-neutral protocol       Tecido runtime host
  ├── model abstraction and provider implementation     AI SDK / @ai-sdk/*
  └── deployable lifecycle and bindings                 Celld adapter
       ├── Worker request, alarm, and cron hooks
       └── Worker configuration generation
```

| Component           | Responsibility                                                                                                                                                    |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tecido Core         | Agent/Thread/Run contracts, event normalization, Tool boundary, and public facade                                                                                 |
| Tecido runtime host | Host-neutral command protocol, address routing, state transitions, durable queue, checkpoints, recovery, retry decisions, stream events, and cron journal         |
| AI SDK              | Provider/model abstraction and normalization of provider streams                                                                                                  |
| Celld adapter       | Celld binding translation and Worker request, alarm, and cron lifecycle integration                                                                               |
| Application         | Authentication and authorization, principal-to-Thread-address mapping, provider and secret selection, and idempotency or reconciliation for external side effects |
| CLI                 | Agent declaration validation, manifest/Worker/Celld configuration generation, and development startup                                                             |

Core and the shared runtime host do not depend on Celld types or classes. The Thread facade connects to the runtime host through an internal RuntimePort, which is not part of the public API. The Celld production adapter installs that port and translates Celld lifecycle events into the shared Thread and schedule objects. Tecido does not delegate durable execution to the AI SDK's automatic Tool loop; it manages model rounds, Tool-level checkpoints, FIFO ordering, retries, and recovery.

## Identity, events, and deduplication

A persistent Thread address consists of deployment identity and `(namespace, agentId, threadId)`. All three values are required opaque strings; a namespace does not provide authentication or authorization. The Celld adapter creates an internal routing key from a versioned canonical encoding of the tuple and checks it against the original tuple in stored metadata.

Messages and cron triggers are normalized into internal event envelopes. Tecido can supply a server-generated event ID and receive time for a message. A cron occurrence is deterministically identified by app, Agent, schedule, and scheduled time. Each individual Thread operation is identified by the occurrence, Thread address, and operation key.

Deduplication is scoped to the combination of Thread address and transaction identity. A resend with the same key and semantic payload resolves to the original Run; a different payload returns `IDEMPOTENCY_CONFLICT`. Digests exclude server-generated IDs and receive times. Deduplication is not guaranteed after the retention period expires.

## Public API and execution scope

Users declare Agents and Tools with `agent()` and `tool()`, then register Agents in `TecidoConfig`. The Thread facade returned by `Agent.thread({ namespace, id })` provides these operations:

- `run(input, options?)`: accept a Run and wait for the terminal result of the caller's attempt.
- `stream(input, options?)`: return a stream handle with a `runId` after acceptance.
- `getRun(runId)` and `subscribe(runId, { afterSeq })`: read Run state and resume durable events.
- `retry(runId, options?)` and `cancel(runId)`: explicitly retry, provide a reconciled result, or request durable cancellation.

The Thread facade captures the RuntimePort and Agent registry from a scope installed by the host during a Worker request, cron hook, or Cell execution. Calls outside that scope return `RUNTIME_NOT_BOUND`; they do not silently fall back to an in-memory runtime. Agent declarations accept an AI SDK `LanguageModel`; the application selects the provider and supplies credentials.

A Tool defines an input schema, execution function, timeout, and retry policy. Tecido validates model-generated Tool input with Standard Schema and persists the parsed input and Tool plan before execution. Tool input and output must be JSON-serializable. A stable `toolCallId` can be used as an external idempotency key, but the Tool author is responsible for making external side effects safe to repeat.

## Runs, ordering, and persistence

A Run is the logical execution for one input event; an attempt is one execution attempt. An explicit retry keeps the `runId` and increments the attempt. On initial acceptance, Tecido persists the Run, user input, attempt, queue position, and execution request before calling a model or provider. Dispatches within a Thread run serially in durable sequence order; different Threads can run concurrently. Retries are appended to the queue tail so a failed Run does not block later events.

The conceptual state transitions are:

```text
accepted → model_running ↔ tool_pending → tool_running → tool_completed
     └───────────────────────────→ completed | failed | cancelled
failed ── explicit retry ──→ accepted (next attempt)
```

State transitions and checkpoints are persisted in transactions, while external provider and Tool calls happen outside those transactions. Tecido persists a model's Tool plan first, then records each Tool through `pending → running → completed`. The final assistant message, Run completion, and terminal stream event are committed together. Partial output from a failed attempt remains in the stream log but is not added to the committed conversation.

The logical data model includes Thread metadata, Runs, attempts, messages, Tool calls, Run checkpoints, stream events, and durable dispatch/cron journals. The initial implementation updates a versioned Thread snapshot within a Celld transaction; it has not yet been decomposed into the relational tables described by the design. JSON payloads and storage schemas are versioned and validated. An unsupported schema is never treated as an empty state.

### Failures, retries, and cancellation

On restart, recovery follows the durable state:

| State at interruption       | Action                                                                                          |
| --------------------------- | ----------------------------------------------------------------------------------------------- |
| `accepted` / `tool_pending` | Dispatch can continue from the stored input                                                     |
| `tool_completed`            | Continue to the next model round using the stored result                                        |
| `model_running`             | Mark failed because the provider outcome is uncertain; do not automatically call it again       |
| `tool_running`              | Mark failed because the external side effect is uncertain, and record `indeterminateSideEffect` |
| Terminal state              | Do not execute again                                                                            |

Retrying an uncertain Tool requires a `retry: "safe"` declaration or a confirmed result supplied by the application after reconciliation. Failed Runs are never retried implicitly. Cancellation is a durable request; if an in-flight Tool's outcome is uncertain, Tecido records that uncertainty rather than treating the operation as successful. Disconnecting a stream subscriber does not cancel the Run.

## Streaming and conversation context

Tecido's `StreamEvent` is independent of provider chunks and has a monotonically increasing `seq` across attempts within a Run. Events are delivered only after persistence. `afterSeq` is an exclusive cursor used to resume a stream. The durable cursor is rechecked so events are not lost between reading past events and waiting for new ones. A cursor outside the retention window returns an explicit error.

Each model request is built from the committed conversation and the current Run checkpoint. User input and unfinished Tool interactions are not truncated; older completed turns are dropped using deterministic grouping rules. If the required content alone exceeds the limit, Tecido fails before calling the provider. Long-term memory, automatic summarization, and RAG are outside the base runtime.

## Static cron and deployment

Agent `schedules` are the sole source of schedule definitions, and the timezone is UTC. The CLI generates Celld cron triggers and a dispatch table keyed by `(agentId, scheduleId)`, then detects configuration mismatches. The runtime does not expose an API to create or modify schedules.

A cron handler durably accepts an occurrence before running its hook. Hooks may be replayed after interruption and must therefore be replayable. Each Thread operation has its own occurrence and operation identity and reaches the same Run path through the journal/outbox and normal Thread acceptance. A single occurrence ID must not be reused as the idempotency key for multiple operations. Direct external side effects may repeat when a hook is replayed; external work belongs in Tools that can be made idempotent.

`tecido build` validates configuration and generates the manifest, Worker, and Celld configuration from the same Agent declarations. `tecido dev` uses the same build pipeline for local startup. Tecido manages internal classes, bindings, migrations, and cron settings and rejects conflicts. Secrets, buckets, and node settings are supplied by the operating environment and are not embedded in generated files. Durable Object class migrations and Thread storage schema migrations are managed separately.

## Errors, security, and operations

Public errors use stable codes, sanitized messages, retryability, and optional details. Key errors include `IDEMPOTENCY_CONFLICT`, `THREAD_ADDRESS_INVALID`, `CONTEXT_LIMIT_EXCEEDED`, `MODEL_ERROR`, `TOOL_INPUT_INVALID`, `TOOL_ERROR`, `INDETERMINATE_SIDE_EFFECT`, `RUN_NOT_RETRYABLE`, `RUN_CANCELLED`, `STREAM_CURSOR_EXPIRED`, and `STORAGE_SCHEMA_UNSUPPORTED`.

The application maps authenticated and authorized principals to Thread addresses. Secrets, message content, raw provider responses, and idempotency keys are excluded from logs and errors by default. Operational logs carry correlation IDs, state, latency, and usage, with a redaction boundary. Exactly-once external side effects, managed hosting, and a generic workflow engine are outside the guarantees and scope.

## Current implementation boundary

As of 2026-09-27, an initial implementation connects Agent/config validation, a port-backed Thread facade, AsyncLocalStorage scope, the Celld adapter, durable acceptance/FIFO/recovery, CLI build/dev and Worker configuration generation, and a cron occurrence journal. It targets Celld 0.6.0. Generated artifacts live under `.tecido/`; development rebuilds require an explicit restart.

The runtime uses versioned Thread snapshots and polls persisted stream events. Defaults retain completed Run data for 30 days, stream events for 7 days, idempotency keys for 30 days, and cron journals for 30 days. Expired Run data is removed on the next Thread state transition; expired stream events are cleared and old cursors return `STREAM_CURSOR_EXPIRED`. Active Runs are never pruned. Limits default to 32,000 estimated context tokens, 8 Tool rounds, 10 minutes per Run, 2 minutes per model call, and 1 minute per Tool call. Context selection estimates tokens from serialized messages and instructions at four characters per token, drops oldest complete turns deterministically, and fails with `CONTEXT_LIMIT_EXCEEDED` when required context still exceeds the limit. Limits and retention durations are configurable through `TecidoConfig.limits` and `TecidoConfig.retention`. Thread snapshots retain schema version 1. The persisted fields are changed directly in this early-stage format; no v2 marker or compatibility migration is used. Real Celld and backup/restore verification remain outstanding; see the [remaining work](../plan.md).
