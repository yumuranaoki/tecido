import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
} from "@standard-schema/spec";
import { isPlainObject } from "remeda";
import { NonEmptyStringSchema } from "./primitives.js";
import type { RunId } from "./run.js";
import { z } from "zod/v4";

/**
 * A Standard Schema validator with the Standard JSON Schema conversion hook
 * required to describe tool inputs to AI SDK providers.
 */
export type ToolSchema<Input = unknown, Output = Input> = StandardSchemaV1<
  Input,
  Output
> &
  StandardJSONSchemaV1<Input, Output>;

/** Context supplied by Tecido when it invokes a Tool. */
export interface ToolContext {
  /** Identifier of the Run executing this Tool. */
  readonly runId: RunId;
  /** Stable identifier suitable for forwarding as an external idempotency key. */
  readonly toolCallId: string;
  /** Signal aborted when the Run or Tool is cancelled or times out. */
  readonly signal: AbortSignal;
}

type AnyToolSchema = ToolSchema<any, any>;
type ToolExecutor<Schema extends AnyToolSchema, Output> = (
  input: StandardSchemaV1.InferOutput<Schema>,
  context: ToolContext,
) => Promise<Output>;

/** Configuration and callable contract for one named Agent Tool. */
export interface ToolOptions<
  Schema extends AnyToolSchema = AnyToolSchema,
  Output = unknown,
> {
  /** Description presented to the model when selecting a Tool. */
  readonly description: string;
  /** Standard Schema used for validation and model-facing JSON Schema conversion. */
  readonly inputSchema: Schema;
  /** Whether a tool call with uncertain outcome may be repeated after recovery. */
  readonly retry?: "safe" | "never";
  /** Optional upper bound in milliseconds for one Tool invocation. */
  readonly timeoutMs?: number;

  /**
   * Executes the Tool with schema-validated input and durable call context.
   * @param input Validated tool input.
   * @param context Durable Run and cancellation identifiers.
   * @returns The serializable Tool result.
   */
  execute(
    input: StandardSchemaV1.InferOutput<Schema>,
    context: ToolContext,
  ): Promise<Output>;
}

/** Typed Tool contract inferred from its input schema and execute result. */
export type Tool<
  Schema extends AnyToolSchema = AnyToolSchema,
  Output = unknown,
> = ToolOptions<Schema, Output>;

const ToolOptionsSchema = z.object({
  description: NonEmptyStringSchema,
  inputSchema: z.custom<AnyToolSchema>(isToolSchema, {
    message:
      "Tool inputSchema must implement Standard Schema validation and JSON Schema conversion.",
  }),
  retry: z.enum(["safe", "never"]).optional(),
  timeoutMs: z.number().positive().optional(),
  execute: z.custom<ToolExecutor<AnyToolSchema, unknown>>(
    (value) => typeof value === "function",
    { message: "Tool execute must be a function." },
  ),
});

/**
 * Creates a typed Tool declaration without running it.
 * @param options Description, input schema, retry policy, and executor.
 * @returns The same Tool contract with its input and output types preserved.
 */
export function tool<Schema extends AnyToolSchema, Output>(
  options: ToolOptions<Schema, Output>,
): Tool<Schema, Output> {
  return parseToolOptions(options) as Tool<Schema, Output>;
}

function parseToolOptions(options: unknown): Tool<AnyToolSchema, unknown> {
  const parsed = ToolOptionsSchema.parse(options);

  return {
    description: parsed.description,
    inputSchema: parsed.inputSchema,
    retry: parsed.retry ?? "never",
    ...(parsed.timeoutMs === undefined ? {} : { timeoutMs: parsed.timeoutMs }),
    execute: parsed.execute,
  };
}

function isToolSchema(value: unknown): value is AnyToolSchema {
  if (!isPlainObject(value)) return false;

  const standard = value["~standard"];
  if (!isPlainObject(standard) || typeof standard.validate !== "function") {
    return false;
  }

  return (
    isPlainObject(standard.jsonSchema) &&
    typeof standard.jsonSchema.input === "function" &&
    typeof standard.jsonSchema.output === "function"
  );
}

