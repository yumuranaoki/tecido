import type { RuntimeObjectNamespace } from "../../runtime-host/contracts.js";

/** Celld 0.6.0 bindings consumed by its host adapter. */
export interface HostEnv {
  readonly TECIDO_THREADS: RuntimeObjectNamespace;
  readonly TECIDO_SCHEDULES: RuntimeObjectNamespace;
  readonly [name: string]: unknown;
}
