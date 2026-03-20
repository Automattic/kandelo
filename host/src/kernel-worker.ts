/**
 * CentralizedKernelWorker — Manages a single kernel Wasm instance that
 * services syscalls from multiple process workers via channel IPC.
 *
 * Architecture:
 *   - One kernel Wasm instance with its own Memory
 *   - Multiple process workers, each with their own shared Memory
 *   - Each thread (including main thread) in each process has a channel
 *     region in the process's Memory
 *   - JS event loop polls channels via Atomics.waitAsync
 *   - On syscall: copy args from process Memory → kernel scratch,
 *     call kernel_handle_channel, copy result back, notify process
 *
 * Channel layout in process Memory (matches wasm_posix_shared::channel):
 *   Offset  Size  Field
 *   0       4B    status (IDLE=0, PENDING=1, COMPLETE=2, ERROR=3)
 *   4       4B    syscall number
 *   8       24B   arguments (6 x i32)
 *   32      4B    return value
 *   36      4B    errno
 *   40      64KB  data transfer buffer
 */

import { WasmPosixKernel } from "./kernel";
import type { KernelConfig, PlatformIO } from "./types";

/** Channel status values */
const CH_IDLE = 0;
const CH_PENDING = 1;
const CH_COMPLETE = 2;

/** Errno values */
const EAGAIN = 11;

/** Syscall numbers for sleep/delay */
const SYS_NANOSLEEP = 41;
const SYS_USLEEP = 68;
const SYS_CLOCK_NANOSLEEP = 124;
const SYS_FUTEX = 200;
const SYS_POLL = 60;

/** Syscall numbers for fork/exec/clone */
const SYS_EXECVE = 211;
const SYS_FORK = 212;
const SYS_VFORK = 213;
const SYS_CLONE = 201;
const SYS_EXIT = 34;
const SYS_EXIT_GROUP = 35;

/** Retry interval for EAGAIN polling (ms) */
const EAGAIN_RETRY_MS = 1;

/** Channel layout offsets */
const CH_STATUS = 0;
const CH_SYSCALL = 4;
const CH_ARGS = 8;
const CH_ARGS_COUNT = 6;
const CH_RETURN = 32;
const CH_ERRNO = 36;
const CH_DATA = 40;
const CH_DATA_SIZE = 65536;
const CH_TOTAL_SIZE = CH_DATA + CH_DATA_SIZE;

/** Scratch area layout in kernel Memory for kernel_handle_channel.
 * Same as channel layout but used as the kernel-side buffer. */
const SCRATCH_SIZE = CH_TOTAL_SIZE;

/** Struct sizes for output data copying */
const WASM_STAT_SIZE = 88;
const TIMESPEC_SIZE = 8;  // 2 x i32 (sec, nsec) on wasm32
const ITIMERVAL_SIZE = 16; // 2 x timespec
const RLIMIT_SIZE = 16;   // 2 x i64 on wasm32

// -----------------------------------------------------------------------
// Arg descriptor system for pointer redirection
//
// For each syscall that has pointer arguments, we describe which args
// are pointers, their direction (in/out/inout), and how to determine
// the data size (null-terminated string, fixed size, or specified by
// another arg).
// -----------------------------------------------------------------------

type SizeSpec =
  | { type: "cstring" }           // null-terminated string
  | { type: "arg"; argIndex: number } // size given by another arg
  | { type: "fixed"; size: number };  // fixed-size struct

interface ArgDesc {
  argIndex: number;
  direction: "in" | "out" | "inout";
  size: SizeSpec;
}

/** Per-syscall pointer arg descriptors.
 * Only syscalls with pointer args need entries here. */
