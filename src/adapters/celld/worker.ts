import { z } from "zod/v4";
import { parseConfig } from "../../config.js";
import { createManifest } from "../../manifest.js";
import { withRuntimeContext } from "../../runtime-context.js";
import type { CellState, HostEnv } from "./contracts.js";
import { createCelldPort } from "./port.js";
import { SchedulerCell } from "./scheduler.js";
import { ThreadCell } from "./thread-cell.js";

export function createWorker(rawConfig: unknown, expectedManifest: string, revision: string) {
  const config = parseConfig(rawConfig);
  if (JSON.stringify(createManifest(config)) !== expectedManifest) throw new Error("STATIC_CONFIG_MISMATCH");

  const context = (env: HostEnv) => ({
    env: Object.fromEntries(
      Object.entries(env).filter(([name, value]) => !name.startsWith("TECIDO_") && typeof value === "string"),
    ) as Readonly<Record<string, string>>,
  });
  const runtimeContext = (env: HostEnv) => ({
    agents: config.agents,
    port: createCelldPort(env.TECIDO_THREADS),
    env: context(env).env,
  });

  return {
    ThreadCell: class extends ThreadCell {
      constructor(
        state: CellState,
        private readonly env: HostEnv,
      ) {
        super(state, config);
      }
      override alarm(): Promise<void> {
        return withRuntimeContext(runtimeContext(this.env), () => super.alarm());
      }
    },
    SchedulerCell: class extends SchedulerCell {
      constructor(state: CellState, env: HostEnv) {
        super(state, config, createCelldPort(env.TECIDO_THREADS), revision, context(env).env);
      }
    },
    handler: {
      async fetch(request: Request, env: HostEnv): Promise<Response> {
        if (!config.fetch) return Response.json({ error: "NO_REQUEST_HANDLER" }, { status: 404 });

        return withRuntimeContext(runtimeContext(env), () => config.fetch!(request, context(env)));
      },
      async scheduled(controller: unknown, env: HostEnv): Promise<void> {
        const event = z.object({ cron: z.string(), scheduledTime: z.number().int().nonnegative() }).parse(controller);
        const scheduledAt = new Date(event.scheduledTime).toISOString();
        const targets = createManifest(config).schedules.filter((schedule) => schedule.cron === event.cron);
        if (!targets.length) throw new Error("SCHEDULE_NOT_FOUND");

        for (const target of targets) {
          const occurrenceId = JSON.stringify([1, config.name, target.agentId, target.id, scheduledAt]);
          const cell = env.TECIDO_SCHEDULES.get(env.TECIDO_SCHEDULES.idFromName(occurrenceId));
          const response = await cell.fetch(
            new Request("https://tecido/occurrence", {
              method: "POST",
              body: JSON.stringify({
                agentId: target.agentId,
                scheduleId: target.id,
                occurrenceId,
                scheduledAt,
                revision,
              }),
            }),
          );
          if (!response.ok) throw new Error("OCCURRENCE_ACCEPT_FAILED");
        }
      },
    },
  };
}
