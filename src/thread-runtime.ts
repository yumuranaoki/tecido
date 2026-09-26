import {
  stepCountIs,
  streamText,
  tool as aiTool,
  type ModelMessage,
  type ToolExecutionOptions,
} from "ai";
import { mapValues } from "remeda";
import { match, P } from "ts-pattern";
import type { AgentOptions } from "./agent.js";
import { AgentRunError, type AgentError } from "./errors.js";
import type { ModelUsage } from "./model.js";
import type {
  AgentOutput,
  RetryOptions,
  RunId,
  RunOptions,
  RunResult,
  RunSnapshot,
  RunStatus,
  RunStream,
  StreamEvent,
  TransactionId,
} from "./run.js";
import type { Thread } from "./thread.js";
import type { Tool } from "./tool.js";

interface ThreadState {
  readonly messages: readonly ModelMessage[];
  /** Run records keyed by the generated Run ID. */
  readonly runs: ReadonlyMap<RunId, RunState>;
  /** Deduplication records keyed by the caller-provided transaction ID. */
  readonly transactions: ReadonlyMap<TransactionId, TransactionRecord>;
}

interface TransactionRecord {
  readonly input: string;
  readonly runId: RunId;
}

interface RunState {
  readonly runId: RunId;
  readonly input: string;
  readonly acceptedAt: string;
  readonly events: readonly StreamEvent[];
  readonly attempt: number;
  readonly status: RunStatus;
  readonly updatedAt: string;
  readonly controller: AbortController;
  readonly signal: RunSignal;
  readonly error?: AgentError;
  readonly result?: RunResult;
}

interface RunSignal {
  readonly wait: Promise<void>;
  readonly notify: () => void;
}

interface ModelTurnOutput {
  readonly responseMessages: readonly ModelMessage[];
  readonly usage?: ModelUsage;
}

type Captured<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: unknown };

type ModelTurnOutcome = Captured<ModelTurnOutput>;

const USER_CANCELLATION = Symbol("user cancellation");

type NewStreamEvent = StreamEvent extends infer Event
  ? Event extends StreamEvent
    ? Omit<Event, "seq" | "attempt">
    : never
  : never;

