import { expect, it } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { compileSdkFixture } from "./support/compile-sdk-fixture";

it("passes live GBM native window sizes through the SDK's ordinary EGL path", async () => {
  const { programPath, cleanup } = compileSdkFixture(
    new URL("./fixtures/gbm-native-window.c", import.meta.url),
    ["-lEGL", "-lGLESv2", "-lgbm", "-ldrm"],
  );
  try {
    const result = await runCentralizedProgram({
      programPath, argv: ["gbm-native-window"], useDefaultRootfs: false,
    });
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("EGL handoff, retirement: ok");
  } finally { cleanup(); }
}, 30_000);
