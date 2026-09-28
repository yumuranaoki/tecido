import assert from "node:assert/strict";
import { test } from "node:test";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { z } from "zod/v4";
import type { CellStorage, StorageTransaction } from "../../src/adapters/celld/contracts.js";
import { createCelldPort } from "../../src/adapters/celld/port.js";
import { SchedulerCell } from "../../src/adapters/celld/scheduler.js";
import { Accepted, State } from "../../src/adapters/celld/schema.js";
import { ThreadCell } from "../../src/adapters/celld/thread-cell.js";
import { agent } from "../../src/agent.js";
import { parseConfig } from "../../src/config.js";
import { createManifest } from "../../src/manifest.js";
import { withRuntimeContext } from "../../src/runtime-context.js";
import { tool } from "../../src/tool.js";

class Storage implements CellStorage {
  values = new Map<string, unknown>();
  alarm: number | null = null;

  async get<Value>(key: string): Promise<Value | undefined> {
    return structuredClone(this.values.get(key)) as Value | undefined;
  }

  async put<Value>(key: string, value: Value) {
    this.values.set(key, structuredClone(value));
  }

  async setAlarm(time: number) {
    this.alarm = time;
  }

  async getAlarm() {
    return this.alarm;
  }

  async deleteAlarm() {
    this.alarm = null;
  }

  async transaction<Value>(operation: (tx: StorageTransaction) => Promise<Value>): Promise<Value> {
    const before = structuredClone(this.values),
      alarm = this.alarm;
    try {
      return await operation(this);
    } catch (error) {
      this.values = before;
      this.alarm = alarm;
      throw error;
    }
  }
}

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

function model(text = "answer") {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "text-start", id: "text" },
          { type: "text-delta", id: "text", delta: text },
          { type: "text-end", id: "text" },
          { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
        ],
      }),
    }),
  });
}

const address = { namespace: "test", agentId: "assistant", threadId: "a" };

const event = (input = "hello", transactionId = "request") => ({
  type: "message",
  input,
  transactionId,
  eventId: crypto.randomUUID(),
  receivedAt: new Date().toISOString(),
});

async function send(cell: ThreadCell, command: object) {
  const response = await cell.fetch(
    new Request("https://test", { method: "POST", body: JSON.stringify({ address, ...command }) }),
  );
  return { status: response.status, body: await response.json() };
}

function fixture() {
  const languageModel = model();
  const assistant = agent({ id: "assistant", model: languageModel, instructions: "Be concise." });
  const config = parseConfig({ name: "test", agents: [assistant] });
  const storage = new Storage();
  const cell = new ThreadCell({ storage }, config);
  return { languageModel, assistant, config, storage, cell };
}

test("config discovery accepts a model instance and rejects duplicate identity", () => {
  const declared = agent({
    id: "assistant",
    model: model(),
    instructions: "",
    schedules: [{ id: "daily", cron: "0 9 * * *" }],
    async onCron() {},
  });
  const config = parseConfig({ name: "test", agents: [declared] });
  assert.equal(createManifest(config).schedules[0]?.cron, "0 9 * * *");
  assert.throws(() => parseConfig({ name: "test", agents: [declared, declared] }), /Duplicate/);
  assert.throws(() => parseConfig({ name: "test", agents: [declared], vars: { TECIDO_THREADS: "bad" } }), /Reserved/);
  assert.throws(() => declared.thread({ namespace: "x", id: "y" }), /RUNTIME_NOT_BOUND/);
});

test("Zod schemas satisfy Tool boundary", () => {
  assert.equal(
    tool({
      description: "Test",
      inputSchema: z.object({ value: z.string() }),
      async execute({ value }) {
        return value;
      },
    }).retry,
    "never",
  );
});