const SYSCALL_ARGS: Record<number, ArgDesc[]> = {
  // File operations
  1:  [{ argIndex: 0, direction: "in", size: { type: "cstring" } }],     // OPEN: path
  3:  [{ argIndex: 1, direction: "out", size: { type: "arg", argIndex: 2 } }], // READ: buf
  4:  [{ argIndex: 1, direction: "in", size: { type: "arg", argIndex: 2 } }],  // WRITE: buf
  6:  [{ argIndex: 1, direction: "out", size: { type: "fixed", size: WASM_STAT_SIZE } }], // FSTAT: stat_buf
  64: [{ argIndex: 1, direction: "out", size: { type: "arg", argIndex: 2 } }], // PREAD: buf
  65: [{ argIndex: 1, direction: "in", size: { type: "arg", argIndex: 2 } }],  // PWRITE: buf

  // FD operations
  9:  [{ argIndex: 0, direction: "out", size: { type: "fixed", size: 8 } }],   // PIPE: 2 x i32
  78: [{ argIndex: 0, direction: "out", size: { type: "fixed", size: 8 } }],   // PIPE2: 2 x i32

  // Stat
  11: [
    { argIndex: 0, direction: "in", size: { type: "cstring" } },               // STAT: path
    { argIndex: 1, direction: "out", size: { type: "fixed", size: WASM_STAT_SIZE } },
  ],
  12: [
    { argIndex: 0, direction: "in", size: { type: "cstring" } },               // LSTAT: path
    { argIndex: 1, direction: "out", size: { type: "fixed", size: WASM_STAT_SIZE } },
  ],
  93: [
    { argIndex: 1, direction: "in", size: { type: "cstring" } },               // FSTATAT: path
    { argIndex: 2, direction: "out", size: { type: "fixed", size: WASM_STAT_SIZE } },
  ],

  // Directory operations
  13: [{ argIndex: 0, direction: "in", size: { type: "cstring" } }],           // MKDIR: path
  14: [{ argIndex: 0, direction: "in", size: { type: "cstring" } }],           // RMDIR: path
  15: [{ argIndex: 0, direction: "in", size: { type: "cstring" } }],           // UNLINK: path
  16: [
    { argIndex: 0, direction: "in", size: { type: "cstring" } },               // RENAME: old
    { argIndex: 1, direction: "in", size: { type: "cstring" } },               //         new
  ],
  17: [
    { argIndex: 0, direction: "in", size: { type: "cstring" } },               // LINK: old
    { argIndex: 1, direction: "in", size: { type: "cstring" } },               //       new
  ],
  18: [
    { argIndex: 0, direction: "in", size: { type: "cstring" } },               // SYMLINK: target
    { argIndex: 1, direction: "in", size: { type: "cstring" } },               //          linkpath
  ],
  19: [
    { argIndex: 0, direction: "in", size: { type: "cstring" } },               // READLINK: path
    { argIndex: 1, direction: "out", size: { type: "arg", argIndex: 2 } },     //           buf
  ],
  20: [{ argIndex: 0, direction: "in", size: { type: "cstring" } }],           // CHMOD: path
  21: [{ argIndex: 0, direction: "in", size: { type: "cstring" } }],           // CHOWN: path
  22: [{ argIndex: 0, direction: "in", size: { type: "cstring" } }],           // ACCESS: path
  23: [{ argIndex: 0, direction: "out", size: { type: "arg", argIndex: 1 } }], // GETCWD: buf
  24: [{ argIndex: 0, direction: "in", size: { type: "cstring" } }],           // CHDIR: path
  25: [{ argIndex: 0, direction: "in", size: { type: "cstring" } }],           // OPENDIR: path
  26: [
    { argIndex: 1, direction: "out", size: { type: "fixed", size: 16 } },      // READDIR: dirent
    { argIndex: 2, direction: "out", size: { type: "arg", argIndex: 3 } },     //          name_buf
  ],
  122: [{ argIndex: 1, direction: "out", size: { type: "arg", argIndex: 2 } }], // GETDENTS64: buf

  // Signals
  36: [
    { argIndex: 1, direction: "in", size: { type: "fixed", size: 16 } },       // SIGACTION: act
    { argIndex: 2, direction: "out", size: { type: "fixed", size: 16 } },      //            oldact
  ],

  // Time
  40: [{ argIndex: 1, direction: "out", size: { type: "fixed", size: TIMESPEC_SIZE } }], // CLOCK_GETTIME
  41: [{ argIndex: 0, direction: "in", size: { type: "fixed", size: TIMESPEC_SIZE } }],  // NANOSLEEP
  123: [{ argIndex: 1, direction: "out", size: { type: "fixed", size: TIMESPEC_SIZE } }], // CLOCK_GETRES
  124: [{ argIndex: 2, direction: "in", size: { type: "fixed", size: TIMESPEC_SIZE } }], // CLOCK_NANOSLEEP

  // UTIMENSAT: (dirfd, path, times, flags)
  125: [
    { argIndex: 1, direction: "in", size: { type: "cstring" } },
    { argIndex: 2, direction: "in", size: { type: "fixed", size: TIMESPEC_SIZE * 2 } },
  ],

  // Environment
  43: [
    { argIndex: 0, direction: "in", size: { type: "cstring" } },               // GETENV: name
    { argIndex: 1, direction: "out", size: { type: "arg", argIndex: 2 } },     //         buf
  ],
  44: [
    { argIndex: 0, direction: "in", size: { type: "cstring" } },               // SETENV: name
    { argIndex: 1, direction: "in", size: { type: "cstring" } },               //         value
  ],
  45: [{ argIndex: 0, direction: "in", size: { type: "cstring" } }],           // UNSETENV: name

  75: [{ argIndex: 0, direction: "out", size: { type: "arg", argIndex: 1 } }], // UNAME: buf
  120: [{ argIndex: 0, direction: "out", size: { type: "arg", argIndex: 1 } }], // GETRANDOM: buf
  109: [
    { argIndex: 0, direction: "in", size: { type: "cstring" } },               // REALPATH: path
    { argIndex: 1, direction: "out", size: { type: "arg", argIndex: 2 } },     //           buf
  ],

  // Sockets
  51: [{ argIndex: 1, direction: "in", size: { type: "arg", argIndex: 2 } }],  // BIND: addr
  54: [{ argIndex: 1, direction: "in", size: { type: "arg", argIndex: 2 } }],  // CONNECT: addr
  55: [{ argIndex: 1, direction: "in", size: { type: "arg", argIndex: 2 } }],  // SEND: buf
  56: [{ argIndex: 1, direction: "out", size: { type: "arg", argIndex: 2 } }], // RECV: buf
  58: [{ argIndex: 3, direction: "out", size: { type: "fixed", size: 4 } }],   // GETSOCKOPT: val
  61: [{ argIndex: 3, direction: "out", size: { type: "fixed", size: 8 } }],   // SOCKETPAIR: sv

  140: [
    { argIndex: 0, direction: "in", size: { type: "cstring" } },               // GETADDRINFO: name
    { argIndex: 1, direction: "out", size: { type: "fixed", size: 256 } },     //              result_buf
  ],
  137: [{ argIndex: 1, direction: "in", size: { type: "arg", argIndex: 2 } }], // SENDMSG: msg
  138: [{ argIndex: 1, direction: "inout", size: { type: "arg", argIndex: 2 } }], // RECVMSG: msg
  62: [
    { argIndex: 1, direction: "in", size: { type: "arg", argIndex: 2 } },      // SENDTO: buf
    { argIndex: 4, direction: "in", size: { type: "arg", argIndex: 5 } },      //         dest_addr
  ],
  63: [
    { argIndex: 1, direction: "out", size: { type: "arg", argIndex: 2 } },     // RECVFROM: buf
    { argIndex: 4, direction: "out", size: { type: "arg", argIndex: 5 } },     //           src_addr
  ],

  // Poll/select
  60: [{ argIndex: 0, direction: "inout", size: { type: "arg", argIndex: 1 } }], // POLL: fds (nfds * 8)

  // Terminal
  70: [{ argIndex: 1, direction: "out", size: { type: "fixed", size: 256 } }], // TCGETATTR
  71: [{ argIndex: 2, direction: "in", size: { type: "fixed", size: 256 } }],  // TCSETATTR
  72: [{ argIndex: 2, direction: "inout", size: { type: "fixed", size: 256 } }], // IOCTL

  // File system
  85: [{ argIndex: 0, direction: "in", size: { type: "cstring" } }],           // TRUNCATE: path
  129: [
    { argIndex: 0, direction: "in", size: { type: "cstring" } },               // STATFS: path
    { argIndex: 1, direction: "out", size: { type: "fixed", size: 64 } },      //         buf
  ],
  130: [{ argIndex: 1, direction: "out", size: { type: "fixed", size: 64 } }], // FSTATFS: buf

  // *at variants
  69: [{ argIndex: 1, direction: "in", size: { type: "cstring" } }],           // OPENAT: path
  94: [{ argIndex: 1, direction: "in", size: { type: "cstring" } }],           // UNLINKAT: path
  95: [{ argIndex: 1, direction: "in", size: { type: "cstring" } }],           // MKDIRAT: path
  96: [
    { argIndex: 1, direction: "in", size: { type: "cstring" } },               // RENAMEAT: oldpath
    { argIndex: 3, direction: "in", size: { type: "cstring" } },               //           newpath
  ],
  97: [{ argIndex: 1, direction: "in", size: { type: "cstring" } }],           // FACCESSAT: path
  98: [{ argIndex: 1, direction: "in", size: { type: "cstring" } }],           // FCHMODAT: path
  99: [{ argIndex: 1, direction: "in", size: { type: "cstring" } }],           // FCHOWNAT: path
  100: [
    { argIndex: 1, direction: "in", size: { type: "cstring" } },               // LINKAT: oldpath
    { argIndex: 3, direction: "in", size: { type: "cstring" } },               //         newpath
  ],
  101: [
    { argIndex: 0, direction: "in", size: { type: "cstring" } },               // SYMLINKAT: target
    { argIndex: 2, direction: "in", size: { type: "cstring" } },               //            linkpath
  ],
  102: [
    { argIndex: 1, direction: "in", size: { type: "cstring" } },               // READLINKAT: path
    { argIndex: 3, direction: "out", size: { type: "arg", argIndex: 4 } },     //             buf
  ],

  // Resource limits
  83: [{ argIndex: 1, direction: "out", size: { type: "fixed", size: RLIMIT_SIZE } }],  // GETRLIMIT
  84: [{ argIndex: 1, direction: "in", size: { type: "fixed", size: RLIMIT_SIZE } }],   // SETRLIMIT

  108: [{ argIndex: 1, direction: "out", size: { type: "arg", argIndex: 2 } }], // GETRUSAGE: buf
  132: [
    { argIndex: 0, direction: "out", size: { type: "fixed", size: 4 } },       // GETRESUID
    { argIndex: 1, direction: "out", size: { type: "fixed", size: 4 } },
    { argIndex: 2, direction: "out", size: { type: "fixed", size: 4 } },
  ],
  134: [
    { argIndex: 0, direction: "out", size: { type: "fixed", size: 4 } },       // GETRESGID
    { argIndex: 1, direction: "out", size: { type: "fixed", size: 4 } },
    { argIndex: 2, direction: "out", size: { type: "fixed", size: 4 } },
  ],

  // Wait
  139: [
    { argIndex: 1, direction: "out", size: { type: "fixed", size: 4 } },       // WAIT4: wstatus
    { argIndex: 3, direction: "out", size: { type: "fixed", size: 32 } },      //        rusage
  ],

  // Exec
  211: [{ argIndex: 0, direction: "in", size: { type: "cstring" } }],          // EXECVE: path

  // Timer
  225: [
    { argIndex: 1, direction: "in", size: { type: "fixed", size: ITIMERVAL_SIZE } },   // SETITIMER: new
    { argIndex: 2, direction: "out", size: { type: "fixed", size: ITIMERVAL_SIZE } },  //            old
  ],
  224: [{ argIndex: 1, direction: "out", size: { type: "fixed", size: ITIMERVAL_SIZE } }], // GETITIMER

  // statx
  260: [
    { argIndex: 1, direction: "in", size: { type: "cstring" } },               // STATX: path
    { argIndex: 3, direction: "out", size: { type: "fixed", size: 256 } },     //        statxbuf
  ],
};

