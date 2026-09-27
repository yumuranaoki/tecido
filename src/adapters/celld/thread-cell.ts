import { type ModelMessage, tool as aiTool, streamText } from "ai";
import { z } from "zod/v4";
import type { AgentOptions } from "../../agent.js";
import type { TecidoConfig } from "../../config.js";
import type { LanguageModel } from "../../model.js";
import { runtimeEnv } from "../../runtime-context.js";
import { awaitWithSignal } from "./abort.js";
import type { CellState } from "./contracts.js";
import { Command, Retry, State, type StoredRun, type StoredState } from "./schema.js";

const KEY = "tecido.thread.v1";

type ThreadCommand = z.infer<typeof Command>;

type Transition<Value> = { state: StoredState; value: Value };

type ModelCall = { toolCallId: string; toolName: string; input: unknown };

type StoredToolCall = StoredRun["calls"][number];
type RetryResolution = z.infer<typeof Retry>["reconcile"];

/** One Cell owns a Thread. Every transition and its recovery alarm commit together. */
export class ThreadCell {
  private active: { runId: string; controller: AbortController } | undefined;
  private recovering = true;
  private draining = false;

  constructor(
    private readonly cell: CellState,
    private readonly config: TecidoConfig,
  ) {}

  private update<Value>(
    transition: (state: StoredState | undefined) => { state: StoredState; value: Value },
    arm = true,
  ): Promise<Value> {
    return this.cell.storage.transaction(async (tx) => {
      const raw = await tx.get<unknown>(KEY);
      const state = raw === undefined ? undefined : State.parse(raw);
      const next = transition(state);
      if (state !== next.state) await tx.put(KEY, State.parse(next.state));
      if (arm) {
        if (next.state.runs.some((run) => !terminal(run))) {
          const deadline = await tx.getAlarm();
          // Celld may expose the currently firing alarm here; it cannot cover the next wake.
          if (deadline === null || deadline <= Date.now() || deadline > Date.now() + 1000)
            await tx.setAlarm(Date.now() + 1000);
        } else await tx.deleteAlarm();
      }
      return next.value;
    });
  }

