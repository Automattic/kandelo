/**
 * REPL regression test — js_node_loop must keep running while
 * os.setReadHandler watches are alive.
 */
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));
const NODE = join(__dirname, "../../examples/libs/quickjs/bin/node.wasm");

describe.skipIf(!existsSync(NODE))("node REPL", () => {
  it("prints banner, evaluates input, exits on \\q", async () => {
    const result = await runCentralizedProgram({
      programPath: NODE,
      argv: ["node"],
      timeout: 8_000,
      onStarted: async (kw, pid) => {
        await new Promise((r) => setTimeout(r, 800));
        kw.appendStdinData(pid, new TextEncoder().encode("1+2\n"));
        await new Promise((r) => setTimeout(r, 800));
        kw.appendStdinData(pid, new TextEncoder().encode("\\q\n"));
      },
    });
    expect(result.stdout).toContain("QuickJS-ng");
    expect(result.stdout).toContain("3");
    expect(result.exitCode).toBe(0);
  });
});
