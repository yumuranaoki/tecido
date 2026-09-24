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

const thread = assistant.thread({
  namespace: "acme",
  id: "alice",
});

const stream = await thread.stream("What's the weather in Tokyo?", {
  transactionId: request.id,
});

for await (const event of stream) {
  // text-delta, tool-call, tool-result, completed, failed
}
```