export function createThread(options: AgentOptions): Thread {
  const state = createStateCell(createThreadState());
  let queueTail: Promise<void> = Promise.resolve();

  const readRun = (runId: RunId): RunState => requireRun(state.read(), runId);

  const publish = (runId: RunId, event: NewStreamEvent): void => {
    const { run, notify } = appendRunEvent(readRun(runId), event);
    state.transition((current) => withRun(current, run));
    notify();
  };

  const failRun = (runId: RunId, error: unknown): void => {
    const run = readRun(runId);
    if (isTerminal(run.status)) return;
    if (isCancellationRequested(run)) {
      publish(runId, { type: "cancelled" });
      return;
    }

    const normalized = normalizeError(error);
    state.transition((current) =>
      withRun(current, {
        ...requireRun(current, runId),
        error: normalized,
        updatedAt: new Date().toISOString(),
      }),
    );
    publish(runId, { type: "failed", error: normalized });
  };

  const execute = async (runId: RunId): Promise<void> => {
    const run = readRun(runId);
    if (isCancellationRequested(run)) {
      publish(runId, { type: "cancelled" });
      return;
    }

    const runningRun: RunState = {
      ...run,
      status: "model_running",
      updatedAt: new Date().toISOString(),
    };
    state.transition((current) => withRun(current, runningRun));

    const userMessage: ModelMessage = { role: "user", content: runningRun.input };
    const modelOutcome = await runModelTurn(
      options,
      [...state.read().messages, userMessage],
      runningRun,
      (event) => publish(runId, event),
    );

    if (!modelOutcome.ok) {
      failRun(runId, modelOutcome.error);
      return;
    }

    const activeRun = readRun(runId);
    if (isCancellationRequested(activeRun)) {
      publish(runId, { type: "cancelled" });
      return;
    }

    state.transition((current) =>
      withMessages(current, [
        ...current.messages,
        userMessage,
        ...modelOutcome.value.responseMessages,
      ]),
    );

    const result: RunResult = {
      runId,
      output: { text: textForAttempt(activeRun) } satisfies AgentOutput,
      ...(modelOutcome.value.usage === undefined
        ? {}
        : { usage: modelOutcome.value.usage }),
    };
    state.transition((current) =>
      withRun(current, {
        ...requireRun(current, runId),
        result,
        updatedAt: new Date().toISOString(),
      }),
    );
    publish(runId, {
      type: "completed",
      ...(modelOutcome.value.usage === undefined
        ? {}
        : { usage: modelOutcome.value.usage }),
    });
  };

  const enqueue = (runId: RunId): void => {
    const execution = queueTail.then(() => execute(runId));
    queueTail = execution.then(
      () => undefined,
      (error: unknown) => failRun(runId, error),
    );
  };

  const stream = async (
    input: string,
    runOptions?: RunOptions,
  ): Promise<RunStream> => {
    const transactionId = runOptions?.transactionId;
    const previous = transactionId === undefined
      ? undefined
      : state.read().transactions.get(transactionId);

    if (previous !== undefined) {
      if (previous.input !== input) {
        throw new Error(
          `IDEMPOTENCY_CONFLICT: transaction ${transactionId} was already used for different input.`,
        );
      }
      return runStream(readRun, previous.runId, 0);
    }

    const run = createRun(input);
    state.transition((current) => withRun(current, run));
    if (transactionId !== undefined) {
      state.transition((current) =>
        withTransaction(current, transactionId, {
          input,
          runId: run.runId,
        }),
      );
    }
    enqueue(run.runId);
    return runStream(readRun, run.runId, 0);
  };

  const waitForResult = async (
    runId: RunId,
    events: AsyncIterable<StreamEvent>,
  ): Promise<RunResult> => {
    for await (const event of events) {
      const error = match(event)
        .with({ type: "failed" }, (failed) =>
          new AgentRunError(runId, failed.attempt, failed.type, failed.error))
        .with({ type: "cancelled" }, (cancelled) =>
          new AgentRunError(
            runId,
            cancelled.attempt,
            cancelled.type,
            cancelledError(),
          ))
        .with(
          { type: P.union("text-delta", "tool-call", "tool-result", "completed") },
          () => undefined,
        )
        .exhaustive();

      if (error !== undefined) throw error;
    }

    const result = readRun(runId).result;
    if (result === undefined) {
      throw new Error(`Run ${runId} ended without a result.`);
    }
    return result;
  };

  return {
    run: async (input: string, runOptions?: RunOptions): Promise<RunResult> => {
      const runStream = await stream(input, runOptions);
      return waitForResult(runStream.runId, runStream);
    },

    stream,

    getRun: async (runId: RunId): Promise<RunSnapshot> =>
      snapshot(readRun(runId)),

    subscribe: (
      runId: RunId,
      subscribeOptions?: { readonly afterSeq?: number },
    ): AsyncIterable<StreamEvent> =>
      subscribeEvents(readRun, runId, subscribeOptions?.afterSeq ?? 0),

    retry: async (
      runId: RunId,
      retryOptions?: RetryOptions,
    ): Promise<RunResult> => {
      const run = readRun(runId);
      if (run.status !== "failed") {
        throw new Error(`Run ${runId} is not in a failed state.`);
      }
      if (retryOptions?.reconcile !== undefined) {
        throw new Error(
          "Tool reconciliation is not available in the in-memory runtime.",
        );
      }
      if (hasToolCalls(run)) {
        throw new Error(
          "A Run with tool calls cannot be retried by the in-memory runtime.",
        );
      }

      const afterSeq = run.events.length;
      state.transition((current) => withRun(current, retryRun(run)));
      enqueue(runId);
      return waitForResult(runId, subscribeEvents(readRun, runId, afterSeq));
    },

    cancel: async (runId: RunId): Promise<void> => {
      const run = readRun(runId);
      if (!isTerminal(run.status)) run.controller.abort(USER_CANCELLATION);
    },
  };
}

interface StateCell<State> {
  read(): State;
  transition(reducer: (current: State) => State): State;
}

function createStateCell<State>(initial: State): StateCell<State> {
  let current = initial;
  return {
    read: () => current,
    transition: (reducer) => {
      current = reducer(current);
      return current;
    },
  };
}

function createThreadState(): ThreadState {
  return {
    messages: [],
    runs: new Map(),
    transactions: new Map(),
  };
}

function createRun(input: string): RunState {
  const now = new Date().toISOString();
  return {
    runId: globalThis.crypto.randomUUID(),
    input,
    acceptedAt: now,
    events: [],
    attempt: 1,
    status: "accepted",
    updatedAt: now,
    controller: new AbortController(),
    signal: createRunSignal(),
  };
}