test("acceptance and wake persist before execution; duplicate conflicts", async () => {
  const { cell, storage, config, languageModel } = fixture();
  const first = await send(cell, { type: "accept", event: event() });
  assert.equal(first.status, 200);
  const accepted = Accepted.parse(first.body);
  assert.ok(storage.alarm);
  const deadline = storage.alarm;
  assert.equal(languageModel.doStreamCalls.length, 0);
  const duplicate = Accepted.parse((await send(cell, { type: "accept", event: event() })).body);
  assert.equal(duplicate.runId, accepted.runId);
  assert.equal(duplicate.duplicate, true);
  assert.equal((await send(cell, { type: "accept", event: event("other") })).status, 409);
  await send(cell, { type: "events", runId: accepted.runId, afterSeq: 0 });
  assert.equal(storage.alarm, deadline, "polling must not postpone the alarm");
  await new ThreadCell({ storage }, config).alarm();
  const persisted = State.parse(await storage.get("tecido.thread.v1"));
  assert.equal(persisted.runs[0]?.snapshot.result?.output.text, "answer");
  assert.equal(persisted.messages.length, 2);
  assert.equal(storage.alarm, null);
});

test("same input across separate turns does not duplicate earlier conversation", async () => {
  const { cell, storage, languageModel } = fixture();
  await send(cell, { type: "accept", event: event("hello", "one") });
  await cell.alarm();
  await send(cell, { type: "accept", event: event("hello", "two") });
  await cell.alarm();
  assert.equal(State.parse(await storage.get("tecido.thread.v1")).messages.length, 4);
  assert.equal(languageModel.doStreamCalls.length, 2);
});

test("interrupted model is failed, explicit retry uses a new cursor and archived attempt", async () => {
  const { cell, storage, config, languageModel } = fixture();
  const accepted = Accepted.parse((await send(cell, { type: "accept", event: event() })).body);
  const state = State.parse(await storage.get("tecido.thread.v1"));
  state.runs[0]!.snapshot.status = "model_running";
  await storage.put("tecido.thread.v1", state);
  const restarted = new ThreadCell({ storage }, config);
  await restarted.alarm();
  assert.equal(languageModel.doStreamCalls.length, 0);
  const retry = Accepted.parse((await send(restarted, { type: "retry", runId: accepted.runId })).body);
  assert.equal(retry.attempt, 2);
  assert.equal(retry.afterSeq, 1);
  await restarted.alarm();
  const archived = await send(restarted, { type: "read", runId: accepted.runId, attempt: 1 });
  assert.equal(archived.body.status, "failed");
  assert.equal((await send(restarted, { type: "read", runId: accepted.runId })).body.status, "completed");
});

test("Thread facade captures its port and uses durable acceptance without executeNext", async () => {
  const { cell, assistant, config } = fixture();
  const port = createCelldPort({
    idFromName: (name) => name,
    get: () => ({ fetch: (request) => cell.fetch(request) }),
  });
  const stream = await withRuntimeContext({ agents: config.agents, port }, () =>
    assistant.thread({ namespace: "test", id: "a" }).stream("hello"),
  );
  await cell.alarm();
  const events = [];
  for await (const event of stream) events.push(event);
  assert.equal(events.at(-1)?.type, "completed");
  await assert.rejects(
    withRuntimeContext({ agents: [], port }, async () => assistant.thread({ namespace: "test", id: "a" })),
    /AGENT_NOT_REGISTERED/,
  );
});

test("cron replay delivers journaled operation once to Thread", async () => {
  const { cell, config, storage } = fixture();
  const port = createCelldPort({
    idFromName: (name) => name,
    get: () => ({ fetch: (request) => cell.fetch(request) }),
  });
  let attempts = 0;
  const scheduled = agent({
    id: "assistant",
    model: model(),
    instructions: "",
    schedules: [{ id: "daily", cron: "0 9 * * *" }],
    async onCron(_event, context) {
      await context.thread({ namespace: "test", id: "a" }).stream("briefing");
      if (attempts++ === 0) throw new Error("crash after acceptance");
    },
  });
  const schedulerStorage = new Storage();
  const scheduler = new SchedulerCell(
    { storage: schedulerStorage },
    { ...config, agents: [scheduled] },
    port,
    "revision",
  );
  const scheduledAt = "2026-09-27T09:00:00.000Z";
  const occurrence = {
    agentId: "assistant",
    scheduleId: "daily",
    scheduledAt,
    occurrenceId: JSON.stringify([1, "test", "assistant", "daily", scheduledAt]),
    revision: "revision",
  };
  await scheduler.fetch(new Request("https://test", { method: "POST", body: JSON.stringify(occurrence) }));
  await scheduler.alarm();
  await scheduler.alarm();
  assert.equal(State.parse(await storage.get("tecido.thread.v1")).runs.length, 1);
  const journal = await schedulerStorage.get<{ status: string; expiresAt: number }>("tecido.occurrence.v1");
  assert.equal(journal?.status, "completed");
  assert.equal(schedulerStorage.alarm, journal?.expiresAt);
});