// Also need a way to compute poll size: nfds * sizeof(struct pollfd) = nfds * 8
// This is handled as a special case in the size computation.

/** Info about a registered thread channel. */
interface ChannelInfo {
  pid: number;
  memory: WebAssembly.Memory;
  channelOffset: number;
  /** Int32Array view for Atomics operations */
  i32View: Int32Array;
}

/** Info about a registered process. */
interface ProcessRegistration {
  pid: number;
  memory: WebAssembly.Memory;
  channels: ChannelInfo[];
}

/** Callbacks for fork/exec/exit handling in centralized mode. */
export interface CentralizedKernelCallbacks {
  /**
   * Called when a process forks. The kernel has already cloned the Process
   * in its ProcessTable. The callback should spawn a child Worker with
   * a copy of the parent's Memory and register it with the kernel.
   * Returns the channel offsets allocated for the child.
   */
  onFork?: (parentPid: number, childPid: number, parentMemory: WebAssembly.Memory) => Promise<number[]>;

  /**
   * Called when a process calls execve. The callback should resolve the
   * program path and reinitialize the Worker with the new binary.
   * Returns 0 on success, negative errno on error.
   */
  onExec?: (pid: number, path: string) => Promise<number>;

  /**
   * Called when a process calls clone (thread creation). The callback should
   * spawn a thread Worker sharing the parent's Memory. Returns the TID.
   */
  onClone?: (pid: number, fnPtr: number, argPtr: number, stackPtr: number, tlsPtr: number, ctidPtr: number, memory: WebAssembly.Memory) => Promise<number>;

