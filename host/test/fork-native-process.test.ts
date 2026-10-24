/** Native artifacts must survive real worker creation and child replay. */
import { describe, expect, it } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { compileSdkFixture } from "./support/compile-sdk-fixture";

const cases = [
  { source: "d_01_single_fork", markers: ["CHILD: ok", "PASS: D-01"] },
  { source: "d_05_fork_in_loop", markers: ["ITER 0", "PASS: D-05"] },
  { source: "d_07_fork_call_indirect", markers: ["CHILD: ok", "PASS: D-07"] },
  {
    source: "d_08_fork_stack_carryovers",
    markers: ["CHILD: ok x=21 y=35", "PASS: D-08"],
  },
  {
    source: "p_07_recursive_fork",
    markers: ["GRANDCHILD: ok", "PASS: P-07"],
  },
  {
    source: "k_01_fork_in_sigusr1_handler",
    markers: ["IN_HANDLER", "POST_HANDLER", "PASS: K-01"],
  },
  {
    source: "fork-from-thread",
    markers: ["GRANDCHILD_THREAD: ok", "CHILD_THREAD: grandchild=", "PASS"],
  },
  {
    source: "p_11_fork_continuation_enomem",
    maxPages: 384,
    markers: [
      "ROOT_CONTINUATION_ENOMEM: ok",
      "ROOT_NO_PHANTOM_CHILD: ok",
      "ROOT_PARENT_USABLE: ok",
      "CONTINUATION_ENOMEM: ok",
      "NO_PHANTOM_CHILD: ok",
      "CONTINUATION_PAGE_REUSED: ok",
      "RECOVERY_CHILD: ok",
      "PASS: P-11",
    ],
  },
];

describe.each(["wasm32", "wasm64"] as const)("native %s process artifacts", (arch) => {
  for (const fixture of cases) {
    it(fixture.source, async () => {
      // Use the ordinary SDK, compiler-facts and production post-optimizer.
      // Only backend selection differs from normal package instrumentation.
      const program = compileSdkFixture(
        new URL(`../../programs/${fixture.source}.c`, import.meta.url), [],
        { forkInstrument: true, arch, backend: "native" },
      );
      try {
        const result = await runCentralizedProgram({
          programPath: program.programPath,
          argv: [fixture.source],
          timeout: 30_000,
          maxPages: fixture.maxPages,
          // These programs need libc, syscalls and workers, but no rootfs files.
          useDefaultRootfs: false,
        });
        const diagnostic = `${result.stdout}\n${result.stderr}`;
        expect(result.exitCode, diagnostic).toBe(0);
        for (const marker of fixture.markers) {
          expect(result.stdout, diagnostic).toContain(marker);
        }
        expect(result.stdout, diagnostic).not.toContain("FAIL:");
        expect(result.stderr).toBe("");
      } finally {
        program.cleanup();
      }
    }, 120_000);
  }
});
