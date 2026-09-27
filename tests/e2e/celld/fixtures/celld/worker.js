import { AsyncLocalStorage } from "node:async_hooks";
const scope = new AsyncLocalStorage();
export class Probe {
  constructor(state) {
    this.state = state;
  }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/arm") {
      await this.state.storage.transaction(async (tx) => {
        await tx.put("accepted", true);
        await tx.setAlarm(Date.now() + 2000);
      });
    }
    if (path === "/rollback") {
      try {
        await this.state.storage.transaction(async (tx) => {
          await tx.put("rolledBack", false);
          await tx.setAlarm(Date.now() + 600000);
          throw new Error("rollback");
        });
      } catch {}
    }
    return Response.json({
      accepted: (await this.state.storage.get("accepted")) ?? false,
      fired: (await this.state.storage.get("fired")) ?? false,
      rolledBack: (await this.state.storage.get("rolledBack")) ?? true,
      alarm: await this.state.storage.getAlarm(),
    });
  }
  async alarm() {
    await this.state.storage.put("fired", true);
  }
}
export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === "/scope") {
      const results = await Promise.all(
        ["one", "two"].map((id) =>
          scope.run(id, async () => {
            await new Promise((resolve) => setTimeout(resolve, id === "one" ? 10 : 1));
            return scope.getStore();
          }),
        ),
      );
      return Response.json(results);
    }
    return env.PROBE.get(env.PROBE.idFromName("probe")).fetch(request);
  },
};
