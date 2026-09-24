import type { RunStatus } from "../run.js";

/** Internal canonical address used by the runtime host. */
export interface RuntimeThreadAddress {
  readonly namespace: string;
  readonly agentId: string;
  readonly threadId: string;
}

/** Normalized durable event accepted by a Thread runtime. */
export type ThreadEvent =
  | {
      readonly eventId: string;
      readonly type: "message";
      readonly input: string;
      readonly receivedAt: string;
    }
  | {
      readonly eventId: string;
      readonly type: "cron";
      readonly scheduleId: string;
      readonly occurrenceId: string;
      readonly input: string;
      readonly scheduledAt: string;
    };

/** Durable acceptance result produced by a runtime host. */
export interface AcceptedRun {
  readonly runId: string;
  readonly queueSeq: number;
  readonly status: RunStatus;
  readonly duplicate: boolean;
}
