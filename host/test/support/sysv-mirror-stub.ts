/**
 * Test double for the kernel's SysV shared-memory byte-coherence mirror.
 *
 * The mirror is Rust-owned (`SharedMappingTable` in
 * `crates/runtime-core/src/memory.rs`), and its merge/refresh/version protocol
 * is covered by Rust unit tests there. What these host tests still own is the
 * *contract between host and kernel*: which entry point is called, with which
 * arguments, in which order relative to `mmap`/`munmap`, `shmat`/`shmdt` and
 * the exact-entry gate, and what the host does when one of them refuses.
 *
 * So this stub keeps just enough state to answer the two counting entry points
 * truthfully — the host's syscall-boundary early-out depends on them — and
 * records every call for ordering assertions. It deliberately does NOT
 * reimplement the byte protocol: a test that needs to assert on published
 * bytes belongs in Rust.
 */

/** One attachment as the kernel would record it. */
export interface StubSysvAttachment {
  segId: number;
  size: number;
  readOnly: boolean;
}

export interface SysvMirrorStubCall {
  readonly name: string;
  readonly args: readonly unknown[];
}

export interface SysvMirrorStubOptions {
  /**
   * Force a negative errno from one entry point, to exercise the host's
   * refusal path without needing a kernel that can actually fail.
   */
  readonly fail?: Partial<Record<SysvMirrorEntryName, number>>;
  /**
   * Stand in for the one visible side effect of a successful `track`: the
   * kernel seeds the process's mapped range from the segment's authoritative
   * bytes. Tests that assert the guest saw those bytes supply this; tests that
   * only care about call ordering leave it out.
   *
   * Runs before the attachment is recorded, matching the kernel, where a
   * failed seed means no attachment is tracked at all.
   */
  readonly seedProcessBytes?: (
    pid: number,
    addr: number,
    segId: number,
    size: number,
  ) => void;
}

export type SysvMirrorEntryName =
  | "kernel_shared_mapping_sysv_track"
  | "kernel_shared_mapping_sysv_sync_process"
  | "kernel_shared_mapping_sysv_sync_segment"
  | "kernel_shared_mapping_sysv_publish_mapping"
  | "kernel_shared_mapping_sysv_drop_mapping"
  | "kernel_shared_mapping_sysv_release_process"
  | "kernel_shared_mapping_sysv_inherit"
  | "kernel_shared_mapping_sysv_active_pid_count"
  | "kernel_shared_mapping_sysv_process_count";

/** Every entry point the host may resolve; harnesses must expose all of them. */
export const SYSV_MIRROR_EXPORT_NAMES: readonly SysvMirrorEntryName[] = [
  "kernel_shared_mapping_sysv_track",
  "kernel_shared_mapping_sysv_sync_process",
  "kernel_shared_mapping_sysv_sync_segment",
  "kernel_shared_mapping_sysv_publish_mapping",
  "kernel_shared_mapping_sysv_drop_mapping",
  "kernel_shared_mapping_sysv_release_process",
  "kernel_shared_mapping_sysv_inherit",
  "kernel_shared_mapping_sysv_active_pid_count",
  "kernel_shared_mapping_sysv_process_count",
];

export interface SysvMirrorStub {
  /** pid -> attach address -> attachment, as the kernel would hold it. */
  readonly attachments: Map<number, Map<number, StubSysvAttachment>>;
  /** Every entry-point call, in order. */
  readonly calls: SysvMirrorStubCall[];
  /** Drop-in `kernelExports` entries. */
  readonly exports: Record<string, unknown>;
  /** Seed an attachment without going through `track`. */
  seed(pid: number, addr: number, attachment: StubSysvAttachment): void;
  /** Attachment count for one process, as the kernel would report it. */
  count(pid: number): number;
  /** Calls to one entry point, in order. */
  callsTo(name: SysvMirrorEntryName): readonly SysvMirrorStubCall[];
}

const EIO = 5;