  /**
   * Called when a process exits.
   */
  onExit?: (pid: number, exitStatus: number) => void;
}

export class CentralizedKernelWorker {
  private kernel: WasmPosixKernel;
  private kernelInstance: WebAssembly.Instance | null = null;
  private kernelMemory: WebAssembly.Memory | null = null;
  private processes = new Map<number, ProcessRegistration>();
  private activeChannels: ChannelInfo[] = [];
  private scratchOffset = 0;
  private initialized = false;
  private nextChildPid = 100;

  constructor(
    private config: KernelConfig,
    private io: PlatformIO,
    private callbacks: CentralizedKernelCallbacks = {},
  ) {
    this.kernel = new WasmPosixKernel(config, io, {
      // In centralized mode, callbacks like onKill/onFork are handled
      // differently — the kernel returns EAGAIN and JS handles them.
      // For now, provide no-op callbacks.
    });
  }

  /**
   * Initialize the centralized kernel.
   * Loads kernel Wasm, sets mode to centralized (1).
   */
  async init(kernelWasmBytes: BufferSource): Promise<void> {
    await this.kernel.init(kernelWasmBytes);
    this.kernelInstance = this.kernel.getInstance()!;
    this.kernelMemory = this.kernel.getMemory()!;

    // Set centralized mode
    const setMode = this.kernelInstance.exports.kernel_set_mode as (mode: number) => void;
    setMode(1);

    // Allocate scratch area in kernel memory.
    // We use a fixed high address that won't conflict with the kernel's
    // heap allocator (which grows from __heap_base upward).
    // Use the last SCRATCH_SIZE bytes of the current memory.
    const memBytes = this.kernelMemory.buffer.byteLength;
    this.scratchOffset = memBytes - SCRATCH_SIZE;
    // Ensure scratch area is zeroed
    new Uint8Array(this.kernelMemory.buffer, this.scratchOffset, SCRATCH_SIZE).fill(0);

    this.initialized = true;
  }

  /**
   * Register a process and its thread channels with the kernel.
   * Each channel is a region in the process's shared Memory.
   */
  registerProcess(
    pid: number,
    memory: WebAssembly.Memory,
    channelOffsets: number[],
  ): void {
    if (!this.initialized) throw new Error("Kernel not initialized");

    // Create process in kernel's process table
    const createProcess = this.kernelInstance!.exports.kernel_create_process as (pid: number) => number;
    const result = createProcess(pid);
    if (result < 0) {
      throw new Error(`Failed to create process ${pid}: errno ${-result}`);
    }

    const channels: ChannelInfo[] = channelOffsets.map((offset) => ({
      pid,
      memory,
      channelOffset: offset,
      i32View: new Int32Array(memory.buffer, offset),
    }));

    const registration: ProcessRegistration = { pid, memory, channels };
    this.processes.set(pid, registration);
    this.activeChannels.push(...channels);

    // Start listening on each channel
    for (const channel of channels) {
      this.listenOnChannel(channel);
    }
  }

  /**
   * Unregister a process. Stops listening on its channels and removes
   * it from the kernel's process table.
   */
  unregisterProcess(pid: number): void {
    const registration = this.processes.get(pid);
    if (!registration) return;

    // Remove channels from active list
    this.activeChannels = this.activeChannels.filter((ch) => ch.pid !== pid);

    // Remove from kernel process table
    const removeProcess = this.kernelInstance!.exports.kernel_remove_process as (pid: number) => number;
    removeProcess(pid);

    this.processes.delete(pid);
  }

  /**
   * Listen for a syscall on a channel using Atomics.waitAsync.
   * When the process sets status to PENDING, we handle the syscall.
   */
  private listenOnChannel(channel: ChannelInfo): void {
    // Re-create Int32Array view in case memory was grown
    const i32View = new Int32Array(channel.memory.buffer, channel.channelOffset);
    channel.i32View = i32View;

    const statusIndex = CH_STATUS / 4;

    // Check if already pending (process might have sent before we started listening)
    const currentStatus = Atomics.load(i32View, statusIndex);
    if (currentStatus === CH_PENDING) {
      // Handle immediately
      this.handleSyscall(channel);
      return;
    }

    // Wait for PENDING status asynchronously
    const waitResult = Atomics.waitAsync(i32View, statusIndex, CH_IDLE);

    if (waitResult.async) {
      waitResult.value.then(() => {
        // Check if still registered
        if (!this.processes.has(channel.pid)) return;
        // Status changed — check if PENDING
        const status = Atomics.load(i32View, statusIndex);
        if (status === CH_PENDING) {
          this.handleSyscall(channel);
        } else {
          // Not pending, re-listen
          this.listenOnChannel(channel);
        }
      });
    } else {
      // Synchronous result — status already changed
      const status = Atomics.load(i32View, statusIndex);
      if (status === CH_PENDING) {
        this.handleSyscall(channel);
      } else {
        // Re-listen on next tick to avoid stack overflow
        queueMicrotask(() => this.listenOnChannel(channel));
      }
    }
  }

