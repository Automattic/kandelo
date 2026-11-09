import { afterAll, beforeAll, expect, it } from "vitest";
import { compileSdkFixture } from "./support/compile-sdk-fixture";
import { runCentralizedProgram } from "./centralized-test-helper";

let fixture: ReturnType<typeof compileSdkFixture>;
beforeAll(() => {
  fixture = compileSdkFixture(new URL("../../programs/graphics_fork_metadata_mutex.c", import.meta.url), ["-pthread"], { forkInstrument: true });
}, 120_000);
afterAll(() => fixture?.cleanup());

for (const [name, output] of [
  ["contention", "OK metadata contention"],
  ["locked-fork", "OK metadata locked fork"],
  ["signal-wake", "OK metadata signal wake"],
]) {
  it(`parks private graphics metadata locks correctly: ${name}`, async () => {
    const result = await runCentralizedProgram({
      programPath: fixture.programPath,
      argv: ["graphics_fork_metadata_mutex", name],
      timeout: 45_000,
    });
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout.trim()).toBe(output);
    expect(result.stderr).toBe("");
  }, 60_000);
}
