import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { agent } from "../../../../../src/agent.js";
import type { TecidoConfig } from "../../../../../src/config.js";

const assistant = agent({
  id: "assistant",
  model: new MockLanguageModelV3({
    doStream: async ({ prompt }) => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "text-start", id: "text" },
          { type: "text-delta", id: "text", delta: `messages:${prompt.length}` },
          { type: "text-end", id: "text" },
          {
            type: "finish",
            finishReason: { unified: "stop", raw: undefined },
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 1, text: 1, reasoning: undefined },
            },
          },
        ],
      }),
    }),
  }),
  instructions: "fixture",
  schedules: [{ id: "minute", cron: "* * * * *" }],
  async onCron(_event, context) {
    const result = await context.thread({ namespace: "fixture", id: "cron" }).run("tick");
    const reportUrl = "TECIDO_TEST_REPORT_URL";
    if (reportUrl.startsWith("http:")) await fetch(reportUrl, { method: "POST", body: JSON.stringify(result) });
  },
});

export default {
  name: "tecido-integration",
  agents: [assistant],
  async fetch(request) {
    const url = new URL(request.url);
    const thread = assistant.thread({ namespace: "fixture", id: "test" });
    if (url.pathname === "/read") return Response.json(await thread.getRun(url.searchParams.get("runId")!));
    if (url.pathname === "/stream") {
      const stream = await thread.stream("hello", { transactionId: url.searchParams.get("key") ?? "first" });
      return Response.json({ runId: stream.runId });
    }
    return Response.json(await thread.run("hello", { transactionId: url.searchParams.get("key") ?? "first" }));
  },
} satisfies TecidoConfig;
