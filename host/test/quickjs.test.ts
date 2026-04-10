/**
 * QuickJS-NG integration tests.
 *
 * Tests the `qjs` command — a standalone QuickJS-NG JavaScript interpreter
 * with ES2023 support and POSIX os/std modules.
 */

import { describe, it, expect } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "../..");
const qjsWasm = join(repoRoot, "examples/libs/quickjs/bin/qjs.wasm");
const hasQjs = existsSync(qjsWasm);

describe.skipIf(!hasQjs)("QuickJS-NG", () => {
  it("evaluates a simple expression", async () => {
    const result = await runCentralizedProgram({
      programPath: qjsWasm,
      argv: ["qjs", "-e", 'console.log("hello qjs")'],
    });
    expect(result.stdout).toContain("hello qjs");
    expect(result.exitCode).toBe(0);
  });

  it("supports ES2023 features (BigInt, findLast, groupBy)", async () => {
    const result = await runCentralizedProgram({
      programPath: qjsWasm,
      argv: [
        "qjs",
        "-e",
        [
          'console.log("findLast:", [1,2,3,4,5].findLast(x => x < 4))',
          'console.log("BigInt:", (2n ** 64n).toString())',
          'console.log("groupBy:", Object.keys(Object.groupBy([1,2,3], x => x % 2 ? "odd" : "even")).sort().join(","))',
        ].join(";"),
      ],
    });
    expect(result.stdout).toContain("findLast: 3");
    expect(result.stdout).toContain("BigInt: 18446744073709551616");
    expect(result.stdout).toContain("groupBy: even,odd");
    expect(result.exitCode).toBe(0);
  });

  it("supports file I/O via std module", async () => {
    const result = await runCentralizedProgram({
      programPath: qjsWasm,
      argv: [
        "qjs",
        "--std",
        "-e",
        [
          'var f = std.open("/tmp/qjs-vitest.txt", "w")',
          'f.puts("test data\\n")',
          "f.close()",
          'var f2 = std.open("/tmp/qjs-vitest.txt", "r")',
          'print("read:", f2.getline())',
          "f2.close()",
          'os.remove("/tmp/qjs-vitest.txt")',
        ].join(";"),
      ],
    });
    expect(result.stdout).toContain("read: test data");
    expect(result.exitCode).toBe(0);
  });

  it("supports POSIX os module (getcwd, getpid, stat, pipe)", async () => {
    const result = await runCentralizedProgram({
      programPath: qjsWasm,
      argv: [
        "qjs",
        "--std",
        "-e",
        [
          "var [cwd, err] = os.getcwd()",
          'print("cwd ok:", err === 0)',
          'print("pid:", os.getpid())',
          "var fds = os.pipe()",
          'print("pipe:", fds !== null && fds.length === 2)',
          "if (fds) { os.close(fds[0]); os.close(fds[1]) }",
        ].join(";"),
      ],
    });
    expect(result.stdout).toContain("cwd ok: true");
    expect(result.stdout).toContain("pid: 100");
    expect(result.stdout).toContain("pipe: true");
    expect(result.exitCode).toBe(0);
  });
});
