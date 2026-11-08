import { afterAll, beforeAll, expect, it } from "vitest";
import { compileSdkFixture } from "./support/compile-sdk-fixture";
import { runCentralizedProgram } from "./centralized-test-helper";
const fixtures = new Map<string, ReturnType<typeof compileSdkFixture>>();
beforeAll(() => {
  for (const arch of ["wasm32", "wasm64"] as const) {
    fixtures.set(arch, compileSdkFixture(new URL("../../programs/gbm_fork_ownership.c", import.meta.url), ["-lgbm", "-ldrm"], { arch, forkInstrument: true }));
  }
}, 120_000);
afterAll(() => { for (const fixture of fixtures.values()) fixture.cleanup(); });
for (const arch of ["wasm32", "wasm64"] as const) {
for (const mode of ["inherited", "mapping-replacement", "mapping-partial", "mapping-middle", "mapping-same-bo", "waitpid", "waitid"] as const) {
it(`${arch} preserves exact C GBM custody through ${mode}`, async () => {
  const result = await runCentralizedProgram({ programPath: fixtures.get(arch)!.programPath,
    // The fixture uses kernel device/proc mounts, matching the browser's
    // minimal image; an unrelated old rootfs must not supply its runtime.
    useDefaultRootfs: false, argv: ["gbm_fork_ownership", mode], timeout: 45_000 });
  expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.stdout.trim()).toBe(mode === "inherited"
    ? "OK inherited GBM storage and custody" : mode === "waitpid" || mode === "waitid"
      ? `OK GBM child publication through ${mode}` : "OK exact GBM mapping replacement custody");
  expect(result.stderr).toBe("");
}, 60_000);
}
}
