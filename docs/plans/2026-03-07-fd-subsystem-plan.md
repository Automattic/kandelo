# File Descriptor Subsystem Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement a working POSIX file descriptor subsystem (open, close, read, write, lseek, dup, dup2, pipe, fstat, fcntl) as the first kernel subsystem, establishing the full architecture (Rust Wasm kernel-space, user-space stubs, TypeScript host glue).

**Architecture:** Cargo workspace with three Rust crates (`kernel`, `userspace`, `shared`) targeting `wasm32-unknown-unknown` without wasm-bindgen. TypeScript host glue with `tsup` for dual ESM/CJS. SharedArrayBuffer+Atomics as the primary IPC path.

**Tech Stack:** Rust (nightly, for wasm atomics), TypeScript, tsup, Vitest

---

### Task 1: Project Scaffolding — Cargo Workspace

**Files:**
- Create: `Cargo.toml` (workspace root)
- Create: `crates/shared/Cargo.toml`
- Create: `crates/shared/src/lib.rs`
- Create: `crates/kernel/Cargo.toml`
- Create: `crates/kernel/src/lib.rs`
- Create: `crates/userspace/Cargo.toml`
- Create: `crates/userspace/src/lib.rs`
- Create: `.cargo/config.toml`
- Create: `rust-toolchain.toml`

**Step 1: Create workspace root Cargo.toml**

```toml
# Cargo.toml
[workspace]
resolver = "2"
members = [
    "crates/shared",
    "crates/kernel",
    "crates/userspace",
]

[workspace.package]
version = "0.1.0"
edition = "2024"

[profile.release]
lto = true
opt-level = "s"
strip = true
```

**Step 2: Create the shared crate**

```toml
# crates/shared/Cargo.toml
[package]
name = "wasm-posix-shared"
version.workspace = true
edition.workspace = true

[lib]
crate-type = ["rlib"]
```

```rust
// crates/shared/src/lib.rs
#![no_std]

/// Syscall numbers for the kernel interface.
#[repr(u32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Syscall {
    Open = 1,
    Close = 2,
    Read = 3,
    Write = 4,
    Lseek = 5,
    Dup = 6,
    Dup2 = 7,
    Pipe = 8,
    Fstat = 9,
    Fcntl = 10,
}

/// Syscall channel status values.
#[repr(u32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelStatus {
    Idle = 0,
    Pending = 1,
    Complete = 2,
    Error = 3,
}

/// POSIX errno values.
#[repr(i32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Errno {
    Success = 0,
    EPERM = 1,
    ENOENT = 2,
    EINTR = 4,
    EIO = 5,
    ENXIO = 6,
    EBADF = 9,
    EAGAIN = 11,
    ENOMEM = 12,
    EACCES = 13,
    EFAULT = 14,
    EEXIST = 17,
    ENOTDIR = 20,
    EISDIR = 21,
    EINVAL = 22,
    ENFILE = 23,
    EMFILE = 24,
    ENOSPC = 28,
    ESPIPE = 29,
    EROFS = 30,
    EPIPE = 32,
    ERANGE = 34,
    ENAMETOOLONG = 36,
    ENOSYS = 38,
    ENOTEMPTY = 39,
    ELOOP = 40,
    EOVERFLOW = 75,
    ECONNRESET = 104,
    ENOTCONN = 107,
}

/// Open file flags (O_* constants).
pub mod flags {
    pub const O_RDONLY: u32 = 0;
    pub const O_WRONLY: u32 = 1;
    pub const O_RDWR: u32 = 2;
    pub const O_ACCMODE: u32 = 3;
    pub const O_CREAT: u32 = 0o100;
    pub const O_EXCL: u32 = 0o200;
    pub const O_TRUNC: u32 = 0o1000;
    pub const O_APPEND: u32 = 0o2000;
    pub const O_NONBLOCK: u32 = 0o4000;
    pub const O_DIRECTORY: u32 = 0o200000;
    pub const O_CLOEXEC: u32 = 0o2000000;
}

/// File descriptor flags.
pub mod fd_flags {
    pub const FD_CLOEXEC: u32 = 1;
}

/// fcntl commands.
pub mod fcntl_cmd {
    pub const F_DUPFD: u32 = 0;
    pub const F_GETFD: u32 = 1;
    pub const F_SETFD: u32 = 2;
    pub const F_GETFL: u32 = 3;
    pub const F_SETFL: u32 = 4;
    pub const F_DUPFD_CLOEXEC: u32 = 1030;
}

/// lseek whence values.
pub mod seek {
    pub const SEEK_SET: u32 = 0;
    pub const SEEK_CUR: u32 = 1;
    pub const SEEK_END: u32 = 2;
}

/// File mode/type constants for stat.
pub mod mode {
    pub const S_IFMT: u32 = 0o170000;
    pub const S_IFREG: u32 = 0o100000;
    pub const S_IFDIR: u32 = 0o040000;
    pub const S_IFCHR: u32 = 0o020000;
    pub const S_IFBLK: u32 = 0o060000;
    pub const S_IFIFO: u32 = 0o010000;
    pub const S_IFLNK: u32 = 0o120000;
    pub const S_IFSOCK: u32 = 0o140000;

    pub const S_IRWXU: u32 = 0o700;
    pub const S_IRUSR: u32 = 0o400;
    pub const S_IWUSR: u32 = 0o200;
    pub const S_IXUSR: u32 = 0o100;
    pub const S_IRWXG: u32 = 0o070;
    pub const S_IRGRP: u32 = 0o040;
    pub const S_IWGRP: u32 = 0o020;
    pub const S_IXGRP: u32 = 0o010;
    pub const S_IRWXO: u32 = 0o007;
    pub const S_IROTH: u32 = 0o004;
    pub const S_IWOTH: u32 = 0o002;
    pub const S_IXOTH: u32 = 0o001;
}

/// Syscall channel layout offsets (bytes).
pub mod channel {
    pub const STATUS_OFFSET: usize = 0;
    pub const SYSCALL_OFFSET: usize = 4;
    pub const ARGS_OFFSET: usize = 8;
    pub const ARGS_COUNT: usize = 6;
    pub const RETURN_OFFSET: usize = 32;
    pub const ERRNO_OFFSET: usize = 36;
    pub const DATA_OFFSET: usize = 40;
    /// Minimum channel size (header + 64KB data buffer).
    pub const MIN_CHANNEL_SIZE: usize = 40 + 65536;
}

/// Stat structure layout for serialization across the Wasm boundary.
/// All fields are u32 for simplicity in the initial implementation.
#[repr(C)]
#[derive(Debug, Clone, Copy, Default)]
pub struct WasmStat {
    pub st_dev: u64,
    pub st_ino: u64,
    pub st_mode: u32,
    pub st_nlink: u32,
    pub st_uid: u32,
    pub st_gid: u32,
    pub st_size: u64,
    pub st_atime_sec: u64,
    pub st_atime_nsec: u32,
    pub st_mtime_sec: u64,
    pub st_mtime_nsec: u32,
    pub st_ctime_sec: u64,
    pub st_ctime_nsec: u32,
    pub _pad: u32,
}
```

**Step 3: Create the kernel crate**

```toml
# crates/kernel/Cargo.toml
[package]
name = "kandelo"
version.workspace = true
edition.workspace = true

[lib]
crate-type = ["cdylib"]

[dependencies]
wasm-posix-shared = { path = "../shared" }
```

```rust
// crates/kernel/src/lib.rs
#![no_std]

extern crate wasm_posix_shared;

#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    loop {}
}
```

**Step 4: Create the userspace crate**

```toml
# crates/userspace/Cargo.toml
[package]
name = "wasm-posix-userspace"
version.workspace = true
edition.workspace = true

[lib]
crate-type = ["cdylib"]

[dependencies]
wasm-posix-shared = { path = "../shared" }
```

```rust
// crates/userspace/src/lib.rs
#![no_std]

extern crate wasm_posix_shared;

#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    loop {}
}
```

**Step 5: Create .cargo/config.toml**

```toml
# .cargo/config.toml
[build]
target = "wasm32-unknown-unknown"

[target.wasm32-unknown-unknown]
rustflags = ["-C", "target-feature=+atomics,+bulk-memory,+mutable-globals"]
```

**Step 6: Create rust-toolchain.toml**

```toml
# rust-toolchain.toml
[toolchain]
channel = "nightly"
targets = ["wasm32-unknown-unknown"]
```

**Step 7: Verify it compiles**

