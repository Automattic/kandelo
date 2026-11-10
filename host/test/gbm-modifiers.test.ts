import { expect, it } from "vitest";
import { compileSdkFixture } from "./support/compile-sdk-fixture";
import { runCentralizedProgram } from "./centralized-test-helper";

it("validates GBM modifier requests and queries through the normal SDK", async () => {
  const fixture = compileSdkFixture(new URL("./fixtures/gbm-modifiers.c", import.meta.url), ["-lgbm", "-ldrm"]);
  try {
    const result = await runCentralizedProgram({
      programPath: fixture.programPath, useDefaultRootfs: false, timeout: 10_000,
    });
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout.trim()).toBe("OK GBM modifier admission and public format queries");
  } finally { fixture.cleanup(); }
}, 60_000);
