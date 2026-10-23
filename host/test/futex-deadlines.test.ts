import { expect, it } from "vitest";
import { compileSdkFixture } from "./support/compile-sdk-fixture";
import { runCentralizedProgram } from "./centralized-test-helper";

it("expires absolute futex deadlines in both clocks and preserves relative waits", async () => {
  const { programPath, cleanup } = compileSdkFixture(
    new URL("./fixtures/futex-deadlines.c", import.meta.url),
  );
  try {
    const result = await runCentralizedProgram({
      programPath, argv: ["futex-deadlines"], timeout: 15_000,
      useDefaultRootfs: false,
    });
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("FUTEX_DEADLINES_PASS");
    expect(result.stderr).toBe("");
  } finally { cleanup(); }
}, 120_000);
