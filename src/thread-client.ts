import { z } from "zod/v4";
import { AgentRunError } from "./errors.js";
import { NonEmptyStringSchema } from "./primitives.js";
import type { RunOptions, RunResult, RunStream } from "./run.js";
import type { AcceptedRun, RuntimeThreadAddress } from "./runtime-events.js";
import type { RuntimePort } from "./runtime.js";
import type { Thread } from "./thread.js";

export function createThreadClient(port: RuntimePort, address: RuntimeThreadAddress): Thread {
  const accept = (input: string, options?: RunOptions): Promise<AcceptedRun> =>
    port.accept(address, {
      type: "message",
      eventId: crypto.randomUUID(),
      input: z.string().parse(input),
      receivedAt: new Date().toISOString(),
      ...(options?.transactionId === undefined
        ? {}
        : {
            transactionId: NonEmptyStringSchema.parse(options.transactionId),
          }),
    });

  const handle = (accepted: AcceptedRun): RunStream => ({
    runId: accepted.runId,
    [Symbol.asyncIterator]: () => port.subscribe(address, accepted.runId, accepted.afterSeq)[Symbol.asyncIterator](),
  });

  const wait = async (accepted: AcceptedRun): Promise<RunResult> => {
    for await (const event of handle(accepted)) {
      if (event.attempt !== accepted.attempt) continue;

      if (event.type === "failed" || event.type === "cancelled") {
        throw new AgentRunError(
          accepted.runId,
          event.attempt,
          event.type,
          event.type === "failed"
            ? event.error
            : {
                code: "RUN_CANCELLED",
                message: "Run was cancelled.",
                retryable: false,
              },
        );
      }

      if (event.type === "completed") {
        const snapshot = await port.readAttempt(address, accepted.runId, accepted.attempt);
        if (snapshot.result !== undefined) return snapshot.result;

        throw new Error("RUN_RESULT_MISSING: completed attempt has no result.");
      }
    }

    throw new Error("RUN_STREAM_INCOMPLETE: no terminal event for accepted attempt.");
  };

  return {
    run: async (input, options) => wait(await accept(input, options)),
    stream: async (input, options) => handle(await accept(input, options)),
    getRun: (runId) => port.readRun(address, NonEmptyStringSchema.parse(runId)),
    subscribe: (runId, options) =>
      port.subscribe(
        address,
        NonEmptyStringSchema.parse(runId),
        z
          .number()
          .int()
          .nonnegative()
          .parse(options?.afterSeq ?? 0),
      ),
    retry: async (runId, options) => wait(await port.retry(address, NonEmptyStringSchema.parse(runId), options)),
    cancel: (runId) => port.cancel(address, NonEmptyStringSchema.parse(runId)),
  };
}
