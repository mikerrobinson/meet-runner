import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const APP = new URL("../app/", import.meta.url).href;

export function resolve(specifier, context, next) {
  let spec = specifier.startsWith("~/") ? APP + specifier.slice(2) : specifier;
  if (/^[./]|^file:/.test(spec) && !/\.[a-z]+$/.test(spec)) {
    const base = new URL(spec, context.parentURL);
    for (const ext of [".ts", ".tsx"]) {
      if (existsSync(fileURLToPath(base.href + ext))) {
        return next(base.href + ext, context);
      }
    }
  }
  return next(spec, context);
}
