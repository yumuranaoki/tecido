import { z } from "zod/v4";

export const NonEmptyStringSchema = z
  .string()
  .refine((value) => value.trim().length > 0, { message: "Must contain at least one non-whitespace character." });

export const DeploymentNameSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, "Use a lowercase deployment name.");
