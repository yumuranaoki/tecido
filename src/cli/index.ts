#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { build } from "esbuild";
import { z } from "zod/v4";
import type { TecidoConfig } from "../config.js";
import type { createManifest } from "../manifest.js";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
const executable = process.env.CELLD_BIN ?? "celld";
const bundler = fileURLToPath(new URL("../../node_modules/.bin/esbuild", import.meta.url));
const runtimeEnv = { ...process.env, CELLD_ESBUILD: process.env.CELLD_ESBUILD ?? bundler };

const ConfigPathSchema = z.string().min(1).default("tecido.config.ts");
const PortSchema = z
  .string()
  .regex(/^\d+$/, "--port must be an integer between 1 and 65535.")
  .refine((value) => Number(value) >= 1 && Number(value) <= 65535, "--port must be an integer between 1 and 65535.")
  .default("9876");
const BuildOptionsSchema = z.strictObject({ config: ConfigPathSchema });
const DevOptionsSchema = z.strictObject({
  config: ConfigPathSchema,
  port: PortSchema,
  logs: z.boolean().default(false),
});

const commandResult = z.enum(["build", "dev"]).safeParse(process.argv[2]);

if (
  process.argv[2] === "--help" ||
  process.argv[2] === "-h" ||
  process.argv[2] === "help" ||
  process.argv[2] === undefined
) {
  printHelp();
} else if (!commandResult.success) {
  console.error("Unknown command. Use tecido --help.");
  process.exitCode = 1;
} else {
  try {
    const command = commandResult.data;
    const options =
      command === "dev"
        ? {
            config: { type: "string" as const },
            port: { type: "string" as const },
            logs: { type: "boolean" as const },
            help: { type: "boolean" as const, short: "h" },
          }
        : { config: { type: "string" as const }, help: { type: "boolean" as const, short: "h" } };
    const parsed = parseArgs({ args: process.argv.slice(3), options, strict: true, allowPositionals: false });
    if (parsed.values.help) printHelp();
    else if (command === "dev") {
      const values = DevOptionsSchema.parse(parsed.values);
      await main(command, resolve(values.config), values.port, values.logs);
    } else {
      const values = BuildOptionsSchema.parse(parsed.values);
      await main(command, resolve(values.config), "9876", false);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Tecido command failed.");
    process.exitCode = 1;
  }
}

function printHelp() {
  console.log(
    "tecido build [--config <path>] | dev [--config <path>] [--port <port>] [--logs]\nRequires celld 0.6.0. dev listens on localhost and preserves .tecido/.celld.",
  );
}

function assertCelldVersion(): void {
  const version = spawnSync(executable, ["--version"], { encoding: "utf8" });
  if (version.status !== 0 || version.stdout.trim() !== "celld 0.6.0") {
    throw new Error("Install celld 0.6.0; this adapter has not been verified against other versions.");
  }
}

function createBuildOptions() {
  return {
    bundle: true,
    format: "esm" as const,
    target: "es2022",
    platform: "neutral" as const,
    external: ["node:*"],
    conditions: ["worker", "browser", "import", "default"],
    mainFields: ["module", "browser", "main"],
    logLevel: "silent" as const,
    alias: { tecido: join(sourceRoot, "index.ts") },
  };
}

async function discoverConfig(
  configPath: string,
  project: string,
  directory: string,
  options: ReturnType<typeof createBuildOptions>,
): Promise<{ config: TecidoConfig; manifest: ReturnType<typeof createManifest> }> {
  const discoveryPath = join(directory, `discovery-${randomUUID()}.mjs`);
  let config: TecidoConfig;
  let manifest: ReturnType<typeof createManifest>;
  try {
    await build({
      ...options,
      platform: "node",
      outfile: discoveryPath,
      stdin: {
        contents: `import raw from ${JSON.stringify(configPath)}; import {parseConfig} from ${JSON.stringify(join(sourceRoot, "config.ts"))}; import {createManifest} from ${JSON.stringify(join(sourceRoot, "manifest.ts"))}; export const config = parseConfig(raw); export const manifest = createManifest(config);`,
        resolveDir: project,
      },
    });
    ({ config, manifest } = await import(pathToFileURL(discoveryPath).href));
  } finally {
    await rm(discoveryPath, { force: true });
  }

  return { config, manifest };
}

async function buildWorker(
  configPath: string,
  project: string,
  directory: string,
  options: ReturnType<typeof createBuildOptions>,
  config: TecidoConfig,
  manifest: ReturnType<typeof createManifest>,
): Promise<string> {
  const manifestText = JSON.stringify(manifest);
  const workerInput = (revision: string) =>
    `import config from ${JSON.stringify(configPath)}; import {createWorker} from ${JSON.stringify(join(sourceRoot, "adapters/celld/worker.ts"))}; const runtime = createWorker(config, ${JSON.stringify(manifestText)}, ${JSON.stringify(revision)}); export const TecidoThread = runtime.ThreadCell; export const TecidoSchedule = runtime.SchedulerCell; export default runtime.handler;`;
  const initial = await build({
    ...options,
    write: false,
    stdin: { contents: workerInput("revision"), resolveDir: project },
  });
  const revision = createHash("sha256")
    .update(initial.outputFiles[0]!.contents)
    .update(JSON.stringify(config.vars ?? {}))
    .digest("hex");
  const release = join(directory, "builds", revision);
  await mkdir(release, { recursive: true });
  await build({
    ...options,
    outfile: join(release, "worker.js"),
    stdin: { contents: workerInput(revision), resolveDir: project },
  });
  await writeFile(
    join(release, "manifest.json"),
    JSON.stringify({ ...manifest, revision, celld: "0.6.0" }, null, 2) + "\n",
  );

  return revision;
}

function createGeneratedConfig(config: TecidoConfig, manifest: ReturnType<typeof createManifest>, revision: string) {
  return {
    name: config.name,
    main: `./builds/${revision}/worker.js`,
    compatibility_date: "2025-06-01",
    compatibility_flags: ["nodejs_compat"],
    durable_objects: {
      bindings: [
        { name: "TECIDO_THREADS", class_name: "TecidoThread" },
        { name: "TECIDO_SCHEDULES", class_name: "TecidoSchedule" },
      ],
    },
    migrations: [{ tag: "tecido-v1", new_sqlite_classes: ["TecidoThread", "TecidoSchedule"] }],
    vars: config.vars ?? {},
    ...(manifest.schedules.length
      ? { triggers: { crons: [...new Set(manifest.schedules.map((schedule) => schedule.cron))].sort() } }
      : {}),
  };
}

async function writeDeploymentConfig(
  directory: string,
  config: TecidoConfig,
  manifest: ReturnType<typeof createManifest>,
  revision: string,
): Promise<void> {
  const generated = createGeneratedConfig(config, manifest, revision);
  const candidate = join(directory, `candidate-${randomUUID()}.json`);
  try {
    // Celld's parser validates its cron dialect, exports and migrations without deployment.
    await writeFile(candidate, JSON.stringify(generated, null, 2) + "\n");
    const validation = spawnSync(executable, ["deploy", candidate, "--dry-run"], { env: runtimeEnv, encoding: "utf8" });
    if (validation.status !== 0) throw new Error(`Celld validation failed:\n${validation.stderr}`);
    await rename(candidate, join(directory, "wrangler.jsonc"));
  } finally {
    await rm(candidate, { force: true });
  }
}

async function startDev(directory: string, port: string, logs: boolean): Promise<void> {
  const source = join(dirname(directory), ".dev.vars");
  const target = join(directory, ".dev.vars");
  try {
    await readFile(source);
    await rm(target, { force: true });
    await symlink(source, target);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code !== "ENOENT") throw error;
  }
  const child = spawn(
    executable,
    ["dev", join(directory, "wrangler.jsonc"), "--port", port, "--no-watch", ...(logs ? ["--logs"] : [])],
    {
      env: { ...runtimeEnv, CELLD_READY_FLEET_GATE_MS: "0" },
      stdio: "inherit",
    },
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
  child.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1);
  });
}

async function main(command: "build" | "dev", configPath: string, port: string, logs: boolean) {
  assertCelldVersion();
  const project = dirname(configPath);
  const directory = join(project, ".tecido");
  await mkdir(directory, { recursive: true });
  const options = createBuildOptions();
  const { config, manifest } = await discoverConfig(configPath, project, directory, options);
  const revision = await buildWorker(configPath, project, directory, options, config, manifest);
  await writeDeploymentConfig(directory, config, manifest, revision);
  console.log(`Built ${join(directory, "wrangler.jsonc")}`);

  if (command === "dev") await startDev(directory, port, logs);
}
