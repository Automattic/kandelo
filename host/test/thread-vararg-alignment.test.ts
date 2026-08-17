/**
 * The host installs a new thread's `__stack_pointer` from the value musl's
 * pthread_create computed, and that value is only 4-byte aligned: musl
 * rounds the stack to sizeof(uintptr_t) and then subtracts `struct
 * start_args`. Clang builds every callee frame from an SP it assumes is
 * 16-byte aligned, so on a thread started that way a variadic caller
 * stores each 64-bit argument four bytes away from where va_arg reads it.
 *
 * Waybar exposed this in the omarchy demo. Its GDBus client runs on a
 * thread, GIO writes the EXTERNAL auth identity with
 * g_strdup_printf("%lli", (gint64) uid), and the bar sent the high half of
 * its uid — "AUTH EXTERNAL 30" at uid 1000. dbus-daemon answered
 * "REJECTED EXTERNAL" and the bar exited.
 */
import { describe, expect, it } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { tryResolveBinary } from "../src/binary-resolver";

const binary = tryResolveBinary("programs/thread-vararg-alignment.wasm");

describe("thread stack alignment", () => {
  it.skipIf(!binary)(
    "keeps a 64-bit vararg intact on a thread",
    async () => {
      const result = await runCentralizedProgram({
        programPath: binary!,
        argv: ["thread-vararg-alignment"],
        timeout: 20_000,
      });

      const dump = `stdout=${result.stdout}\nstderr=${result.stderr}`;
      expect(result.stdout, dump).toContain("MAIN: 1000");
      expect(result.stdout, dump).toContain("THREAD: 1000");
      expect(result.stdout, dump).toContain("PASS");
      expect(result.exitCode, dump).toBe(0);
    },
    30_000,
  );
});
