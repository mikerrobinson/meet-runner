import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const APP = new URL("../app/", import.meta.url).href;

/**
 * Teaches Node the two things the app's imports assume: the `~/` alias, and
 * that a relative import has no extension.
 *
 * Whether an extension is missing is decided by looking, not by pattern —
 * `./sync.server` ends in something that looks exactly like one, and guessing
 * from the shape of the name meant `.server.ts` files could never be imported
 * from a test at all.
 */
export function resolve(specifier, context, next) {
  const spec = specifier.startsWith("~/") ? APP + specifier.slice(2) : specifier;

  if (/^[./]|^file:/.test(spec)) {
    const base = new URL(spec, context.parentURL);
    if (!existsSync(fileURLToPath(base.href))) {
      for (const ext of [".ts", ".tsx"]) {
        if (existsSync(fileURLToPath(base.href + ext))) {
          return next(base.href + ext, context);
        }
      }
    }
  }

  return next(spec, context);
}
