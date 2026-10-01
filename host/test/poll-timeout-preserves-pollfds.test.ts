/**
 * A poll() that outlives its first pass is completed by the host from a
 * timer, without running the syscall through the kernel again. That
 * completion must not copy the kernel's shared scratch buffer back over the
 * caller's pollfd array: by the time the timer fires, the scratch holds the
 * data of whatever syscall ran last, in any process.
 *
 * dbus-daemon exposed this in the omarchy browser demo. Its 30-second auth
 * timeout expired, the expiry wrote a foreign process's bytes over the
 * daemon's pollfd array, and the main loop then polled a descriptor the
 * daemon never opened — "invalid request, socket fd 12 not open", thousands
 * of times a second, with every bus client left unserved.
 */
import { describe, expect, it } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { tryResolveBinary } from "../src/binary-resolver";

const binary = tryResolveBinary("programs/poll-timeout-preserves-pollfds.wasm");

describe("poll timeout", () => {
  it.skipIf(!binary)(
    "leaves the caller's pollfd array intact while another process runs syscalls",
    async () => {
      const result = await runCentralizedProgram({
        programPath: binary!,
        argv: ["poll-timeout-preserves-pollfds"],
        timeout: 20_000,
      });

      const dump = `stdout=${result.stdout}\nstderr=${result.stderr}`;
      expect(result.stdout, dump).toMatch(/PARENT: rc=0 fd=\d+ events=1 revents=0/);
      expect(result.stdout, dump).toContain("PASS");
      expect(result.exitCode, dump).toBe(0);
    },
    30_000,
  );
});
