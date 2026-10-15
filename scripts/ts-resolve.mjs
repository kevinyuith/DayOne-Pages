/**
 * Lets Node run the dashboard's TypeScript modules as they are (scripts/*.mts):
 * "@/x" → src/x, and an extensionless relative import → its .ts/.tsx file.
 * `node --import ./scripts/ts-resolve.mjs scripts/<check>.mts`
 */
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";

const SRC = new URL("../src/", import.meta.url);

registerHooks({
  resolve(specifier, context, nextResolve) {
    let spec = specifier.startsWith("@/") ? new URL(specifier.slice(2), SRC).href : specifier;
    if ((spec.startsWith(".") || spec.startsWith("file:")) && !/\.[cm]?[jt]sx?$|\.json$/.test(spec)) {
      const base = new URL(spec, context.parentURL);
      for (const ext of [".ts", ".tsx", "/index.ts"]) {
        const candidate = new URL(base.href + ext);
        if (existsSync(candidate)) {
          spec = candidate.href;
          break;
        }
      }
    }
    return nextResolve(spec, context);
  },
});
