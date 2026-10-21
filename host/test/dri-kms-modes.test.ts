import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { NodeKernelHost } from "../src/node-kernel-host";
import { runCentralizedProgram } from "./centralized-test-helper";
import { compileSdkFixture } from "./support/compile-sdk-fixture";

describe("KMS display owner notifications through Node's stats handle", () => {
  let fixture: ReturnType<typeof compileSdkFixture>;
  beforeAll(() => {
    fixture = compileSdkFixture(new URL("./fixtures/kms-display-owner.c", import.meta.url), [], {
      forkInstrument: true,
    });
  }, 120_000);
  afterAll(() => fixture?.cleanup());

  it.each(["drop", "exit", "terminate"])("publishes release on %s, preserving ownership across child exit", async mode => {
    let stdout = "", stderr = "", pid = 0;
    const host = new NodeKernelHost({
      onStdout: (_pid, bytes) => { stdout += new TextDecoder().decode(bytes); },
      onStderr: (_pid, bytes) => { stderr += new TextDecoder().decode(bytes); },
    });
    try {
      await host.init();
      const stats = new Int32Array(new SharedArrayBuffer(64));
      host.kmsAttachStats(1, stats.buffer as SharedArrayBuffer);
      const exit = host.spawn(Uint8Array.from(readFileSync(fixture.programPath)).buffer,
        ["kms-display-owner", mode], {
          uid: 1000, gid: 1000,
          ownedJob: { id: "kms-owner", timeoutMs: 30_000 },
          onStarted: started => { pid = started; },
        });
      await expect.poll(() => stdout, { timeout: 15_000 }).toContain("owner retained after child exit");
      expect(pid).toBeGreaterThan(0);
      await expect.poll(() => Atomics.load(stats, 8)).toBe(pid);
      if (mode === "terminate") {
        await host.terminateProcess(pid, 0);
      } else {
        host.appendStdinData(pid, new TextEncoder().encode("g"));
        if (mode === "drop") {
          await expect.poll(() => stdout).toContain("master released while process lives");
          await expect.poll(() => Atomics.load(stats, 8)).toBe(0);
          host.appendStdinData(pid, new TextEncoder().encode("g"));
        }
      }
      expect(await exit, stderr + stdout).toBe(0);
      await expect.poll(() => Atomics.load(stats, 8)).toBe(0);
    } finally { await host.destroy(); }
  }, 45_000);
});

it("enumerates selectable KMS modes through the Node guest ioctl channel", async () => {
  const { programPath, cleanup } = compileSdkFixture(new URL("./fixtures/kms-modes.c", import.meta.url));
  try {
    const result = await runCentralizedProgram({
      programPath, argv: ["kms-modes"], uid: 1000, gid: 1000, useDefaultRootfs: false,
    });
    expect(result.exitCode, result.stderr + result.stdout).toBe(0);
    expect(result.stdout).toMatch(/kms-modes: \d+ modes, one preferred, .*: ok/);
    expect(result.stdout).toContain("cached absolute range survives two modesets: ok");
  } finally { cleanup(); }
}, 30_000);

it("preserves explicit producer bounds across host display setup and guest modesets", async () => {
  const { programPath, cleanup } = compileSdkFixture(new URL("./fixtures/kms-modes.c", import.meta.url));
  let stdout = "", stderr = "";
  const host = new NodeKernelHost({
    onStdout: (_pid, bytes) => { stdout += new TextDecoder().decode(bytes); },
    onStderr: (_pid, bytes) => { stderr += new TextDecoder().decode(bytes); },
  });
  try {
    await host.init();
    host.setInputCanvasDims(1024, 512);
    host.kmsSetDisplaySize(1, 960, 540);
    const exitCode = await host.spawn(
      Uint8Array.from(readFileSync(programPath)).buffer,
      ["kms-modes", "1023", "511"], { uid: 1000, gid: 1000 },
    );
    expect(exitCode, stderr + stdout).toBe(0);
    expect(stdout).toContain("cached absolute range survives two modesets: ok");
  } finally { await host.destroy(); cleanup(); }
}, 30_000);
