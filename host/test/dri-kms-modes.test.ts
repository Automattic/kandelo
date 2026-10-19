import { expect, it } from "vitest";
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
