const EAGAIN = 11;

/** Why a vfork child stopped using its parent's image. */
export type VforkExactCompletionReason =
  | "exec"
  | "exit"
  | "signal"
  | "trap";

/**
 * The host's half of a vfork child's borrow of its parent's image.
 *
 * The kernel owns the lifetime itself: one borrower per address space, the
 * parked parent, and when the parent may resume. What stays here is what only
 * the host can know: the control slot it reserved, whether a child realm may
 * already have touched the shared memory, and whether it has told the kernel
 * how the borrow ended (see `endVforkBorrow` in process-lifecycle.ts).
 */
export interface VforkWorkspaceOwnership {
  /**
   * The process whose address space the slot was reserved from. A vfork child
   * borrows its parent's memory, so the release goes back to the parent's pid,
   * not the child's.
   */
  readonly ownerPid: number;
  readonly childPid: number;
  readonly slotAddr: number;
  released: boolean;
  /**
   * Set immediately before the child Worker starts. Before it, a failure is
   * an ordinary launch failure the kernel rolls back; after it, a child realm
   * may have touched the parent's memory and only containment is truthful.
   */
  childMayAccessMemory: boolean;
  /** Set once the kernel was told how the borrow ended. */
  borrowEnded: boolean;
}

/** A vfork launch the host could not admit; the parent's vfork gets EAGAIN. */
export class VforkAddressSpaceBusyError extends Error {
  readonly errno = EAGAIN;

  constructor(
    message = "address space already has an active vfork lifetime",
  ) {
    super(message);
    this.name = "VforkAddressSpaceBusyError";
  }
}
