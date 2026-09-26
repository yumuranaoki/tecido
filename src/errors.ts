import type { RunId } from "./run.js";

/** Normalized, provider-independent error information exposed by a Run. */
export interface AgentError {
  /** Stable Tecido error code. */
  readonly code: string;
  /** Sanitized human-readable description of the failure. */
  readonly message: string;
  /** Whether an explicit retry may be appropriate. */
  readonly retryable: boolean;
  /** Optional structured, sanitized diagnostic data. */
  readonly details?: unknown;
}

/** Error rejected by `Thread.run()` or `Thread.retry()` after a Run terminates. */
export class AgentRunError extends Error {
  /** Identifier of the failed or cancelled Run. */
  readonly runId: RunId;
  /** Attempt number that reached the terminal state. */
  readonly attempt: number;
  /** Terminal Run status represented by this error. */
  readonly status: "failed" | "cancelled";
  /** Normalized failure details. */
  readonly error: AgentError;

  constructor(
    runId: RunId,
    attempt: number,
    status: "failed" | "cancelled",
    error: AgentError,
  ) {
    super(error.message);
    this.name = "AgentRunError";
    this.runId = runId;
    this.attempt = attempt;
    this.status = status;
    this.error = error;
  }
}
