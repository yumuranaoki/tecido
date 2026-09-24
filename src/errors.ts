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
export declare class AgentRunError extends Error {
  /** Identifier of the failed or cancelled Run. */
  readonly runId: string;
  /** Attempt number that reached the terminal state. */
  readonly attempt: number;
  /** Terminal status represented by this error. */
  readonly status: "failed" | "cancelled";
  /** Normalized failure details. */
  readonly error: AgentError;

  /**
   * Creates the typed error view of a terminal Run.
   * @param runId Identifier of the Run.
   * @param attempt Attempt number that terminated.
   * @param status Terminal Run status.
   * @param error Normalized failure details.
   */
  constructor(
    runId: string,
    attempt: number,
    status: "failed" | "cancelled",
    error: AgentError,
  );
}
