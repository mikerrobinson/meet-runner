/**
 * Runs every `tests/*.test.ts` and fails if any assertion did.
 *
 * Node strips the types itself, so there's no test framework and no second
 * build to keep in step with the app's.
 */
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const suites = readdirSync(here).filter((f) => f.endsWith(".test.ts")).sort();

let failed = 0;
for (const suite of suites) {
  console.log(`\n${suite}`);
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--experimental-transform-types",
      "--no-warnings",
      "--import",
      join(here, "resolve-alias.mjs"),
      join(here, suite),
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0) failed += 1;
}

console.log(
  failed === 0
    ? `\nAll ${suites.length} suites passed.`
    : `\n${failed} of ${suites.length} suites failed.`,
);
process.exit(failed === 0 ? 0 : 1);
