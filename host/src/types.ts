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

export interface PlatformIO {
  open(path: string, flags: number, mode: number): number;
  close(handle: number): number;
  read(
    handle: number,
    buffer: Uint8Array,
    offset: number | null,
    length: number,
  ): number;
  write(
    handle: number,
    buffer: Uint8Array,
    offset: number | null,
    length: number,
  ): number;
  seek(handle: number, offset: number, whence: number): number;
  fstat(handle: number): StatResult;
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

  // Path-based operations
  stat(path: string): StatResult;
  lstat(path: string): StatResult;
  statfs(path: string): StatfsResult;
  pathconf(path: string, name: number): PathconfValue;
  mkdir(path: string, mode: number): void;
  rmdir(path: string): void;
  unlink(path: string): void;
  rename(oldPath: string, newPath: string): void;
  link(existingPath: string, newPath: string): void;
  symlink(target: string, path: string): void;
  readlink(path: string): string;
  chmod(path: string, mode: number): void;
  chown(path: string, uid: number, gid: number): void;
  lchown(path: string, uid: number, gid: number): void;
  access(path: string, mode: number): void;
  utimensat(path: string, atimeSec: number, atimeNsec: number, mtimeSec: number, mtimeNsec: number): void;

  // Directory iteration
  opendir(path: string): number;
  readdir(
    handle: number,
  ): { name: string; type: number; ino: number } | null;
  closedir(handle: number): void;

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
  poll?(events: number): number;
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
  /** Return POSIX poll revents bits for this connection handle. */
  poll?(handle: number, events: number): number;
  close(handle: number): void;
  getaddrinfo(hostname: string): Uint8Array; // Returns 4-byte IPv4
  listenTcp?(listenerId: string, addr: Uint8Array, port: number, target: TcpListenTarget): number;
  closeTcpListener?(listenerId: string): void;
  bindUdp?(endpointId: string, addr: Uint8Array, port: number, target: UdpReceiveTarget): number;
  unbindUdp?(endpointId: string): void;
  sendDatagram?(datagram: UdpDatagram): number;
}
