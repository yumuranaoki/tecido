import { modelMessageSchema } from "ai";
import { z } from "zod/v4";
import { NonEmptyStringSchema as ID } from "../primitives.js";
import { Address, Event, Snapshot, Stream } from "./protocol.js";

const Call = z.object({
  id: ID,
  providerId: ID,
  name: ID,
  input: z.json(),
  retry: z.enum(["safe", "never"]),
  status: z.enum(["pending", "running", "completed"]),
  output: z.json().optional(),
});

export const Run = z.object({
  snapshot: Snapshot,
  event: Event,
  queueSeq: z.number().int().positive(),
  dispatchSeq: z.number().int().positive(),
  afterSeq: z.number().int().nonnegative(),
  eventStartSeq: z.number().int().nonnegative().optional(),
  events: z.array(Stream),
  attempts: z.array(Snapshot),
  context: z.array(modelMessageSchema).optional(),
  contextStart: z.number().int().nonnegative().optional(),
  round: z.number().int().nonnegative(),
  calls: z.array(Call),
  text: z.string(),
  cancelled: z.boolean(),
});

export const State = z.object({
  version: z.literal(1),
  address: Address,
  nextQueue: z.number().int().positive(),
  nextDispatch: z.number().int().positive(),
  messages: z.array(modelMessageSchema),
  runs: z.array(Run),
});

export type StoredRun = z.infer<typeof Run>;

export type StoredState = z.infer<typeof State>;
