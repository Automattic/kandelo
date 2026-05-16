import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));
const NODE = join(__dirname, "../../examples/libs/quickjs/bin/node.wasm");
const HAS_NODE = existsSync(NODE);

/* Regression for the js_node_loop unhandled-rejection sweep. js_std_loop_once
   drains microtasks but doesn't run js_std_promise_rejection_check, so a
   bare async-IIFE rejection used to exit silently with code 0. */
describe.skipIf(!HAS_NODE)("node unhandled-rejection sweep", () => {
  it("exits non-zero with a diagnostic on top-level async rejection", async () => {
    const src = `(async () => { throw new Error('boom'); })();`;
    const r = await runCentralizedProgram({
      programPath: NODE,
      argv: ["node", "-e", src],
      timeout: 5_000,
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("Possibly unhandled promise rejection");
    expect(r.stderr).toContain("boom");
  });

  it("exits 0 when the rejection is handled before the sweep runs", async () => {
    const src = `Promise.reject(new Error('caught')).catch(() => {});`;
    const r = await runCentralizedProgram({
      programPath: NODE,
      argv: ["node", "-e", src],
      timeout: 5_000,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).not.toContain("Possibly unhandled promise rejection");
  });
});
