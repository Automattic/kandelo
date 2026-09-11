export interface KernelConfig {
  maxWorkers: number;
  dataBufferSize: number;
  useSharedMemory: boolean;
  /** Host default pthread slots when process wasm declares -1. */
  defaultThreadSlots?: number;
  /** Log every syscall with decoded args and return values to stderr */
  enableSyscallLog?: boolean;
  /** Log syscalls only for processes with this ptrWidth (4 or 8). Useful when
   *  one wasm64 process in a multi-process demo is misbehaving and the rest
   *  are wasm32 — enabling enableSyscallLog drowns the trace in unrelated
   *  syscalls. */
  syscallLogPtrWidth?: 4 | 8;
}

export interface StatResult {
  /** Exact filesystem identity values. Native backends should prefer bigint. */
  dev: number | bigint;
  ino: number | bigint;
  mode: number;
  nlink: number;
  uid: number;
  gid: number;
  size: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface StatfsResult {
  type: number;
  bsize: number;
  blocks: number;
  bfree: number;
  bavail: number;
  files: number;
  ffree: number;
  fsid: number;
  namelen: number;
  frsize: number;
  flags: number;
}

/** `null` represents a successful indeterminate/unsupported-option result. */
export type PathconfValue = number | null;

/**
 * An exact signed i64 file offset. Ordinary offsets remain numbers; bigint is
 * used when a Wasm64 caller's value cannot be represented safely as a number.
 */
export type HostFileOffset = number | bigint;

/**
 * The result of one append operation while the backing still owns its EOF
 * serialization boundary.
 *
 * `end` is the file position immediately after the bytes reported by
 * `written`. Keeping both values prevents callers from reconstructing the
 * append start from a stale pre-write stat.
 */
export interface AppendOutcome {
  readonly written: number;
  readonly end: HostFileOffset;
}

export interface PlatformIO {
  /**
   * Resolve and materialize deferred backing for a path before a synchronous
   * open/read consumer enters the filesystem. Implementations without lazy
   * backing may omit this hook.
   */
  preparePath?(path: string): Promise<boolean>;
  open(path: string, flags: number, mode: number): number;
  close(handle: number): number;
  read(
    handle: number,
    buffer: Uint8Array,
    offset: HostFileOffset | null,
    length: number,
  ): number;
  write(
    handle: number,
    buffer: Uint8Array,
    offset: HostFileOffset | null,
    length: number,
  ): number;
  /**
   * Atomically resolve EOF, apply an optional exclusive file-size ceiling,
   * and append within one backing-owned operation.
   */
  append(
    handle: number,
    buffer: Uint8Array,
    length: number,
    limit: HostFileOffset | null,
  ): AppendOutcome;
  seek(
    handle: number,
    offset: HostFileOffset,
    whence: number,
  ): HostFileOffset;
  fstat(handle: number): StatResult;
  /** Filesystem identity and set-ID policy bound to this exact open handle. */
  fstatfs?(handle: number): StatfsResult;
  fpathconf(handle: number, name: number): PathconfValue;

  /**
   * Qualify a filesystem-reported inode within this PlatformIO instance.
   *
   * The path is used only to select the owning mount/backend; callers may
   * pass the remembered path of an unlinked or renamed open file. Equal
   * identities must name the same underlying file object, including through
   * hard links. Return null when the backend cannot promise stable object
   * identity (for example, a backend that reports no inode number).
   */
  fileIdentity?(path: string, dev: bigint, ino: bigint): string | null;

  /**
   * Qualify an inode through an already-open file handle.
   *
   * Unlike `fileIdentity`, this must not resolve the remembered pathname: an
   * open file remains a valid mmap backing after that name is unlinked or
   * renamed. Return null when the backend cannot promise stable identity.
   */
  fileHandleIdentity?(handle: number, dev: bigint, ino: bigint): string | null;

  /**
   * Metadata for a guest path, for this host's OWN bookkeeping only.
   *
   * This is NOT part of the kernel contract and backs no `env.host_*` import.
   * The kernel never asks this host to resolve a path; its sole caller is the
   * shared-mmap backing lookup in `kernel-worker.ts`, which needs a file's
   * identity to find the mapping it already created for that file.
   *
   * It is the last path-shaped method on this interface, and it survives only
   * because the mmap-coherence machinery that needs it is keyed by path rather
   * than by descriptor. Reworking that is a change to the worker's mapping
   * model, not to the host filesystem contract.
   */
  stat(path: string): StatResult;

  // Directory-relative operations.
  //
  // The kernel owns the POSIX namespace. It resolves mount routing, `..`, and
  // symlink chains itself, then asks this host to resolve exactly ONE path
  // component relative to a directory handle this host previously issued. No
  // method here ever receives a guest path, a mount prefix, a `..`, or a
  // symlink chain, and `name` is always a single component (`"."` naming the
  // directory itself).
  //
  // This whole group is an OPTIONAL capability: "expose a real host
  // directory". A host with no host-backed mount implements none of it, and
  // the kernel never calls it, because no path can reach a mount that does not
  // exist.

  /**
   * Directory handles naming each mount's root, published to the kernel at
   * boot as the anchors for its per-component walks.
   */
  foreignMountRoots(): { prefix: string; handle: number }[];