Run: `cd /Users/brandon/ai-src/kandelo && cargo build --release -Z build-std=core,alloc -Z build-std-features=panic_immediate_abort`
Expected: Successful build producing `.wasm` files in `target/wasm32-unknown-unknown/release/`

**Step 8: Commit**

```bash
git add Cargo.toml crates/ .cargo/ rust-toolchain.toml
git commit -m "feat: scaffold Cargo workspace with kernel, userspace, and shared crates"
```

---

### Task 2: Project Scaffolding — TypeScript Host Glue

**Files:**
- Create: `host/package.json`
- Create: `host/tsconfig.json`
- Create: `host/tsup.config.ts`
- Create: `host/src/index.ts`

**Step 1: Create host/package.json**

```json
{
  "name": "wasm-posix-host",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": {
        "types": "./dist/index.d.ts",
        "default": "./dist/index.js"
      },
      "require": {
        "types": "./dist/index.d.cts",
        "default": "./dist/index.cjs"
      }
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "test": "vitest"
  },
  "devDependencies": {
    "tsup": "^8.0.0",
    "typescript": "^5.4.0",
    "vitest": "^3.0.0"
  }
}
```

**Step 2: Create host/tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "sourceMap": true,
    "lib": ["ES2022", "DOM"]
  },
  "include": ["src"]
}
```

**Step 3: Create host/tsup.config.ts**

```typescript
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  splitting: false,
});
```

**Step 4: Create host/src/index.ts**

```typescript
export { WasmPosixKernel } from "./kernel";
export type { KernelConfig, PlatformIO } from "./types";
```

**Step 5: Create host/src/types.ts**

```typescript
export interface KernelConfig {
  /** Number of worker channels to pre-allocate. */
  maxWorkers: number;
  /** Size of the data transfer buffer per channel (bytes). */
  dataBufferSize: number;
  /** Whether SharedArrayBuffer is available. */
  useSharedMemory: boolean;
}

export interface PlatformIO {
  /** Open a file, returning a host-side handle. */
  open(path: string, flags: number, mode: number): Promise<number>;
  /** Close a host-side handle. */
  close(handle: number): Promise<number>;
  /** Read from a host-side handle into a buffer. */
  read(handle: number, buffer: Uint8Array, offset: number, length: number): Promise<number>;
  /** Write to a host-side handle from a buffer. */
  write(handle: number, buffer: Uint8Array, offset: number, length: number): Promise<number>;
  /** Seek on a host-side handle. */
  seek(handle: number, offset: number, whence: number): Promise<number>;
  /** Get file stats for a host-side handle. */
  fstat(handle: number): Promise<StatResult>;
}

export interface StatResult {
  dev: number;
  ino: number;
  mode: number;
  nlink: number;
  uid: number;
  gid: number;
  size: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
}
```

**Step 6: Create host/src/kernel.ts (stub)**

```typescript
import type { KernelConfig, PlatformIO } from "./types";

export class WasmPosixKernel {
  private config: KernelConfig;
  private io: PlatformIO;

  constructor(config: KernelConfig, io: PlatformIO) {
    this.config = config;
    this.io = io;
  }

  async init(): Promise<void> {
    // Will load kernel wasm, set up SharedArrayBuffer channels
  }
}
```

**Step 7: Install dependencies and verify build**

Run: `cd /Users/brandon/ai-src/kandelo/host && npm install && npm run build`
Expected: Successful build producing dist/ with ESM, CJS, and .d.ts files

**Step 8: Commit**

```bash
git add host/
git commit -m "feat: scaffold TypeScript host glue with tsup dual ESM/CJS output"
```

---

### Task 3: Kernel File Descriptor Table

**Files:**
- Create: `crates/kernel/src/fd.rs`
- Modify: `crates/kernel/src/lib.rs`

**Step 1: Write fd table tests**

```rust
// crates/kernel/src/fd.rs
#[cfg(test)]
mod tests {
    use super::*;
    use wasm_posix_shared::Errno;

    #[test]
    fn test_alloc_returns_lowest_available() {
        let mut table = FdTable::new();
        // Pre-open stdin=0, stdout=1, stderr=2
        table.preopen_stdio();
        let fd = table.alloc(OpenFileDescRef(0), 0).unwrap();
        assert_eq!(fd, 3);
    }

    #[test]
    fn test_alloc_fills_gaps() {
        let mut table = FdTable::new();
        table.preopen_stdio();
        let fd3 = table.alloc(OpenFileDescRef(0), 0).unwrap();
        let _fd4 = table.alloc(OpenFileDescRef(0), 0).unwrap();
        table.free(fd3);
        let fd_reused = table.alloc(OpenFileDescRef(0), 0).unwrap();
        assert_eq!(fd_reused, 3); // gap filled
    }

    #[test]
    fn test_alloc_at_minimum() {
        let mut table = FdTable::new();
        table.preopen_stdio();
        let fd = table.alloc_at_min(OpenFileDescRef(0), 0, 10).unwrap();
        assert_eq!(fd, 10);
    }

    #[test]
    fn test_close_invalid_fd() {
        let mut table = FdTable::new();
        assert_eq!(table.free(99), Err(Errno::EBADF));
    }

    #[test]
    fn test_get_fd_flags() {
        let mut table = FdTable::new();
        table.preopen_stdio();
        let fd = table.alloc(OpenFileDescRef(0), wasm_posix_shared::fd_flags::FD_CLOEXEC).unwrap();
        let entry = table.get(fd).unwrap();
        assert_eq!(entry.fd_flags, wasm_posix_shared::fd_flags::FD_CLOEXEC);
    }

    #[test]
    fn test_emfile_when_full() {
        let mut table = FdTable::with_max(4);
        table.preopen_stdio();
        let _ = table.alloc(OpenFileDescRef(0), 0).unwrap(); // fd 3
        assert_eq!(table.alloc(OpenFileDescRef(0), 0), Err(Errno::EMFILE));
    }
}
```

**Step 2: Run tests to verify they fail**

Run: `cd /Users/brandon/ai-src/kandelo && cargo test -p kandelo --target x86_64-apple-darwin`
Expected: FAIL — `FdTable` and `OpenFileDescRef` not defined

Note: We run kernel tests on the host target, not wasm32, since we need a test runner.

**Step 3: Implement FdTable**

```rust
// crates/kernel/src/fd.rs
extern crate alloc;
use alloc::vec::Vec;
use wasm_posix_shared::Errno;

/// Reference to an open file description (index into the OFD table).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OpenFileDescRef(pub usize);

/// Per-fd entry in the file descriptor table.
#[derive(Debug, Clone)]
pub struct FdEntry {
    pub ofd_ref: OpenFileDescRef,
    pub fd_flags: u32,
}

/// Per-process file descriptor table.
pub struct FdTable {
    entries: Vec<Option<FdEntry>>,
    max_fds: usize,
}

impl FdTable {
    pub fn new() -> Self {
        Self::with_max(1024)
    }

    pub fn with_max(max_fds: usize) -> Self {
        let mut entries = Vec::with_capacity(max_fds.min(64));
        entries.resize_with(max_fds.min(64), || None);
        FdTable { entries, max_fds }
    }

    /// Pre-open stdin(0), stdout(1), stderr(2) pointing to OFD refs 0, 1, 2.
    pub fn preopen_stdio(&mut self) {
        while self.entries.len() < 3 {
            self.entries.push(None);
        }
        for i in 0..3 {
            self.entries[i] = Some(FdEntry {
                ofd_ref: OpenFileDescRef(i),
                fd_flags: 0,
            });
        }
    }

    /// Allocate the lowest available fd, pointing to the given OFD.
    pub fn alloc(&mut self, ofd_ref: OpenFileDescRef, fd_flags: u32) -> Result<i32, Errno> {
        self.alloc_at_min(ofd_ref, fd_flags, 0)
    }

    /// Allocate the lowest available fd >= min_fd.
    pub fn alloc_at_min(&mut self, ofd_ref: OpenFileDescRef, fd_flags: u32, min_fd: i32) -> Result<i32, Errno> {
        let min = min_fd as usize;
        // Extend if needed
        while self.entries.len() <= min && self.entries.len() < self.max_fds {
            self.entries.push(None);
        }

        for i in min..self.entries.len() {
            if self.entries[i].is_none() {
                self.entries[i] = Some(FdEntry { ofd_ref, fd_flags });
                return Ok(i as i32);
            }
        }

        // Try extending
        if self.entries.len() < self.max_fds {
            let idx = self.entries.len();
            self.entries.push(Some(FdEntry { ofd_ref, fd_flags }));
            return Ok(idx as i32);
        }

        Err(Errno::EMFILE)
    }

