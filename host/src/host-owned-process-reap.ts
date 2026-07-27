const ESRCH = 3;
const ECHILD = 10;

type GetParentPid = (pid: number) => number;
type ReapExitedChild = (parentPid: number, childPid: number) => number;

export type HostOwnedProcessReapResult =
  | "reaped"
  | "already-reaped"
  | "guest-owned";

/**
 * Reap an exited process only when it is a direct child of the host-owned
 * ppid=0 host-parent sentinel.
 *
 * Rust remains authoritative for both the parent relationship and exited-state
 * check. Reading the parent first only distinguishes guest-owned children,
 * which must remain available to wait/waitpid, from host-owned children whose
 * failure to reap is a lifecycle error that must not be hidden as ECHILD.
 */
export function reapHostOwnedExitedProcess(
  kernelInstance: WebAssembly.Instance | null,
  pid: number,
): HostOwnedProcessReapResult {
  if (!kernelInstance) {
    throw new Error("kernel instance is unavailable while reaping a process");
  }

  const getParentPid = kernelInstance.exports.kernel_get_parent_pid;
  const reapExitedChild = kernelInstance.exports.kernel_reap_exited_child;
  if (typeof getParentPid !== "function") {
    throw new Error("kernel_get_parent_pid export is unavailable");
  }
  if (typeof reapExitedChild !== "function") {
    throw new Error("kernel_reap_exited_child export is unavailable");
  }

  const parentPid = (getParentPid as GetParentPid)(pid);
  if (parentPid === -ESRCH) return "already-reaped";
  if (parentPid < 0) {
    throw new Error(
      `kernel_get_parent_pid rejected process ${pid} with errno ${-parentPid}`,
    );
  }
  if (parentPid !== 0) return "guest-owned";

  // WHY: only Rust may atomically prove both ppid=0 ownership and Exited
  // state. Removing the process directly from TypeScript could discard a
  // running process or steal a guest parent's wait status.
  const result = (reapExitedChild as ReapExitedChild)(0, pid);
  if (result === 0) return "reaped";
  if (result === -ECHILD) {
    throw new Error(
      `kernel rejected host-owned process ${pid}; it is not an exited ppid=0 child`,
    );
  }
  throw new Error(
    `kernel_reap_exited_child rejected process ${pid} with errno ${-result}`,
  );
}
