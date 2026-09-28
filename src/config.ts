import { z } from "zod/v4";
import { type Agent, isAgent } from "./agent.js";
import { DeploymentNameSchema, NonEmptyStringSchema } from "./primitives.js";

/** Application code receives web primitives and application variables, never host bindings. */
export interface AppContext {
  readonly env: Readonly<Record<string, string | undefined>>;
}

export type RequestHandler = (request: Request, context: AppContext) => Response | Promise<Response>;

export interface RuntimeLimits {
  readonly maxContextTokens: number;
  readonly maxToolRounds: number;
  readonly runTimeoutMs: number;
  readonly modelTimeoutMs: number;
  readonly toolTimeoutMs: number;
}

export interface RetentionPolicy {
  readonly runMs: number;
  readonly streamEventMs: number;
  readonly idempotencyMs: number;
  readonly cronJournalMs: number;
}

export interface RuntimeLimitOverrides {
  readonly maxContextTokens?: number | undefined;
  readonly maxToolRounds?: number | undefined;
  readonly runTimeoutMs?: number | undefined;
  readonly modelTimeoutMs?: number | undefined;
  readonly toolTimeoutMs?: number | undefined;
}

export interface RetentionOverrides {
  readonly runMs?: number | undefined;
  readonly streamEventMs?: number | undefined;
  readonly idempotencyMs?: number | undefined;
  readonly cronJournalMs?: number | undefined;
}

export const DEFAULT_LIMITS: RuntimeLimits = {
  maxContextTokens: 32_000,
  maxToolRounds: 8,
  runTimeoutMs: 10 * 60_000,
  modelTimeoutMs: 120_000,
  toolTimeoutMs: 60_000,
};

/** Fully validated application configuration returned by `parseConfig`. */
export interface ResolvedTecidoConfig {
  readonly name: string;
  readonly agents: readonly Agent[];
  readonly vars?: Readonly<Record<string, string>>;
  readonly limits: RuntimeLimits;
  readonly retention: RetentionPolicy;
  readonly fetch?: RequestHandler;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  runMs: 30 * 24 * 60 * 60_000,
  streamEventMs: 7 * 24 * 60 * 60_000,
  idempotencyMs: 30 * 24 * 60 * 60_000,
  cronJournalMs: 30 * 24 * 60 * 60_000,
};

/** The application declaration consumed by the Tecido CLI. */
export interface TecidoConfig {
  readonly name: string;
  readonly agents: readonly Agent[];
  readonly vars?: Readonly<Record<string, string>>;
  readonly limits?: RuntimeLimitOverrides;
  readonly retention?: RetentionOverrides;
  readonly fetch?: RequestHandler;
}

const PositiveInteger = z.number().int().positive();
const LimitsSchema = z.strictObject({
  maxContextTokens: PositiveInteger.optional(),
  maxToolRounds: PositiveInteger.optional(),
  runTimeoutMs: PositiveInteger.optional(),
  modelTimeoutMs: PositiveInteger.optional(),
  toolTimeoutMs: PositiveInteger.optional(),
});
const RetentionSchema = z.strictObject({
  runMs: PositiveInteger.optional(),
  streamEventMs: PositiveInteger.optional(),
  idempotencyMs: PositiveInteger.optional(),
  cronJournalMs: PositiveInteger.optional(),
});

const ConfigSchema = z.strictObject({
  name: DeploymentNameSchema,
  agents: z.array(z.custom<Agent>(isAgent)).min(1),
  vars: z.record(NonEmptyStringSchema, z.string()).optional(),
  limits: LimitsSchema.optional(),
  retention: RetentionSchema.optional(),
  fetch: z.custom<RequestHandler>((value) => typeof value === "function").optional(),
});

function validateAgent(declaration: Agent, ids: Set<string>): void {
  if (ids.has(declaration.options.id)) throw new Error(`Duplicate Agent id: ${declaration.options.id}`);

  ids.add(declaration.options.id);
  if (declaration.options.schedules?.length && !declaration.options.onCron) {
    throw new Error(`Agent ${declaration.options.id} declares schedules without onCron.`);
  }
}

function validateAgents(agents: readonly Agent[]): void {
  const ids = new Set<string>();
  for (const declaration of agents) validateAgent(declaration, ids);
}

function validateVariables(vars: Readonly<Record<string, string>> | undefined): void {
  for (const key of Object.keys(vars ?? {})) {
    if (key.startsWith("TECIDO_")) throw new Error(`Reserved variable: ${key}`);
  }
}

function resolveLimits(limits: RuntimeLimitOverrides | undefined): RuntimeLimits {
  return { ...resolveContextLimits(limits), ...resolveTimeoutLimits(limits) };
}

function resolveContextLimits(limits: RuntimeLimitOverrides | undefined) {
  return {
    maxContextTokens: limits?.maxContextTokens ?? DEFAULT_LIMITS.maxContextTokens,
    maxToolRounds: limits?.maxToolRounds ?? DEFAULT_LIMITS.maxToolRounds,
  };
}

function resolveTimeoutLimits(limits: RuntimeLimitOverrides | undefined) {
  return {
    runTimeoutMs: limits?.runTimeoutMs ?? DEFAULT_LIMITS.runTimeoutMs,
    modelTimeoutMs: limits?.modelTimeoutMs ?? DEFAULT_LIMITS.modelTimeoutMs,
    toolTimeoutMs: limits?.toolTimeoutMs ?? DEFAULT_LIMITS.toolTimeoutMs,
  };
}

function resolveRetention(retention: RetentionOverrides | undefined): RetentionPolicy {
  return {
    runMs: retention?.runMs ?? DEFAULT_RETENTION.runMs,
    streamEventMs: retention?.streamEventMs ?? DEFAULT_RETENTION.streamEventMs,
    idempotencyMs: retention?.idempotencyMs ?? DEFAULT_RETENTION.idempotencyMs,
    cronJournalMs: retention?.cronJournalMs ?? DEFAULT_RETENTION.cronJournalMs,
  };
}

function validateRetention(retention: RetentionPolicy): void {
  if (retention.idempotencyMs > retention.runMs || retention.streamEventMs > retention.runMs)
    throw new Error("retention.idempotencyMs and retention.streamEventMs cannot exceed retention.runMs.");
}

export function parseConfig(value: unknown): ResolvedTecidoConfig {
  const config = ConfigSchema.parse(value);
  validateAgents(config.agents);
  validateVariables(config.vars);
  const limits = resolveLimits(config.limits);
  const retention = resolveRetention(config.retention);
  validateRetention(retention);

  return {
    name: config.name,
    agents: config.agents,
    ...(config.vars === undefined ? {} : { vars: config.vars }),
    limits,
    retention,
    ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
  };
}
