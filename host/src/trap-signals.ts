import { SIGNAL_EXIT_STATUS_BASE, TRAP_SIGNALS } from "./generated/abi";

/**
 * Turning a Wasm trap into a POSIX signal is platform policy, and it lives in
 * `wasm_posix_shared::trap_signal` — one table, shared by Node, the browser,
 * and `crates/host-native`, reached from here through the kernel's
 * `kernel_classify_wasm_trap_signal` export.
 *
 * What stays here is the part only a JavaScript host can do: recovering the
 * text. `WebAssembly` reports a trap by throwing a `RuntimeError` whose
 * `message` is engine-defined prose, and only this host holds that object.
 * Once the text exists it is bytes, so the decision travels to Rust rather
 * than being made twice.
 */

export const SIGILL = TRAP_SIGNALS.SIGILL;
export const SIGFPE = TRAP_SIGNALS.SIGFPE;
export const SIGSEGV = TRAP_SIGNALS.SIGSEGV;

/** Classifies an engine trap message into a signal number, or 0 for "not a trap". */
export type WasmTrapClassifier = (text: string) => number;

/**
 * Flatten a rejection reason into the text a classifier can read.
 *
 * The stack is included because some engines put the trap wording only there
 * — V8's `RuntimeError` message is terse while the stack names the faulting
 * instruction.
 */
export function crashText(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.stack ? `${reason.message}\n${reason.stack}` : reason.message;
  }
  return String(reason ?? "");
}

/**
 * The wait status a shell reports for a process killed by `signum`.
 *
 * `SIGNAL_EXIT_STATUS_BASE` is generated from
 * `wasm_posix_shared::trap_signal::signal_exit_status`, so the convention is
 * stated once, in Rust.
 */
export function signalExitStatus(signum: number): number {
  return SIGNAL_EXIT_STATUS_BASE + signum;
}

/**
 * The signal a trap raised, or `fallback` when the text is not a trap.
 *
 * `SIGSEGV` is the default because an unrecognised failure inside a running
 * guest is far more often a memory fault than anything else, and because it is
 * what every caller here has always used.
 */
export function classifiedSignalOrFallback(
  classify: WasmTrapClassifier,
  reason: unknown,
  fallback: number = SIGSEGV,
): number {
  const text = crashText(reason);
  if (!text) return fallback;
  const signum = classify(text);
  return signum > 0 ? signum : fallback;
}

/**
 * The wait status for a classified trap, or `null` when the reason is not a
 * trap at all.
 *
 * The `null` is load-bearing: a `CompileError`, a `LinkError`, or an ABI
 * mismatch is a launch failure, and reporting one as a fatal signal would tell
 * the guest's parent that a program ran and faulted when it never started.
 */
export function classifiedTrapExitStatus(
  classify: WasmTrapClassifier,
  reason: unknown,
): number | null {
  const text = crashText(reason);
  if (!text) return null;
  const signum = classify(text);
  return signum > 0 ? signalExitStatus(signum) : null;
}
