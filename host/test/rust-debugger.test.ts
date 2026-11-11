import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";
import { resolveBinary } from "../src/binary-resolver";
import { buildRustBacktraceFixture } from "./fixtures/rust-backtrace-build";

const repo = resolve(import.meta.dirname, "../..");
let directory: string, program: string, image: string, kernel: string;
beforeAll(async () => {
  directory = mkdtempSync(join(process.env.KANDELO_AGENT_SCRATCH_DIR ?? tmpdir(), "kandelo-rust-debugger-"));
  program = buildRustBacktraceFixture(directory);
  kernel = resolveBinary("kernel.wasm");
  const fs = KandeloImageFs.create();
  fs.mkdir("/usr"); fs.mkdir("/usr/bin");
  fs.writeFile("/usr/bin/rust-backtrace", new Uint8Array(readFileSync(program)), 0o755);
  image = join(directory, "debugger.vfs"); writeFileSync(image, await fs.saveImage());
}, 900_000);
afterAll(() => { if (directory && !process.env.KANDELO_AGENT_SCRATCH_DIR) rmSync(directory, { recursive: true, force: true }); });
function run(commands: string, mode = "capture") {
  const result = spawnSync(process.execPath, ["--import", "tsx/esm", "scripts/debug-rust.ts", program,
    "--break", "programs/rust/backtrace/src/main.rs:5", "--commands", commands,
    "--image", image, "--kernel", kernel, "--", mode], {
    cwd: repo, env: { ...process.env, RUST_BACKTRACE: "0" }, encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 ** 2,
  });
  expect(result.error).toBeUndefined();
  expect(result.stderr).not.toMatch(/destroy drain timed out|force-terminating/);
  return result;
}
for (const mode of ["capture", "thread"]) {
  it(`Rust debugger stops, steps, prints a stack and resumes an actual ${mode}`, () => {
    const result = run("next,where,continue", mode);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toMatch(/paused worker \d+: .*user_inner.*main.rs":5:5/);
    expect(result.stderr).toMatch(/paused worker \d+: .*user_inner.*main.rs":6:2/);
    expect(result.stderr).toMatch(/guest exited 0/);
    expect(result.stdout).toContain(mode === "capture" ? "CAPTURED_BACKTRACE" : "THREAD_BACKTRACE");
  }, 90_000);
}
it("quitting while Rust is paused disconnects the inspector and retires workers", () => {
  const result = run("quit");
  expect(result.status, result.stderr).toBe(130);
  expect(result.signal).toBeNull();
  expect(result.stderr).toMatch(/paused worker \d+: .*user_inner/);
}, 90_000);