export function createSysvMirrorStub(
  options: SysvMirrorStubOptions = {},
): SysvMirrorStub {
  const attachments = new Map<number, Map<number, StubSysvAttachment>>();
  const calls: SysvMirrorStubCall[] = [];
  const fail = options.fail ?? {};

  const record = (name: SysvMirrorEntryName, args: unknown[]): number | null => {
    calls.push({ name, args });
    const forced = fail[name];
    return typeof forced === "number" ? forced : null;
  };

  const pidMap = (pid: number): Map<number, StubSysvAttachment> => {
    let map = attachments.get(pid);
    if (!map) {
      map = new Map();
      attachments.set(pid, map);
    }
    return map;
  };

  const retire = (pid: number): void => {
    if (attachments.get(pid)?.size === 0) attachments.delete(pid);
  };

  const stub: SysvMirrorStub = {
    attachments,
    calls,
    seed(pid, addr, attachment) {
      pidMap(pid).set(addr, { ...attachment });
    },
    count(pid) {
      return attachments.get(pid)?.size ?? 0;
    },
    callsTo(name) {
      return calls.filter((call) => call.name === name);
    },
    exports: {
      kernel_shared_mapping_sysv_track: (
        pid: number,
        addr: number | bigint,
        segId: number,
        size: number,
        readOnly: number,
      ): number => {
        const forced = record("kernel_shared_mapping_sysv_track", [
          pid,
          addr,
          segId,
          size,
          readOnly,
        ]);
        if (forced !== null) return forced;
        options.seedProcessBytes?.(pid, Number(addr), segId, size);
        pidMap(pid).set(Number(addr), {
          segId,
          size,
          readOnly: readOnly !== 0,
        });
        return 0;
      },
      kernel_shared_mapping_sysv_sync_process: (
        pid: number,
        force: number,
      ): number =>
        record("kernel_shared_mapping_sysv_sync_process", [pid, force]) ?? 0,
      kernel_shared_mapping_sysv_sync_segment: (segId: number): number =>
        record("kernel_shared_mapping_sysv_sync_segment", [segId]) ?? 0,
      kernel_shared_mapping_sysv_publish_mapping: (
        pid: number,
        addr: number | bigint,
        segId: number,
        size: number,
      ): number => {
        const forced = record("kernel_shared_mapping_sysv_publish_mapping", [
          pid,
          addr,
          segId,
          size,
        ]);
        if (forced !== null) return forced;
        const mapping = attachments.get(pid)?.get(Number(addr));
        // The kernel refuses when its two authorities disagree; mirror that,
        // because the host's shmdt path depends on the refusal.
        if (!mapping || mapping.segId !== segId || mapping.size !== size) {
          return -EIO;
        }
        return 0;
      },
      kernel_shared_mapping_sysv_drop_mapping: (
        pid: number,
        addr: number | bigint,
        segId: number,
        size: number,
      ): number => {
        const forced = record("kernel_shared_mapping_sysv_drop_mapping", [
          pid,
          addr,
          segId,
          size,
        ]);
        if (forced !== null) return forced;
        const mapping = attachments.get(pid)?.get(Number(addr));
        if (!mapping || mapping.segId !== segId || mapping.size !== size) {
          return -EIO;
        }
        attachments.get(pid)!.delete(Number(addr));
        retire(pid);
        return 0;
      },
      kernel_shared_mapping_sysv_release_process: (
        pid: number,
        publish: number,
        detach: number,
      ): number => {
        const forced = record("kernel_shared_mapping_sysv_release_process", [
          pid,
          publish,
          detach,
        ]);
        if (forced !== null) return forced;
        attachments.delete(pid);
        return 0;
      },
      kernel_shared_mapping_sysv_inherit: (
        parentPid: number,
        childPid: number,
        childMemoryLen: bigint,
      ): number => {
        const forced = record("kernel_shared_mapping_sysv_inherit", [
          parentPid,
          childPid,
          childMemoryLen,
        ]);
        if (forced !== null) return forced;
        const parent = attachments.get(parentPid);
        if (!parent || parent.size === 0) return 0;
        const child = pidMap(childPid);
        for (const [addr, attachment] of parent) {
          child.set(addr, { ...attachment });
        }
        return 0;
      },
      kernel_shared_mapping_sysv_active_pid_count: (): number => {
        calls.push({ name: "kernel_shared_mapping_sysv_active_pid_count", args: [] });
        return attachments.size;
      },
      kernel_shared_mapping_sysv_process_count: (pid: number): number => {
        calls.push({ name: "kernel_shared_mapping_sysv_process_count", args: [pid] });
        return attachments.get(pid)?.size ?? 0;
      },
    },
  };

  return stub;
}
