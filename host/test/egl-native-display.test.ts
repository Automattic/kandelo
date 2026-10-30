import { afterAll, beforeAll, expect, it } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { compileSdkFixture } from "./support/compile-sdk-fixture";
import { loggingGraphicsGl } from "./support/logging-graphics-gl";

let fixture: ReturnType<typeof compileSdkFixture>;
beforeAll(() => {
  fixture = compileSdkFixture(new URL("./fixtures/egl-native-display.c", import.meta.url),
    ["-lEGL", "-lGLESv2", "-lgbm", "-ldrm"]);
}, 120_000);
afterAll(() => fixture?.cleanup());

it("keeps native displays separate and retains DRM files until current contexts retire", async () => {
  const { gl } = loggingGraphicsGl();
  const result = await runCentralizedProgram({
    programPath: fixture.programPath,
    timeout: 30_000,
    onKernelReady(kernel, pid) {
      kernel.gl.attachCanvas(pid, { getContext: () => gl } as unknown as OffscreenCanvas);
    },
  });
  expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.stdout.trim()).toBe("OK native EGL display identity and retained DRM files");
}, 60_000);