    /// Free an fd, returning the OFD ref it pointed to.
    pub fn free(&mut self, fd: i32) -> Result<OpenFileDescRef, Errno> {
        let idx = fd as usize;
        if idx >= self.entries.len() {
            return Err(Errno::EBADF);
        }
        match self.entries[idx].take() {
            Some(entry) => Ok(entry.ofd_ref),
            None => Err(Errno::EBADF),
        }
    }

    /// Get an fd entry.
    pub fn get(&self, fd: i32) -> Result<&FdEntry, Errno> {
        let idx = fd as usize;
        if idx >= self.entries.len() {
            return Err(Errno::EBADF);
        }
        self.entries[idx].as_ref().ok_or(Errno::EBADF)
    }

    /// Get a mutable fd entry.
    pub fn get_mut(&mut self, fd: i32) -> Result<&mut FdEntry, Errno> {
        let idx = fd as usize;
        if idx >= self.entries.len() {
            return Err(Errno::EBADF);
        }
        self.entries[idx].as_mut().ok_or(Errno::EBADF)
    }

    /// Set fd at a specific index (for dup2). Closes existing if present.
    /// Returns the old OFD ref if one was displaced.
    pub fn set_at(&mut self, fd: i32, ofd_ref: OpenFileDescRef, fd_flags: u32) -> Result<Option<OpenFileDescRef>, Errno> {
        let idx = fd as usize;
        if idx >= self.max_fds {
            return Err(Errno::EBADF);
        }
        while self.entries.len() <= idx {
            self.entries.push(None);
        }
        let old = self.entries[idx].take().map(|e| e.ofd_ref);
        self.entries[idx] = Some(FdEntry { ofd_ref, fd_flags });
        Ok(old)
    }
}
```

**Step 4: Update kernel lib.rs**

```rust
// crates/kernel/src/lib.rs
#![no_std]
#![cfg_attr(target_arch = "wasm32", no_main)]

extern crate alloc;
extern crate wasm_posix_shared;

pub mod fd;

#[cfg(target_arch = "wasm32")]
#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    loop {}
}
```

**Step 5: Run tests to verify they pass**

Run: `cd /Users/brandon/ai-src/kandelo && cargo test -p kandelo --target x86_64-apple-darwin`
Expected: All 6 tests pass

**Step 6: Commit**

```bash
git add crates/kernel/src/
git commit -m "feat: implement per-process file descriptor table with alloc/free/dup support"
```

---

### Task 4: Open File Description Table

**Files:**
- Create: `crates/kernel/src/ofd.rs`
- Modify: `crates/kernel/src/lib.rs`

**Step 1: Write OFD table tests**

```rust
// In crates/kernel/src/ofd.rs
#[cfg(test)]
mod tests {
    use super::*;
    use wasm_posix_shared::flags;

    #[test]
    fn test_create_ofd() {
        let mut table = OfdTable::new();
        let idx = table.create(FileType::Regular, flags::O_RDWR, 42);
        assert_eq!(idx, 0);
        let ofd = table.get(idx).unwrap();
        assert_eq!(ofd.file_type, FileType::Regular);
        assert_eq!(ofd.status_flags, flags::O_RDWR);
        assert_eq!(ofd.host_handle, 42);
        assert_eq!(ofd.offset, 0);
        assert_eq!(ofd.ref_count, 1);
    }

    #[test]
    fn test_ref_counting() {
        let mut table = OfdTable::new();
        let idx = table.create(FileType::Regular, flags::O_RDONLY, 1);
        table.inc_ref(idx);
        assert_eq!(table.get(idx).unwrap().ref_count, 2);
        assert_eq!(table.dec_ref(idx), false); // not freed
        assert_eq!(table.get(idx).unwrap().ref_count, 1);
        assert_eq!(table.dec_ref(idx), true); // freed
        assert!(table.get(idx).is_none());
    }

    #[test]
    fn test_set_status_flags_preserves_access_mode() {
        let mut table = OfdTable::new();
        let idx = table.create(FileType::Regular, flags::O_RDWR | flags::O_APPEND, 1);
        // F_SETFL should not change access mode
        table.set_status_flags(idx, flags::O_NONBLOCK);
        let ofd = table.get(idx).unwrap();
        assert_eq!(ofd.status_flags & flags::O_ACCMODE, flags::O_RDWR);
        assert!(ofd.status_flags & flags::O_NONBLOCK != 0);
        assert!(ofd.status_flags & flags::O_APPEND == 0); // removed
    }
}
```

**Step 2: Run tests to verify they fail**

Run: `cargo test -p kandelo --target x86_64-apple-darwin`
Expected: FAIL

**Step 3: Implement OfdTable**

```rust
// crates/kernel/src/ofd.rs
extern crate alloc;
use alloc::vec::Vec;
use wasm_posix_shared::flags;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileType {
    Regular,
    Directory,
    Pipe,
    CharDevice,
    Socket,
}

/// Open file description — shared state among dup'd file descriptors.
pub struct OpenFileDesc {
    pub file_type: FileType,
    /// Access mode + status flags (O_RDONLY/O_WRONLY/O_RDWR + O_APPEND/O_NONBLOCK/...).
    pub status_flags: u32,
    /// Host-side handle (opaque identifier used by PlatformIO).
    pub host_handle: i64,
    /// Current file offset.
    pub offset: i64,
    /// Reference count.
    pub ref_count: u32,
}

/// Table of open file descriptions.
pub struct OfdTable {
    entries: Vec<Option<OpenFileDesc>>,
}

/// Flags that can be modified by F_SETFL.
const MODIFIABLE_FLAGS: u32 = flags::O_APPEND | flags::O_NONBLOCK;

impl OfdTable {
    pub fn new() -> Self {
        OfdTable {
            entries: Vec::new(),
        }
    }

    /// Create a new OFD, returning its index.
    pub fn create(&mut self, file_type: FileType, status_flags: u32, host_handle: i64) -> usize {
        let ofd = OpenFileDesc {
            file_type,
            status_flags,
            host_handle,
            offset: 0,
            ref_count: 1,
        };

        // Reuse a freed slot if available
        for (i, slot) in self.entries.iter_mut().enumerate() {
            if slot.is_none() {
                *slot = Some(ofd);
                return i;
            }
        }

        let idx = self.entries.len();
        self.entries.push(Some(ofd));
        idx
    }

    pub fn get(&self, idx: usize) -> Option<&OpenFileDesc> {
        self.entries.get(idx).and_then(|e| e.as_ref())
    }

    pub fn get_mut(&mut self, idx: usize) -> Option<&mut OpenFileDesc> {
        self.entries.get_mut(idx).and_then(|e| e.as_mut())
    }

    pub fn inc_ref(&mut self, idx: usize) {
        if let Some(ofd) = self.get_mut(idx) {
            ofd.ref_count += 1;
        }
    }

    /// Decrement ref count. Returns true if the OFD was freed.
    pub fn dec_ref(&mut self, idx: usize) -> bool {
        let should_free = if let Some(ofd) = self.get_mut(idx) {
            ofd.ref_count -= 1;
            ofd.ref_count == 0
        } else {
            return false;
        };

        if should_free {
            self.entries[idx] = None;
        }
        should_free
    }

