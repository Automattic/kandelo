import { expect, it } from "vitest";
import { compileSdkFixture } from "./support/compile-sdk-fixture";
import { runCentralizedProgram } from "./centralized-test-helper";
import { loggingGraphicsGl } from "./support/logging-graphics-gl";

it.each(["wasm32", "wasm64"] as const)("validates GLES hint state and five error families through the normal %s SDK", async arch => {
  const fixture = compileSdkFixture(new URL("./fixtures/gles-hints.c", import.meta.url),
    ["-lEGL", "-lGLESv2"], { arch });
  try {
    const { gl } = loggingGraphicsGl();
    const result = await runCentralizedProgram({
      programPath: fixture.programPath, useDefaultRootfs: false, timeout: 30_000,
      onKernelReady(kernel, pid) {
        kernel.gl.attachCanvas(pid, { getContext: () => gl } as unknown as OffscreenCanvas);
      },
    });
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    // Node verifies the actual linked C error paths with its existing GL
    // allocation double. Exact framebuffer pixels belong to browser cases.
    expect(result.stdout.trim().split("\n")).toEqual([
      "OK GLES string-query enums and cached state",
      "OK GLES object-generation counts",
      "OK GLES uniform negative locations: 19 setters",
      "OK GLES uniform matrix validation: 3 sizes",
      "OK GLES uniform vector validation: 8 setters",
      "OK GLES hints retain context state, conversions and invalid-enum errors",
    ]);
  } finally { fixture.cleanup(); }
}, 90_000);
