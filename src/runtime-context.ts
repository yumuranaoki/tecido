import { AsyncLocalStorage } from "node:async_hooks";
import type { Agent } from "./agent.js";
import type { RuntimePort } from "./runtime.js";

/** Installed only by the runtime host; never shared through a mutable global binding. */
export interface RuntimeContext {
  readonly agents: readonly Agent[];
  readonly port: RuntimePort;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

const contexts = new AsyncLocalStorage<RuntimeContext>();

export function withRuntimeContext<Value>(context: RuntimeContext, operation: () => Value): Value {
  return contexts.run(context, operation);
}

export function requireRuntime(agent: Agent): RuntimePort {
  const context = contexts.getStore();
  if (context === undefined) throw new Error("RUNTIME_NOT_BOUND: use the Tecido runtime to access a Thread.");

  if (!context.agents.includes(agent))
    throw new Error("AGENT_NOT_REGISTERED: the Agent is not registered in this app.");

  return context.port;
}

export function runtimeEnv(): Readonly<Record<string, string | undefined>> {
  return contexts.getStore()?.env ?? {};
}
