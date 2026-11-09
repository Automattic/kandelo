import { afterAll, beforeAll, expect, it } from "vitest";
import { compileSdkFixture } from "./support/compile-sdk-fixture";
import { loggingGraphicsGl } from "./support/logging-graphics-gl";
import { runCentralizedProgram } from "./centralized-test-helper";

const fixtures = new Map<string, ReturnType<typeof compileSdkFixture>>();
beforeAll(() => {
  for (const arch of ["wasm32", "wasm64"] as const) {
    fixtures.set(arch, compileSdkFixture(new URL("../../programs/egl_fork_reinitialize.c", import.meta.url),
      ["-pthread", "-lEGL", "-lGLESv2", "-lgbm", "-ldrm"], { arch, forkInstrument: true }));
  }
}, 120_000);
afterAll(() => { for (const fixture of fixtures.values()) fixture.cleanup(); });

for (const arch of ["wasm32", "wasm64"] as const) {
  for (const scenario of [
    { mode: "protocol", label: "creates a fresh child renderer and retains inherited image storage",
      expected: "OK EGL child renderer and inherited storage" },
    { mode: "borrow-protocol", label: "retires vanished peer image borrows and preserves caller/storage ownership",
      expected: "OK target image borrow fork custody" },
  ] as const) {
    it(`${arch} ${scenario.label}`, async () => {
      // This is target driver/TLS/fork ownership evidence with real kernel BO
      // exports and mapped bytes. The Node renderer records GL protocol; only
      // the matching three-engine browser cases judge rendered pixels.
      const { gl } = loggingGraphicsGl();
      const result = await runCentralizedProgram({
        programPath: fixtures.get(arch)!.programPath,
        argv: ["egl_fork_reinitialize", scenario.mode],
        timeout: 90_000,
        onKernelReady(kernel, pid) {
          kernel.gl.attachCanvas(pid, { getContext: () => gl } as unknown as OffscreenCanvas);
        },
      });
      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout.trim()).toBe(scenario.expected);
      expect(result.stderr).toBe("");
    }, 120_000);
  }
}