function retryRun(run: RunState): RunState {
  return {
    runId: run.runId,
    input: run.input,
    acceptedAt: run.acceptedAt,
    events: run.events,
    attempt: run.attempt + 1,
    status: "accepted",
    updatedAt: new Date().toISOString(),
    controller: new AbortController(),
    signal: createRunSignal(),
  };
}

function createRunSignal(): RunSignal {
  let notify!: () => void;
  const wait = new Promise<void>((resolve) => {
    notify = resolve;
  });
  return { wait, notify };
}

function withMessages(
  state: ThreadState,
  messages: readonly ModelMessage[],
): ThreadState {
  return { ...state, messages };
}

function withRun(state: ThreadState, run: RunState): ThreadState {
  const runs = new Map<RunId, RunState>([...state.runs, [run.runId, run]]);
  return { ...state, runs };
}

function withTransaction(
  state: ThreadState,
  transactionId: TransactionId,
  transaction: TransactionRecord,
): ThreadState {
  const transactions = new Map<TransactionId, TransactionRecord>([
    ...state.transactions,
    [transactionId, transaction],
  ]);
  return { ...state, transactions };
}

function appendRunEvent(
  run: RunState,
  event: NewStreamEvent,
): { readonly run: RunState; readonly notify: () => void } {
  const now = new Date().toISOString();
  const sequencedEvent = {
    ...event,
    seq: run.events.length + 1,
    attempt: run.attempt,
  } as StreamEvent;
  const signal = createRunSignal();

  return {
    run: {
      ...run,
      events: [...run.events, sequencedEvent],
      status: statusForEvent(event),
      updatedAt: now,
      signal,
    },
    notify: run.signal.notify,
  };
}

function statusForEvent(event: NewStreamEvent): RunStatus {
  return match(event)
    .returnType<RunStatus>()
    .with({ type: "completed" }, () => "completed")
    .with({ type: "failed" }, () => "failed")
    .with({ type: "cancelled" }, () => "cancelled")
    .with({ type: "tool-call" }, () => "tool_pending")
    .with({ type: "tool-result" }, () => "tool_completed")
    .with({ type: "text-delta" }, () => "model_running")
    .exhaustive();
}

async function runModelTurn(
  options: AgentOptions,
  messages: readonly ModelMessage[],
  run: RunState,
  publish: (event: NewStreamEvent) => void,
): Promise<ModelTurnOutcome> {
  const modelResult = capture(() =>
    streamText({
      model: options.model,
      system: options.instructions,
      messages: [...messages],
      tools: createModelTools(options.tools ?? {}, run),
      stopWhen: stepCountIs(8),
      maxRetries: 0,
      abortSignal: run.controller.signal,
    }),
  );
  if (!modelResult.ok) return { ok: false, error: modelResult.error };

  const iterator = capture(() =>
    modelResult.value.fullStream[Symbol.asyncIterator](),
  );
  if (!iterator.ok) return { ok: false, error: iterator.error };

  while (true) {
    const next = await captureAsync(() => iterator.value.next());
    if (!next.ok) return { ok: false, error: next.error };
    if (next.value.done) break;

    const part = next.value.value;
    const outcome = match(part)
      .returnType<ModelTurnOutcome | undefined>()
      .with({ type: "text-delta" }, (textDelta) => {
        publish({ type: "text-delta", delta: textDelta.text });
        return undefined;
      })
      .with({ type: "tool-call" }, (toolCall) => {
        publish({
          type: "tool-call",
          toolCallId: toolCall.toolCallId,
          name: toolCall.toolName,
          input: toolCall.input,
        });
        return undefined;
      })
      .with({ type: "tool-result" }, (toolResult) => {
        publish({
          type: "tool-result",
          toolCallId: toolResult.toolCallId,
          output: toolResult.output,
        });
        return undefined;
      })
      .with(
        { type: P.union("tool-error", "error") },
        (streamError) => {
          run.controller.abort(streamError.error);
          return { ok: false, error: streamError.error };
        },
      )
      .with({ type: "abort" }, (abort) =>
        isCancellationRequested(run)
          ? undefined
          : {
              ok: false,
              error: new Error(
                abort.reason ?? "The model stream was aborted.",
              ),
            },
      )
      // SDK parts without a persisted StreamEvent representation are ignored.
      .with(
        {
          type: P.union(
            "text-start",
            "text-end",
            "reasoning-start",
            "reasoning-end",
            "reasoning-delta",
            "custom",
            "tool-input-start",
            "tool-input-end",
            "tool-input-delta",
            "source",
            "file",
            "reasoning-file",
            "tool-output-denied",
            "tool-approval-request",
            "tool-approval-response",
            "start-step",
            "finish-step",
            "start",
            "finish",
            "raw",
          ),
        },
        () => undefined,
      )
      .exhaustive();

    if (outcome !== undefined) return outcome;
  }

  if (isCancellationRequested(run)) {
    return { ok: false, error: cancelledError() };
  }

  const completion = await captureAsync(() =>
    Promise.all([
      modelResult.value.responseMessages,
      modelResult.value.totalUsage,
    ] as const),
  );
  if (!completion.ok) return { ok: false, error: completion.error };

  const [responseMessages, usage] = completion.value;
  return {
    ok: true,
    value: {
      responseMessages,
      ...(usage === undefined ? {} : { usage }),
    },
  };
}

