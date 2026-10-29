import { expect, it } from "vitest";
import { compileSdkFixture } from "./support/compile-sdk-fixture";
import { runCentralizedProgram } from "./centralized-test-helper";
import { loggingGraphicsGl } from "./support/logging-graphics-gl";

it.each(["wasm32", "wasm64"] as const)("validates GLES hint state and six error families through the normal %s SDK", async arch => {
  const fixture = compileSdkFixture(new URL("./fixtures/gles-hints.c", import.meta.url),
    ["-lEGL", "-lGLESv2"], { arch });
  try {
    // This allocation double explicitly models the fixture's active uniforms;
    // shader compilation, values and pixels are exercised by real browsers.
    const { gl } = loggingGraphicsGl([
      ...[0x1406,0x8b50,0x8b51,0x8b52].map((type,i)=>({name:`f${i+1}`,type,size:1})),
      ...[0x1404,0x8b53,0x8b54,0x8b55].map((type,i)=>({name:`i${i+1}`,type,size:1})),
      ...[0x8b5a,0x8b5b,0x8b5c].map((type,i)=>({name:`m${i+2}`,type,size:1})),
      {name:"tail[0]",type:0x8b52,size:3},
    ]);
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
      "OK GLES positive uniforms: type, zero count and array tails",
      "OK GLES inactive uniforms require current program: 19 setters",
      "OK GLES hints retain context state, conversions and invalid-enum errors",
    ]);
  } finally { fixture.cleanup(); }
}, 90_000);