    /// Set status flags per F_SETFL semantics: only O_APPEND, O_NONBLOCK etc.
    /// Preserves access mode bits.
    pub fn set_status_flags(&mut self, idx: usize, new_flags: u32) {
        if let Some(ofd) = self.get_mut(idx) {
            let access_mode = ofd.status_flags & flags::O_ACCMODE;
            let new_modifiable = new_flags & MODIFIABLE_FLAGS;
            ofd.status_flags = access_mode | new_modifiable;
        }
    }
}
```

**Step 4: Add mod to lib.rs**

Add `pub mod ofd;` to `crates/kernel/src/lib.rs`.

**Step 5: Run tests**

Run: `cargo test -p kandelo --target x86_64-apple-darwin`
Expected: All tests pass

**Step 6: Commit**

```bash
git add crates/kernel/src/
git commit -m "feat: implement open file description table with ref counting and F_SETFL semantics"
```

---

### Task 5: Pipe Ring Buffer

**Files:**
- Create: `crates/kernel/src/pipe.rs`
- Modify: `crates/kernel/src/lib.rs`

**Step 1: Write pipe buffer tests**

```rust
// crates/kernel/src/pipe.rs
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_write_and_read() {
        let mut pipe = PipeBuffer::new(64);
        assert_eq!(pipe.write(b"hello"), 5);
        let mut buf = [0u8; 10];
        assert_eq!(pipe.read(&mut buf), 5);
        assert_eq!(&buf[..5], b"hello");
    }

    #[test]
    fn test_fifo_ordering() {
        let mut pipe = PipeBuffer::new(64);
        pipe.write(b"first");
        pipe.write(b"second");
        let mut buf = [0u8; 20];
        let n = pipe.read(&mut buf);
        assert_eq!(&buf[..n], b"firstsecond");
    }

    #[test]
    fn test_full_buffer() {
        let mut pipe = PipeBuffer::new(8);
        assert_eq!(pipe.write(b"12345678"), 8);
        assert_eq!(pipe.write(b"more"), 0); // full
    }

    #[test]
    fn test_wraparound() {
        let mut pipe = PipeBuffer::new(8);
        pipe.write(b"12345678");
        let mut buf = [0u8; 4];
        pipe.read(&mut buf); // read 4, freeing space at front
        assert_eq!(pipe.write(b"abcd"), 4); // wraps around
        let mut buf2 = [0u8; 8];
        let n = pipe.read(&mut buf2);
        assert_eq!(&buf2[..n], b"5678abcd");
    }

    #[test]
    fn test_empty_read() {
        let mut pipe = PipeBuffer::new(64);
        let mut buf = [0u8; 10];
        assert_eq!(pipe.read(&mut buf), 0);
    }
}
```

**Step 2: Run tests to verify failure**

Run: `cargo test -p kandelo --target x86_64-apple-darwin`
Expected: FAIL

**Step 3: Implement PipeBuffer**

```rust
// crates/kernel/src/pipe.rs
extern crate alloc;
use alloc::vec::Vec;

pub const DEFAULT_PIPE_CAPACITY: usize = 65536;
pub const PIPE_BUF: usize = 4096;

/// A ring buffer backing a pipe.
pub struct PipeBuffer {
    buf: Vec<u8>,
    head: usize, // read position
    tail: usize, // write position
    len: usize,  // bytes currently in buffer
    read_end_open: bool,
    write_end_open: bool,
}

impl PipeBuffer {
    pub fn new(capacity: usize) -> Self {
        PipeBuffer {
            buf: {
                let mut v = Vec::with_capacity(capacity);
                v.resize(capacity, 0);
                v
            },
            head: 0,
            tail: 0,
            len: 0,
            read_end_open: true,
            write_end_open: true,
        }
    }

    pub fn capacity(&self) -> usize {
        self.buf.len()
    }

    pub fn available(&self) -> usize {
        self.len
    }

