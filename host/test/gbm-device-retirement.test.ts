import { expect, it } from "vitest";
import { compileSdkFixture } from "./support/compile-sdk-fixture";
import { runCentralizedProgram } from "./centralized-test-helper";

it.each(["wasm32", "wasm64"] as const)("retains GBM's retired device file through the normal %s SDK", async arch => {
  const fixture = compileSdkFixture(new URL("./fixtures/gbm-device-retirement.c", import.meta.url), ["-lgbm", "-ldrm"], { arch });
  try {
    const result = await runCentralizedProgram({
      programPath: fixture.programPath, useDefaultRootfs: false, timeout: 10_000,
    });
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout.trim()).toBe("OK GBM buffers retain their retired device file");
  } finally { fixture.cleanup(); }
}, 60_000);
