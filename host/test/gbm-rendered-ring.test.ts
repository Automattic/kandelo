import { expect, it } from "vitest";
import { compileSdkFixture } from "./support/compile-sdk-fixture";
import { runCentralizedProgram } from "./centralized-test-helper";
import { loggingGraphicsGl } from "./support/logging-graphics-gl";

// The Node GL double verifies allocation/ownership. Browser cases compile the
// same guest without this define and require actual retained pixels.
it.each(["wasm32", "wasm64"] as const)("retains rendered GBM buffer owners through the %s SDK", async arch => {
  const fixture = compileSdkFixture(new URL("./fixtures/gbm-rendered-ring.c", import.meta.url),
    ["-DGBM_RING_OWNERSHIP_ONLY", "-lEGL", "-lGLESv2", "-lgbm", "-ldrm"], { arch });
  try {
    const { gl, calls } = loggingGraphicsGl();
    const result = await runCentralizedProgram({ programPath: fixture.programPath,
      useDefaultRootfs: false, timeout: 20_000,
      onKernelReady(kernel, pid) {
        kernel.gl.attachCanvas(pid, { getContext: () => gl } as unknown as OffscreenCanvas);
      },
    });
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("OK GBM rendered fronts survive swaps, exhaustion and retirement");
    let previous = -1;
    for (const color of [[1,0,0,1],[0,1,0,1],[0,0,1,1],[1,1,0,1]]) {
      const index = calls.findIndex(([name,args], i) => i > previous && name === "clearColor"
        && color.every((value,c) => args[c] === value));
      expect(index).toBeGreaterThan(previous);
      previous = index;
    }
  } finally { fixture.cleanup(); }
}, 60_000);
