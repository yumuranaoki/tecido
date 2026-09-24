import type { AgentSchedule, CronHandler } from "./cron.js";
import type { LanguageModel } from "./model.js";
import type { Thread, ThreadAddress } from "./thread.js";
import type { Tool } from "./tool.js";

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

/** A code-defined Agent that can open durable, addressable Threads. */
export interface Agent {
  /** Stable identifier declared in `AgentOptions`. */
  readonly id: string;

  /**
   * Returns the durable Thread identified by this Agent and the supplied address.
   * @param address Application-scoped namespace and thread identifier.
   */
  thread(address: ThreadAddress): Thread;
}

/**
 * Declares an Agent using an AI SDK language model and Tecido tools.
 * @param options Immutable Agent configuration.
 */
export declare function agent(options: AgentOptions): Agent;
