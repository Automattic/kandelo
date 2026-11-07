import { afterAll, beforeAll, expect, it } from "vitest";
import { compileSdkFixture } from "./support/compile-sdk-fixture";
import { loggingGraphicsGl } from "./support/logging-graphics-gl";
import { runCentralizedProgram } from "./centralized-test-helper";

let fixture: ReturnType<typeof compileSdkFixture>;
beforeAll(() => {
  fixture = compileSdkFixture(new URL("../../programs/egl_dri_fd_ownership.c", import.meta.url),
    ["-lEGL", "-lGLESv2", "-lgbm", "-ldrm"]);
}, 120_000);
afterAll(() => fixture?.cleanup());

it("keeps EGL cleanup and work off a closed and recycled render descriptor", async () => {
  const { gl } = loggingGraphicsGl();
  const result = await runCentralizedProgram({
    programPath: fixture.programPath,
    argv: ["egl_dri_fd_ownership"],
    timeout: 30_000,
    onKernelReady(kernel, pid) {
      kernel.gl.attachCanvas(pid, { getContext: () => gl } as unknown as OffscreenCanvas);
    },
  });
  expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.stdout.trim()).toBe("OK exact DRI file ownership");
}, 60_000);