  /**
   * Handle a pending syscall from a process channel.
   *
   * 1. Read syscall number + args from process Memory
   * 2. For each pointer arg: copy data from process Memory to kernel scratch
   * 3. Write adjusted args to kernel scratch channel header
   * 4. Call kernel_handle_channel(scratchOffset, pid)
   * 5. For each output pointer arg: copy data from kernel scratch to process Memory
   * 6. Write return value + errno to process channel
   * 7. Set status to COMPLETE and notify process
   * 8. Re-listen for next syscall
   */
  private handleSyscall(channel: ChannelInfo): void {
    const processView = new DataView(channel.memory.buffer, channel.channelOffset);

    // Read syscall number and args from process channel
    const syscallNr = processView.getUint32(CH_SYSCALL, true);
    const origArgs: number[] = [];
    for (let i = 0; i < CH_ARGS_COUNT; i++) {
      origArgs.push(processView.getInt32(CH_ARGS + i * 4, true));
    }

    // --- Intercept fork/exec/clone/exit before calling kernel ---
    // These syscalls need special async handling that can't go through
    // the blocking host_fork/host_exec imports.

    if (syscallNr === SYS_FORK || syscallNr === SYS_VFORK) {
      this.handleFork(channel, origArgs);
      return;
    }

    if (syscallNr === SYS_EXECVE) {
      this.handleExec(channel, origArgs);
      return;
    }

    if (syscallNr === SYS_CLONE) {
      this.handleClone(channel, origArgs);
      return;
    }

    if (syscallNr === SYS_EXIT || syscallNr === SYS_EXIT_GROUP) {
      this.handleExit(channel, syscallNr, origArgs);
      return;
    }

    // --- Normal syscall path ---
    const kernelView = new DataView(this.kernelMemory!.buffer, this.scratchOffset);

    // Copy raw args to kernel scratch header (will be adjusted below)
    const adjustedArgs = [...origArgs];

    // Process pointer args: copy data between process and kernel memory
    const argDescs = SYSCALL_ARGS[syscallNr];
    let dataOffset = 0; // Offset within scratch data area for allocations

    if (argDescs) {
      // Re-create typed views (memory may have grown)
      const processMem = new Uint8Array(channel.memory.buffer);
      const kernelMem = new Uint8Array(this.kernelMemory!.buffer);
      const dataStart = this.scratchOffset + CH_DATA;

      for (const desc of argDescs) {
        const ptr = origArgs[desc.argIndex];
        if (ptr === 0) continue; // null pointer, skip

        // Compute size of data to copy
        let size: number;
        if (desc.size.type === "cstring") {
          // Read null-terminated string length from process memory
          let len = 0;
          while (processMem[ptr + len] !== 0 && len < CH_DATA_SIZE - dataOffset - 1) {
            len++;
          }
          size = len + 1; // include null terminator
        } else if (desc.size.type === "arg") {
          size = origArgs[desc.size.argIndex];
          // Special case for poll: nfds * sizeof(struct pollfd)
          if (syscallNr === 60) size *= 8;
        } else {
          size = desc.size.size;
        }

        if (size <= 0 || dataOffset + size > CH_DATA_SIZE) continue;

        const kernelPtr = dataStart + dataOffset;

        // Copy input data from process to kernel
        if (desc.direction === "in" || desc.direction === "inout") {
          kernelMem.set(processMem.subarray(ptr, ptr + size), kernelPtr);
        } else {
          // Output-only: zero the kernel scratch area
          kernelMem.fill(0, kernelPtr, kernelPtr + size);
        }

        // Update arg to point to kernel memory
        adjustedArgs[desc.argIndex] = kernelPtr;

        dataOffset += size;
        // Align to 4 bytes for next allocation
        dataOffset = (dataOffset + 3) & ~3;
      }
    }

    // Write adjusted args to kernel scratch
    kernelView.setUint32(CH_SYSCALL, syscallNr, true);
    for (let i = 0; i < CH_ARGS_COUNT; i++) {
      kernelView.setInt32(CH_ARGS + i * 4, adjustedArgs[i], true);
    }

    // Call kernel_handle_channel
    const handleChannel = this.kernelInstance!.exports.kernel_handle_channel as (offset: number, pid: number) => number;
    handleChannel(this.scratchOffset, channel.pid);

    // Read return value and errno from kernel scratch
    const retVal = kernelView.getInt32(CH_RETURN, true);
    const errVal = kernelView.getUint32(CH_ERRNO, true);

    // --- Blocking syscall handling ---

    // 1. EAGAIN: kernel returned EAGAIN for a blocking syscall.
    //    Schedule async retry — the process stays blocked on Atomics.wait.
    if (retVal === -1 && errVal === EAGAIN) {
      this.handleBlockingRetry(channel, syscallNr, origArgs);
      return;
    }

    // 2. Sleep syscalls: kernel returned success immediately, but we need
    //    to delay the response to simulate the sleep duration.
    if (this.handleSleepDelay(channel, syscallNr, origArgs, retVal, errVal)) {
      return;
    }

    // --- Normal completion ---
    this.completeChannel(channel, syscallNr, origArgs, argDescs, retVal, errVal);
  }

