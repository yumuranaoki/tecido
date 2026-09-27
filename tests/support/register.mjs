import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { transformSync } from "esbuild";

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (specifier.endsWith(".js") && specifier.startsWith(".")) return next(specifier.slice(0, -3) + ".ts", context);
      throw error;
    }
  },
  load(url, context, next) {
    if (url.endsWith(".ts") && !url.includes("/node_modules/"))
      return {
        format: "module",
        source: transformSync(readFileSync(new URL(url), "utf8"), { loader: "ts", format: "esm", target: "es2022" })
          .code,
        shortCircuit: true,
      };
    return next(url, context);
  },
});