    pub fn free_space(&self) -> usize {
        self.buf.len() - self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// Write data into the pipe. Returns number of bytes written.
    pub fn write(&mut self, data: &[u8]) -> usize {
        let to_write = data.len().min(self.free_space());
        if to_write == 0 {
            return 0;
        }

        let cap = self.buf.len();
        for i in 0..to_write {
            self.buf[(self.tail + i) % cap] = data[i];
        }
        self.tail = (self.tail + to_write) % cap;
        self.len += to_write;
        to_write
    }

    /// Read data from the pipe. Returns number of bytes read.
    pub fn read(&mut self, buf: &mut [u8]) -> usize {
        let to_read = buf.len().min(self.len);
        if to_read == 0 {
            return 0;
        }

        let cap = self.buf.len();
        for i in 0..to_read {
            buf[i] = self.buf[(self.head + i) % cap];
        }
        self.head = (self.head + to_read) % cap;
        self.len -= to_read;
        to_read
    }

    pub fn close_read_end(&mut self) {
        self.read_end_open = false;
    }

    pub fn close_write_end(&mut self) {
        self.write_end_open = false;
    }

    pub fn is_read_end_open(&self) -> bool {
        self.read_end_open
    }

    pub fn is_write_end_open(&self) -> bool {
        self.write_end_open
    }
}
```

**Step 4: Add mod to lib.rs**

Add `pub mod pipe;` to `crates/kernel/src/lib.rs`.

**Step 5: Run tests**

Run: `cargo test -p kandelo --target x86_64-apple-darwin`
Expected: All tests pass

**Step 6: Commit**

```bash
git add crates/kernel/src/
git commit -m "feat: implement pipe ring buffer with FIFO ordering and wraparound"
```

---

### Task 6: Kernel Syscall Dispatcher

**Files:**
- Create: `crates/kernel/src/process.rs`
- Create: `crates/kernel/src/syscalls.rs`
- Modify: `crates/kernel/src/lib.rs`

**Step 1: Define the process state and syscall dispatcher**

The process state aggregates the fd table and OFD table. The syscall dispatcher routes syscall numbers to handler functions.

```rust
// crates/kernel/src/process.rs
extern crate alloc;
use alloc::vec::Vec;
use crate::fd::{FdTable, OpenFileDescRef};
use crate::ofd::{OfdTable, FileType};
use crate::pipe::PipeBuffer;
use wasm_posix_shared::{Errno, WasmStat};
use wasm_posix_shared::{flags, fd_flags, fcntl_cmd, seek, mode};

/// Host I/O callback trait (imported from the host environment).
pub trait HostIO {
    fn host_open(&mut self, path: &[u8], flags: u32, mode: u32) -> Result<i64, Errno>;
    fn host_close(&mut self, handle: i64) -> Result<(), Errno>;
    fn host_read(&mut self, handle: i64, buf: &mut [u8]) -> Result<usize, Errno>;
    fn host_write(&mut self, handle: i64, buf: &[u8]) -> Result<usize, Errno>;
    fn host_seek(&mut self, handle: i64, offset: i64, whence: u32) -> Result<i64, Errno>;
    fn host_fstat(&mut self, handle: i64) -> Result<WasmStat, Errno>;
}

/// Per-process kernel state.
pub struct Process {
    pub pid: u32,
    pub fd_table: FdTable,
    pub ofd_table: OfdTable,
    pub pipes: Vec<Option<PipeBuffer>>,
}

impl Process {
    pub fn new(pid: u32) -> Self {
        let mut proc = Process {
            pid,
            fd_table: FdTable::new(),
            ofd_table: OfdTable::new(),
            pipes: Vec::new(),
        };
        proc.fd_table.preopen_stdio();
        // Create OFDs for stdio (handles 0, 1, 2 from host)
        proc.ofd_table.create(FileType::CharDevice, flags::O_RDONLY, 0); // stdin
        proc.ofd_table.create(FileType::CharDevice, flags::O_WRONLY, 1); // stdout
        proc.ofd_table.create(FileType::CharDevice, flags::O_WRONLY, 2); // stderr
        proc
    }
}
```

```rust
// crates/kernel/src/syscalls.rs
use crate::fd::OpenFileDescRef;
use crate::ofd::FileType;
use crate::pipe::PipeBuffer;
use crate::process::{Process, HostIO};
use wasm_posix_shared::{Errno, WasmStat};
use wasm_posix_shared::{flags, fd_flags, fcntl_cmd, seek};

pub fn sys_open(proc: &mut Process, host: &mut dyn HostIO, path: &[u8], oflags: u32, mode: u32) -> Result<i32, Errno> {
    let handle = host.host_open(path, oflags, mode)?;
    let file_type = if oflags & flags::O_DIRECTORY != 0 {
        FileType::Directory
    } else {
        FileType::Regular
    };
    let ofd_idx = proc.ofd_table.create(file_type, oflags & !flags::O_CREAT & !flags::O_EXCL & !flags::O_TRUNC, handle);
    let fd_fl = if oflags & flags::O_CLOEXEC != 0 { fd_flags::FD_CLOEXEC } else { 0 };
    proc.fd_table.alloc(OpenFileDescRef(ofd_idx), fd_fl)
}

pub fn sys_close(proc: &mut Process, host: &mut dyn HostIO, fd: i32) -> Result<(), Errno> {
    let ofd_ref = proc.fd_table.free(fd)?;
    let freed = proc.ofd_table.dec_ref(ofd_ref.0);
    if freed {
        if let Some(ofd) = proc.ofd_table.get(ofd_ref.0) {
            // Won't reach here since it's freed, but we need the handle before freeing
        }
        // For pipes, close the appropriate end
        // For host-backed files, close the host handle
        // Note: we need to capture the handle before dec_ref frees the OFD
    }
    // Better approach: get handle before freeing
    Ok(())
}

pub fn sys_close_v2(proc: &mut Process, host: &mut dyn HostIO, fd: i32) -> Result<(), Errno> {
    let ofd_ref = proc.fd_table.free(fd)?;
    // Get host handle before potentially freeing the OFD
    let (host_handle, file_type) = {
        let ofd = proc.ofd_table.get(ofd_ref.0).ok_or(Errno::EBADF)?;
        (ofd.host_handle, ofd.file_type)
    };
    let freed = proc.ofd_table.dec_ref(ofd_ref.0);
    if freed {
        match file_type {
            FileType::Pipe => {
                // Pipe cleanup handled separately
            }
            _ => {
                let _ = host.host_close(host_handle);
            }
        }
    }
    Ok(())
}

pub fn sys_read(proc: &mut Process, host: &mut dyn HostIO, fd: i32, buf: &mut [u8]) -> Result<usize, Errno> {
    let ofd_ref = proc.fd_table.get(fd)?.ofd_ref;
    let ofd = proc.ofd_table.get(ofd_ref.0).ok_or(Errno::EBADF)?;

    // Check readable
    let access = ofd.status_flags & flags::O_ACCMODE;
    if access == flags::O_WRONLY {
        return Err(Errno::EBADF);
    }

    let handle = ofd.host_handle;
    let n = host.host_read(handle, buf)?;

    // Update offset
    if let Some(ofd) = proc.ofd_table.get_mut(ofd_ref.0) {
        ofd.offset += n as i64;
    }
    Ok(n)
}

pub fn sys_write(proc: &mut Process, host: &mut dyn HostIO, fd: i32, buf: &[u8]) -> Result<usize, Errno> {
    let ofd_ref = proc.fd_table.get(fd)?.ofd_ref;
    let ofd = proc.ofd_table.get(ofd_ref.0).ok_or(Errno::EBADF)?;

    // Check writable
    let access = ofd.status_flags & flags::O_ACCMODE;
    if access == flags::O_RDONLY {
        return Err(Errno::EBADF);
    }

    let handle = ofd.host_handle;
    let n = host.host_write(handle, buf)?;

    if let Some(ofd) = proc.ofd_table.get_mut(ofd_ref.0) {
        ofd.offset += n as i64;
    }
    Ok(n)
}

pub fn sys_lseek(proc: &mut Process, fd: i32, offset: i64, whence: u32) -> Result<i64, Errno> {
    let ofd_ref = proc.fd_table.get(fd)?.ofd_ref;
    let ofd = proc.ofd_table.get_mut(ofd_ref.0).ok_or(Errno::EBADF)?;

    if ofd.file_type == FileType::Pipe {
        return Err(Errno::ESPIPE);
    }

    let new_offset = match whence {
        seek::SEEK_SET => offset,
        seek::SEEK_CUR => ofd.offset + offset,
        seek::SEEK_END => {
            // For SEEK_END we'd need file size from host — for now return ENOSYS
            return Err(Errno::ENOSYS);
        }
        _ => return Err(Errno::EINVAL),
    };

    if new_offset < 0 {
        return Err(Errno::EINVAL);
    }

    ofd.offset = new_offset;
    Ok(new_offset)
}

pub fn sys_dup(proc: &mut Process, fd: i32) -> Result<i32, Errno> {
    let ofd_ref = proc.fd_table.get(fd)?.ofd_ref;
    proc.ofd_table.inc_ref(ofd_ref.0);
    proc.fd_table.alloc(ofd_ref, 0) // FD_CLOEXEC cleared
}

pub fn sys_dup2(proc: &mut Process, host: &mut dyn HostIO, oldfd: i32, newfd: i32) -> Result<i32, Errno> {
    // Validate oldfd
    let _ = proc.fd_table.get(oldfd)?;

    if oldfd == newfd {
        return Ok(newfd); // No-op per POSIX
    }

    if newfd < 0 {
        return Err(Errno::EBADF);
    }

    // Close newfd if open (ignore errors per POSIX)
    if proc.fd_table.get(newfd).is_ok() {
        let _ = sys_close_v2(proc, host, newfd);
    }

    let ofd_ref = proc.fd_table.get(oldfd)?.ofd_ref;
    proc.ofd_table.inc_ref(ofd_ref.0);
    proc.fd_table.set_at(newfd, ofd_ref, 0)?; // FD_CLOEXEC cleared
    Ok(newfd)
}

pub fn sys_pipe(proc: &mut Process) -> Result<(i32, i32), Errno> {
    let mut pipe = PipeBuffer::new(crate::pipe::DEFAULT_PIPE_CAPACITY);

    // Store pipe and get index
    let pipe_idx = {
        let mut found = None;
        for (i, slot) in proc.pipes.iter().enumerate() {
            if slot.is_none() {
                found = Some(i);
                break;
            }
        }
        match found {
            Some(i) => {
                proc.pipes[i] = Some(pipe);
                i
            }
            None => {
                let i = proc.pipes.len();
                proc.pipes.push(Some(pipe));
                i
            }
        }
    };

    // Encode pipe index as negative host handle to distinguish from host files
    let pipe_handle = -(pipe_idx as i64) - 1;

    // Create two OFDs: read end and write end
    let read_ofd = proc.ofd_table.create(FileType::Pipe, flags::O_RDONLY, pipe_handle);
    let write_ofd = proc.ofd_table.create(FileType::Pipe, flags::O_WRONLY, pipe_handle);

    let read_fd = proc.fd_table.alloc(OpenFileDescRef(read_ofd), 0)?;
    let write_fd = match proc.fd_table.alloc(OpenFileDescRef(write_ofd), 0) {
        Ok(fd) => fd,
        Err(e) => {
            proc.fd_table.free(read_fd).ok();
            proc.ofd_table.dec_ref(read_ofd);
            proc.ofd_table.dec_ref(write_ofd);
            return Err(e);
        }
    };

    Ok((read_fd, write_fd))
}

pub fn sys_fstat(proc: &mut Process, host: &mut dyn HostIO, fd: i32) -> Result<WasmStat, Errno> {
    let ofd_ref = proc.fd_table.get(fd)?.ofd_ref;
    let ofd = proc.ofd_table.get(ofd_ref.0).ok_or(Errno::EBADF)?;

    match ofd.file_type {
        FileType::Pipe => {
            let mut stat = WasmStat::default();
            stat.st_mode = wasm_posix_shared::mode::S_IFIFO | 0o600;
            Ok(stat)
        }
        _ => host.host_fstat(ofd.host_handle),
    }
}

pub fn sys_fcntl(proc: &mut Process, fd: i32, cmd: u32, arg: i32) -> Result<i32, Errno> {
    match cmd {
        fcntl_cmd::F_DUPFD => {
            let ofd_ref = proc.fd_table.get(fd)?.ofd_ref;
            proc.ofd_table.inc_ref(ofd_ref.0);
            proc.fd_table.alloc_at_min(ofd_ref, 0, arg)
        }
        fcntl_cmd::F_DUPFD_CLOEXEC => {
            let ofd_ref = proc.fd_table.get(fd)?.ofd_ref;
            proc.ofd_table.inc_ref(ofd_ref.0);
            proc.fd_table.alloc_at_min(ofd_ref, fd_flags::FD_CLOEXEC, arg)
        }
        fcntl_cmd::F_GETFD => {
            let entry = proc.fd_table.get(fd)?;
            Ok(entry.fd_flags as i32)
        }
        fcntl_cmd::F_SETFD => {
            let entry = proc.fd_table.get_mut(fd)?;
            entry.fd_flags = arg as u32;
            Ok(0)
        }
        fcntl_cmd::F_GETFL => {
            let ofd_ref = proc.fd_table.get(fd)?.ofd_ref;
            let ofd = proc.ofd_table.get(ofd_ref.0).ok_or(Errno::EBADF)?;
            Ok(ofd.status_flags as i32)
        }
        fcntl_cmd::F_SETFL => {
            let ofd_ref = proc.fd_table.get(fd)?.ofd_ref;
            proc.ofd_table.set_status_flags(ofd_ref.0, arg as u32);
            Ok(0)
        }
        _ => Err(Errno::EINVAL),
    }
}
```

**Step 2: Write integration tests for syscall flows**

```rust
// Add to crates/kernel/src/syscalls.rs
#[cfg(test)]
mod tests {
    use super::*;
    use crate::process::Process;

    struct MockHostIO {
        next_handle: i64,
    }

    impl MockHostIO {
        fn new() -> Self {
            MockHostIO { next_handle: 100 }
        }
    }