  /**
   * Complete a syscall by copying output data and notifying the process.
   */
  private completeChannel(
    channel: ChannelInfo,
    syscallNr: number,
    origArgs: number[],
    argDescs: ArgDesc[] | undefined,
    retVal: number,
    errVal: number,
  ): void {
    const processView = new DataView(channel.memory.buffer, channel.channelOffset);

    // Copy output data from kernel scratch back to process memory
    if (argDescs) {
      const processMem = new Uint8Array(channel.memory.buffer);
      const kernelMem = new Uint8Array(this.kernelMemory!.buffer);
      const dataStart = this.scratchOffset + CH_DATA;
      let outOffset = 0;

      for (const desc of argDescs) {
        const origPtr = origArgs[desc.argIndex];
        if (origPtr === 0) continue;

        // Recompute size (same logic as prepareInputData)
        let size: number;
        if (desc.size.type === "cstring") {
          let len = 0;
          while (processMem[origPtr + len] !== 0 && len < CH_DATA_SIZE - outOffset - 1) {
            len++;
          }
          size = len + 1;
        } else if (desc.size.type === "arg") {
          size = origArgs[desc.size.argIndex];
          if (syscallNr === SYS_POLL) size *= 8;
        } else {
          size = desc.size.size;
        }

        if (size <= 0 || outOffset + size > CH_DATA_SIZE) continue;

        const kernelPtr = dataStart + outOffset;

        // Copy output data from kernel to process
        if (desc.direction === "out" || desc.direction === "inout") {
          let copySize = size;
          if (desc.direction === "out" && desc.size.type === "arg") {
            if (retVal > 0 && retVal < size) {
              copySize = retVal;
            }
          }
          processMem.set(
            kernelMem.subarray(kernelPtr, kernelPtr + copySize),
            origPtr,
          );
        }

        outOffset += size;
        outOffset = (outOffset + 3) & ~3;
      }
    }

    // Write result to process channel
    processView.setInt32(CH_RETURN, retVal, true);
    processView.setUint32(CH_ERRNO, errVal, true);

    // Set status to COMPLETE and notify process
    const i32View = new Int32Array(channel.memory.buffer, channel.channelOffset);
    Atomics.store(i32View, CH_STATUS / 4, CH_COMPLETE);
    Atomics.notify(i32View, CH_STATUS / 4, 1);

    // Re-listen for next syscall
    if (this.processes.has(channel.pid)) {
      queueMicrotask(() => this.listenOnChannel(channel));
    }
  }

  /**
   * Handle EAGAIN retry for blocking syscalls.
   * The process stays blocked while we retry asynchronously.
   */
  private handleBlockingRetry(
    channel: ChannelInfo,
    syscallNr: number,
    origArgs: number[],
  ): void {
    if (!this.processes.has(channel.pid)) return;

    // Futex wait: use Atomics.waitAsync on the target address in process memory
    if (syscallNr === SYS_FUTEX) {
      const futexOp = origArgs[1] & 0x7f; // mask out FUTEX_PRIVATE_FLAG
      if (futexOp === 0) { // FUTEX_WAIT
        const addr = origArgs[0]; // address in process memory
        const expectedVal = origArgs[2];
        const i32View = new Int32Array(channel.memory.buffer);
        const index = addr >>> 2; // convert byte offset to i32 index

        // Check if value already changed
        const currentVal = Atomics.load(i32View, index);
        if (currentVal !== expectedVal) {
          // Value changed, retry syscall immediately — kernel should succeed
          this.retrySyscall(channel);
          return;
        }

        // Wait for value to change
        const waitResult = Atomics.waitAsync(i32View, index, expectedVal);
        if (waitResult.async) {
          waitResult.value.then(() => {
            if (this.processes.has(channel.pid)) {
              this.retrySyscall(channel);
            }
          });
        } else {
          // Already changed
          queueMicrotask(() => this.retrySyscall(channel));
        }
        return;
      }
    }

    // Poll with timeout: the kernel did a non-blocking check and returned EAGAIN.
    // We retry after a short delay. If poll has timeout=0 (EAGAIN means no events),
    // we should return 0 immediately instead of retrying.
    if (syscallNr === SYS_POLL) {
      const timeout = origArgs[2]; // timeout in ms
      if (timeout === 0) {
        // Non-blocking poll — return 0 (no events)
        this.completeChannel(channel, syscallNr, origArgs, SYSCALL_ARGS[syscallNr], 0, 0);
        return;
      }
      // For timeout > 0, retry after min(timeout, retry_interval)
      const retryMs = timeout > 0 ? Math.min(timeout, EAGAIN_RETRY_MS) : EAGAIN_RETRY_MS;
      setTimeout(() => {
        if (this.processes.has(channel.pid)) {
          this.retrySyscall(channel);
        }
      }, retryMs);
      return;
    }

    // Default: retry after short delay (pipe read/write, socket operations, etc.)
    setTimeout(() => {
      if (this.processes.has(channel.pid)) {
        this.retrySyscall(channel);
      }
    }, EAGAIN_RETRY_MS);
  }

  /**
   * Retry a syscall by re-invoking handleSyscall with the original
   * args still in the process channel.
   */
  private retrySyscall(channel: ChannelInfo): void {
    // The process channel still has the original args (we never wrote a response).
    // Just re-handle it.
    this.handleSyscall(channel);
  }

