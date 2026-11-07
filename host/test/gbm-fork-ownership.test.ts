import { afterAll, beforeAll, expect, it } from "vitest";
import { compileSdkFixture } from "./support/compile-sdk-fixture";
import { runCentralizedProgram } from "./centralized-test-helper";
let fixture: ReturnType<typeof compileSdkFixture>;
beforeAll(() => {
  fixture = compileSdkFixture(new URL("../../programs/gbm_fork_ownership.c", import.meta.url), ["-lgbm", "-ldrm"], { forkInstrument: true });
}, 120_000);
afterAll(() => fixture?.cleanup());
it("preserves inherited C GBM objects through nested fork and child retirement", async () => {
  const result = await runCentralizedProgram({ programPath: fixture.programPath, argv: ["gbm_fork_ownership"], timeout: 45_000 });
  expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.stdout.trim()).toBe("OK inherited GBM storage and custody");
  expect(result.stderr).toBe("");
}, 60_000);