  /**
   * Open one component relative to a directory handle. `O_DIRECTORY` yields
   * another directory handle; anything else yields a file handle. Both share
   * one id space and are released by `close`.
   */
  openat(dirHandle: number, name: string, flags: number, mode: number): number;
  /** `AT_SYMLINK_NOFOLLOW` describes a symlink rather than its target. */
  fstatat(dirHandle: number, name: string, flags: number): StatResult;
  mkdirat(dirHandle: number, name: string, mode: number): void;
  /** `AT_REMOVEDIR` selects `rmdir(2)` semantics. */
  unlinkat(dirHandle: number, name: string, flags: number): void;
  renameat(
    oldDirHandle: number,
    oldName: string,
    newDirHandle: number,
    newName: string,
  ): void;
  linkat(
    oldDirHandle: number,
    oldName: string,
    newDirHandle: number,
    newName: string,
  ): void;
  /** `target` is opaque data stored verbatim; only `name` names an entry. */
  symlinkat(target: string, dirHandle: number, name: string): void;
  readlinkat(dirHandle: number, name: string): string;
  fchmodat(dirHandle: number, name: string, mode: number): void;
  /** `AT_SYMLINK_NOFOLLOW` selects `lchown(2)`. */
  fchownat(
    dirHandle: number,
    name: string,
    uid: number,
    gid: number,
    flags: number,
  ): void;
  utimensatAt(
    dirHandle: number,
    name: string,
    atimeSec: number,
    atimeNsec: number,
    mtimeSec: number,
    mtimeNsec: number,
  ): void;
  /**
   * Return and consume the next entry of a directory handle. If this throws,
   * the iterator must stay on that entry so the caller can retry without a
   * directory-position gap: the kernel may return a short successful
   * `getdents64` after copying earlier records and retry on the next syscall.
   */
  readdir(
    handle: number,
  ): { name: string; type: number; ino: number } | null;

  // File operations
  ftruncate(handle: number, length: number): void;
  fsync(handle: number): void;
  fchmod(handle: number, mode: number): void;
  fchown(handle: number, uid: number, gid: number): void;

  // Time
  clockGettime(clockId: number): { sec: number; nsec: number };
  nanosleep(sec: number, nsec: number): void;

  // Process (optional — only needed when process management is available)
  waitpid?(pid: number, options: number): { pid: number; status: number };

  // Networking (optional — only needed for AF_INET support)
  network?: NetworkIO;
}

export interface NetworkAddress {
  addr: Uint8Array;
  port: number;
}

export interface TcpConnectionPeer {
  send(data: Uint8Array, flags: number): number;
  recv(maxLen: number, flags: number): Uint8Array;
  /**
   * Report what this engine can observe about the connection, as a
   * `NET_READINESS` fact word (`host/src/generated/abi.ts`).
   *
   * This is deliberately *not* `revents`. Deciding which of
   * POLLIN/POLLOUT/POLLERR/POLLHUP belongs in `revents` is a POSIX decision
   * and the kernel makes it, in `runtime_core::net_readiness`. Report facts
   * here and nothing else.
   */
  readiness?(): number;
  /** Disable one or both directions without resetting the connection. */
  shutdown(how: number): void;
  /** Orderly close: flush/FIN the write half and orphan the receive half. */
  close(): void;
  /** Abort immediately and make both peers observe a connection reset. */
  abort(): void;
}

export interface TcpListenTarget {
  accept(peer: TcpConnectionPeer, local: NetworkAddress, remote: NetworkAddress): number;
}

export interface UdpDatagram {
  srcAddr: Uint8Array;
  srcPort: number;
  dstAddr: Uint8Array;
  dstPort: number;
  data: Uint8Array;
}

export interface UdpReceiveTarget {
  receive(datagram: UdpDatagram): number;
}

export interface NetworkIO {
  /** IPv4 address owned by this guest network stack, when known. */
  readonly localAddress?: Uint8Array;
  connect(handle: number, addr: Uint8Array, port: number): void;
  /** 0 = connected, positive errno = failed, -11 = still pending (EAGAIN). */
  connectStatus(handle: number): number;
  send(handle: number, data: Uint8Array, flags: number): number;
  recv(handle: number, maxLen: number, flags: number): Uint8Array;
  /**
   * Report what this engine can observe about a connection handle, as a
   * `NET_READINESS` fact word (`host/src/generated/abi.ts`).
   *
   * This is deliberately *not* `revents`. Deciding which of
   * POLLIN/POLLOUT/POLLERR/POLLHUP belongs in `revents` is a POSIX decision
   * and the kernel makes it, in `runtime_core::net_readiness`. Report facts
   * here and nothing else.
   *
   * A backend that omits this is reported to the kernel as
   * `NET_READINESS.UNOBSERVABLE`, whose documented handling is
   * wake-every-round with `EAGAIN` from `recv`/`send`.
   */
  readiness?(handle: number): number;
  close(handle: number): void;
  getaddrinfo(hostname: string): Uint8Array; // Returns 4-byte IPv4
  listenTcp?(listenerId: string, addr: Uint8Array, port: number, target: TcpListenTarget): number;
  closeTcpListener?(listenerId: string): void;
  bindUdp?(endpointId: string, addr: Uint8Array, port: number, target: UdpReceiveTarget): number;
  unbindUdp?(endpointId: string): void;
  sendDatagram?(datagram: UdpDatagram): number;
}