  /**
   * Handle sleep syscalls where the kernel returns success immediately
   * but we need to delay the channel response.
   * Returns true if this is a sleep syscall that was handled.
   */
  private handleSleepDelay(
    channel: ChannelInfo,
    syscallNr: number,
    origArgs: number[],
    retVal: number,
    errVal: number,
  ): boolean {
    if (syscallNr === SYS_NANOSLEEP && retVal >= 0) {
      // nanosleep: a1 = pointer to timespec {sec, nsec} in kernel scratch
      const kernelView = new DataView(this.kernelMemory!.buffer, this.scratchOffset);
      const sec = kernelView.getUint32(CH_DATA, true);
      const nsec = kernelView.getUint32(CH_DATA + 4, true);
      const delayMs = sec * 1000 + Math.floor(nsec / 1_000_000);

      if (delayMs > 0) {
        setTimeout(() => {
          if (this.processes.has(channel.pid)) {
            this.completeChannel(channel, syscallNr, origArgs, SYSCALL_ARGS[syscallNr], retVal, errVal);
          }
        }, delayMs);
        return true;
      }
    }

    if (syscallNr === SYS_USLEEP && retVal >= 0) {
      // usleep: a1 = microseconds
      const usec = origArgs[0] >>> 0;
      const delayMs = Math.max(1, Math.floor(usec / 1000));

      if (delayMs > 0) {
        setTimeout(() => {
          if (this.processes.has(channel.pid)) {
            this.completeChannel(channel, syscallNr, origArgs, SYSCALL_ARGS[syscallNr], retVal, errVal);
          }
        }, delayMs);
        return true;
      }
    }

    if (syscallNr === SYS_CLOCK_NANOSLEEP && retVal >= 0) {
      // clock_nanosleep: a3 = pointer to timespec in kernel scratch
      const kernelView = new DataView(this.kernelMemory!.buffer, this.scratchOffset);
      // The timespec was copied to scratch data at a specific offset.
      // We need to find where it was placed. Since it's arg index 2 (the 3rd arg),
      // and it's the only pointer arg for this syscall, it should be at CH_DATA.
      const sec = kernelView.getUint32(CH_DATA, true);
      const nsec = kernelView.getUint32(CH_DATA + 4, true);
      const delayMs = sec * 1000 + Math.floor(nsec / 1_000_000);

      if (delayMs > 0) {
        setTimeout(() => {
          if (this.processes.has(channel.pid)) {
            this.completeChannel(channel, syscallNr, origArgs, SYSCALL_ARGS[syscallNr], retVal, errVal);
          }
        }, delayMs);
        return true;
      }
    }

    return false;
  }

  // -----------------------------------------------------------------------
  // Fork/exec/clone/exit handling
  // -----------------------------------------------------------------------

  /**
   * Handle SYS_FORK/SYS_VFORK: clone the Process in the kernel's ProcessTable,
   * then call the onFork callback to spawn the child Worker.
   */
  private handleFork(channel: ChannelInfo, _origArgs: number[]): void {
    if (!this.callbacks.onFork) {
      // No fork handler — return -ENOSYS
      this.completeChannel(channel, SYS_FORK, _origArgs, undefined, -1, 38);
      return;
    }

    const parentPid = channel.pid;
    const childPid = this.nextChildPid++;

    // Clone the Process in the kernel's ProcessTable
    const kernelForkProcess = this.kernelInstance!.exports.kernel_fork_process as
      (parentPid: number, childPid: number) => number;
    const forkResult = kernelForkProcess(parentPid, childPid);
    if (forkResult < 0) {
      // Fork failed in kernel (e.g., ESRCH, ENOMEM)
      this.completeChannel(channel, SYS_FORK, _origArgs, undefined, -1, (-forkResult) >>> 0);
      return;
    }

    // Call the async fork handler to spawn child Worker
    this.callbacks.onFork(parentPid, childPid, channel.memory).then((childChannelOffsets) => {
      if (!this.processes.has(parentPid)) return;

      // Register the child's channels with the kernel worker.
      // The callback should have already created the child's Memory as a copy
      // of the parent's. We need the child's Memory reference.
      // For now, the onFork callback handles registration externally.
      // We just need to complete the parent's channel with the child PID.

      // Complete parent's channel with child PID
      this.completeChannel(channel, SYS_FORK, _origArgs, undefined, childPid, 0);
    }).catch(() => {
      // Fork failed — remove child from kernel ProcessTable
      const removeProcess = this.kernelInstance!.exports.kernel_remove_process as
        (pid: number) => number;
      removeProcess(childPid);

      // Return -ENOMEM to parent
      this.completeChannel(channel, SYS_FORK, _origArgs, undefined, -1, 12);
    });
  }

