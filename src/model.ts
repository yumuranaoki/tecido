import type { LanguageModelUsage } from "ai";

/** The AI SDK's provider-neutral model interface used by an Agent. */
export type { LanguageModel } from "ai";

/** Usage metrics reported by the AI SDK for a model response. */
export type ModelUsage = LanguageModelUsage;
