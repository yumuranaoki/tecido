import { z } from "zod/v4";

export const NonEmptyStringSchema = z
  .string()
  .refine((value) => value.trim().length > 0, { message: "Must contain at least one non-whitespace character." });
