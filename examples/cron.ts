import { createOpenAI } from "@ai-sdk/openai";
import { agent } from "../src/index.js";

export const briefing = agent({
  id: "briefing-assistant",
  model: ({ env }) => createOpenAI(env.OPENAI_API_KEY ? { apiKey: env.OPENAI_API_KEY } : {})("gpt-4.1-mini"),
  instructions: "Prepare concise daily briefings.",
  schedules: [{ id: "daily-briefing", cron: "0 9 * * *" }],
  async onCron(event, context) {
    await context.thread({ namespace: "system", id: event.scheduleId }).run("Prepare today's briefing.");
  },
});
