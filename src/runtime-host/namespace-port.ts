import { z } from "zod/v4";
import type { RuntimeThreadAddress } from "../runtime-events.js";
import type { RuntimePort } from "../runtime.js";
import type { RuntimeObjectNamespace } from "./contracts.js";
import { Accepted, Snapshot, Stream } from "./protocol.js";

export async function objectKey(address: RuntimeThreadAddress): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([1, address.namespace, address.agentId, address.threadId]));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createNamespacePort(namespace: RuntimeObjectNamespace): RuntimePort {
  const send = async (address: RuntimeThreadAddress, command: object): Promise<unknown> => {
    const object = namespace.get(namespace.idFromName(await objectKey(address)));
    // This is an internal request to the addressed runtime object, not an external HTTP request.
    const response = await object.fetch(
      new Request("https://tecido/thread", { method: "POST", body: JSON.stringify({ ...command, address }) }),
    );
    const body: unknown = await response.json();
    if (!response.ok) {
      const error = z.object({ error: z.string() }).parse(body);
      throw new Error(error.error);
    }

    return body;
  };

  return {
    accept: async (address, event) => Accepted.parse(await send(address, { type: "accept", event })),
    readRun: async (address, runId) => Snapshot.parse(await send(address, { type: "read", runId })),
    readAttempt: async (address, runId, attempt) =>
      Snapshot.parse(await send(address, { type: "read", runId, attempt })),
    retry: async (address, runId, options) => Accepted.parse(await send(address, { type: "retry", runId, options })),
    cancel: async (address, runId) => {
      await send(address, { type: "cancel", runId });
    },
    async *subscribe(address, runId, afterSeq) {
      let cursor = afterSeq;
      while (true) {
        const page = z
          .object({ events: z.array(Stream), terminal: z.boolean() })
          .parse(await send(address, { type: "events", runId, afterSeq: cursor }));
        for (const event of page.events) {
          if (event.seq <= cursor) throw new Error("INVALID_EVENT_SEQUENCE");
          cursor = event.seq;
          yield event;
          if (event.type === "completed" || event.type === "failed" || event.type === "cancelled") return;
        }
        if (page.terminal) return;

        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    },
  };
}
