import type { Thread, ThreadAddress } from "./thread.js";

/** One static UTC cron schedule declared by an Agent. */
export interface AgentSchedule {
  /** Stable identifier for this schedule within the Agent. */
  readonly id: string;
  /** Cron expression interpreted in UTC by the host runtime. */
  readonly cron: string;
}

/** The stable identity and scheduled time of one cron occurrence. */
export interface CronEvent {
  /** Identifier of the Agent schedule that produced this occurrence. */
  readonly scheduleId: string;
  /** Deterministic identifier used to deduplicate delivery of this occurrence. */
  readonly occurrenceId: string;
  /** ISO-8601 timestamp for the scheduled occurrence. */
  readonly scheduledAt: string;
}

/** Read-only helpers available to an Agent's cron handler. */
export interface CronContext {
  /**
   * Returns a durable Thread belonging to the Agent whose schedule fired.
   * @param address Address of the target Thread.
   */
  thread(address: ThreadAddress): Thread;
}

/**
 * Handler invoked when the host delivers a scheduled occurrence.
 * @param event Stable schedule occurrence metadata.
 * @param context Thread access scoped to the scheduled Agent.
 */
export type CronHandler = (
  event: CronEvent,
  context: CronContext,
) => Promise<void>;
