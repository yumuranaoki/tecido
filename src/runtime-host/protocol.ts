import { z } from "zod/v4";
import type { ModelUsage } from "../model.js";
import { NonEmptyStringSchema as ID } from "../primitives.js";

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

const ModelUsageData = z.json().transform((value) => value as unknown as ModelUsage);

export const Result = z.object({ runId: ID, output: z.object({ text: z.string() }), usage: ModelUsageData.optional() });

export const Snapshot = z
  .object({
    runId: ID,
    status: Status,
    attempt: z.number().int().positive(),
    acceptedAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    result: Result.optional(),
    error: ErrorData.optional(),
    usage: ModelUsageData.optional(),
    deploymentRevision: ID.optional(),
    startedAt: z.iso.datetime().optional(),
    finishedAt: z.iso.datetime().optional(),
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
  z.object({ ...sequence, type: z.literal("completed"), usage: z.custom<ModelUsage>().optional() }),
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
