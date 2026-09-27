import * as R from "remeda";
import { z } from "zod/v4";
import type { AgentSchedule, CronHandler } from "./cron.js";
import type { LanguageModel } from "./model.js";
import { NonEmptyStringSchema } from "./primitives.js";
import { requireRuntime } from "./runtime-context.js";
import { createThreadClient } from "./thread-client.js";
import type { Thread, ThreadAddress } from "./thread.js";
import type { Tool } from "./tool.js";
import { tool } from "./tool.js";

/** Configuration for a statically declared Agent. */
export interface AgentOptions {
  /** Stable identifier used with the Thread address. */
  readonly id: string;
  /** AI SDK model or runtime factory used for each model round. */
  readonly model: LanguageModel | AgentModelFactory;
  /** System instructions supplied to the model. */
  readonly instructions: string;
  /** Tools available to the model, keyed by their public names. */
  readonly tools?: Readonly<Record<string, Tool<any, any>>>;
  /** Static UTC schedules dispatched by the host runtime. */
  readonly schedules?: readonly AgentSchedule[];
  /** Optional handler invoked for each delivered schedule occurrence. */
  readonly onCron?: CronHandler;
}

/** Runtime values available when an Agent resolves its model. */
export interface AgentModelContext {
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** Creates an AI SDK model from values supplied by the active runtime. */
export type AgentModelFactory = (context: AgentModelContext) => LanguageModel;

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
  const duplicates = R.pipe(
    schedules,
    R.map((schedule, index) => [index, schedule] as const),
    R.groupBy(([, schedule]) => schedule.id),
    R.values(),
    R.flatMap((sameIdSchedules) => R.drop(sameIdSchedules, 1)),
    R.sortBy(([index]) => index),
  );

  R.forEach(duplicates, ([index, schedule]) =>
    context.addIssue({
      code: "custom",
      message: `Duplicate Agent schedule id: ${schedule.id}`,
      path: [index, "id"],
    }),
  );
});

const AgentOptionsSchema = z.object({
  id: NonEmptyStringSchema,
  model: z.custom<LanguageModel | AgentModelFactory>((value) => typeof value === "function" || isObject(value), {
    message: "Agent model must be an AI SDK LanguageModel object or factory.",
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

const declarations = new WeakSet<object>();

/**
 * Declares an Agent using an AI SDK language model and Tecido tools.
 * @param options Agent configuration.
 */
export function agent(options: AgentOptions): Agent {
  const agentOptions = parseAgentOptions(options);
  const declaration: Agent = {
    options: agentOptions,
    thread(address: ThreadAddress): Thread {
      const parsed = parseThreadAddress(address);
      return createThreadClient(requireRuntime(declaration), {
        namespace: parsed.namespace,
        agentId: agentOptions.id,
        threadId: parsed.id,
      });
    },
  };
  declarations.add(declaration);
  return declaration;
}

export function isAgent(value: unknown): value is Agent {
  return typeof value === "object" && value !== null && declarations.has(value);
}

function parseAgentOptions(options: unknown): AgentOptions {
  const parsed = AgentOptionsSchema.parse(options);
  const tools =
    parsed.tools === undefined
      ? undefined
      : R.mapValues(parsed.tools, (declaration) => tool(declaration as Tool<any, any>));
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
