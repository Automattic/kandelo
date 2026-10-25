import { expect, it } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { loggingGraphicsGl, allocatedTexture } from "./support/logging-graphics-gl";
import { compileSdkFixture } from "./support/compile-sdk-fixture";

it("passes live GBM native window sizes through the SDK's ordinary EGL path", async () => {
  const { programPath, cleanup } = compileSdkFixture(
    new URL("./fixtures/gbm-native-window.c", import.meta.url),
    ["-lEGL", "-lGLESv2", "-lgbm", "-ldrm"],
  );
  try {
    const { gl, calls } = loggingGraphicsGl();
    const result = await runCentralizedProgram({
      programPath, argv: ["gbm-native-window"], useDefaultRootfs: false,
      onKernelReady(kernel, pid) {
        kernel.gl.attachCanvas(pid, { getContext: () => gl } as unknown as OffscreenCanvas);
      },
    });
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("EGL handoff, retirement: ok");
    expect(allocatedTexture(calls, 800, 600)).toBeInstanceOf(Object);
  } finally { cleanup(); }
}, 30_000);
