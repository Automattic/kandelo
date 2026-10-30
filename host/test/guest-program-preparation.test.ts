import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NodeKernelHost } from "../src/node-kernel-host";
import { resolveBinary } from "../src/binary-resolver";
import { createProgramCompatibilityImage, frozenPreparationSource } from "./fixtures/program-compatibility";

describe("normal-package guest preparation", () => {
  let host: NodeKernelHost;
  let image: Uint8Array;
  let expected: Buffer;
  let work: string;
  let sequence = 0;
  const input = frozenPreparationSource();
  const originalPath = `/work/originals/${createHash("sha256").update(input).digest("hex")}.wasm`;
  const options = ["-o", "/work/output.wasm", "--original-store", "/work", "--post-optimize", "Os", "--max-input-bytes", "16777216", "--max-output-bytes", "16777216"];

  async function run(argv: string[], path = "/bin/wasm-fork-instrument", uid = 1000) {
    const id = `guest-preparation-${++sequence}`;
    const process = await host.spawnFromVfs(path, argv, {
      uid, gid: uid, cwd: "/work",
      env: ["HOME=/work", "PATH=/bin", "TMPDIR=/work/temporary", "SQLITE_TMPDIR=/work/temporary", "WASM_OPT=/bin/wasm-opt", "BINARYEN_CORES=1"],
      ownedJob: { id, timeoutMs: 120_000 },
    });
    void process.exit.catch(() => {});
    const deadline = Date.now() + 135_000;
    let cursor = 0;
    let output = "";
    for (;;) {
      const result = await host.readOwnedJob(id, cursor, 16384);
      if (result.expired) throw new Error("Guest preparation output expired");
      output = (output + result.chunks.map(chunk => new TextDecoder().decode(chunk.bytes)).join("")).slice(-65536);
      cursor = result.next;
      if (result.terminationObserved) {
        await host.releaseOwnedJob(id);
        return { status: result.status, exitCode: result.exitCode, output };
      }
      if (Date.now() >= deadline) throw new Error("Guest preparation did not retire");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }

  async function read(path: string) {
    const bytes = await host.readFileFromVfs(path);
    if (bytes === null) throw new Error(`Missing preparation output ${path}`);
    return Buffer.from(bytes);
  }

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), "kandelo-guest-preparation-oracle-"));
    writeFileSync(join(work, "input.wasm"), input, { mode: 0o755 });
    execFileSync(resolve(import.meta.dirname, "../../scripts/run-wasm-fork-instrument.sh"), [
      join(work, "input.wasm"), "-o", join(work, "output.wasm"), "--original-store", work,
      "--post-optimize", "Os", "--max-input-bytes", "16777216", "--max-output-bytes", "16777216",
    ], { timeout: 120_000, stdio: "pipe", env: { ...process.env, BINARYEN_CORES: "1" } });
    expected = readFileSync(join(work, "output.wasm"));
    image = await createProgramCompatibilityImage();
  }, 180_000);

  beforeEach(async () => {
    host = new NodeKernelHost({ rootfsImage: image });
    await host.init(Uint8Array.from(readFileSync(resolveBinary("kernel.wasm"))).buffer);
    const result = await run(["wasm-fork-instrument", "/work/input.wasm", ...options]);
    expect(result, result.output).toMatchObject({ status: "completed", exitCode: 0 });
    expect(await read("/work/output.wasm")).toEqual(expected);
  }, 180_000);
  afterEach(async () => { await host?.destroy(); });
  afterAll(() => { if (work) rmSync(work, { recursive: true, force: true }); });

  it("executes native-identical optimized bytes and re-prepares from the retained original", async () => {
    expect(await read(originalPath)).toEqual(input);
    const executed = await run(["output"], "/work/output.wasm");
    expect(executed, executed.output).toMatchObject({ status: "completed", exitCode: 0, output: expect.stringContaining("PASS") });
    expect(await host.readFileFromVfs("/work/reprepared.wasm")).toBeNull();
    const changed = options.map(value => value === "/work/output.wasm" ? "/work/reprepared.wasm" : value);
    expect(await run(["wasm-fork-instrument", "/work/output.wasm", ...changed, "--reprepare-from-original"])).toMatchObject({ status: "completed", exitCode: 0 });
    expect(await read("/work/reprepared.wasm")).toEqual(expected);
    expect(await run(["reprepared"], "/work/reprepared.wasm")).toMatchObject({ status: "completed", exitCode: 0, output: expect.stringContaining("PASS") });
  }, 180_000);

  it("prepares through inherited private descriptors without altering source authority or offsets", async () => {
    const result = await run(["preparation-descriptors", "/work/fd-output.wasm"], "/bin/preparation-descriptors");
    expect(result, result.output).toMatchObject({ status: "completed", exitCode: 0, output: expect.stringContaining("DESCRIPTOR_PREPARATION_PASS") });
    expect(await read("/work/fd-output.wasm")).toEqual(expected);
    expect(await read("/work/input.wasm")).toEqual(input);
    expect(await host.readFileFromVfs("/work/fd-staging.wasm")).toBeNull();
    expect(await run(["fd-output"], "/work/fd-output.wasm")).toMatchObject({ status: "completed", exitCode: 0, output: expect.stringContaining("PASS") });
    const refused = await run(["preparation-descriptors", "/work/fd-refused.wasm", "refuse"], "/bin/preparation-descriptors");
    expect(refused, refused.output).toMatchObject({ status: "completed", exitCode: 0, output: expect.stringContaining("DESCRIPTOR_REFUSAL_PASS") });
    expect(await host.readFileFromVfs("/work/fd-refused.wasm")).toBeNull();
  }, 180_000);

  it("pins preparer and optimizer code across pathname moves", async () => {
    const result = await run(["preparation-descriptors", "/work/fd-pinned.wasm", "pinned-tools"], "/bin/preparation-descriptors", 0);
    expect(result, result.output).toMatchObject({ status: "completed", exitCode: 0, output: expect.stringContaining("DESCRIPTOR_PREPARATION_PASS") });
    expect(await read("/work/fd-pinned.wasm")).toEqual(expected);
    expect(await read("/bin/wasm-fork-instrument")).not.toHaveLength(0);
    expect(await read("/bin/wasm-opt")).not.toHaveLength(0);
    expect(await run(["fd-pinned"], "/work/fd-pinned.wasm", 0)).toMatchObject({ status: "completed", exitCode: 0, output: expect.stringContaining("PASS") });
  }, 180_000);

  it("refuses a missing retained original without replacing an existing output", async () => {
    const changed = options.map(value => value === "/work" ? "/work/missing-store" : value);
    const result = await run(["wasm-fork-instrument", "/work/output.wasm", ...changed, "--reprepare-from-original"]);
    expect(result, result.output).toMatchObject({ status: "completed", exitCode: 1 });
    expect(await read("/work/output.wasm")).toEqual(expected);
  }, 180_000);

  it("refuses an input budget violation without replacing an existing output", async () => {
    const changed = options.map((value, index) => options[index - 1] === "--max-input-bytes" ? "1" : value);
    const result = await run(["wasm-fork-instrument", "/work/input.wasm", ...changed]);
    expect(result, result.output).toMatchObject({ status: "completed", exitCode: 1 });
    expect(await read("/work/output.wasm")).toEqual(expected);
    expect(await read(originalPath)).toEqual(input);
  }, 180_000);

  it("refuses a corrupted original without replacing an existing output", async () => {
    await host.writeFileToVfs(originalPath, Uint8Array.of(0, 1, 2));
    const result = await run(["wasm-fork-instrument", "/work/output.wasm", ...options, "--reprepare-from-original"]);
    expect(result, result.output).toMatchObject({ status: "completed", exitCode: 1 });
    expect(await read("/work/output.wasm")).toEqual(expected);
  }, 180_000);
});
