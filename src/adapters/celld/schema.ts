import { modelMessageSchema } from "ai";
import { z } from "zod/v4";
import { NonEmptyStringSchema as ID } from "../../primitives.js";

export const Address = z.object({ namespace: ID, agentId: ID, threadId: ID });

export const Event = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message"),
    eventId: ID,
    input: z.string(),
    receivedAt: z.iso.datetime(),
    transactionId: ID.optional(),
  }),
  z.object({
    type: z.literal("cron"),
    eventId: ID,
    input: z.string(),
    scheduleId: ID,
    occurrenceId: ID,
    scheduledAt: z.iso.datetime(),
  }),
]);

export const ErrorData = z.object({ code: ID, message: z.string(), retryable: z.boolean() });

export const Status = z.enum([
  "accepted",
  "model_running",
  "tool_pending",
  "tool_running",
  "tool_completed",
  "completed",
  "failed",
  "cancelled",
]);

export const Result = z.object({ runId: ID, output: z.object({ text: z.string() }) });

export const Snapshot = z
  .object({
    runId: ID,
    status: Status,
    attempt: z.number().int().positive(),
    acceptedAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    result: Result.optional(),
    error: ErrorData.optional(),
  })
  .transform(({ result, error, ...snapshot }) => ({
    ...snapshot,
    ...(result === undefined ? {} : { result }),
    ...(error === undefined ? {} : { error }),
  }));

const sequence = { seq: z.number().int().positive(), attempt: z.number().int().positive() };

export const Stream = z.discriminatedUnion("type", [
  z.object({ ...sequence, type: z.literal("text-delta"), delta: z.string() }),
  z.object({ ...sequence, type: z.literal("tool-call"), toolCallId: ID, name: ID, input: z.json() }),
  z.object({ ...sequence, type: z.literal("tool-result"), toolCallId: ID, output: z.json() }),
  z.object({ ...sequence, type: z.literal("completed") }),
  z.object({ ...sequence, type: z.literal("failed"), error: ErrorData }),
  z.object({ ...sequence, type: z.literal("cancelled") }),
]);

export const Accepted = z.object({
  runId: ID,
  queueSeq: z.number().int().positive(),
  status: Status,
  duplicate: z.boolean(),
  attempt: z.number().int().positive(),
  afterSeq: z.number().int().nonnegative(),
});

const Call = z.object({
  id: ID,
  providerId: ID,
  name: ID,
  input: z.json(),
  retry: z.enum(["safe", "never"]),
  status: z.enum(["pending", "running", "completed"]),
  output: z.json().optional(),
});

export const Run = z.object({
  snapshot: Snapshot,
  event: Event,
  queueSeq: z.number().int().positive(),
  dispatchSeq: z.number().int().positive(),
  afterSeq: z.number().int().nonnegative(),
  events: z.array(Stream),
  attempts: z.array(Snapshot),
  context: z.array(modelMessageSchema).optional(),
  contextStart: z.number().int().nonnegative().optional(),
  round: z.number().int().nonnegative(),
  calls: z.array(Call),
  text: z.string(),
  cancelled: z.boolean(),
});

export const State = z.object({
  version: z.literal(1),
  address: Address,
  nextQueue: z.number().int().positive(),
  nextDispatch: z.number().int().positive(),
  messages: z.array(modelMessageSchema),
  runs: z.array(Run),
});

export type StoredRun = z.infer<typeof Run>;

export type StoredState = z.infer<typeof State>;

export const Retry = z.object({
  reconcile: z
    .object({ toolCallId: ID, outcome: z.object({ status: z.literal("completed"), output: z.json() }) })
    .optional(),
});

export const Command = z.discriminatedUnion("type", [
  z.object({ type: z.literal("accept"), address: Address, event: Event }),
  z.object({ type: z.literal("read"), address: Address, runId: ID, attempt: z.number().int().positive().optional() }),
  z.object({ type: z.literal("events"), address: Address, runId: ID, afterSeq: z.number().int().nonnegative() }),
  z.object({ type: z.literal("retry"), address: Address, runId: ID, options: Retry.optional() }),
  z.object({ type: z.literal("cancel"), address: Address, runId: ID }),
]);
