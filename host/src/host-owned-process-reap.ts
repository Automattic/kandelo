type ReapExitedChild = (parentPid: number, childPid: number) => number;

/**
 * Reap an exited process only when it is a direct child of the host-owned
 * ppid=0 namespace.
 *
 * Rust owns both the parent relationship and the exited-state check. A guest
 * child therefore returns ECHILD here and remains available to its parent via
 * wait/waitpid.
 */
export function reapHostOwnedExitedProcess(
  kernelInstance: WebAssembly.Instance | null,
  pid: number,
): boolean {
  if (!kernelInstance) return false;

  const reapExitedChild = kernelInstance.exports.kernel_reap_exited_child;
  if (typeof reapExitedChild !== "function") {
    throw new Error("kernel_reap_exited_child export is unavailable");
  }

  return (reapExitedChild as ReapExitedChild)(0, pid) === 0;
}
