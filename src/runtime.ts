import type { RunId, RunSnapshot, RetryOptions, StreamEvent } from "./run.js";
import type { AcceptedRun, RuntimeThreadAddress, ThreadEvent } from "./runtime-events.js";

/** Internal boundary implemented by a durable runtime host. */
export interface RuntimePort {
  /**
   * Durably accepts an event and assigns its FIFO queue position.
   * @param address Canonical Thread address.
   * @param event Normalized message or cron event.
   * @returns Accepted Run identity and queue metadata.
   */
  accept(
    address: RuntimeThreadAddress,
    event: ThreadEvent,
  ): Promise<AcceptedRun>;

  /**
   * Executes the next accepted item for a Thread, if one is ready.
   * @param address Canonical Thread address.
   */
  executeNext(address: RuntimeThreadAddress): Promise<void>;

  /**
   * Reads one durable Run snapshot.
   * @param address Canonical Thread address.
   * @param runId Identifier of the Run to read.
   * @returns The latest Run snapshot.
   */
  readRun(
    address: RuntimeThreadAddress,
    runId: RunId,
  ): Promise<RunSnapshot>;

  /**
   * Reads committed stream events after an exclusive sequence cursor.
   * @param address Canonical Thread address.
   * @param runId Identifier of the Run to observe.
   * @param afterSeq Exclusive sequence cursor.
   * @returns An async stream of durable events.
   */
  subscribe(
    address: RuntimeThreadAddress,
    runId: RunId,
    afterSeq: number,
  ): AsyncIterable<StreamEvent>;

  /**
   * Enqueues an explicit retry attempt for a failed Run.
   * @param address Canonical Thread address.
   * @param runId Identifier of the Run to retry.
   * @param options Optional reconciliation for an uncertain Tool result.
   * @returns The updated durable Run snapshot.
   */
  retry(
    address: RuntimeThreadAddress,
    runId: RunId,
    options?: RetryOptions,
  ): Promise<RunSnapshot>;

  /**
   * Requests durable cancellation of a Run.
   * @param address Canonical Thread address.
   * @param runId Identifier of the Run to cancel.
   */
  cancel(address: RuntimeThreadAddress, runId: RunId): Promise<void>;
}
