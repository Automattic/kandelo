import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { NodeKernelHost } from "../src/node-kernel-host";
import { runCentralizedProgram } from "./centralized-test-helper";
import { compileSdkFixture } from "./support/compile-sdk-fixture";

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