    impl HostIO for MockHostIO {
        fn host_open(&mut self, _path: &[u8], _flags: u32, _mode: u32) -> Result<i64, Errno> {
            let h = self.next_handle;
            self.next_handle += 1;
            Ok(h)
        }
        fn host_close(&mut self, _handle: i64) -> Result<(), Errno> { Ok(()) }
        fn host_read(&mut self, _handle: i64, buf: &mut [u8]) -> Result<usize, Errno> {
            let data = b"hello";
            let n = data.len().min(buf.len());
            buf[..n].copy_from_slice(&data[..n]);
            Ok(n)
        }
        fn host_write(&mut self, _handle: i64, buf: &[u8]) -> Result<usize, Errno> {
            Ok(buf.len())
        }
        fn host_seek(&mut self, _handle: i64, offset: i64, _whence: u32) -> Result<i64, Errno> {
            Ok(offset)
        }
        fn host_fstat(&mut self, _handle: i64) -> Result<WasmStat, Errno> {
            let mut stat = WasmStat::default();
            stat.st_mode = wasm_posix_shared::mode::S_IFREG | 0o644;
            stat.st_size = 1024;
            Ok(stat)
        }
    }

    #[test]
    fn test_open_close_cycle() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/tmp/test", flags::O_RDWR | flags::O_CREAT, 0o644).unwrap();
        assert_eq!(fd, 3); // 0,1,2 are stdio
        assert!(sys_close_v2(&mut proc, &mut host, fd).is_ok());
        assert_eq!(proc.fd_table.get(fd), Err(Errno::EBADF));
    }

    #[test]
    fn test_dup_shares_ofd() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/test", flags::O_RDWR, 0).unwrap();
        let fd2 = sys_dup(&mut proc, fd).unwrap();
        assert_ne!(fd, fd2);
        // Both should point to same OFD
        let ref1 = proc.fd_table.get(fd).unwrap().ofd_ref;
        let ref2 = proc.fd_table.get(fd2).unwrap().ofd_ref;
        assert_eq!(ref1, ref2);
    }

    #[test]
    fn test_dup2_replaces_target() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/test", flags::O_RDWR, 0).unwrap();
        let result = sys_dup2(&mut proc, &mut host, fd, 10).unwrap();
        assert_eq!(result, 10);
    }

    #[test]
    fn test_dup2_same_fd_noop() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/test", flags::O_RDWR, 0).unwrap();
        assert_eq!(sys_dup2(&mut proc, &mut host, fd, fd).unwrap(), fd);
    }

    #[test]
    fn test_pipe_read_write() {
        let mut proc = Process::new(1);
        let (read_fd, write_fd) = sys_pipe(&mut proc).unwrap();
        // Pipe fds should be 3 and 4
        assert_eq!(read_fd, 3);
        assert_eq!(write_fd, 4);
    }

    #[test]
    fn test_fcntl_dupfd() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/test", flags::O_RDWR, 0).unwrap();
        let fd2 = sys_fcntl(&mut proc, fd, fcntl_cmd::F_DUPFD, 10).unwrap();
        assert!(fd2 >= 10);
    }

    #[test]
    fn test_fcntl_cloexec() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/test", flags::O_RDWR | flags::O_CLOEXEC, 0).unwrap();
        let flags_val = sys_fcntl(&mut proc, fd, fcntl_cmd::F_GETFD, 0).unwrap();
        assert_eq!(flags_val as u32, fd_flags::FD_CLOEXEC);
        // Clear it
        sys_fcntl(&mut proc, fd, fcntl_cmd::F_SETFD, 0).unwrap();
        let flags_val = sys_fcntl(&mut proc, fd, fcntl_cmd::F_GETFD, 0).unwrap();
        assert_eq!(flags_val, 0);
    }

    #[test]
    fn test_fcntl_getfl_setfl() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/test", flags::O_RDWR, 0).unwrap();
        let fl = sys_fcntl(&mut proc, fd, fcntl_cmd::F_GETFL, 0).unwrap();
        assert_eq!(fl as u32 & flags::O_ACCMODE, flags::O_RDWR);
        // Set O_NONBLOCK
        sys_fcntl(&mut proc, fd, fcntl_cmd::F_SETFL, flags::O_NONBLOCK as i32).unwrap();
        let fl = sys_fcntl(&mut proc, fd, fcntl_cmd::F_GETFL, 0).unwrap();
        assert!(fl as u32 & flags::O_NONBLOCK != 0);
        // Access mode preserved
        assert_eq!(fl as u32 & flags::O_ACCMODE, flags::O_RDWR);
    }

    #[test]
    fn test_lseek() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/test", flags::O_RDWR, 0).unwrap();
        let pos = sys_lseek(&mut proc, fd, 100, seek::SEEK_SET).unwrap();
        assert_eq!(pos, 100);
        let pos = sys_lseek(&mut proc, fd, -10, seek::SEEK_CUR).unwrap();
        assert_eq!(pos, 90);
    }

    #[test]
    fn test_lseek_pipe_fails() {
        let mut proc = Process::new(1);
        let (read_fd, _write_fd) = sys_pipe(&mut proc).unwrap();
        assert_eq!(sys_lseek(&mut proc, read_fd, 0, seek::SEEK_SET), Err(Errno::ESPIPE));
    }

    #[test]
    fn test_read_write_only_fd_fails() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/test", flags::O_WRONLY, 0).unwrap();
        let mut buf = [0u8; 10];
        assert_eq!(sys_read(&mut proc, &mut host, fd, &mut buf), Err(Errno::EBADF));
    }

    #[test]
    fn test_write_read_only_fd_fails() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/test", flags::O_RDONLY, 0).unwrap();
        assert_eq!(sys_write(&mut proc, &mut host, fd, b"hello"), Err(Errno::EBADF));
    }

    #[test]
    fn test_fstat_regular_file() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/test", flags::O_RDONLY, 0).unwrap();
        let stat = sys_fstat(&mut proc, &mut host, fd).unwrap();
        assert_eq!(stat.st_mode & wasm_posix_shared::mode::S_IFMT, wasm_posix_shared::mode::S_IFREG);
        assert_eq!(stat.st_size, 1024);
    }

    #[test]
    fn test_fstat_pipe() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let (read_fd, _) = sys_pipe(&mut proc).unwrap();
        let stat = sys_fstat(&mut proc, &mut host, read_fd).unwrap();
        assert_eq!(stat.st_mode & wasm_posix_shared::mode::S_IFMT, wasm_posix_shared::mode::S_IFIFO);
    }
}
```

**Step 3: Add mods to lib.rs**

```rust
// crates/kernel/src/lib.rs
#![no_std]
#![cfg_attr(target_arch = "wasm32", no_main)]

extern crate alloc;
extern crate wasm_posix_shared;

pub mod fd;
pub mod ofd;
pub mod pipe;
pub mod process;
pub mod syscalls;

#[cfg(target_arch = "wasm32")]
#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    loop {}
}
```

**Step 4: Run tests**

Run: `cargo test -p kandelo --target x86_64-apple-darwin`
Expected: All tests pass

**Step 5: Commit**

```bash
git add crates/kernel/src/
git commit -m "feat: implement syscall handlers for open/close/read/write/lseek/dup/dup2/pipe/fstat/fcntl"
```

---

### Task 7: Wasm Export Layer (Kernel)

**Files:**
- Create: `crates/kernel/src/wasm_api.rs`
- Modify: `crates/kernel/src/lib.rs`

**Step 1: Create the Wasm export surface**

This module provides `#[no_mangle] extern "C"` functions that the host glue calls into. These are the kernel's Wasm exports.

