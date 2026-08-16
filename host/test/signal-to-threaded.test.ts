/**
 * A signal sent from another process must reach the handler of a
 * multi-threaded target.
 *
 * Waybar's shape (src/main.cpp catchSignals): the handler writes the
 * signal number to a pipe, a dedicated thread blocks in read() on that
 * pipe, and the main thread blocks in poll(). The omarchy theme switch
 * sends SIGUSR2 and expects the bar to reload its stylesheet.
 */
import { describe, expect, it } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { tryResolveBinary } from "../src/binary-resolver";

const binary = tryResolveBinary("programs/signal-to-threaded.wasm");

describe("signal to a multi-threaded process", () => {
  it.skipIf(!binary)(
    "runs the handler and wakes the reader thread",
    async () => {
      const result = await runCentralizedProgram({
        programPath: binary!,
        argv: ["signal-to-threaded"],
        timeout: 20_000,
      });

      const dump = `stdout=${result.stdout}\nstderr=${result.stderr}`;
      expect(result.stdout, dump).toContain("THREAD: signum=12");
      expect(result.stdout, dump).toContain("MAIN: woken");
      expect(result.stdout, dump).toContain("PASS: signal-to-threaded");
      expect(result.exitCode, dump).toBe(0);
    },
    30_000,
  );
});
