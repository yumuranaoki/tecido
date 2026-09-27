import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod/v4";
import { agent, tool } from "../src/index.js";

export const assistant = agent({
  id: "assistant",
  model: ({ env }) => createOpenAI(env.OPENAI_API_KEY ? { apiKey: env.OPENAI_API_KEY } : {})("gpt-4.1-mini"),
  instructions: "You are a helpful personal assistant. Use the weather tool when asked about the weather.",
  tools: {
    weather: tool({
      description: "Get current weather for a city",
      inputSchema: z.object({ city: z.string().min(1) }),
      retry: "safe",
      async execute({ city }, context) {
        context.signal.throwIfAborted();
        return `${city}: sunny, 22°C`;
      },
    }),
  },
});