  async fetch(request: Request): Promise<Response> {
    const parsed = Command.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "INVALID_COMMAND" }, { status: 400 });

    const command = parsed.data;
    try {
      const value = await this.update(
        (prior) => this.applyCommand(prior, command),
        command.type !== "read" && command.type !== "events",
      );
      if (command.type === "cancel" && this.active?.runId === command.runId) this.active.controller.abort();

      return Response.json(value);
    } catch (failure) {
      const code =
        failure instanceof Error && /^[A-Z_]+$/.test(failure.message) ? failure.message : "STORAGE_SCHEMA_UNSUPPORTED";
      return Response.json({ error: code }, { status: code === "IDEMPOTENCY_CONFLICT" ? 409 : 400 });
    }
  }

  private applyCommand(prior: StoredState | undefined, command: ThreadCommand): Transition<unknown> {
    const state = prior ?? this.createState(command);
    this.assertAddress(state, command);

    if (command.type === "accept") return this.acceptCommand(state, command);
    if (command.type === "read") return this.readCommand(state, command);
    if (command.type === "events") return this.eventsCommand(state, command);
    if (command.type === "cancel") return this.cancelCommand(state, command);

    return this.retryCommand(state, command);
  }

  private createState(command: ThreadCommand): StoredState {
    return {
      version: 1,
      address: command.address,
      nextQueue: 1,
      nextDispatch: 1,
      messages: [],
      runs: [],
    };
  }

  private assertAddress(state: StoredState, command: ThreadCommand): void {
    if (JSON.stringify(state.address) !== JSON.stringify(command.address)) throw new Error("ADDRESS_CONFLICT");

    if (!this.config.agents.some((agent) => agent.options.id === state.address.agentId))
      throw new Error("AGENT_NOT_REGISTERED");
  }

  private acceptCommand(state: StoredState, command: Extract<ThreadCommand, { type: "accept" }>): Transition<unknown> {
    const previous = state.runs.find(
      (run) =>
        run.event.eventId === command.event.eventId ||
        (command.event.type === "message" &&
          command.event.transactionId !== undefined &&
          run.event.type === "message" &&
          run.event.transactionId === command.event.transactionId),
    );
    if (previous) {
      if (semantic(previous.event) !== semantic(command.event)) throw new Error("IDEMPOTENCY_CONFLICT");

      return { state, value: acceptance(previous, true) };
    }

    const time = now();
    const run: StoredRun = {
      snapshot: {
        runId: crypto.randomUUID(),
        status: "accepted",
        attempt: 1,
        acceptedAt: time,
        updatedAt: time,
      },
      event: command.event,
      queueSeq: state.nextQueue,
      dispatchSeq: state.nextDispatch,
      afterSeq: 0,
      events: [],
      attempts: [],
      round: 0,
      calls: [],
      text: "",
      cancelled: false,
    };

    return {
      state: {
        ...state,
        nextQueue: state.nextQueue + 1,
        nextDispatch: state.nextDispatch + 1,
        runs: [...state.runs, run],
      },
      value: acceptance(run, false),
    };
  }

  private readCommand(state: StoredState, command: Extract<ThreadCommand, { type: "read" }>): Transition<unknown> {
    const run = requireRun(state, command.runId);
    const snapshot =
      command.attempt === undefined || command.attempt === run.snapshot.attempt
        ? run.snapshot
        : run.attempts.find((attempt) => attempt.attempt === command.attempt);
    if (snapshot === undefined) throw new Error("ATTEMPT_NOT_FOUND");

    return { state, value: snapshot };
  }

  private eventsCommand(state: StoredState, command: Extract<ThreadCommand, { type: "events" }>): Transition<unknown> {
    const run = requireRun(state, command.runId);

    return {
      state,
      value: { events: run.events.filter((event) => event.seq > command.afterSeq), terminal: terminal(run) },
    };
  }

  private cancelCommand(state: StoredState, command: Extract<ThreadCommand, { type: "cancel" }>): Transition<unknown> {
    const run = requireRun(state, command.runId);
    const next = terminal(run)
      ? run
      : run.snapshot.status === "accepted" ||
          run.snapshot.status === "tool_pending" ||
          run.snapshot.status === "tool_completed"
        ? finish(run, "cancelled")
        : { ...run, cancelled: true };

    return { state: replace(state, next), value: { ok: true } };
  }

  private retryCommand(state: StoredState, command: Extract<ThreadCommand, { type: "retry" }>): Transition<unknown> {
    const run = requireRun(state, command.runId);
    if (run.snapshot.status !== "failed") throw new Error("RUN_NOT_RETRYABLE");

    const reconciliation = command.options?.reconcile;
    const uncertain = run.calls.find((call) => call.status === "running");
    this.assertRetryResolution(uncertain, reconciliation);
    const calls = this.prepareRetryCalls(run.calls, reconciliation);
    const next: StoredRun = {
      ...run,
      calls,
      cancelled: false,
      afterSeq: run.events.length,
      events: reconciliation
        ? [
            ...run.events,
            {
              type: "tool-result",
              toolCallId: reconciliation.toolCallId,
              output: reconciliation.outcome.output,
              seq: run.events.length + 1,
              attempt: run.snapshot.attempt + 1,
            },
          ]
        : run.events,
      snapshot: {
        runId: run.snapshot.runId,
        acceptedAt: run.snapshot.acceptedAt,
        updatedAt: now(),
        attempt: run.snapshot.attempt + 1,
        status: "accepted",
      },
      attempts: [...run.attempts, run.snapshot],
      dispatchSeq: state.nextDispatch,
    };

    return {
      state: { ...replace(state, next), nextDispatch: state.nextDispatch + 1 },
      value: acceptance(next, false),
    };
  }

  private assertRetryResolution(uncertain: StoredToolCall | undefined, reconciliation: RetryResolution): void {
    if (reconciliation && (!uncertain || uncertain.id !== reconciliation.toolCallId))
      throw new Error("INVALID_RECONCILIATION");

    if (uncertain && uncertain.retry !== "safe" && !reconciliation) throw new Error("RUN_NOT_RETRYABLE");
  }

  private prepareRetryCalls(calls: readonly StoredToolCall[], reconciliation: RetryResolution): StoredToolCall[] {
    return calls.map((call) =>
      call.status !== "running"
        ? call
        : reconciliation
          ? { ...call, status: "completed" as const, output: reconciliation.outcome.output }
          : { ...call, status: "pending" as const },
    );
  }

  async alarm(): Promise<void> {
    if (this.draining) return;

    this.draining = true;
    try {
      await this.drain();
    } finally {
      this.draining = false;
    }
  }

  private async drain(): Promise<void> {
    if (this.active) return;

    const selected = await this.update((state) => {
      if (!state) throw new Error("THREAD_NOT_FOUND");
      const recovered = this.recovering
        ? {
            ...state,
            runs: state.runs.map((run) =>
              run.snapshot.status === "model_running"
                ? finish(run, "failed", "MODEL_INTERRUPTED")
                : run.snapshot.status === "tool_running"
                  ? finish(run, "failed", "INDETERMINATE_SIDE_EFFECT")
                  : run,
            ),
          }
        : state;
      const run = recovered.runs.filter((item) => !terminal(item)).sort((a, b) => a.dispatchSeq - b.dispatchSeq)[0];
      return { state: recovered, value: run ? { run, address: recovered.address } : undefined };
    });
    this.recovering = false;
    if (!selected) return;

    const controller = new AbortController();
    this.active = { runId: selected.run.snapshot.runId, controller };
    try {
      const declaration = this.config.agents.find((agent) => agent.options.id === selected.address.agentId);
      if (!declaration) throw new Error("AGENT_NOT_REGISTERED");
      await this.execute(selected.run.snapshot.runId, declaration.options, controller.signal);
    } catch {
      await this.change(selected.run.snapshot.runId, (run) =>
        terminal(run)
          ? run
          : finish(
              run,
              run.cancelled && run.snapshot.status !== "tool_running" ? "cancelled" : "failed",
              run.snapshot.status === "tool_running" ? "INDETERMINATE_SIDE_EFFECT" : "RUN_FAILED",
            ),
      );
    } finally {
      this.active = undefined;
    }
  }

  private change(runId: string, transition: (run: StoredRun, state: StoredState) => StoredRun): Promise<StoredRun> {
    return this.update((state) => {
      if (!state) throw new Error("THREAD_NOT_FOUND");
      const current = requireRun(state, runId);
      const next = terminal(current) ? current : transition(current, state);
      return { state: replace(state, next), value: next };
    });
  }

  private async execute(runId: string, options: AgentOptions, signal: AbortSignal): Promise<void> {
    let run = await this.initializeRun(runId);
    const model = typeof options.model === "function" ? options.model({ env: runtimeEnv() }) : options.model;

    while (!terminal(run)) {
      if (run.cancelled) {
        await this.change(runId, (current) => finish(current, "cancelled"));

        return;
      }

      if (run.calls.length) {
        run = await this.executeToolCalls(runId, run, options, signal);

        continue;
      }

      if (run.round >= 8) throw new Error("MODEL_ROUND_LIMIT");
      const round = await this.executeModelRound(runId, run, options, model, signal);
      run = round.run;
      if (run.cancelled || signal.aborted) throw new Error("RUN_CANCELLED");

      if (round.calls.length) {
        run = await this.recordToolCalls(runId, options, round.messages, round.calls);

        continue;
      }

      if (round.reason !== "stop") throw new Error("MODEL_INCOMPLETE");
      await this.completeRun(runId, round.messages);

      return;
    }
  }

  private initializeRun(runId: string): Promise<StoredRun> {
    return this.change(runId, (current, state) => ({
      ...current,
      contextStart: current.contextStart ?? state.messages.length,
      context: current.context ?? [...state.messages, { role: "user", content: current.event.input }],
    }));
  }

  private async executeToolCalls(
    runId: string,
    initialRun: StoredRun,
    options: AgentOptions,
    signal: AbortSignal,
  ): Promise<StoredRun> {
    let run = initialRun;
    for (const planned of run.calls) {
      if (planned.status === "completed") continue;
      run = await this.executeToolCall(runId, planned, options, signal);
      if (terminal(run)) {
        return run;
      }
    }

    return this.advanceAfterTools(runId);
  }

  private async executeToolCall(
    runId: string,
    planned: StoredToolCall,
    options: AgentOptions,
    signal: AbortSignal,
  ): Promise<StoredRun> {
    const declaration = options.tools?.[planned.name];
    if (!declaration) throw new Error("TOOL_NOT_FOUND");
    const validated = await declaration.inputSchema["~standard"].validate(planned.input);
    if (validated.issues) throw new Error("TOOL_INPUT_INVALID");

    const running = await this.change(runId, (current) => ({
      ...current,
      snapshot: { ...current.snapshot, status: "tool_running", updatedAt: now() },
      calls: current.calls.map((call) => (call.id === planned.id ? { ...call, status: "running" } : call)),
    }));
    if (terminal(running)) {
      return running;
    }

    const toolSignal = AbortSignal.any([signal, AbortSignal.timeout(declaration.timeoutMs ?? 60000)]);
    const output = z
      .json()
      .parse(
        await awaitWithSignal(
          () => declaration.execute(validated.value, { runId, toolCallId: planned.id, signal: toolSignal }),
          toolSignal,
        ),
      );

    return this.change(runId, (current) => ({
      ...current,
      snapshot: { ...current.snapshot, status: "tool_completed", updatedAt: now() },
      calls: current.calls.map((call) => (call.id === planned.id ? { ...call, status: "completed", output } : call)),
      events: [
        ...current.events,
        {
          type: "tool-result",
          toolCallId: planned.id,
          output,
          seq: current.events.length + 1,
          attempt: current.snapshot.attempt,
        },
      ],
    }));
  }

  private advanceAfterTools(runId: string): Promise<StoredRun> {
    return this.change(runId, (current) => ({
      ...current,
      calls: [],
      round: current.round + 1,
      context: [
        ...current.context!,
        {
          role: "tool",
          content: current.calls.map((call) => ({
            type: "tool-result",
            toolCallId: call.providerId,
            toolName: call.name,
            output: { type: "json", value: call.output! },
          })),
        },
      ],
    }));
  }

  private async executeModelRound(
    runId: string,
    run: StoredRun,
    options: AgentOptions,
    model: LanguageModel,
    signal: AbortSignal,
  ) {
    run = await this.change(runId, (current) => ({
      ...current,
      text: "",
      snapshot: { ...current.snapshot, status: "model_running", updatedAt: now() },
    }));
    if (terminal(run)) {
      return { run, messages: [] as readonly ModelMessage[], calls: [] as readonly ModelCall[], reason: "cancelled" };
    }

    const result = streamText({
      model,
      system: options.instructions,
      messages: run.context!,
      maxRetries: 0,
      abortSignal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
      tools: Object.fromEntries(
        Object.entries(options.tools ?? {}).map(([name, declaration]) => [
          name,
          aiTool({ description: declaration.description, inputSchema: declaration.inputSchema }),
        ]),
      ),
    });
    for await (const part of result.fullStream) {
      if (part.type === "error" || part.type === "tool-error" || part.type === "abort") throw new Error("MODEL_ERROR");
      if (part.type === "text-delta")
        run = await this.change(runId, (current) => ({
          ...current,
          text: current.text + part.text,
          events: [
            ...current.events,
            {
              type: "text-delta",
              delta: part.text,
              seq: current.events.length + 1,
              attempt: current.snapshot.attempt,
            },
          ],
        }));
    }

    const [messages, calls, reason] = await Promise.all([
      result.responseMessages,
      result.toolCalls,
      result.finishReason,
    ]);

    return { run, messages, calls, reason };
  }

  private recordToolCalls(
    runId: string,
    options: AgentOptions,
    messages: readonly ModelMessage[],
    calls: readonly ModelCall[],
  ): Promise<StoredRun> {
    return this.change(runId, (current) => {
      const planned = calls.map((call, index) => ({
        id: JSON.stringify([runId, current.round, index]),
        providerId: call.toolCallId,
        name: call.toolName,
        input: z.json().parse(call.input),
        retry: options.tools?.[call.toolName]?.retry ?? "never",
        status: "pending" as const,
      }));

      return {
        ...current,
        context: [...current.context!, ...messages],
        calls: planned,
        snapshot: { ...current.snapshot, status: "tool_pending", updatedAt: now() },
        events: [
          ...current.events,
          ...planned.map((call, index) => ({
            type: "tool-call" as const,
            toolCallId: call.id,
            name: call.name,
            input: call.input,
            seq: current.events.length + index + 1,
            attempt: current.snapshot.attempt,
          })),
        ],
      };
    });
  }

  private completeRun(runId: string, messages: readonly ModelMessage[]): Promise<StoredRun> {
    return this.update((state) => {
      if (!state) throw new Error("THREAD_NOT_FOUND");
      const current = requireRun(state, runId);
      if (terminal(current)) {
        return { state, value: current };
      }

      if (current.cancelled) {
        return { state: replace(state, finish(current, "cancelled")), value: current };
      }

      const completed: StoredRun = {
        ...current,
        snapshot: {
          ...current.snapshot,
          status: "completed",
          updatedAt: now(),
          result: { runId, output: { text: current.text } },
        },
        events: [
          ...current.events,
          { type: "completed", seq: current.events.length + 1, attempt: current.snapshot.attempt },
        ],
      };
      const priorLength = current.contextStart!;
      const turn = current.context!.slice(priorLength);

      return {
        state: { ...replace(state, completed), messages: [...state.messages, ...turn, ...messages] },
        value: completed,
      };
    });
  }
}

