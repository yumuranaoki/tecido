import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

type TestResponse = {
  runId?: string;
  status?: string;
  result?: { output?: { text?: string } };
  output?: { text?: string };
};

test("Celld generated Worker integration", { timeout: 180_000 }, async () => {
  const root = resolve(import.meta.dirname, "../../..");
  const directory = await mkdtemp(join(root, "tests/.celld-test-"));
  const port = await new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "string" || address === null) {
        reject(new Error("Could not determine the test server port"));
        return;
      }
      server.close(() => resolvePort(address.port));
    });
  });
  const url = `http://127.0.0.1:${port}`;

  let cronResult: TestResponse | undefined;
  const reports = createHttpServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    cronResult = JSON.parse(body) as TestResponse;
    response.end("ok");
  });
  await new Promise<void>((resolveListen) => reports.listen({ port: 0, host: "127.0.0.1" }, resolveListen));
  const reportAddress = reports.address();
  if (typeof reportAddress === "string" || reportAddress === null) throw new Error("Could not start report server");
  const reportUrl = `http://127.0.0.1:${reportAddress.port}/cron`;
  let child: ReturnType<typeof spawn> | undefined;
  let output = "";

  async function start(): Promise<void> {
    output = "";
    const started = spawn(
      process.execPath,
      [
        join(root, "src/cli/index.ts"),
        "dev",
        "--config",
        join(directory, "tecido.config.ts"),
        "--port",
        String(port),
        "--logs",
      ],
      { cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    child = started;
    started.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    started.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    await until(async () => {
      if (started.exitCode !== null) throw new Error(output);
      try {
        const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
        return response.status === 204;
      } catch {
        return false;
      }
    }, 20000);
  }

  async function stop(): Promise<void> {
    const activeChild = child;
    if (!activeChild || activeChild.exitCode !== null || activeChild.signalCode !== null) return;
    if (activeChild.pid === undefined) throw new Error("Worker process has no pid");
    const exited = new Promise<void>((resolveExit) => activeChild.once("exit", () => resolveExit()));
    process.kill(-activeChild.pid, "SIGKILL");
    await exited;
  }

  async function until(check: () => boolean | Promise<boolean>, timeout = 10000): Promise<void> {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await check()) return;
      await delay(100);
    }
    throw new Error(`Timed out.\n${output}`);
  }

  async function json(path: string): Promise<TestResponse> {
    const response = await fetch(url + path, { signal: AbortSignal.timeout(45000) }).catch(async (error: unknown) => {
      let detail = "";
      if (path === "/?key=second") {
        const identity = await fetch(url + "/stream?key=second").then((response) => response.json());
        detail = JSON.stringify(await fetch(url + `/read?runId=${identity.runId}`).then((response) => response.json()));
      }
      throw new Error(
        `Request ${path} failed: ${error instanceof Error ? error.message : String(error)}\nState: ${detail}\n${output}`,
      );
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}\n${output}`);
    return (await response.json()) as TestResponse;
  }

  try {
    const fixture = await readFile(join(import.meta.dirname, "fixtures/app/tecido.config.ts"), "utf8");
    await writeFile(
      join(directory, "tecido.config.ts"),
      fixture.replaceAll("../../../../../src/", "../../src/").replace("TECIDO_TEST_REPORT_URL", reportUrl),
    );
    await start();
    console.log("Started generated Worker");
    const accepted = await json("/stream?key=restart");
    await stop();
    console.log("Restarting after acceptance");
    await start();
    let snapshot: TestResponse | undefined;
    await until(async () => {
      snapshot = await json(`/read?runId=${accepted.runId}`);
      return snapshot.status === "completed";
    });

    assert.equal(snapshot?.result?.output?.text, "messages:2");
    const duplicate = await json("/?key=restart");

    assert.equal(duplicate.runId, accepted.runId);
    const next = await json("/?key=second");

    assert.equal(next.output?.text, "messages:4");
    console.log("PASS: generated Worker, acceptance/restart, deduplication, persisted conversation");

    await until(async () => cronResult !== undefined, 95000);
    assert.equal(cronResult?.output?.text, "messages:2");

    console.log("PASS: generated cron trigger invokes the declared Agent through durable Thread delivery");
    await stop();
  } finally {
    await stop();
    await rm(directory, { recursive: true, force: true });
    reports.closeAllConnections();
    await new Promise((resolveClose) => reports.close(resolveClose));
  }
});
