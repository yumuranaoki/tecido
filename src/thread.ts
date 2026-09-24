import type {
  RetryOptions,
  RunOptions,
  RunResult,
  RunSnapshot,
  RunStream,
  StreamEvent,
} from "./run.js";

/** Application-visible address of a durable Thread within one Agent. */
export interface ThreadAddress {
  /** Tenant or application boundary chosen by the host application. */
  readonly namespace: string;
  /** Opaque identifier for the Thread within the namespace. */
  readonly id: string;
}

/** Durable conversation and Run interface for one Agent address. */
export interface Thread {
  /**
   * Accepts an input and waits for its Run to complete.
   * @param input User or scheduled input text.
   * @param options Optional transaction identifier used to deduplicate a request.
   * @returns The committed assistant result.
   */
  run(input: string, options?: RunOptions): Promise<RunResult>;

  /**
   * Accepts an input and returns a stream handle for its durable Run events.
   * @param input User or scheduled input text.
   * @param options Optional transaction identifier used to deduplicate a request.
   * @returns A handle that can be iterated or resumed through `subscribe`.
   */
  stream(input: string, options?: RunOptions): Promise<RunStream>;

  /**
   * Reads the durable status and result of an existing Run.
   * @param runId Identifier of the Run to read.
   * @returns The latest durable snapshot.
   */
  getRun(runId: string): Promise<RunSnapshot>;

  /**
   * Subscribes to committed events after an exclusive sequence cursor.
   * @param runId Identifier of the Run to observe.
   * @param options Optional exclusive cursor from which to resume.
   * @returns An async stream of durable Run events.
   */
  subscribe(
    runId: string,
    options?: { readonly afterSeq?: number },
  ): AsyncIterable<StreamEvent>;

  /**
   * Explicitly retries a failed Run as a new attempt.
   * @param runId Identifier of the Run to retry.
   * @param options Optional reconciliation for an uncertain tool side effect.
   * @returns The committed result of the successful attempt.
   */
  retry(runId: string, options?: RetryOptions): Promise<RunResult>;

  /**
   * Requests durable cancellation of a non-terminal Run.
   * @param runId Identifier of the Run to cancel.
   */
  cancel(runId: string): Promise<void>;
}