const terminal = (run: StoredRun) => ["completed", "failed", "cancelled"].includes(run.snapshot.status);

const now = () => new Date().toISOString();

const error = (code: string) => ({ code, message: code, retryable: code !== "INDETERMINATE_SIDE_EFFECT" });

function requireRun(state: StoredState, runId: string): StoredRun {
  const run = state.runs.find((item) => item.snapshot.runId === runId);
  if (!run) throw new Error("RUN_NOT_FOUND");
  return run;
}

function replace(state: StoredState, run: StoredRun): StoredState {
  return { ...state, runs: state.runs.map((item) => (item.snapshot.runId === run.snapshot.runId ? run : item)) };
}

function finish(run: StoredRun, status: "failed" | "cancelled", code?: string): StoredRun {
  const failure = status === "failed" ? error(code ?? "RUN_FAILED") : undefined;
  return {
    ...run,
    snapshot: { ...run.snapshot, status, updatedAt: now(), ...(failure ? { error: failure } : {}) },
    events: [
      ...run.events,
      {
        seq: run.events.length + 1,
        attempt: run.snapshot.attempt,
        ...(status === "failed" ? { type: "failed" as const, error: failure! } : { type: "cancelled" as const }),
      },
    ],
  };
}

const acceptance = (run: StoredRun, duplicate: boolean) => ({
  runId: run.snapshot.runId,
  status: run.snapshot.status,
  queueSeq: run.queueSeq,
  duplicate,
  attempt: run.snapshot.attempt,
  afterSeq: run.afterSeq,
});

const semantic = (event: StoredRun["event"]) =>
  JSON.stringify(
    event.type === "message"
      ? [event.type, event.input]
      : [event.type, event.input, event.scheduleId, event.occurrenceId, event.scheduledAt],
  );
