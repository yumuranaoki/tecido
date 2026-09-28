import { z } from "zod/v4";
import { parseConfig } from "../../config.js";
import { createManifest } from "../../manifest.js";
import { withRuntimeContext } from "../../runtime-context.js";
import type { RuntimeObjectState } from "../../runtime-host/contracts.js";
import { createNamespacePort } from "../../runtime-host/namespace-port.js";
import { ScheduleObject } from "../../runtime-host/schedule-object.js";
import { ThreadObject } from "../../runtime-host/thread-object.js";
import type { HostEnv } from "./contracts.js";

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
    port: createNamespacePort(env.TECIDO_THREADS),
    env: context(env).env,
  });

  return {
    ThreadCell: class extends ThreadObject {
      constructor(
        state: RuntimeObjectState,
        private readonly env: HostEnv,
      ) {
        super(state, config, revision);
      }
      override alarm(): Promise<void> {
        return withRuntimeContext(runtimeContext(this.env), () => super.alarm());
      }
    },
    SchedulerCell: class extends ScheduleObject {
      constructor(state: RuntimeObjectState, env: HostEnv) {
        super(state, config, createNamespacePort(env.TECIDO_THREADS), revision, context(env).env);
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
