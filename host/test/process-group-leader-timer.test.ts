/**
 * A process group leader that exits with an armed POSIX timer, while another
 * member of its group still runs, releases the timer once.
 *
 * coreutils timeout makes itself a group leader, arms a timer, and exits
 * when its child does. The child leaves `sleep` running in the group, so
 * dash's reap of timeout keeps a limbo record for the group id. The host
 * retires timeout's timer after that reap; the limbo record is not the
 * process and must not answer for its timers.
 *
 * Requires the normal dash and coreutils package artifacts. A missing
 * artifact is a provisioning failure, not passing or skipped coverage.
 */
import { describe, expect, it } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { resolveBinary } from "../src/binary-resolver";

const dash = resolveBinary("programs/dash.wasm");
const coreutils = resolveBinary("programs/coreutils.wasm");

describe("process group leader POSIX timer", () => {
  it(
    "retires the timer of a reaped leader whose group still has a member",
    async () => {
      const result = await runCentralizedProgram({
        programPath: dash,
        argv: ["dash", "-c", "timeout 2 dash -c 'sleep 3 & exit 0'; echo status=$?"],
        env: ["PATH=/bin", "HOME=/tmp"],
        execPrograms: new Map([["/bin/dash", dash], ["/bin/sleep", coreutils], ["/bin/timeout", coreutils]]),
        timeout: 30_000,
      });
      const output = `stdout=${result.stdout}\nstderr=${result.stderr}`;

      expect(result.exitCode, output).toBe(0);
      expect(result.stdout, output).toBe("status=0\n");
    },
    60_000,
  );
});
