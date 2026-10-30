import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, type BrowserContext } from "@playwright/test";
import { frozenPreparationSource, programCompatibilityManifest } from "../../../host/test/fixtures/program-compatibility";
import { resolveBinary } from "../../../host/src/binary-resolver";
import type { ProgramCompatibilityFixture } from "../pages/program-compatibility-test/main";

const marker: Record<string, string> = {
  echo: "BASELINE_ECHO", "spawn-smoke": "spawned-ok\nOK", "fstatat-empty-path": "FSTATAT_EMPTY_PATH_PASS",
  "mmap-file": "msync ok\nPASS", pthread: "main: retval = 42 (expected 42)\nPASS",
  "environment-lifecycle": "FORK_ENV_PASS\nEXEC_ENV_PASS\nEMPTY_ENV_PASS",
};

for (const persistence of [false, true]) test(`frozen supported programs and retained-original preparation run offline with the current runtime (${persistence ? "OPFS" : "memory"})`, async ({ playwright, browserName, baseURL }, testInfo) => {
  test.setTimeout(300_000);
  const work = mkdtempSync(join(tmpdir(), "kandelo-native-preparation-oracle-"));
  const userDataDirectory = mkdtempSync(join(tmpdir(), "kandelo-program-preparation-browser-"));
  let context: BrowserContext | undefined;
  const failures: string[] = [];
  let sourceRequests = 0;
  try {
    const projectUse = testInfo.project.use as {
      channel?: string; launchOptions?: Record<string, unknown>;
      proxy?: Record<string, unknown>; extraHTTPHeaders?: Record<string, string>;
    };
    context = await playwright[browserName].launchPersistentContext(userDataDirectory, {
      channel: projectUse.channel, proxy: projectUse.proxy as never,
      extraHTTPHeaders: projectUse.extraHTTPHeaders, ...(projectUse.launchOptions ?? {}),
      serviceWorkers: "block",
    });
    const page = context.pages()[0] ?? await context.newPage();
    page.on("requestfailed", request => {
      failures.push(`${request.url()}: ${request.failure()?.errorText}`);
      if (failures.length > 32) failures.shift();
    });
    page.on("console", message => {
      if (message.type() !== "error" && message.type() !== "warning") return;
      failures.push(`${message.type()}: ${message.text().slice(0, 1024)}`);
      if (failures.length > 32) failures.shift();
    });
    const input = frozenPreparationSource();
    writeFileSync(join(work, "input.wasm"), input, { mode: 0o755 });
    execFileSync(resolve(import.meta.dirname, "../../../scripts/run-wasm-fork-instrument.sh"), [
      join(work, "input.wasm"), "-o", join(work, "output.wasm"), "--original-store", work,
      "--post-optimize", "Os", "--max-input-bytes", "16777216", "--max-output-bytes", "16777216",
    ], { timeout: 120_000, stdio: "pipe", env: { ...process.env, BINARYEN_CORES: "1" } });
    const expected = readFileSync(join(work, "output.wasm"));
    await page.goto(new URL("/pages/program-compatibility-test/", baseURL).href);
    await page.waitForFunction(() => "__programCompatibility" in window);
    const imageUrl = process.env.KANDELO_PROGRAM_COMPATIBILITY_IMAGE_URL ?? new URL("/program-compatibility.vfs", baseURL).href;
    page.on("request", request => { if (request.url() === imageUrl) sourceRequests += 1; });
    await page.evaluate(async args => {
      await (window as Window & { __programCompatibility: ProgramCompatibilityFixture }).__programCompatibility.initialize(args.imageUrl, args.name);
    }, { imageUrl, name: persistence ? crypto.randomUUID() : undefined });
    const run = (path: string, argv: string[], env: string[] = [], uid = 1000) => page.evaluate(async args => {
      return (window as Window & { __programCompatibility: ProgramCompatibilityFixture }).__programCompatibility.run(args.path, args.argv, args.env, args.uid);
    }, { path, argv, env, uid });
    const read = (path: string) => page.evaluate(async path => {
      return (window as Window & { __programCompatibility: ProgramCompatibilityFixture }).__programCompatibility.read(path);
    }, path);
    const identity = (path: string) => page.evaluate(async path => {
      return (window as Window & { __programCompatibility: ProgramCompatibilityFixture }).__programCompatibility.identity(path);
    }, path);
    for (const record of programCompatibilityManifest.fixtures) {
      expect(await identity(`/bin/${record.name}`)).toEqual({ size: record.size, sha256: record.sha256 });
    }
    expect(Buffer.from((await read("/work/input.wasm"))!)).toEqual(input);
    for (const program of ["wasm-fork-instrument", "wasm-opt"]) {
      const expectedTool = readFileSync(resolveBinary(`programs/${program}.wasm`));
      expect(await identity(`/bin/${program}`)).toEqual({ size: expectedTool.byteLength, sha256: createHash("sha256").update(expectedTool).digest("hex") });
    }
    expect(await run("/bin/wasm-fork-instrument", ["wasm-fork-instrument", "--help"])).toMatchObject({ status: "completed", exitCode: 0 });
    expect(await run("/bin/wasm-opt", ["wasm-opt", "--version"])).toMatchObject({ status: "completed", exitCode: 0 });
    await context.setOffline(true);
    const incompatibleFork = await identity("/launch/incompatible-fork");
    await expect(run("/launch/incompatible-fork", ["incompatible-fork"]))
      .rejects.toThrow(/Rebuild user-built forking programs with the current Kandelo SDK/);
    expect(await identity("/launch/incompatible-fork")).toEqual(incompatibleFork);
    await expect(run("/launch/not-executable", ["refused"])).rejects.toThrow(/errno 13/);
    await expect(run("/launch/missing", ["missing"])).rejects.toThrow(/errno 2/);
    await expect(run("/launch/invalid", ["invalid"])).rejects.toThrow(/errno 8/);
    await expect(run("/launch/echo-no-read", ["echo", "x".repeat(65_537)])).rejects.toThrow(/errno 7/);
    expect(await run("../launch/echo-no-read", ["source-name", "INITIAL_EXECUTE_ONLY"]))
      .toMatchObject({ status: "completed", exitCode: 0, output: expect.stringContaining("INITIAL_EXECUTE_ONLY") });
    expect(await run("../launch/script", ["original-argv", "tail"]))
      .toMatchObject({ status: "completed", exitCode: 0, output: expect.stringContaining("INITIAL_SCRIPT ../launch/script tail") });
    for (const record of programCompatibilityManifest.fixtures) {
      const result = await run(`/bin/${record.name}`, [record.name, ...(record.name === "echo" ? ["BASELINE_ECHO"] : [])], ["INITIAL=parent", "REMOVE=before-fork"]);
      expect(result, result.output).toMatchObject({ status: "completed", exitCode: 0 });
      expect(result.output).toContain(marker[record.name]);
    }
    const options = ["-o", "/work/output.wasm", "--original-store", "/work", "--post-optimize", "Os", "--max-input-bytes", "16777216", "--max-output-bytes", "16777216"];
    const prepared = await run("/bin/wasm-fork-instrument", ["wasm-fork-instrument", "/work/input.wasm", ...options]);
    expect(prepared, prepared.output).toMatchObject({ status: "completed", exitCode: 0 });
    expect(Buffer.from((await read("/work/output.wasm"))!)).toEqual(expected);
    const originalPath = `/work/originals/${createHash("sha256").update(input).digest("hex")}.wasm`;
    expect(Buffer.from((await read(originalPath))!)).toEqual(input);
    expect(await run("/work/output.wasm", ["output"])).toMatchObject({ status: "completed", exitCode: 0, output: expect.stringContaining("PASS") });
    expect(await read("/work/reprepared.wasm")).toBeNull();
    const reprepareOptions = options.map(value => value === "/work/output.wasm" ? "/work/reprepared.wasm" : value);
    expect(await run("/bin/wasm-fork-instrument", ["wasm-fork-instrument", "/work/output.wasm", ...reprepareOptions, "--reprepare-from-original"])).toMatchObject({ status: "completed", exitCode: 0 });
    expect(Buffer.from((await read("/work/reprepared.wasm"))!)).toEqual(expected);
    expect(await run("/work/reprepared.wasm", ["reprepared"])).toMatchObject({ status: "completed", exitCode: 0, output: expect.stringContaining("PASS") });
    const descriptors = await run("/bin/preparation-descriptors", ["preparation-descriptors", "/work/fd-output.wasm"]);
    expect(descriptors, descriptors.output).toMatchObject({ status: "completed", exitCode: 0, output: expect.stringContaining("DESCRIPTOR_PREPARATION_PASS") });
    expect(Buffer.from((await read("/work/fd-output.wasm"))!)).toEqual(expected);
    expect(await read("/work/fd-staging.wasm")).toBeNull();
    expect(await run("/work/fd-output.wasm", ["fd-output"])).toMatchObject({ status: "completed", exitCode: 0, output: expect.stringContaining("PASS") });
    const descriptorRefusal = await run("/bin/preparation-descriptors", ["preparation-descriptors", "/work/fd-refused.wasm", "refuse"]);
    expect(descriptorRefusal, descriptorRefusal.output).toMatchObject({ status: "completed", exitCode: 0, output: expect.stringContaining("DESCRIPTOR_REFUSAL_PASS") });
    expect(await read("/work/fd-refused.wasm")).toBeNull();
    const pinned = await run("/bin/preparation-descriptors", ["preparation-descriptors", "/work/fd-pinned.wasm", "pinned-tools"], [], 0);
    expect(pinned, pinned.output).toMatchObject({ status: "completed", exitCode: 0, output: expect.stringContaining("DESCRIPTOR_PREPARATION_PASS") });
    expect(Buffer.from((await read("/work/fd-pinned.wasm"))!)).toEqual(expected);
    expect(await run("/work/fd-pinned.wasm", ["fd-pinned"], [], 0)).toMatchObject({ status: "completed", exitCode: 0, output: expect.stringContaining("PASS") });
    if (persistence) {
      await context.setOffline(false);
      await page.evaluate(async () => {
        await (window as Window & { __programCompatibility: ProgramCompatibilityFixture }).__programCompatibility.reopen();
      });
      expect(await run("/bin/wasm-fork-instrument", ["wasm-fork-instrument", "--help"])).toMatchObject({ status: "completed", exitCode: 0 });
      expect(await run("/bin/wasm-opt", ["wasm-opt", "--version"])).toMatchObject({ status: "completed", exitCode: 0 });
      await context.setOffline(true);
      expect(Buffer.from((await read("/work/reprepared.wasm"))!)).toEqual(expected);
      expect(Buffer.from((await read(originalPath))!)).toEqual(input);
      expect(await run("/work/reprepared.wasm", ["reopened"])).toMatchObject({ status: "completed", exitCode: 0, output: expect.stringContaining("PASS") });
      expect(await read("/work/reopened-prepared.wasm")).toBeNull();
      const reopenedOptions = options.map(value => value === "/work/output.wasm" ? "/work/reopened-prepared.wasm" : value);
      expect(await run("/bin/wasm-fork-instrument", ["wasm-fork-instrument", "/work/reprepared.wasm", ...reopenedOptions, "--reprepare-from-original"])).toMatchObject({ status: "completed", exitCode: 0 });
      expect(Buffer.from((await read("/work/reopened-prepared.wasm"))!)).toEqual(expected);
      expect(await run("/work/reopened-prepared.wasm", ["reopened-prepared"])).toMatchObject({ status: "completed", exitCode: 0, output: expect.stringContaining("PASS") });
      expect(await identity("/launch/incompatible-fork")).toEqual(incompatibleFork);
      await expect(run("/launch/incompatible-fork", ["incompatible-fork"]))
        .rejects.toThrow(/Rebuild user-built forking programs with the current Kandelo SDK/);
      expect(await identity("/launch/incompatible-fork")).toEqual(incompatibleFork);
      expect(Buffer.from((await read("/work/fd-output.wasm"))!)).toEqual(expected);
      expect(await run("/bin/preparation-descriptors", ["preparation-descriptors", "/work/fd-reopened.wasm"])).toMatchObject({ status: "completed", exitCode: 0, output: expect.stringContaining("DESCRIPTOR_PREPARATION_PASS") });
      expect(Buffer.from((await read("/work/fd-reopened.wasm"))!)).toEqual(expected);
      expect(await run("/work/fd-reopened.wasm", ["fd-reopened"])).toMatchObject({ status: "completed", exitCode: 0, output: expect.stringContaining("PASS") });
    }
    await page.evaluate(async path => {
      await (window as Window & { __programCompatibility: ProgramCompatibilityFixture }).__programCompatibility.write(path, [0, 1, 2]);
    }, originalPath);
    const refused = await run("/bin/wasm-fork-instrument", ["wasm-fork-instrument", "/work/output.wasm", ...options, "--reprepare-from-original"]);
    expect(refused, refused.output).toMatchObject({ status: "completed", exitCode: 1 });
    expect(Buffer.from((await read("/work/output.wasm"))!)).toEqual(expected);
    expect(sourceRequests).toBe(1);
  } catch (error) {
    await testInfo.attach("compatibility-diagnostics", { body: failures.join("\n"), contentType: "text/plain" });
    throw error;
  } finally {
    try {
      if (context) {
        try {
          await context.setOffline(false);
          await context.pages()[0]?.evaluate(async () => {
            await (window as Window & { __programCompatibility?: ProgramCompatibilityFixture }).__programCompatibility?.destroy();
          });
        } finally { await context.close(); }
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
      rmSync(userDataDirectory, { recursive: true, force: true });
    }
  }
});
