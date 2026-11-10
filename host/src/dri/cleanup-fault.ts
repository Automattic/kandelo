/**
 * A DRI/GL release the host could not finish after the kernel retired the
 * object (close, munmap, exec, exit, DRM_IOCTL_MODE_RMFB, master drop).
 *
 * WHY THIS IS FATAL. The kernel has already moved on: it reuses the address
 * range or identity the object named, and no syscall can report the failure
 * to the process that caused it. Whatever the host still holds -- a mapping
 * that would copy a reused range into the buffer, a final writeback that
 * never reached it, a native GPU object nothing will delete -- can never be
 * released again, so the system is no longer what its state says it is. The
 * host reports the fault through `KernelCallbacks.onHostFault`, which stops
 * the kernel instance, and throws so the import cannot return success.
 */
export class DriCleanupFault extends Error {
  constructor(
    readonly operation: string,
    readonly pid: number,
    readonly object: string,
    readonly reason: string,
    cause?: unknown,
  ) {
    super(`DRI cleanup fault: ${operation} of ${object} for pid ${pid}: ${reason}`,
      cause === undefined ? undefined : { cause });
    this.name = "DriCleanupFault";
  }
}