function capture<Value>(operation: () => Value): Captured<Value> {
  try {
    return { ok: true, value: operation() };
  } catch (error) {
    return { ok: false, error };
  }
}

async function captureAsync<Value>(
  operation: () => Promise<Value>,
): Promise<Captured<Value>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return { ok: false, error };
  }
}

function createModelTools(
  declarations: Readonly<Record<string, Tool<any, any>>>,
  run: RunState,
) {
  return mapValues(declarations, (declaration) => adaptTool(declaration, run));
}

function adaptTool<Schema extends Tool<any, any>>(
  declaration: Schema,
  run: RunState,
) {
  return aiTool({
    description: declaration.description,
    inputSchema: declaration.inputSchema,
    execute: (input, context: ToolExecutionOptions<unknown>) =>
      declaration.execute(input, {
        runId: run.runId,
        toolCallId: context.toolCallId,
        signal: context.abortSignal ?? run.controller.signal,
      }),
  });
}

function runStream(
  readRun: (runId: RunId) => RunState,
  runId: RunId,
  afterSeq: number,
): RunStream {
  return {
    runId,
    [Symbol.asyncIterator]: () =>
      subscribeEvents(readRun, runId, afterSeq)[Symbol.asyncIterator](),
  };
}

async function* subscribeEvents(
  readRun: (runId: RunId) => RunState,
  runId: RunId,
  afterSeq: number,
): AsyncIterable<StreamEvent> {
  let cursor = afterSeq;

  while (true) {
    const run = readRun(runId);
    const next = run.events.find((event) => event.seq > cursor);
    if (next !== undefined) {
      cursor = next.seq;
      yield next;
      continue;
    }

    if (isTerminal(run.status)) return;
    await run.signal.wait;
  }
}

function textForAttempt(run: RunState): string {
  return run.events
    .filter(
      (event): event is Extract<StreamEvent, { readonly type: "text-delta" }> =>
        event.type === "text-delta" && event.attempt === run.attempt,
    )
    .map((event) => event.delta)
    .join("");
}

function isCancellationRequested(run: RunState): boolean {
  return run.controller.signal.reason === USER_CANCELLATION;
}

function hasToolCalls(run: RunState): boolean {
  return run.events.some((event) => event.type === "tool-call");
}

function snapshot(run: RunState): RunSnapshot {
  return {
    runId: run.runId,
    status: run.status,
    attempt: run.attempt,
    acceptedAt: run.acceptedAt,
    updatedAt: run.updatedAt,
    ...(run.error === undefined ? {} : { error: run.error }),
    ...(run.result === undefined ? {} : { result: run.result }),
  };
}

function requireRun(state: ThreadState, runId: RunId): RunState {
  const run = state.runs.get(runId);
  if (run === undefined) throw new Error(`Unknown Run: ${runId}`);
  return run;
}

function isTerminal(status: RunStatus): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

function normalizeError(_error: unknown): AgentError {
  return {
    code: "RUN_FAILED",
    message: "Agent run failed.",
    retryable: false,
  };
}

function cancelledError(): AgentError {
  return {
    code: "RUN_CANCELLED",
    message: "Run was cancelled.",
    retryable: false,
  };
}
