/**
 * Test double for the kernel's shared-mapping table: SysV attachments and
 * `MAP_SHARED` mappings of kernel-owned files.
 *
 * The table is Rust-owned (`SharedMappingTable` in
 * `crates/runtime-core/src/memory.rs`), and its merge/refresh/version protocol
 * is covered by Rust unit tests there. What these host tests still own is the
 * *contract between host and kernel*: which entry point is called, with which
 * arguments, in which order relative to `mmap`/`munmap`, `shmat`/`shmdt` and
 * the exact-entry gate, and what the host does when one of them refuses.
 *
 * So this stub keeps just enough state to answer the counting entry point
 * truthfully — the host's syscall-boundary early-out depends on it — and
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

/** One kernel-file mapping as the kernel would record it. */
export interface StubFileMapping {
  fd: number;
  len: number;
  fileOffset: number;
  writable: boolean;
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
  | "kernel_shared_mapping_process_count"
  | "kernel_shared_mapping_sync_process"
  | "kernel_shared_mapping_release_process"
  | "kernel_shared_mapping_inherit"
  | "kernel_shared_mapping_sysv_track"
  | "kernel_shared_mapping_sysv_sync_segment"
  | "kernel_shared_mapping_sysv_publish_mapping"
  | "kernel_shared_mapping_sysv_drop_mapping"
  | "kernel_shared_mapping_file_track"
  | "kernel_shared_mapping_flush"
  | "kernel_shared_mapping_unmap"
  | "kernel_shared_mapping_remap"
  | "kernel_shared_mapping_prepare_write"
  | "kernel_shared_mapping_protect";

/** Every entry point the host may resolve; harnesses must expose all of them. */
export const SYSV_MIRROR_EXPORT_NAMES: readonly SysvMirrorEntryName[] = [
  "kernel_shared_mapping_process_count",
  "kernel_shared_mapping_sync_process",
  "kernel_shared_mapping_release_process",
  "kernel_shared_mapping_inherit",
  "kernel_shared_mapping_sysv_track",
  "kernel_shared_mapping_sysv_sync_segment",
  "kernel_shared_mapping_sysv_publish_mapping",
  "kernel_shared_mapping_sysv_drop_mapping",
  "kernel_shared_mapping_file_track",
  "kernel_shared_mapping_flush",
  "kernel_shared_mapping_unmap",
  "kernel_shared_mapping_remap",
  "kernel_shared_mapping_prepare_write",
  "kernel_shared_mapping_protect",
];

export interface SysvMirrorStub {
  /** pid -> attach address -> attachment, as the kernel would hold it. */
  readonly attachments: Map<number, Map<number, StubSysvAttachment>>;
  /** pid -> map address -> kernel-file mapping, as the kernel would hold it. */
  readonly fileMappings: Map<number, Map<number, StubFileMapping>>;
  /** Every entry-point call, in order. */
  readonly calls: SysvMirrorStubCall[];
  /** Drop-in `kernelExports` entries. */
  readonly exports: Record<string, unknown>;
  /** Seed an attachment without going through `track`. */
  seed(pid: number, addr: number, attachment: StubSysvAttachment): void;
  /** Shared-mapping count for one process, as the kernel would report it. */
  count(pid: number): number;
  /** Calls to one entry point, in order. */
  callsTo(name: SysvMirrorEntryName): readonly SysvMirrorStubCall[];
}

const EIO = 5;

export function createKernelSharedMappingStub(
  options: SysvMirrorStubOptions = {},
): SysvMirrorStub {
  const attachments = new Map<number, Map<number, StubSysvAttachment>>();
  const fileMappings = new Map<number, Map<number, StubFileMapping>>();
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

  const count = (pid: number): number =>
    (attachments.get(pid)?.size ?? 0) + (fileMappings.get(pid)?.size ?? 0);

  const stub: SysvMirrorStub = {
    attachments,
    fileMappings,
    calls,
    seed(pid, addr, attachment) {
      pidMap(pid).set(addr, { ...attachment });
    },
    count,
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
      kernel_shared_mapping_sync_process: (
        pid: number,
        force: number,
      ): number =>
        record("kernel_shared_mapping_sync_process", [pid, force]) ?? 0,
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
      kernel_shared_mapping_release_process: (
        pid: number,
        publish: number,
        detach: number,
      ): number => {
        const forced = record("kernel_shared_mapping_release_process", [
          pid,
          publish,
          detach,
        ]);
        if (forced !== null) return forced;
        attachments.delete(pid);
        fileMappings.delete(pid);
        return 0;
      },
      kernel_shared_mapping_inherit: (
        parentPid: number,
        childPid: number,
        childMemoryLen: bigint,
      ): number => {
        const forced = record("kernel_shared_mapping_inherit", [
          parentPid,
          childPid,
          childMemoryLen,
        ]);
        if (forced !== null) return forced;
        const parent = attachments.get(parentPid);
        if (parent && parent.size > 0) {
          const child = pidMap(childPid);
          for (const [addr, attachment] of parent) {
            child.set(addr, { ...attachment });
          }
        }
        const parentFiles = fileMappings.get(parentPid);
        if (parentFiles && parentFiles.size > 0) {
          fileMappings.set(
            childPid,
            new Map(
              Array.from(parentFiles, ([addr, mapping]) => [addr, { ...mapping }]),
            ),
          );
        }
        return 0;
      },
      kernel_shared_mapping_process_count: (pid: number): number => {
        calls.push({ name: "kernel_shared_mapping_process_count", args: [pid] });
        return count(pid);
      },
      kernel_shared_mapping_file_track: (
        pid: number,
        addr: bigint,
        fd: number,
        len: bigint,
        fileOffset: bigint,
        writable: number,
        memoryLen: bigint,
      ): number => {
        const forced = record("kernel_shared_mapping_file_track", [
          pid,
          addr,
          fd,
          len,
          fileOffset,
          writable,
          memoryLen,
        ]);
        if (forced !== null) return forced;
        let map = fileMappings.get(pid);
        if (!map) {
          map = new Map();
          fileMappings.set(pid, map);
        }
        map.set(Number(addr), {
          fd,
          len: Number(len),
          fileOffset: Number(fileOffset),
          writable: writable !== 0,
        });
        return 0;
      },
      kernel_shared_mapping_flush: (
        pid: number,
        addr: bigint,
        len: bigint,
      ): number => record("kernel_shared_mapping_flush", [pid, addr, len]) ?? 0,
      kernel_shared_mapping_unmap: (
        pid: number,
        addr: bigint,
        len: bigint,
      ): number => {
        const forced = record("kernel_shared_mapping_unmap", [pid, addr, len]);
        if (forced !== null) return forced;
        const map = fileMappings.get(pid);
        if (!map) return 0;
        const start = Number(addr);
        const end = start + Number(len);
        for (const [mapAddr, mapping] of Array.from(map)) {
          if (mapAddr >= start && mapAddr + mapping.len <= end) map.delete(mapAddr);
        }
        if (map.size === 0) fileMappings.delete(pid);
        return 0;
      },
      kernel_shared_mapping_remap: (
        pid: number,
        oldAddr: bigint,
        newAddr: bigint,
        newLen: bigint,
      ): number => {
        const forced = record("kernel_shared_mapping_remap", [
          pid,
          oldAddr,
          newAddr,
          newLen,
        ]);
        if (forced !== null) return forced;
        const map = fileMappings.get(pid);
        const mapping = map?.get(Number(oldAddr));
        if (!map || !mapping) return 0;
        map.delete(Number(oldAddr));
        map.set(Number(newAddr), { ...mapping, len: Number(newLen) });
        return 0;
      },
      kernel_shared_mapping_prepare_write: (
        pid: number,
        addr: bigint,
        len: bigint,
      ): number =>
        record("kernel_shared_mapping_prepare_write", [pid, addr, len]) ?? 0,
      kernel_shared_mapping_protect: (
        pid: number,
        addr: bigint,
        len: bigint,
        writable: number,
      ): number =>
        record("kernel_shared_mapping_protect", [pid, addr, len, writable]) ?? 0,
    },
  };

  return stub;
}
