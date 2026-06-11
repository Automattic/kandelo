import { expect, test } from "@playwright/test";
import {
  classifyWasmCrashSignal,
  SIGFPE,
  SIGILL,
  SIGSEGV,
} from "../../../host/src/trap-signals";

const TRAP_MODULES = [
  {
    name: "memory-oob",
    expectedSignum: SIGSEGV,
    bytes: [
      0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 5, 3,
      1, 0, 1, 7, 7, 1, 3, 114, 117, 110, 0, 0, 10, 12, 1, 10, 0, 65,
      128, 128, 4, 40, 2, 0, 26, 11,
    ],
  },
  {
    name: "divide-by-zero",
    expectedSignum: SIGFPE,
    bytes: [
      0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 7, 7,
      1, 3, 114, 117, 110, 0, 0, 10, 10, 1, 8, 0, 65, 1, 65, 0, 109, 26,
      11,
    ],
  },
  {
    name: "unreachable",
    expectedSignum: SIGILL,
    bytes: [
      0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 7, 7,
      1, 3, 114, 117, 110, 0, 0, 10, 5, 1, 3, 0, 0, 11,
    ],
  },
  {
    name: "indirect-null-table-entry",
    expectedSignum: SIGILL,
    bytes: [
      0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 4, 4,
      1, 112, 0, 1, 7, 7, 1, 3, 114, 117, 110, 0, 0, 10, 9, 1, 7, 0, 65,
      0, 17, 0, 0, 11,
    ],
  },
  {
    name: "indirect-table-oob",
    expectedSignum: SIGSEGV,
    bytes: [
      0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2,
      1, 0, 4, 4, 1, 112, 0, 1, 7, 7, 1, 3, 114, 117, 110, 0,
      0, 10, 9, 1, 7, 0, 65, 1, 17, 0, 0, 11,
    ],
  },
] as const;

test("Wasm trap messages classify to POSIX signals in this browser engine", async ({
  page,
  browserName,
}) => {
  await page.setContent("<!doctype html><title>wasm trap signal test</title>");

  const messages = await page.evaluate(async (fixtures) => {
    const results: Record<string, string> = {};
    for (const fixture of fixtures) {
      const { instance } = await WebAssembly.instantiate(new Uint8Array(fixture.bytes));
      const run = instance.exports.run;
      if (typeof run !== "function") {
        throw new Error(`fixture ${fixture.name} did not export run()`);
      }
      try {
        run();
        results[fixture.name] = "NO_TRAP";
      } catch (err) {
        if (err instanceof Error) {
          results[fixture.name] = `${err.name}: ${err.message}`;
        } else {
          results[fixture.name] = String(err);
        }
      }
    }
    return results;
  }, TRAP_MODULES);

  for (const fixture of TRAP_MODULES) {
    const message = messages[fixture.name];
    expect(message, `${browserName} ${fixture.name}`).toBeDefined();
    expect(message, `${browserName} ${fixture.name}`).not.toBe("NO_TRAP");
    const classification = classifyWasmCrashSignal(message);
    expect(
      classification?.signum,
      `${browserName} ${fixture.name}: ${message}`,
    ).toBe(fixture.expectedSignum);
  }
});