```rust
// crates/kernel/src/wasm_api.rs
//! Wasm-exported functions for the kernel.
//! The host calls these to process syscalls from user-space.

use crate::process::{Process, HostIO};
use crate::syscalls;

/// Global kernel state. In Wasm, this module is single-threaded.
static mut PROCESS: Option<Process> = None;

/// Host I/O function imports. These are provided by the TypeScript host.
extern "C" {
    fn host_open(path_ptr: *const u8, path_len: u32, flags: u32, mode: u32) -> i64;
    fn host_close(handle: i64) -> i32;
    fn host_read(handle: i64, buf_ptr: *mut u8, buf_len: u32) -> i32;
    fn host_write(handle: i64, buf_ptr: *const u8, buf_len: u32) -> i32;
    fn host_seek(handle: i64, offset: i64, whence: u32) -> i64;
    fn host_fstat(handle: i64, stat_ptr: *mut u8) -> i32;
}

/// Wrapper that implements HostIO by calling imported host functions.
struct WasmHostIO;

impl HostIO for WasmHostIO {
    fn host_open(&mut self, path: &[u8], flags: u32, mode: u32) -> Result<i64, wasm_posix_shared::Errno> {
        let result = unsafe { host_open(path.as_ptr(), path.len() as u32, flags, mode) };
        if result < 0 {
            Err(wasm_posix_shared::Errno::EIO) // Host encodes errno in negative values
        } else {
            Ok(result)
        }
    }

    fn host_close(&mut self, handle: i64) -> Result<(), wasm_posix_shared::Errno> {
        let result = unsafe { host_close(handle) };
        if result < 0 { Err(wasm_posix_shared::Errno::EIO) } else { Ok(()) }
    }

    fn host_read(&mut self, handle: i64, buf: &mut [u8]) -> Result<usize, wasm_posix_shared::Errno> {
        let result = unsafe { host_read(handle, buf.as_mut_ptr(), buf.len() as u32) };
        if result < 0 { Err(wasm_posix_shared::Errno::EIO) } else { Ok(result as usize) }
    }

    fn host_write(&mut self, handle: i64, buf: &[u8]) -> Result<usize, wasm_posix_shared::Errno> {
        let result = unsafe { host_write(handle, buf.as_ptr(), buf.len() as u32) };
        if result < 0 { Err(wasm_posix_shared::Errno::EIO) } else { Ok(result as usize) }
    }

    fn host_seek(&mut self, handle: i64, offset: i64, whence: u32) -> Result<i64, wasm_posix_shared::Errno> {
        let result = unsafe { host_seek(handle, offset, whence) };
        if result < 0 { Err(wasm_posix_shared::Errno::EIO) } else { Ok(result) }
    }

    fn host_fstat(&mut self, handle: i64) -> Result<wasm_posix_shared::WasmStat, wasm_posix_shared::Errno> {
        let mut stat = wasm_posix_shared::WasmStat::default();
        let ptr = &mut stat as *mut _ as *mut u8;
        let result = unsafe { host_fstat(handle, ptr) };
        if result < 0 { Err(wasm_posix_shared::Errno::EIO) } else { Ok(stat) }
    }
}

fn get_process() -> &'static mut Process {
    unsafe { PROCESS.as_mut().expect("kernel not initialized") }
}

#[no_mangle]
pub extern "C" fn kernel_init(pid: u32) {
    unsafe {
        PROCESS = Some(Process::new(pid));
    }
}

#[no_mangle]
pub extern "C" fn kernel_open(path_ptr: *const u8, path_len: u32, flags: u32, mode: u32) -> i32 {
    let path = unsafe { core::slice::from_raw_parts(path_ptr, path_len as usize) };
    let proc = get_process();
    let mut host = WasmHostIO;
    match syscalls::sys_open(proc, &mut host, path, flags, mode) {
        Ok(fd) => fd,
        Err(e) => -(e as i32),
    }
}

#[no_mangle]
pub extern "C" fn kernel_close(fd: i32) -> i32 {
    let proc = get_process();
    let mut host = WasmHostIO;
    match syscalls::sys_close_v2(proc, &mut host, fd) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    }
}

#[no_mangle]
pub extern "C" fn kernel_read(fd: i32, buf_ptr: *mut u8, buf_len: u32) -> i32 {
    let buf = unsafe { core::slice::from_raw_parts_mut(buf_ptr, buf_len as usize) };
    let proc = get_process();
    let mut host = WasmHostIO;
    match syscalls::sys_read(proc, &mut host, fd, buf) {
        Ok(n) => n as i32,
        Err(e) => -(e as i32),
    }
}

#[no_mangle]
pub extern "C" fn kernel_write(fd: i32, buf_ptr: *const u8, buf_len: u32) -> i32 {
    let buf = unsafe { core::slice::from_raw_parts(buf_ptr, buf_len as usize) };
    let proc = get_process();
    let mut host = WasmHostIO;
    match syscalls::sys_write(proc, &mut host, fd, buf) {
        Ok(n) => n as i32,
        Err(e) => -(e as i32),
    }
}

#[no_mangle]
pub extern "C" fn kernel_lseek(fd: i32, offset_lo: u32, offset_hi: i32, whence: u32) -> i64 {
    let offset = ((offset_hi as i64) << 32) | (offset_lo as i64);
    let proc = get_process();
    match syscalls::sys_lseek(proc, fd, offset, whence) {
        Ok(pos) => pos,
        Err(e) => -(e as i64),
    }
}

#[no_mangle]
pub extern "C" fn kernel_dup(fd: i32) -> i32 {
    let proc = get_process();
    match syscalls::sys_dup(proc, fd) {
        Ok(new_fd) => new_fd,
        Err(e) => -(e as i32),
    }
}

#[no_mangle]
pub extern "C" fn kernel_dup2(oldfd: i32, newfd: i32) -> i32 {
    let proc = get_process();
    let mut host = WasmHostIO;
    match syscalls::sys_dup2(proc, &mut host, oldfd, newfd) {
        Ok(fd) => fd,
        Err(e) => -(e as i32),
    }
}

#[no_mangle]
pub extern "C" fn kernel_pipe(fildes_ptr: *mut i32) -> i32 {
    let proc = get_process();
    match syscalls::sys_pipe(proc) {
        Ok((read_fd, write_fd)) => {
            unsafe {
                *fildes_ptr = read_fd;
                *fildes_ptr.add(1) = write_fd;
            }
            0
        }
        Err(e) => -(e as i32),
    }
}

#[no_mangle]
pub extern "C" fn kernel_fstat(fd: i32, stat_ptr: *mut u8) -> i32 {
    let proc = get_process();
    let mut host = WasmHostIO;
    match syscalls::sys_fstat(proc, &mut host, fd) {
        Ok(stat) => {
            let bytes = unsafe {
                core::slice::from_raw_parts(
                    &stat as *const _ as *const u8,
                    core::mem::size_of::<wasm_posix_shared::WasmStat>(),
                )
            };
            unsafe {
                core::ptr::copy_nonoverlapping(bytes.as_ptr(), stat_ptr, bytes.len());
            }
            0
        }
        Err(e) => -(e as i32),
    }
}

#[no_mangle]
pub extern "C" fn kernel_fcntl(fd: i32, cmd: u32, arg: i32) -> i32 {
    let proc = get_process();
    match syscalls::sys_fcntl(proc, fd, cmd, arg) {
        Ok(result) => result,
        Err(e) => -(e as i32),
    }
}
```

**Step 2: Add mod to lib.rs**

Add `#[cfg(target_arch = "wasm32")] pub mod wasm_api;` to `crates/kernel/src/lib.rs`.

**Step 3: Verify Wasm build**

Run: `cargo build --release -Z build-std=core,alloc -Z build-std-features=panic_immediate_abort`
Expected: Builds successfully, producing `target/wasm32-unknown-unknown/release/kandelo_kernel.wasm`

**Step 4: Commit**

```bash
git add crates/kernel/src/
git commit -m "feat: add Wasm export layer for kernel syscall interface"
```

---

### Task 8: TypeScript Host — Kernel Loader and Channel Setup

**Files:**
- Create: `host/src/channel.ts`
- Modify: `host/src/kernel.ts`
- Create: `host/src/platform/node.ts`

**Step 1: Implement syscall channel abstraction**

```typescript
// host/src/channel.ts

// Channel layout constants (must match shared crate)
export const STATUS_OFFSET = 0;
export const SYSCALL_OFFSET = 4;
export const ARGS_OFFSET = 8;
export const RETURN_OFFSET = 32;
export const ERRNO_OFFSET = 36;
export const DATA_OFFSET = 40;
export const MIN_CHANNEL_SIZE = 40 + 65536;

export const enum ChannelStatus {
  Idle = 0,
  Pending = 1,
  Complete = 2,
  Error = 3,
}

export class SyscallChannel {
  private view: DataView;
  private i32View: Int32Array;
  private dataView: Uint8Array;

  constructor(buffer: SharedArrayBuffer | ArrayBuffer, byteOffset = 0) {
    this.view = new DataView(buffer, byteOffset);
    this.i32View = new Int32Array(buffer, byteOffset);
    this.dataView = new Uint8Array(buffer, byteOffset + DATA_OFFSET);
  }

  get status(): ChannelStatus {
    return Atomics.load(this.i32View, STATUS_OFFSET / 4);
  }

  set status(value: ChannelStatus) {
    Atomics.store(this.i32View, STATUS_OFFSET / 4, value);
  }

  get syscallNumber(): number {
    return this.view.getUint32(SYSCALL_OFFSET, true);
  }

  getArg(index: number): number {
    return this.view.getInt32(ARGS_OFFSET + index * 4, true);
  }

  setReturn(value: number): void {
    this.view.setInt32(RETURN_OFFSET, value, true);
  }

  setErrno(value: number): void {
    this.view.setInt32(ERRNO_OFFSET, value, true);
  }

  get dataBuffer(): Uint8Array {
    return this.dataView;
  }

  /** Wake a worker waiting on this channel. */
  notifyWorker(): void {
    Atomics.store(this.i32View, STATUS_OFFSET / 4, ChannelStatus.Complete);
    Atomics.notify(this.i32View, STATUS_OFFSET / 4);
  }

  /** Wait for kernel to complete (called from worker side). */
  waitForComplete(): ChannelStatus {
    while (true) {
      const status = Atomics.load(this.i32View, STATUS_OFFSET / 4);
      if (status === ChannelStatus.Complete || status === ChannelStatus.Error) {
        return status;
      }
      Atomics.wait(this.i32View, STATUS_OFFSET / 4, ChannelStatus.Pending);
    }
  }
}
```

