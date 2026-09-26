import { mapValues } from "remeda";
import { z } from "zod/v4";
import type { AgentSchedule, CronHandler } from "./cron.js";
import type { LanguageModel } from "./model.js";
import { NonEmptyStringSchema } from "./primitives.js";
import { createThread } from "./thread-runtime.js";
import type { Thread, ThreadAddress, ThreadId, ThreadNamespace } from "./thread.js";
import type { Tool } from "./tool.js";
import { tool } from "./tool.js";

/** Configuration for a statically declared Agent. */
export interface AgentOptions {
  /** Stable identifier used with the Thread address. */
  readonly id: string;
  /** AI SDK model used for each model round. */
  readonly model: LanguageModel;
  /** System instructions supplied to the model. */
  readonly instructions: string;
  /** Tools available to the model, keyed by their public names. */
  readonly tools?: Readonly<Record<string, Tool<any, any>>>;
  /** Static UTC schedules dispatched by the host runtime. */
  readonly schedules?: readonly AgentSchedule[];
  /** Optional handler invoked for each delivered schedule occurrence. */
  readonly onCron?: CronHandler;
}

/** A code-defined Agent declaration. */
export interface Agent {
  /** Configuration supplied when the Agent was declared. */
  readonly options: AgentOptions;

  /** Returns the Thread identified by this Agent and the supplied address. */
  thread(address: ThreadAddress): Thread;
}

const AgentScheduleSchema = z.object({
  id: NonEmptyStringSchema,
  cron: NonEmptyStringSchema,
});

const AgentSchedulesSchema = z.array(AgentScheduleSchema).superRefine((schedules, context) => {
  const seenIds = new Set<string>();
  schedules.forEach((schedule, index) => {
    if (seenIds.has(schedule.id)) {
      context.addIssue({
        code: "custom",
        message: `Duplicate Agent schedule id: ${schedule.id}`,
        path: [index, "id"],
      });
    }
    seenIds.add(schedule.id);
  });
});

const AgentOptionsSchema = z.object({
  id: NonEmptyStringSchema,
  model: z.custom<LanguageModel>(isObject, {
    message: "Agent model must be an AI SDK LanguageModel object.",
  }),
  instructions: z.string(),
  tools: z.record(NonEmptyStringSchema, z.unknown()).optional(),
  schedules: AgentSchedulesSchema.optional(),
  onCron: z
    .custom<CronHandler>((value) => typeof value === "function", {
      message: "Agent onCron must be a function.",
    })
    .optional(),
});

const ThreadAddressSchema = z.object({
  namespace: NonEmptyStringSchema,
  id: NonEmptyStringSchema,
});

/**
 * Declares an Agent using an AI SDK language model and Tecido tools.
 * @param options Agent configuration.
 */
export function agent(options: AgentOptions): Agent {
  const agentOptions = parseAgentOptions(options);
  // The outer map is keyed by namespace; each inner map is keyed by ThreadAddress.id.
  const threadsByNamespace = new Map<ThreadNamespace, Map<ThreadId, Thread>>();

  return {
    options: agentOptions,
    thread(address: ThreadAddress): Thread {
      const parsedAddress = parseThreadAddress(address);
      const threadsInNamespace = threadsByNamespace.get(parsedAddress.namespace);
      const existing = threadsInNamespace?.get(parsedAddress.id);
      if (existing !== undefined) return existing;

      const thread = createThread(agentOptions);
      if (threadsInNamespace === undefined) {
        threadsByNamespace.set(parsedAddress.namespace, new Map([[parsedAddress.id, thread]]));
      } else {
        threadsInNamespace.set(parsedAddress.id, thread);
      }
      return thread;
    },
  };
}

function parseAgentOptions(options: unknown): AgentOptions {
  const parsed = AgentOptionsSchema.parse(options);
  const tools =
    parsed.tools === undefined
      ? undefined
      : mapValues(parsed.tools, (declaration) => tool(declaration as Tool<any, any>));
  const schedules = parsed.schedules === undefined ? undefined : parsed.schedules;

  return {
    id: parsed.id,
    model: parsed.model,
    instructions: parsed.instructions,
    ...(tools === undefined ? {} : { tools }),
    ...(schedules === undefined ? {} : { schedules }),
    ...(parsed.onCron === undefined ? {} : { onCron: parsed.onCron }),
  };
}

function parseThreadAddress(address: unknown): ThreadAddress {
  return ThreadAddressSchema.parse(address);
}

function isObject(value: unknown): value is object {
  return value !== null && typeof value === "object";
}
