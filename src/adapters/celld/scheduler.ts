import { z } from "zod/v4";
import { type ResolvedTecidoConfig, type TecidoConfig, parseConfig } from "../../config.js";
import { withRuntimeContext } from "../../runtime-context.js";
import type { RuntimePort } from "../../runtime.js";
import { createThreadClient } from "../../thread-client.js";
import type { CellState } from "./contracts.js";
import { Address, Event } from "./schema.js";

const Occurrence = z.object({
  agentId: z.string().min(1),
  scheduleId: z.string().min(1),
  occurrenceId: z.string().min(1),
  scheduledAt: z.iso.datetime(),
  revision: z.string().min(1),
});

const Journal = z.object({
  version: z.literal(1),
  occurrence: Occurrence,
  status: z.enum(["accepted", "running", "completed", "failed"]),
  attempt: z.number().int().nonnegative(),
  operations: z.array(z.object({ address: Address, event: Event })),
  error: z.string().optional(),
  expiresAt: z.number().int().positive().optional(),
});

const KEY = "tecido.occurrence.v1";

/** Each occurrence has its own Cell, so awaiting a Thread cannot block another hook. */
export class SchedulerCell {
  private draining = false;

  private readonly config: ResolvedTecidoConfig;

  constructor(
    private readonly cell: CellState,
    config: TecidoConfig,
    private readonly port: RuntimePort,
    private readonly revision: string,
    private readonly env: Readonly<Record<string, string | undefined>> = {},
  ) {
    this.config = parseConfig(config);
  }

  async fetch(request: Request): Promise<Response> {
    const occurrence = Occurrence.safeParse(await request.json().catch(() => null));
    if (!occurrence.success) return Response.json({ error: "INVALID_OCCURRENCE" }, { status: 400 });

    const expected = JSON.stringify([
      1,
      this.config.name,
      occurrence.data.agentId,
      occurrence.data.scheduleId,
      occurrence.data.scheduledAt,
    ]);
    if (expected !== occurrence.data.occurrenceId || occurrence.data.revision !== this.revision)
      return Response.json({ error: "OCCURRENCE_CONFLICT" }, { status: 409 });

    const declaration = this.config.agents.find((agent) => agent.options.id === occurrence.data.agentId);
    if (!declaration?.options.schedules?.some((schedule) => schedule.id === occurrence.data.scheduleId))
      return Response.json({ error: "SCHEDULE_NOT_FOUND" }, { status: 400 });

    await this.cell.storage.transaction(async (tx) => {
      const prior = await tx.get<unknown>(KEY);
      if (prior !== undefined) {
        Journal.parse(prior);
        return;
      }
      await tx.put(KEY, { version: 1, occurrence: occurrence.data, status: "accepted", attempt: 0, operations: [] });
      await tx.setAlarm(Date.now() + 1);
    });
    return Response.json({ accepted: true });
  }

  async alarm(): Promise<void> {
    if (this.draining) return;

    this.draining = true;

    try {
      await this.drain();
    } finally {
      this.draining = false;
    }
  }

  private async drain(): Promise<void> {
    const journal = await this.cell.storage.transaction(async (tx) => {
      const value = Journal.parse(await tx.get<unknown>(KEY));
      if (value.status === "completed" || value.status === "failed") {
        if (value.expiresAt !== undefined && value.expiresAt <= Date.now()) {
          if (!tx.delete) throw new Error("STORAGE_DELETE_UNSUPPORTED");
          await tx.delete(KEY);
        } else if (value.expiresAt !== undefined) await tx.setAlarm(value.expiresAt);
        return undefined;
      }

      if (value.occurrence.revision !== this.revision || value.attempt >= 3) {
        const expiresAt = Date.now() + this.config.retention.cronJournalMs;
        await tx.put(KEY, {
          ...value,
          status: "failed",
          error: value.attempt >= 3 ? "HOOK_RETRY_LIMIT" : "REVISION_MISMATCH",
          expiresAt,
        });
        await tx.setAlarm(expiresAt);
        return undefined;
      }
      const next = { ...value, status: "running" as const, attempt: value.attempt + 1 };
      await tx.put(KEY, next);
      await tx.setAlarm(Date.now() + 5000);
      return next;
    });
    if (!journal) return;

    const occurrence = journal.occurrence;
    const scopedPort: RuntimePort = {
      ...this.port,
      accept: async (address, message) => {
        if (message.type !== "message") throw new Error("INVALID_HOOK_OPERATION");
        const event = {
          type: "cron" as const,
          eventId: JSON.stringify([
            occurrence.occurrenceId,
            address.namespace,
            address.agentId,
            address.threadId,
            message.transactionId === undefined ? ["default"] : ["key", message.transactionId],
          ]),
          input: message.input,
          scheduleId: occurrence.scheduleId,
          occurrenceId: occurrence.occurrenceId,
          scheduledAt: occurrence.scheduledAt,
        };
        await this.cell.storage.transaction(async (tx) => {
          const state = Journal.parse(await tx.get<unknown>(KEY));
          const prior = state.operations.find((operation) => operation.event.eventId === event.eventId);
          if (prior && JSON.stringify(prior.event) !== JSON.stringify(event)) throw new Error("IDEMPOTENCY_CONFLICT");
          if (!prior) await tx.put(KEY, { ...state, operations: [...state.operations, { address, event }] });
        });
        return this.port.accept(address, event);
      },
    };

    try {
      // Send journaled operations even if replayed hook code branches differently.
      for (const operation of journal.operations) {
        if (operation.event.type !== "cron") throw new Error("INVALID_HOOK_OPERATION");
        await this.port.accept(operation.address, operation.event);
      }
      const agent = this.config.agents.find((item) => item.options.id === occurrence.agentId);
      if (!agent?.options.onCron) throw new Error("SCHEDULE_NOT_FOUND");
      await withRuntimeContext({ agents: this.config.agents, port: scopedPort, env: this.env }, () =>
        agent.options.onCron!(
          {
            scheduleId: occurrence.scheduleId,
            occurrenceId: occurrence.occurrenceId,
            scheduledAt: occurrence.scheduledAt,
          },
          {
            thread: (address) =>
              createThreadClient(scopedPort, {
                namespace: address.namespace,
                agentId: occurrence.agentId,
                threadId: address.id,
              }),
          },
        ),
      );
      await this.cell.storage.transaction(async (tx) => {
        const state = Journal.parse(await tx.get<unknown>(KEY));
        const expiresAt = Date.now() + this.config.retention.cronJournalMs;
        await tx.put(KEY, { ...state, status: "completed", expiresAt });
        await tx.setAlarm(expiresAt);
      });
    } catch (failure) {
      await this.cell.storage.transaction(async (tx) => {
        const state = Journal.parse(await tx.get<unknown>(KEY));
        const permanent = failure instanceof Error && failure.message === "IDEMPOTENCY_CONFLICT";
        const terminal = permanent || state.attempt >= 3;
        const expiresAt = terminal ? Date.now() + this.config.retention.cronJournalMs : undefined;
        await tx.put(KEY, {
          ...state,
          status: terminal ? "failed" : "accepted",
          error: permanent ? "IDEMPOTENCY_CONFLICT" : "HOOK_FAILED",
          ...(expiresAt === undefined ? {} : { expiresAt }),
        });
        if (expiresAt !== undefined) await tx.setAlarm(expiresAt);
        else await tx.setAlarm(Date.now() + 1000 * 2 ** state.attempt);
      });
    }
  }
}
