import { describe, expect, it } from "vitest";
import { resolveBinary } from "../src/binary-resolver";
import { runCentralizedProgram } from "./centralized-test-helper";

const programs = [
  ["wasm32", resolveBinary("programs/wasm32/scm-rights-semantics.wasm")],
  ["wasm64", resolveBinary("programs/wasm64/scm-rights-semantics.wasm")],
] as const;

const semanticCases = [
  {
    name: "stream",
    markers: ["SCM_RIGHTS_STREAM_BARRIER_PASS"],
  },
  {
    name: "peek",
    markers: ["SCM_RIGHTS_STREAM_PEEK_PASS"],
  },
  {
    name: "datagram",
    markers: ["SCM_RIGHTS_DGRAM_ZERO_AND_PEEK_PASS"],
  },
  {
    name: "trunc",
    markers: ["SCM_RIGHTS_DGRAM_TRUNC_PASS"],
  },
  {
    name: "domain",
    markers: ["SCM_RIGHTS_NON_UNIX_REJECTION_PASS"],
  },
  {
    name: "representability",
    markers: ["SCM_RIGHTS_UNREPRESENTABLE_REJECTION_PASS"],
  },
  {
    name: "zero-iov-stream",
    markers: ["SCM_RIGHTS_STREAM_ZERO_IOV_PASS"],
  },
  {
    name: "cloexec",
    markers: [
      "SCM_RIGHTS_CLOEXEC_FLAG_PASS",
      "SCM_RIGHTS_CLOEXEC_EXEC_PASS",
      "SCM_RIGHTS_SEMANTICS_PASS",
    ],
  },
] as const;

const runtimeCases = semanticCases.flatMap(({ name, markers }) =>
  programs.map(
    ([arch, program]) => [name, arch, program, markers] as const,
  ),
);

describe("SCM_RIGHTS message semantics", () => {
  it.each(runtimeCases)(
    "preserves %s semantics in the actual %s binary",
    async (caseName, _arch, program, expectedMarkers) => {
      const result = await runCentralizedProgram({
        programPath: program,
        argv: ["/bin/scm-rights-semantics", "--case", caseName],
        execPrograms: new Map([["/bin/scm-rights-semantics", program]]),
        useDefaultRootfs: false,
        timeout: 30_000,
      });

      expect(
        result.exitCode,
        `stderr=${result.stderr}\nstdout=${result.stdout}`,
      ).toBe(0);
      for (const marker of expectedMarkers) {
        expect(result.stdout).toContain(marker);
      }
      expect(result.stderr).toBe("");
      expect(result.hostDiagnostics).toEqual([]);
    },
  );
});
