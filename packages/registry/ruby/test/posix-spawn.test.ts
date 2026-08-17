import { describe, expect, it } from "vitest";

import { tryResolveBinary } from "../../../../host/src/binary-resolver";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";
import {
  RUBY_POSIX_SPAWN_CASES,
  RUBY_POSIX_SPAWN_EXECUTABLE,
} from "./posix-spawn-contract";

const rubyBinary = tryResolveBinary("programs/ruby/ruby.wasm");

describe.skipIf(!rubyBinary)("Ruby Process.spawn on Kandelo", () => {
  for (const spawnCase of RUBY_POSIX_SPAWN_CASES) {
    it(`${spawnCase.marker} preserves process semantics`, async () => {
      const processEvents: Array<{
        kind: "spawn" | "exec" | "exit";
        pid: number;
        ppid?: number;
      }> = [];
      const result = await runCentralizedProgram({
        programPath: rubyBinary!,
        argv: ["ruby", "--disable-gems", "-e", spawnCase.program],
        env: ["HOME=/tmp", "TMPDIR=/tmp", "K_TEST=inherited-env-ok"],
        execPrograms: new Map([
          [RUBY_POSIX_SPAWN_EXECUTABLE, rubyBinary!],
        ]),
        captureForkCount: true,
        onProcessEvent: (event) => processEvents.push(event),
        useDefaultRootfs: false,
        timeout: 180_000,
      });

      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(`${spawnCase.marker}\n`);
      expect(result.hostDiagnostics).toEqual([]);
      expect(result.forkCountSamples).toEqual([
        spawnCase.expectedForkCount,
      ]);
      const rootPid = processEvents.find((event) => event.kind === "spawn")?.pid;
      const childPid = processEvents.find(
        (event) => event.kind === "spawn" && event.ppid === rootPid,
      )?.pid;
      expect(rootPid).toBeDefined();
      expect(childPid).toBeDefined();
      expect(
        processEvents
          .filter((event) => event.pid === childPid)
          .map((event) => event.kind),
      ).toEqual(spawnCase.expectedChildEvents);
    }, 240_000);
  }
});