  /**
   * Handle SYS_EXECVE: read the path from process memory, call the onExec
   * callback to resolve and load the new program.
   */
  private handleExec(channel: ChannelInfo, origArgs: number[]): void {
    // Read path from process memory (arg 0 is a pointer to null-terminated string)
    const pathPtr = origArgs[0];
    const processMem = new Uint8Array(channel.memory.buffer);
    let pathLen = 0;
    while (processMem[pathPtr + pathLen] !== 0 && pathLen < 4096) {
      pathLen++;
    }
    const path = new TextDecoder().decode(processMem.subarray(pathPtr, pathPtr + pathLen));

    if (!this.callbacks.onExec) {
      // No exec handler — return -ENOSYS
      this.completeChannel(channel, SYS_EXECVE, origArgs, undefined, -1, 38);
      return;
    }

    // Handle exec-related process cleanup in kernel (close CLOEXEC, reset signals)
    const kernelExecSetup = this.kernelInstance!.exports.kernel_exec_setup as
      (pid: number) => number;
    const setupResult = kernelExecSetup(channel.pid);
    if (setupResult < 0) {
      this.completeChannel(channel, SYS_EXECVE, origArgs, undefined, -1, (-setupResult) >>> 0);
      return;
    }

    // Call the async exec handler
    this.callbacks.onExec(channel.pid, path).then((result) => {
      if (!this.processes.has(channel.pid)) return;

      if (result < 0) {
        // Exec failed
        this.completeChannel(channel, SYS_EXECVE, origArgs, undefined, -1, (-result) >>> 0);
      }
      // On success, execve doesn't return — the Worker gets reinitialized
      // with the new program. The channel will be re-registered when the
      // new program starts. Don't complete the channel.
    }).catch(() => {
      this.completeChannel(channel, SYS_EXECVE, origArgs, undefined, -1, 2); // ENOENT
    });
  }

  /**
   * Handle SYS_CLONE: thread creation. Call the onClone callback to spawn
   * a thread Worker sharing the parent's Memory.
   */
  private handleClone(channel: ChannelInfo, origArgs: number[]): void {
    // clone args: (fn_ptr, stack_ptr, flags, arg, ptid_ptr, tls_ptr)
    // In musl's __syscall6 layout for clone
    const fnPtr = origArgs[0];
    const stackPtr = origArgs[1];
    const _flags = origArgs[2];
    const _arg = origArgs[3];
    const _ptidPtr = origArgs[4];
    const tlsPtr = origArgs[5];

    // For clone, we also need ctidPtr. In the kernel dispatch:
    // 201 => kernel_clone(a1, a2, a3, a4, a5, 0) -- 6th arg is ctid but mapped to 0
    // Actually the musl clone sends: fn, stack, flags, arg, ptid, tls, ctid
    // But our syscall only has 6 args. Let's pass through to the kernel for now.

    // Route through the normal kernel_handle_channel for clone — the kernel's
    // sys_clone will return a TID. The onClone callback handles Worker spawning.
    if (!this.callbacks.onClone) {
      // No clone handler — return -ENOSYS
      this.completeChannel(channel, SYS_CLONE, origArgs, undefined, -1, 38);
      return;
    }

    // We need ctidPtr which may be embedded differently. For simplicity,
    // let the kernel handle the clone request and return the TID.
    // Then call onClone to spawn the thread Worker.

    // Call kernel_handle_channel normally for clone — the kernel allocates
    // thread state and returns a TID.
    const kernelView = new DataView(this.kernelMemory!.buffer, this.scratchOffset);
    kernelView.setUint32(CH_SYSCALL, SYS_CLONE, true);
    for (let i = 0; i < CH_ARGS_COUNT; i++) {
      kernelView.setInt32(CH_ARGS + i * 4, origArgs[i], true);
    }

    const handleChannel = this.kernelInstance!.exports.kernel_handle_channel as
      (offset: number, pid: number) => number;
    handleChannel(this.scratchOffset, channel.pid);

    const retVal = kernelView.getInt32(CH_RETURN, true);
    const errVal = kernelView.getUint32(CH_ERRNO, true);

    if (retVal < 0) {
      // Clone failed in kernel
      this.completeChannel(channel, SYS_CLONE, origArgs, undefined, retVal, errVal);
      return;
    }

    const tid = retVal;

    // Call onClone to spawn thread Worker, then complete parent's channel with TID
    this.callbacks.onClone(
      channel.pid, fnPtr, _arg, stackPtr, tlsPtr, 0, channel.memory,
    ).then((assignedTid) => {
      if (!this.processes.has(channel.pid)) return;
      this.completeChannel(channel, SYS_CLONE, origArgs, undefined, assignedTid, 0);
    }).catch(() => {
      this.completeChannel(channel, SYS_CLONE, origArgs, undefined, -1, 12); // ENOMEM
    });
  }

  /**
   * Handle SYS_EXIT/SYS_EXIT_GROUP: notify the kernel and clean up.
   */
  private handleExit(channel: ChannelInfo, syscallNr: number, origArgs: number[]): void {
    const exitStatus = origArgs[0];

    // Route through kernel to update process state
    const kernelView = new DataView(this.kernelMemory!.buffer, this.scratchOffset);
    kernelView.setUint32(CH_SYSCALL, syscallNr, true);
    for (let i = 0; i < CH_ARGS_COUNT; i++) {
      kernelView.setInt32(CH_ARGS + i * 4, origArgs[i], true);
    }

    const handleChannel = this.kernelInstance!.exports.kernel_handle_channel as
      (offset: number, pid: number) => number;
    handleChannel(this.scratchOffset, channel.pid);

    // Complete the channel so the process unblocks (it will exit after)
    const retVal = kernelView.getInt32(CH_RETURN, true);
    const errVal = kernelView.getUint32(CH_ERRNO, true);
    this.completeChannel(channel, syscallNr, origArgs, undefined, retVal, errVal);

    // Notify callback
    if (this.callbacks.onExit) {
      this.callbacks.onExit(channel.pid, exitStatus);
    }
  }

  /** Set the next child PID to allocate. */
  setNextChildPid(pid: number): void {
    this.nextChildPid = pid;
  }

  /** Get the underlying kernel instance for direct access. */
  getKernel(): WasmPosixKernel {
    return this.kernel;
  }

  /** Get the kernel Wasm instance. */
  getKernelInstance(): WebAssembly.Instance | null {
    return this.kernelInstance;
  }
}
