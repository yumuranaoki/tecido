import type { RunId, RunStatus } from "./run.js";
import type { ThreadId, ThreadNamespace } from "./thread.js";

/** Internal canonical address used by the runtime host. */
export interface RuntimeThreadAddress {
  readonly namespace: ThreadNamespace;
  readonly agentId: string;
  readonly threadId: ThreadId;
}

/** Normalized durable event accepted by a Thread runtime. */
export type ThreadEvent =
  | {
      readonly eventId: string;
      readonly type: "message";
      readonly input: string;
      readonly receivedAt: string;
      readonly transactionId?: string;
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
  readonly runId: RunId;
  readonly queueSeq: number;
  readonly status: RunStatus;
  readonly duplicate: boolean;
  readonly attempt: number;
  readonly afterSeq: number;
}
