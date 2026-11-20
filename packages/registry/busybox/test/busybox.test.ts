/**
 * BusyBox's process tools find, signal and separate real Kandelo processes
 * through procfs and the kernel's process table.
 *
 * dash runs each applet by its own name, as an installed link would, and
 * coreutils' sleep is the process they act on:
 *
 *   - pgrep matches by exact name and by parent PID, and pidof by name;
 *   - pkill and killall deliver SIGTERM, which wait reports as status 143;
 *   - setsid runs its command in a new session, where pgrep -s 0 no
 *     longer sees the shell's own sleep, and the shell still does.
 *
 * flock locks an open file description through the kernel's flock(2):
 * a second open of the file cannot take the lock with -n while the first
 * holds it, can after -u, and a blocking flock waits until the holder
 * unlocks.
 *
 * Requires the normal busybox, dash and coreutils package artifacts. A
 * missing artifact is a provisioning failure, not passing or skipped
 * coverage.
 */
import { describe, expect, it } from "vitest";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";
import { resolveBinary } from "../../../../host/src/binary-resolver";

const busybox = resolveBinary("programs/busybox.wasm");
const dash = resolveBinary("programs/dash.wasm");
const coreutils = resolveBinary("programs/coreutils.wasm");

const SCRIPT = [
  "sleep 30 &",
  "first=$!",
  '[ "$(pgrep -x sleep)" = "$first" ] && echo pgrep-name-ok',
  '[ "$(pgrep -P $$ -x sleep)" = "$first" ] && echo pgrep-parent-ok',
  '[ "$(pidof sleep)" = "$first" ] && echo pidof-ok',
  "setsid pgrep -s 0 -x sleep",
  'echo "new-session-status=$?"',
  '[ "$(pgrep -s 0 -x sleep)" = "$first" ] && echo same-session-ok',
  "pkill -x sleep",
  "wait $first",
  'echo "pkill-status=$?"',
  "sleep 30 &",
  "second=$!",
  "killall sleep",
  "wait $second",
  'echo "killall-status=$?"',
].join("\n");

const FLOCK_SCRIPT = [
  "exec 9>/tmp/lock",
  "flock 9 && echo hold-ok",
  "(exec 8>/tmp/lock; flock -n 8)",
  'echo "held-status=$?"',
  "flock -u 9",
  "(exec 8>/tmp/lock; flock -n 8) && echo unlock-ok",
  "flock 9",
  "(exec 8>/tmp/lock; flock 8; echo waiter-locked) &",
  "waiter=$!",
  "sleep 1",
  "echo releasing",
  "flock -u 9",
  "wait $waiter",
].join("\n");

describe("busybox — process tools and flock on the Kandelo kernel", () => {
  it(
    "finds, signals and separates processes with pgrep, pidof, pkill, killall and setsid",
    async () => {
      const execPrograms = new Map<string, string>([["/bin/sleep", coreutils]]);
      for (const applet of ["pgrep", "pkill", "pidof", "killall", "setsid"]) {
        execPrograms.set(`/bin/${applet}`, busybox);
      }
      const result = await runCentralizedProgram({
        programPath: dash,
        argv: ["dash", "-c", SCRIPT],
        env: ["PATH=/bin", "HOME=/tmp"],
        execPrograms,
        timeout: 60_000,
      });
      const output = `stdout=${result.stdout}\nstderr=${result.stderr}`;

      expect(result.exitCode, output).toBe(0);
      expect(result.stdout, output).toBe([
        "pgrep-name-ok",
        "pgrep-parent-ok",
        "pidof-ok",
        "new-session-status=1",
        "same-session-ok",
        "pkill-status=143",
        "killall-status=143",
        "",
      ].join("\n"));
    },
    90_000,
  );

  it(
    "locks, refuses, unlocks and waits on a file with flock",
    async () => {
      const result = await runCentralizedProgram({
        programPath: dash,
        argv: ["dash", "-c", FLOCK_SCRIPT],
        env: ["PATH=/bin", "HOME=/tmp"],
        execPrograms: new Map([["/bin/flock", busybox], ["/bin/sleep", coreutils]]),
        timeout: 60_000,
      });
      const output = `stdout=${result.stdout}\nstderr=${result.stderr}`;

      expect(result.exitCode, output).toBe(0);
      expect(result.stdout, output).toBe([
        "hold-ok",
        "held-status=1",
        "unlock-ok",
        "releasing",
        "waiter-locked",
        "",
      ].join("\n"));
    },
    90_000,
  );
});