**Step 2: Implement Node.js platform I/O**

```typescript
// host/src/platform/node.ts
import type { PlatformIO, StatResult } from "../types";

export class NodePlatformIO implements PlatformIO {
  private fs: typeof import("node:fs") | null = null;

  private async getFs() {
    if (!this.fs) {
      this.fs = await import("node:fs");
    }
    return this.fs;
  }

  async open(path: string, flags: number, mode: number): Promise<number> {
    const fs = await this.getFs();
    // Convert POSIX flags to Node.js flags
    return fs.openSync(path, this.convertFlags(flags), mode);
  }

  async close(handle: number): Promise<number> {
    const fs = await this.getFs();
    fs.closeSync(handle);
    return 0;
  }

  async read(handle: number, buffer: Uint8Array, offset: number, length: number): Promise<number> {
    const fs = await this.getFs();
    return fs.readSync(handle, buffer, 0, length, offset === -1 ? null : offset);
  }

  async write(handle: number, buffer: Uint8Array, offset: number, length: number): Promise<number> {
    const fs = await this.getFs();
    return fs.writeSync(handle, buffer, 0, length, offset === -1 ? null : offset);
  }

  async seek(handle: number, offset: number, whence: number): Promise<number> {
    // Node.js doesn't have lseek — we track offset in the kernel
    return offset;
  }

  async fstat(handle: number): Promise<StatResult> {
    const fs = await this.getFs();
    const stat = fs.fstatSync(handle);
    return {
      dev: stat.dev,
      ino: stat.ino,
      mode: stat.mode,
      nlink: stat.nlink,
      uid: stat.uid,
      gid: stat.gid,
      size: stat.size,
      atimeMs: stat.atimeMs,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
    };
  }

  private convertFlags(posixFlags: number): number {
    // POSIX flags map directly to Node.js fs constants on most platforms
    return posixFlags;
  }
}
```

**Step 3: Update kernel.ts with Wasm loading**

```typescript
// host/src/kernel.ts
import type { KernelConfig, PlatformIO } from "./types";

export class WasmPosixKernel {
  private config: KernelConfig;
  private io: PlatformIO;
  private instance: WebAssembly.Instance | null = null;
  private memory: WebAssembly.Memory | null = null;

  constructor(config: KernelConfig, io: PlatformIO) {
    this.config = config;
    this.io = io;
  }

  async init(wasmBytes: BufferSource): Promise<void> {
    this.memory = new WebAssembly.Memory({
      initial: 256, // 16MB
      maximum: 1024, // 64MB
    });

    const importObject = {
      env: {
        memory: this.memory,
        host_open: (pathPtr: number, pathLen: number, flags: number, mode: number): bigint => {
          const path = this.readString(pathPtr, pathLen);
          // Synchronous for now; async via SAB later
          return BigInt(-1); // TODO: wire up async
        },
        host_close: (handle: bigint): number => 0,
        host_read: (handle: bigint, bufPtr: number, bufLen: number): number => 0,
        host_write: (handle: bigint, bufPtr: number, bufLen: number): number => {
          const data = new Uint8Array(this.memory!.buffer, bufPtr, bufLen);
          // For stdio, write to console
          if (Number(handle) === 1 || Number(handle) === 2) {
            const text = new TextDecoder().decode(data);
            process.stdout.write(text);
            return bufLen;
          }
          return 0;
        },
        host_seek: (handle: bigint, offset: bigint, whence: number): bigint => BigInt(0),
        host_fstat: (handle: bigint, statPtr: number): number => 0,
      },
    };

    const { instance } = await WebAssembly.instantiate(wasmBytes, importObject);
    this.instance = instance;

    // Initialize kernel with PID 1
    (this.instance.exports.kernel_init as Function)(1);
  }

  private readString(ptr: number, len: number): string {
    const bytes = new Uint8Array(this.memory!.buffer, ptr, len);
    return new TextDecoder().decode(bytes);
  }

  // Public API for direct calls (non-worker mode)
  write(fd: number, data: Uint8Array): number {
    if (!this.instance || !this.memory) throw new Error("Kernel not initialized");
    // Copy data into Wasm memory
    const exports = this.instance.exports;
    // For now, use a simple approach — allocate in linear memory
    // TODO: proper memory management
    return (exports.kernel_write as Function)(fd, 0, data.length);
  }
}
```

**Step 4: Update host/src/index.ts exports**

```typescript
export { WasmPosixKernel } from "./kernel";
export { SyscallChannel } from "./channel";
export { NodePlatformIO } from "./platform/node";
export type { KernelConfig, PlatformIO, StatResult } from "./types";
```

**Step 5: Build and verify**

Run: `cd /Users/brandon/ai-src/kandelo/host && npm run build`
Expected: Build succeeds

**Step 6: Commit**

```bash
git add host/
git commit -m "feat: implement TypeScript host with syscall channel, kernel loader, and Node.js platform IO"
```

---

### Task 9: POSIX Compliance Status Document

**Files:**
- Create: `docs/posix-status.md`

**Step 1: Create the POSIX API support status document**

This is the living document tracking what's implemented and what's not.

See separate file content below — this is a reference document, not code.

**Step 2: Commit**

```bash
git add docs/posix-status.md
git commit -m "docs: add POSIX API compliance status tracking document"
```

---

### Task 10: Build Script and Integration Test

**Files:**
- Create: `build.sh`
- Create: `host/test/kernel.test.ts`

**Step 1: Create build script**

```bash
#!/bin/bash
set -euo pipefail

echo "Building Rust Wasm crates..."
cargo build --release \
  -Z build-std=core,alloc \
  -Z build-std-features=panic_immediate_abort

echo "Copying Wasm artifacts..."
mkdir -p host/wasm
cp target/wasm32-unknown-unknown/release/kandelo_kernel.wasm host/wasm/kandelo-kernel.wasm
cp target/wasm32-unknown-unknown/release/wasm_posix_userspace.wasm host/wasm/

echo "Building TypeScript host..."
cd host
npm run build
cd ..

echo "Build complete."
```

**Step 2: Create integration test**

```typescript
// host/test/kernel.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WasmPosixKernel } from "../src/kernel";
import { NodePlatformIO } from "../src/platform/node";

describe("WasmPosixKernel", () => {
  it("should initialize the kernel", async () => {
    const wasmPath = join(__dirname, "../wasm/kandelo-kernel.wasm");
    const wasmBytes = readFileSync(wasmPath);

    const kernel = new WasmPosixKernel(
      { maxWorkers: 4, dataBufferSize: 65536, useSharedMemory: false },
      new NodePlatformIO()
    );

    await kernel.init(wasmBytes);
    // If we get here without error, initialization succeeded
    expect(true).toBe(true);
  });
});
```

**Step 3: Verify full build and test**

Run: `chmod +x build.sh && ./build.sh && cd host && npm test`
Expected: Build succeeds and test passes

**Step 4: Commit**

```bash
git add build.sh host/test/
git commit -m "feat: add build script and integration test for kernel initialization"
```

---

## Future Tasks (Not in This Plan)

These are tracked in `docs/posix-status.md` and will be separate implementation plans:

1. **SharedArrayBuffer IPC** — Wire up the actual cross-worker communication
2. **Asyncify fallback path** — For environments without SharedArrayBuffer
3. **Process management** — fork, exec, waitpid, exit
4. **Signals** — kill, signal, sigaction
5. **Memory management** — mmap, munmap, brk
6. **fcntl locking** — F_GETLK, F_SETLK, F_SETLKW
7. **Directory operations** — opendir, readdir, closedir, mkdir, rmdir
8. **Socket operations** — socket, bind, listen, accept, connect, send, recv
9. **SEEK_END support** — requires host-side file size query in lseek
