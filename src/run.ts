import type { AgentError } from "./errors.js";
import type { ModelUsage } from "./model.js";

/** Durable lifecycle status of a Run. */
export type RunStatus =
  | "accepted"
  | "model_running"
  | "tool_pending"
  | "tool_running"
  | "tool_completed"
  | "completed"
  | "failed"
  | "cancelled";

/** Final assistant content committed when a Run completes. */
export interface AgentOutput {
  /** Concatenated assistant text produced by the Run. */
  readonly text: string;
}

/** Options shared by calls that accept a new input event. */
export interface RunOptions {
  /** Optional caller-provided transaction identifier for deduplicating the same request. */
  readonly transactionId?: string;
}

/** Successful result returned by `Thread.run()` or `Thread.retry()`. */
export interface RunResult {
  /** Durable identifier of the Run. */
  readonly runId: string;
  /** Committed final assistant output. */
  readonly output: AgentOutput;
  /** Aggregate usage reported by the AI SDK model responses. */
  readonly usage?: ModelUsage;
}

/** Point-in-time durable summary of a Run. */
export interface RunSnapshot {
  /** Durable identifier of the Run. */
  readonly runId: string;
  /** Current or terminal lifecycle status. */
  readonly status: RunStatus;
  /** Most recently accepted attempt number. */
  readonly attempt: number;
  /** ISO-8601 timestamp when the Run was accepted. */
  readonly acceptedAt: string;
  /** ISO-8601 timestamp when the snapshot was last updated. */
  readonly updatedAt: string;
  /** Normalized terminal error, when the latest attempt failed. */
  readonly error?: AgentError;
  /** Successful result, when the Run completed. */
  readonly result?: RunResult;
}

/** Application-supplied outcome for reconciling an uncertain tool side effect. */
export interface ToolResolution {
  /** Stable Tecido identifier of the tool call being reconciled. */
  readonly toolCallId: string;
  /** Confirmed result to persist without executing the tool again. */
  readonly outcome: {
    readonly status: "completed";
    readonly output: unknown;
  };
}

/** Options controlling an explicit retry of a failed Run. */
export interface RetryOptions {
  /** Optional confirmed outcome for an uncertain tool call. */
  readonly reconcile?: ToolResolution;
}

/**
 * Durable, resumable event emitted during a Run.
 * Sequence numbers increase across attempts of the same Run.
 */
export type StreamEvent =
  | {
      readonly seq: number;
      readonly attempt: number;
      readonly type: "text-delta";
      readonly delta: string;
    }
  | {
      readonly seq: number;
      readonly attempt: number;
      readonly type: "tool-call";
      readonly toolCallId: string;
      readonly name: string;
      readonly input: unknown;
    }
  | {
      readonly seq: number;
      readonly attempt: number;
      readonly type: "tool-result";
      readonly toolCallId: string;
      readonly output: unknown;
    }
  | {
      readonly seq: number;
      readonly attempt: number;
      readonly type: "completed";
      readonly usage?: ModelUsage;
    }
  | {
      readonly seq: number;
      readonly attempt: number;
      readonly type: "failed";
      readonly error: AgentError;
    }
  | {
      readonly seq: number;
      readonly attempt: number;
      readonly type: "cancelled";
    };

/** Async stream handle returned after a Run has been accepted. */
export interface RunStream extends AsyncIterable<StreamEvent> {
  /** Identifier of the Run whose events this stream yields. */
  readonly runId: string;
}
