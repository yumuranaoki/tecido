# Tecido examples

The application declares Agents and one `tecido.config.ts`. Tecido generates the Worker handlers, internal Durable Object classes/bindings, migrations, and cron triggers. The only schedule definition is `briefing.schedules` in `cron.ts`.

## Run locally

1. Install Celld **0.5.1** and run `pnpm install` in the repository.
2. Create `examples/.dev.vars` with your provider key:

   ```dotenv
   OPENAI_API_KEY=your-key
   ```

3. Start the example from the repository root:

   ```sh
   node src/cli/index.ts dev --config examples/tecido.config.ts --logs
   ```

4. Send a request:

   ```sh
   curl http://127.0.0.1:9876 \
     -H 'content-type: application/json' \
     -d '{"id":"alice","input":"Tell me the weather in Tokyo.","transactionId":"request-1"}'
   ```

Repeating the same transaction returns the saved result. Change `transactionId` for a new turn. The example HTTP handler is for local development; production handlers must authenticate the caller and authorize the Thread address.

The briefing Agent runs at 09:00 UTC. For a local cron check, change its single `cron` declaration to `* * * * *`, then restart the dev command. No generated configuration needs editing. The initial dev command does not watch source changes.

## Generated output and state

```sh
node src/cli/index.ts build --config examples/tecido.config.ts
```

`build` validates the declaration and invokes Celld's `deploy --dry-run` for cron/config validation without deployment. It requires the pinned Celld executable, but no provider key. The package also declares the `tecido` executable for installations.

- `examples/.tecido/wrangler.jsonc` is the stable generated runtime config.
- `examples/.tecido/builds/<revision>/` holds the Worker and metadata manifest.
- `examples/.tecido/.celld/dev/` holds local persistent state. Do not delete `.tecido` when you want to preserve it.
- `.dev.vars` is linked from the project into the runtime directory; credentials are not copied into generated code or the manifest.

Builds replace the runtime config only after validation succeeds and preserve the local state directory. The local dev command uses Celld's single-node readiness override and binds localhost. Production fleet setup is separate.

## Durability implemented so far

Inputs and wakeup alarms commit in one storage transaction. Thread runs are ordered, completed results and stream events persist, and repeated transaction IDs resolve to the original Run. Model/tool checkpoints support explicit retry and reconciliation. Interrupted external calls are failed rather than automatically repeated. A cron hook is replayable: put external side effects in Tools, and use stable `transactionId` values when the same hook submits multiple operations to one Thread.

This is the first runtime implementation, not completion of all v0.1 production requirements. It currently stores a versioned Thread snapshot, polls persisted stream events, and retains history without pruning. Retention limits, bounded context selection, aggregate usage accounting, relational storage migration, and multi-node takeover qualification remain. See [implementation status](../docs/design/runtime_port.md#13-初回実装の到達点) for details. Existing `conversation.v1` example data is not automatically imported.

## Verification

```sh
pnpm test
pnpm test:celld
```

The Celld integration test uses a fake model, builds a real Worker, kills the process immediately after acceptance, restarts it against the same storage, checks deduplication and history, and waits for one real cron occurrence. It can take about a minute and needs no provider credentials.
