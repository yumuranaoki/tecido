import { z } from "zod/v4";
import { type Agent, isAgent } from "./agent.js";
import { DeploymentNameSchema, NonEmptyStringSchema } from "./primitives.js";

/** Application code receives web primitives and application variables, never host bindings. */
export interface AppContext {
  readonly env: Readonly<Record<string, string | undefined>>;
}

export type RequestHandler = (request: Request, context: AppContext) => Response | Promise<Response>;

/** The application declaration consumed by the Tecido CLI. */
export interface TecidoConfig {
  readonly name: string;
  readonly agents: readonly Agent[];
  readonly vars?: Readonly<Record<string, string>>;
  readonly fetch?: RequestHandler;
}

const ConfigSchema = z.strictObject({
  name: DeploymentNameSchema,
  agents: z.array(z.custom<Agent>(isAgent)).min(1),
  vars: z.record(NonEmptyStringSchema, z.string()).optional(),
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

export function parseConfig(value: unknown): TecidoConfig {
  const config = ConfigSchema.parse(value);
  validateAgents(config.agents);
  validateVariables(config.vars);

  return {
    name: config.name,
    agents: config.agents,
    ...(config.vars === undefined ? {} : { vars: config.vars }),
    ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
  };
}
