import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tryResolveBinary } from "../../../../host/src/binary-resolver";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageBuild = join(__dirname, "../bin/js.wasm");
const jsWasm =
  tryResolveBinary("programs/js.wasm") ??
  (existsSync(packageBuild) ? packageBuild : null);

describe.skipIf(!jsWasm)("SpiderMonkey js shell", () => {
  it("evaluates a simple expression", async () => {
    const result = await runCentralizedProgram({
      programPath: jsWasm!,
      argv: ["js", "-e", "print(1 + 1)"],
      timeout: 20_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("2");
  });

  it("supports modern JavaScript syntax that QuickJS compatibility needs", async () => {
    const result = await runCentralizedProgram({
      programPath: jsWasm!,
      argv: [
        "js",
        "-e",
        [
          "print([3, 1, 2].toSorted().join(','))",
          "print(Object.groupBy(['a', 'bb', 'c'], s => s.length)[1].join(','))",
          "print(typeof Promise.withResolvers)",
          "print((2n ** 64n).toString())",
        ].join(";"),
      ],
      timeout: 20_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "1,2,3",
      "a,c",
      "function",
      "18446744073709551616",
    ]);
  });
});
