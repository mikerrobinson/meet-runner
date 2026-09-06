/**
 * A test harness in thirty lines.
 *
 * These run under `node --experimental-strip-types`, so there's no framework
 * to install and no config to keep in step with the build. Each file is a
 * script that makes assertions; `npm test` runs them all and fails the process
 * if any of them didn't hold.
 */

declare const process: { exit(code: number): never };

let failures = 0;

/** Key order isn't data: the documents are compared by value, not by shape. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, stable(v)]),
    );
  }
  return value;
}

export function eq(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(stable(actual));
  const b = JSON.stringify(stable(expected));
  if (a === b) {
    console.log(`  ok   ${what}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${what}\n       got  ${a}\n       want ${b}`);
}

export function done(): void {
  if (failures > 0) {
    console.log(`\n${failures} assertion${failures === 1 ? "" : "s"} failed.`);
    process.exit(1);
  }
}
