# Tecido

Tecido is a lightweight runtime for persistent AI agents, built on [celld](https://github.com/denoland/celld).

The name **Tecido** means "tissue" in Portuguese. Just as multiple cells come together to form tissue, Tecido combines the cells and durable primitives provided by `celld` to build persistent AI agents.

```text
celld
  │ provides cells and durable primitives
  ▼
Tecido
  │ composes them into
  ▼
Persistent Agents
```

While traditional agent SDKs focus on a single request and response, Tecido treats an agent thread as an addressable, persistent entity. A thread retains its conversation and execution history, and wakes up in response to messages or cron events.

```text
message ──┐
          ├──▶ Persistent Agent Thread ──▶ Run
cron ─────┘              │
                         ▼
                  durable state
```

## Why Tecido

Running an AI agent in production typically requires more than an LLM SDK. Applications also need infrastructure such as a database, scheduler, distributed locking, durable storage, and observability.

Tecido delegates as much of this infrastructure layer as possible to `celld`, including storage, single-writer execution, routing, and scheduling.

## Goals

- Preserve conversations across process restarts and deployments
- Remain self-hostable without depending on a particular managed AI or application platform

## Cloud-provider independence

Cloud-provider independence means that Tecido does not expose APIs from a particular managed AI service or application platform through its public API. Tecido can be self-hosted on your choice of compute infrastructure using an object storage service supported by `celld`.

It does not mean that no operational infrastructure is required. Deployments still need TLS termination, ingress, object storage, secret management, and related operational components.

## Example API

```ts
import { agent, tool } from "tecido";
import type { TecidoConfig } from "tecido";

const weather = tool({
  description: "Get weather information",
  inputSchema: WeatherSchema,
  retry: "safe",
  execute: async ({ city }) => getWeather(city),
});

const assistant = agent({
  id: "assistant",
  model,
  instructions: "You are a helpful assistant.",
  tools: { weather },
});

// tecido.config.ts: Tecido installs the runtime before invoking this handler.
export default {
  name: "assistant-app",
  agents: [assistant],
  async fetch(request) {
    // Authenticate the caller and authorize its Thread address here.
    const thread = assistant.thread({ namespace: "acme", id: "alice" });
    const result = await thread.run("What's the weather in Tokyo?", {
      transactionId: request.headers.get("idempotency-key") ?? crypto.randomUUID(),
    });
    return Response.json(result);
  },
} satisfies TecidoConfig;
```

Import `TecidoConfig` as a type from `tecido`. The model can also be a factory,
`model: ({ env }) => createOpenAI({ apiKey: env.OPENAI_API_KEY })("gpt-4.1-mini")`,
so CLI configuration discovery does not require provider credentials.

## Configure an application

The CLI loads the default-exported configuration from `tecido.config.ts` in the
project root. Use `satisfies TecidoConfig` to check the declaration while
preserving its inferred types. The configuration has these fields:

| Field    | Required | Description                                                                                                                                                                                                                       |
| -------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`   | Yes      | Lowercase deployment name. Use letters, numbers, and hyphens; it must start and end with a letter or number.                                                                                                                      |
| `agents` | Yes      | One or more Agents registered by the application. Agent IDs must be unique.                                                                                                                                                       |
| `vars`   | No       | String values added to the generated runtime configuration and available to handlers through `context.env`. Names beginning with `TECIDO_` are reserved. Keep secrets in `.dev.vars` for local development instead of this field. |
| `fetch`  | No       | HTTP request handler. If omitted, requests return `404`. It receives a `Request` and an `AppContext` containing the runtime environment variables.                                                                                |

For example, `vars: { APP_ENV: "production" }` is available as
`context.env.APP_ENV` in the handler. Local development reads `.dev.vars` from
the configuration's project directory.

Both CLI commands accept a path to a configuration file when it is not named
`tecido.config.ts` or is outside the current directory:

```sh
tecido dev --config apps/assistant/tecido.config.ts
tecido build --config apps/assistant/tecido.config.ts
```

## Run the examples

Install Celld **0.5.1**, run `pnpm install`, and follow [the example instructions](examples/README.md).

```sh
node src/cli/index.ts dev --config examples/tecido.config.ts
```

Tecido generates the Worker handlers, internal classes/bindings, and cron settings.
Declare schedules only on the Agent. Access Threads inside Tecido handlers;
outside a bound runtime, Thread access fails explicitly.
