import { z } from "zod/v4";
import type { TecidoConfig } from "../src/index.js";
import { assistant } from "./basic.js";
import { briefing } from "./cron.js";

const Input = z.object({ id: z.string().min(1), input: z.string(), transactionId: z.string().min(1).optional() });

export default {
  name: "tecido-example",
  agents: [assistant, briefing],
  async fetch(request) {
    if (request.method !== "POST") return new Response("Use POST", { status: 405 });

    const parsed = Input.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return new Response("Invalid request", { status: 400 });

    const { id, input, transactionId } = parsed.data;
    // This local example has no authentication. Production handlers must authorize the address.
    const result = await assistant
      .thread({ namespace: "example", id })
      .run(input, transactionId === undefined ? undefined : { transactionId });
    return Response.json(result);
  },
} satisfies TecidoConfig;