test("Tool plan and result persist before next model round", async () => {
  let executions = 0;
  const languageModel = new MockLanguageModelV3({
    doStream: async ({ prompt }) => ({
      stream: prompt.some((message) => message.role === "tool")
        ? simulateReadableStream({
            chunks: [
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: "done" },
              { type: "text-end", id: "t" },
              { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
            ],
          })
        : simulateReadableStream({
            chunks: [
              { type: "tool-call", toolCallId: "provider-call", toolName: "lookup", input: '{"value":"saved"}' },
              { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
            ],
          }),
    }),
  });
  const assistant = agent({
    id: "assistant",
    model: languageModel,
    instructions: "",
    tools: {
      lookup: tool({
        description: "lookup",
        inputSchema: z.object({ value: z.string() }),
        async execute({ value }) {
          executions++;
          return value;
        },
      }),
    },
  });
  const storage = new Storage();
  const cell = new ThreadCell({ storage }, { name: "test", agents: [assistant] });
  await send(cell, { type: "accept", event: event() });
  await cell.alarm();
  const state = State.parse(await storage.get("tecido.thread.v1"));
  assert.equal(state.runs[0]?.snapshot.status, "completed");
  assert.equal(state.runs[0]?.snapshot.result?.output.text, "done");
  assert.equal(executions, 1);
  assert.deepEqual(
    state.runs[0]?.events.map((event) => event.type),
    ["tool-call", "tool-result", "text-delta", "completed"],
  );
});

test("unsafe uncertain Tool cannot retry without reconciliation", async () => {
  const { cell, storage, config } = fixture();
  const accepted = Accepted.parse((await send(cell, { type: "accept", event: event() })).body);
  const state = State.parse(await storage.get("tecido.thread.v1"));
  state.runs[0]!.snapshot.status = "tool_running";
  state.runs[0]!.calls = [
    { id: "stable-id", providerId: "provider", name: "send", input: {}, retry: "never", status: "running" },
  ];
  await storage.put("tecido.thread.v1", state);
  const restarted = new ThreadCell({ storage }, config);
  await restarted.alarm();
  assert.equal((await send(restarted, { type: "retry", runId: accepted.runId })).status, 400);
  assert.equal(
    (
      await send(restarted, {
        type: "retry",
        runId: accepted.runId,
        options: { reconcile: { toolCallId: "wrong", outcome: { status: "completed", output: "sent" } } },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await send(restarted, {
        type: "retry",
        runId: accepted.runId,
        options: { reconcile: { toolCallId: "stable-id", outcome: { status: "completed", output: "sent" } } },
      })
    ).status,
    200,
  );
});

test("cancellation before execution produces a durable terminal event", async () => {
  const { cell, storage, languageModel } = fixture();
  const accepted = Accepted.parse((await send(cell, { type: "accept", event: event() })).body);
  await send(cell, { type: "cancel", runId: accepted.runId });
  await cell.alarm();
  const run = State.parse(await storage.get("tecido.thread.v1")).runs[0]!;
  assert.equal(run.snapshot.status, "cancelled");
  assert.equal(run.events[0]?.type, "cancelled");
  assert.equal(languageModel.doStreamCalls.length, 0);
});

test("an expired alarm is rearmed rather than mistaken for a future wake", async () => {
  const { cell, storage } = fixture();
  storage.alarm = Date.now() - 1000;
  await send(cell, { type: "accept", event: event() });
  assert.ok(storage.alarm! > Date.now());
});

test("external code that ignores abort cannot keep a Tool attempt waiting forever", async () => {
  const { awaitWithSignal } = await import("../../src/adapters/celld/abort.js");
  const controller = new AbortController();
  const waiting = awaitWithSignal(() => new Promise<never>(() => {}), controller.signal);
  controller.abort(new Error("timeout"));
  await assert.rejects(waiting, /timeout/);
});
