import type { TecidoConfig } from "./config.js";

/** Only static routing metadata is serialized; factories and credentials stay out. */
export function createManifest(config: TecidoConfig) {
  return {
    version: 1,
    name: config.name,
    agents: config.agents.map((agent) => agent.options.id).sort(),
    schedules: config.agents
      .flatMap((agent) =>
        (agent.options.schedules ?? []).map((schedule) => ({
          agentId: agent.options.id,
          id: schedule.id,
          cron: schedule.cron,
        })),
      )
      .sort((a, b) => a.agentId.localeCompare(b.agentId) || a.id.localeCompare(b.id)),
  };
}
