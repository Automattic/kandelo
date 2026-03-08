# Phase 9: Polish & Gaps Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fill remaining tractable POSIX API gaps without requiring multi-worker or Asyncify infrastructure.

**Architecture:** All additions are kernel-internal state management or simple wrappers around existing infrastructure. No new host functions needed except for O_NOFOLLOW validation (uses existing host_lstat).

**Tech Stack:** Rust (no_std compatible), wasm32-unknown-unknown target

**Test command:** `cargo test --target $(rustc -vV | grep host | awk '{print $2}') -p wasm-posix-kernel`

**Build command:** `cargo build --target wasm32-unknown-unknown -Z build-std=core,alloc -Z build-std-features=panic_immediate_abort -p wasm-posix-kernel --release`

---

## Design Decisions

### DD1: Terminal state as kernel-internal simulation
The kernel tracks terminal attributes (c_iflag, c_oflag, c_cflag, c_lflag, c_cc) in a TerminalState struct attached to Process. These don't affect actual I/O behavior (host handles real terminal state), but provide correct POSIX semantics for programs that query/set terminal attributes. This mirrors how we handle uid/gid — simulated state that programs can read/write.

### DD2: F_GETOWN/F_SETOWN stores per-OFD owner
Store the async I/O owner PID in the OFD (open file description). F_GETOWN returns it, F_SETOWN sets it. Actual SIGIO delivery is deferred to signal delivery implementation, but storage is correct now.

### DD3: signal() returns old handler as u32
POSIX signal() returns the previous handler. We return SIG_DFL=0, SIG_IGN=1, or the function pointer index. This maps cleanly to our existing SignalHandler enum.

### DD4: MSG_PEEK via non-consuming pipe read
Add a `peek()` method to PipeBuffer that reads without advancing the head pointer. This is the simplest correct implementation.

### DD5: Non-blocking pipe reads return EAGAIN
When O_NONBLOCK is set on a pipe fd and no data is available, return EAGAIN instead of 0. This is the correct POSIX behavior. Write returns EAGAIN when buffer is full.

---

## Task 1: Add TerminalState struct and terminal constants

**Files:**
- Create: `crates/kernel/src/terminal.rs`
- Modify: `crates/kernel/src/lib.rs` — add `pub mod terminal;`
- Modify: `crates/kernel/src/process.rs` — add `pub terminal: TerminalState` to Process
- Modify: `crates/shared/src/lib.rs` — add terminal constants and syscall numbers

**Step 1: Write the failing test**

In `crates/kernel/src/terminal.rs`, add:

```rust
extern crate alloc;

/// Terminal attribute flags (c_lflag)
pub const ECHO: u32 = 0o0010;
pub const ECHOE: u32 = 0o0020;
pub const ECHOK: u32 = 0o0040;
pub const ECHONL: u32 = 0o0100;
pub const ICANON: u32 = 0o0002;
pub const ISIG: u32 = 0o0001;
pub const IEXTEN: u32 = 0o100000;
pub const TOSTOP: u32 = 0o0400;

/// Terminal attribute flags (c_iflag)
pub const ICRNL: u32 = 0o0400;
pub const INLCR: u32 = 0o0100;
pub const IGNCR: u32 = 0o0200;
pub const IXON: u32 = 0o2000;
pub const IXOFF: u32 = 0o10000;
pub const IXANY: u32 = 0o4000;
pub const IMAXBEL: u32 = 0o20000;

/// Terminal attribute flags (c_oflag)
pub const OPOST: u32 = 0o0001;
pub const ONLCR: u32 = 0o0004;

/// Terminal attribute flags (c_cflag)
pub const CS8: u32 = 0o0060;
pub const CREAD: u32 = 0o0200;
pub const HUPCL: u32 = 0o2000;

/// Control character indices
pub const VINTR: usize = 0;
pub const VQUIT: usize = 1;
pub const VERASE: usize = 2;
pub const VKILL: usize = 3;
pub const VEOF: usize = 4;
pub const VTIME: usize = 5;
pub const VMIN: usize = 6;
pub const VSTART: usize = 8;
pub const VSTOP: usize = 9;
pub const VSUSP: usize = 10;
pub const VEOL: usize = 11;
pub const NCCS: usize = 32;

/// tcsetattr action constants
pub const TCSANOW: u32 = 0;
pub const TCSADRAIN: u32 = 1;
pub const TCSAFLUSH: u32 = 2;

/// ioctl commands
pub const TIOCGWINSZ: u32 = 0x5413;
pub const TIOCSWINSZ: u32 = 0x5414;

/// Window size structure
#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct WinSize {
    pub ws_row: u16,
    pub ws_col: u16,
    pub ws_xpixel: u16,
    pub ws_ypixel: u16,
}

/// Kernel-internal terminal state (simulated, not affecting actual host I/O).
#[derive(Debug, Clone)]
pub struct TerminalState {
    pub c_iflag: u32,
    pub c_oflag: u32,
    pub c_cflag: u32,
    pub c_lflag: u32,
    pub c_cc: [u8; NCCS],
    pub winsize: WinSize,
}

impl TerminalState {
    /// Create default terminal state matching a typical Linux terminal.
    pub fn new() -> Self {
        let mut c_cc = [0u8; NCCS];
        c_cc[VINTR] = 0x03;   // Ctrl-C
        c_cc[VQUIT] = 0x1C;   // Ctrl-backslash
        c_cc[VERASE] = 0x7F;  // DEL
        c_cc[VKILL] = 0x15;   // Ctrl-U
        c_cc[VEOF] = 0x04;    // Ctrl-D
        c_cc[VSTART] = 0x11;  // Ctrl-Q
        c_cc[VSTOP] = 0x13;   // Ctrl-S
        c_cc[VSUSP] = 0x1A;   // Ctrl-Z
        c_cc[VMIN] = 1;
        c_cc[VTIME] = 0;

        TerminalState {
            c_iflag: ICRNL | IXON | IXANY | IMAXBEL,
            c_oflag: OPOST | ONLCR,
            c_cflag: CS8 | CREAD | HUPCL,
            c_lflag: ECHO | ECHOE | ECHOK | ICANON | ISIG | IEXTEN,
            c_cc,
            winsize: WinSize {
                ws_row: 24,
                ws_col: 80,
                ws_xpixel: 0,
                ws_ypixel: 0,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_terminal_state_defaults() {
        let ts = TerminalState::new();
        assert!(ts.c_lflag & ECHO != 0);
        assert!(ts.c_lflag & ICANON != 0);
        assert!(ts.c_lflag & ISIG != 0);
        assert!(ts.c_iflag & ICRNL != 0);
        assert!(ts.c_oflag & OPOST != 0);
        assert_eq!(ts.c_cc[VINTR], 0x03);
        assert_eq!(ts.c_cc[VEOF], 0x04);
        assert_eq!(ts.winsize.ws_row, 24);
        assert_eq!(ts.winsize.ws_col, 80);
    }
}
```

**Step 2: Add mod terminal to lib.rs**

Add `pub mod terminal;` to `crates/kernel/src/lib.rs`.

**Step 3: Add terminal field to Process**

In `crates/kernel/src/process.rs`:
- Add `use crate::terminal::TerminalState;`
- Add `pub terminal: TerminalState` field to Process struct
- Initialize `terminal: TerminalState::new()` in Process::new()

**Step 4: Add syscall numbers to shared crate**

In `crates/shared/src/lib.rs`, add to the Syscall enum:
```
Tcgetattr = 70,
Tcsetattr = 71,
Ioctl = 72,
Signal = 73,
```

And add the from_u32 match arms.

**Step 5: Run tests, verify pass**

Run: `cargo test --target $(rustc -vV | grep host | awk '{print $2}') -p wasm-posix-kernel`
Expected: All existing tests + new terminal test pass.

**Step 6: Commit**

```bash
git add -A && git commit -m "feat: add TerminalState struct with default terminal attributes"
```

---

## Task 2: Implement sys_tcgetattr, sys_tcsetattr, sys_ioctl

**Files:**
- Modify: `crates/kernel/src/syscalls.rs` — add sys_tcgetattr, sys_tcsetattr, sys_ioctl

**Step 1: Write the failing tests**

Add tests to `crates/kernel/src/syscalls.rs` in the tests module:

```rust
#[test]
fn test_tcgetattr_returns_terminal_state() {
    let mut proc = Process::new(1);
    // fd 0 (stdin) is CharDevice, should work
    let mut buf = [0u8; 60]; // 4 u32s (16 bytes) + 32 c_cc + padding = at least 48
    let result = sys_tcgetattr(&mut proc, 0, &mut buf);
    assert!(result.is_ok());
    // Verify c_lflag has ECHO set (in the 4th u32)
    let c_lflag = u32::from_le_bytes([buf[12], buf[13], buf[14], buf[15]]);
    assert!(c_lflag & 0o0010 != 0); // ECHO
}

#[test]
fn test_tcgetattr_enotty_for_regular_file() {
    let mut proc = Process::new(1);
    let mut host = MockHostIO::new();
    // Open a regular file
    let fd = sys_open(&mut proc, &mut host, b"/tmp/test", O_RDONLY, 0).unwrap();
    let mut buf = [0u8; 60];
    let result = sys_tcgetattr(&mut proc, fd, &mut buf);
    assert_eq!(result, Err(Errno::ENOTTY));
}

#[test]
fn test_tcsetattr_modifies_terminal_state() {
    let mut proc = Process::new(1);
    // Get current attrs
    let mut buf = [0u8; 60];
    sys_tcgetattr(&mut proc, 0, &mut buf).unwrap();
    // Clear ECHO in c_lflag (4th u32)
    let c_lflag = u32::from_le_bytes([buf[12], buf[13], buf[14], buf[15]]);
    let new_lflag = c_lflag & !0o0010; // Clear ECHO
    buf[12..16].copy_from_slice(&new_lflag.to_le_bytes());
    // Set attrs
    let result = sys_tcsetattr(&mut proc, 0, 0, &buf); // TCSANOW=0
    assert!(result.is_ok());
    // Read back
    let mut buf2 = [0u8; 60];
    sys_tcgetattr(&mut proc, 0, &mut buf2).unwrap();
    let c_lflag2 = u32::from_le_bytes([buf2[12], buf2[13], buf2[14], buf2[15]]);
    assert_eq!(c_lflag2 & 0o0010, 0); // ECHO cleared
}

#[test]
fn test_ioctl_tiocgwinsz() {
    let mut proc = Process::new(1);
    let mut buf = [0u8; 8]; // WinSize is 4 u16s = 8 bytes
    let result = sys_ioctl(&mut proc, 0, 0x5413, &mut buf); // TIOCGWINSZ
    assert!(result.is_ok());
    let ws_row = u16::from_le_bytes([buf[0], buf[1]]);
    let ws_col = u16::from_le_bytes([buf[2], buf[3]]);
    assert_eq!(ws_row, 24);
    assert_eq!(ws_col, 80);
}

#[test]
fn test_ioctl_tiocswinsz() {
    let mut proc = Process::new(1);
    // Set new window size
    let mut buf = [0u8; 8];
    buf[0..2].copy_from_slice(&120u16.to_le_bytes()); // rows
    buf[2..4].copy_from_slice(&200u16.to_le_bytes()); // cols
    let result = sys_ioctl(&mut proc, 0, 0x5414, &mut buf); // TIOCSWINSZ
    assert!(result.is_ok());
    // Read back
    let mut buf2 = [0u8; 8];
    sys_ioctl(&mut proc, 0, 0x5413, &mut buf2).unwrap(); // TIOCGWINSZ
    let ws_row = u16::from_le_bytes([buf2[0], buf2[1]]);
    let ws_col = u16::from_le_bytes([buf2[2], buf2[3]]);
    assert_eq!(ws_row, 120);
    assert_eq!(ws_col, 200);
}
```

**Step 2: Implement the syscalls**

```rust
/// tcgetattr — get terminal attributes
/// Writes c_iflag, c_oflag, c_cflag, c_lflag (4 x u32 = 16 bytes) then c_cc (32 bytes) = 48 bytes
pub fn sys_tcgetattr(proc: &mut Process, fd: i32, buf: &mut [u8]) -> Result<(), Errno> {
    let entry = proc.fd_table.get(fd).ok_or(Errno::EBADF)?;
    let ofd = proc.ofd_table.get(entry.ofd_index).ok_or(Errno::EBADF)?;
    if ofd.file_type != FileType::CharDevice {
        return Err(Errno::ENOTTY);
    }
    if buf.len() < 48 {
        return Err(Errno::EINVAL);
    }
    let ts = &proc.terminal;
    buf[0..4].copy_from_slice(&ts.c_iflag.to_le_bytes());
    buf[4..8].copy_from_slice(&ts.c_oflag.to_le_bytes());
    buf[8..12].copy_from_slice(&ts.c_cflag.to_le_bytes());
    buf[12..16].copy_from_slice(&ts.c_lflag.to_le_bytes());
    buf[16..48].copy_from_slice(&ts.c_cc);
    Ok(())
}

/// tcsetattr — set terminal attributes
/// Reads c_iflag, c_oflag, c_cflag, c_lflag (4 x u32 = 16 bytes) then c_cc (32 bytes) = 48 bytes
/// action: 0=TCSANOW, 1=TCSADRAIN, 2=TCSAFLUSH (all treated same in single-process)
pub fn sys_tcsetattr(proc: &mut Process, fd: i32, _action: u32, buf: &[u8]) -> Result<(), Errno> {
    let entry = proc.fd_table.get(fd).ok_or(Errno::EBADF)?;
    let ofd = proc.ofd_table.get(entry.ofd_index).ok_or(Errno::EBADF)?;
    if ofd.file_type != FileType::CharDevice {
        return Err(Errno::ENOTTY);
    }
    if buf.len() < 48 {
        return Err(Errno::EINVAL);
    }
    let ts = &mut proc.terminal;
    ts.c_iflag = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]);
    ts.c_oflag = u32::from_le_bytes([buf[4], buf[5], buf[6], buf[7]]);
    ts.c_cflag = u32::from_le_bytes([buf[8], buf[9], buf[10], buf[11]]);
    ts.c_lflag = u32::from_le_bytes([buf[12], buf[13], buf[14], buf[15]]);
    ts.c_cc.copy_from_slice(&buf[16..48]);
    Ok(())
}

/// ioctl — device control
/// Only terminal ioctls supported: TIOCGWINSZ (0x5413), TIOCSWINSZ (0x5414)
pub fn sys_ioctl(proc: &mut Process, fd: i32, request: u32, buf: &mut [u8]) -> Result<(), Errno> {
    let entry = proc.fd_table.get(fd).ok_or(Errno::EBADF)?;
    let ofd = proc.ofd_table.get(entry.ofd_index).ok_or(Errno::EBADF)?;
    if ofd.file_type != FileType::CharDevice {
        return Err(Errno::ENOTTY);
    }
    match request {
        0x5413 => { // TIOCGWINSZ
            if buf.len() < 8 {
                return Err(Errno::EINVAL);
            }
            let ws = &proc.terminal.winsize;
            buf[0..2].copy_from_slice(&ws.ws_row.to_le_bytes());
            buf[2..4].copy_from_slice(&ws.ws_col.to_le_bytes());
            buf[4..6].copy_from_slice(&ws.ws_xpixel.to_le_bytes());
            buf[6..8].copy_from_slice(&ws.ws_ypixel.to_le_bytes());
            Ok(())
        }
        0x5414 => { // TIOCSWINSZ
            if buf.len() < 8 {
                return Err(Errno::EINVAL);
            }
            let ws = &mut proc.terminal.winsize;
            ws.ws_row = u16::from_le_bytes([buf[0], buf[1]]);
            ws.ws_col = u16::from_le_bytes([buf[2], buf[3]]);
            ws.ws_xpixel = u16::from_le_bytes([buf[4], buf[5]]);
            ws.ws_ypixel = u16::from_le_bytes([buf[6], buf[7]]);
            Ok(())
        }
        _ => Err(Errno::ENOTTY),
    }
}
```

**Step 3: Run tests, verify pass**

Run: `cargo test --target $(rustc -vV | grep host | awk '{print $2}') -p wasm-posix-kernel`

**Step 4: Commit**

```bash
git add -A && git commit -m "feat: implement tcgetattr, tcsetattr, and ioctl (TIOCGWINSZ/TIOCSWINSZ)"
```

---

## Task 3: Add Wasm exports for terminal syscalls

**Files:**
- Modify: `crates/kernel/src/wasm_api.rs` — add kernel_tcgetattr, kernel_tcsetattr, kernel_ioctl

**Step 1: Add exports**

```rust
#[unsafe(no_mangle)]
pub extern "C" fn kernel_tcgetattr(fd: i32, buf_ptr: *mut u8, buf_len: u32) -> i32 {
    let proc = unsafe { get_process() };
    let buf = unsafe { core::slice::from_raw_parts_mut(buf_ptr, buf_len as usize) };
    match syscalls::sys_tcgetattr(proc, fd, buf) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn kernel_tcsetattr(fd: i32, action: u32, buf_ptr: *const u8, buf_len: u32) -> i32 {
    let proc = unsafe { get_process() };
    let buf = unsafe { core::slice::from_raw_parts(buf_ptr, buf_len as usize) };
    match syscalls::sys_tcsetattr(proc, fd, action, buf) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn kernel_ioctl(fd: i32, request: u32, buf_ptr: *mut u8, buf_len: u32) -> i32 {
    let proc = unsafe { get_process() };
    let buf = unsafe { core::slice::from_raw_parts_mut(buf_ptr, buf_len as usize) };
    match syscalls::sys_ioctl(proc, fd, request, buf) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    }
}
```

**Step 2: Verify Wasm build**

Run: `cargo build --target wasm32-unknown-unknown -Z build-std=core,alloc -Z build-std-features=panic_immediate_abort -p wasm-posix-kernel --release`

**Step 3: Commit**

```bash
git add -A && git commit -m "feat: add Wasm exports for tcgetattr, tcsetattr, and ioctl"
```

---

## Task 4: Implement fcntl F_GETOWN/F_SETOWN

**Files:**
- Modify: `crates/kernel/src/ofd.rs` — add `owner_pid: u32` field to Ofd
- Modify: `crates/kernel/src/syscalls.rs` — add F_GETOWN/F_SETOWN to sys_fcntl
- Modify: `crates/shared/src/lib.rs` — add F_GETOWN=9, F_SETOWN=8 constants

**Step 1: Add constants**

In `crates/shared/src/lib.rs` fcntl_cmd module, add:
```rust
pub const F_GETOWN: u32 = 9;
pub const F_SETOWN: u32 = 8;
```

**Step 2: Add owner_pid to Ofd**

In `crates/kernel/src/ofd.rs`, add `pub owner_pid: u32` field to the Ofd struct, initialized to 0.

**Step 3: Write failing tests**

```rust
#[test]
fn test_fcntl_f_getown_default_zero() {
    let mut proc = Process::new(1);
    let result = sys_fcntl(&mut proc, 0, 9, 0); // F_GETOWN
    assert_eq!(result, Ok(0));
}

#[test]
fn test_fcntl_f_setown_and_getown() {
    let mut proc = Process::new(1);
    // Set owner to pid 42
    let result = sys_fcntl(&mut proc, 0, 8, 42); // F_SETOWN
    assert_eq!(result, Ok(0));
    // Get owner
    let result = sys_fcntl(&mut proc, 0, 9, 0); // F_GETOWN
    assert_eq!(result, Ok(42));
}
```

**Step 4: Implement in sys_fcntl**

Add match arms in the sys_fcntl function:
```rust
8 => { // F_SETOWN
    let ofd = proc.ofd_table.get_mut(entry.ofd_index).ok_or(Errno::EBADF)?;
    ofd.owner_pid = arg;
    Ok(0)
}
9 => { // F_GETOWN
    let ofd = proc.ofd_table.get(entry.ofd_index).ok_or(Errno::EBADF)?;
    Ok(ofd.owner_pid as i32)
}
```

**Step 5: Run tests, verify pass**

**Step 6: Commit**

```bash
git add -A && git commit -m "feat: implement fcntl F_GETOWN and F_SETOWN"
```

---

## Task 5: Implement signal() wrapper

**Files:**
- Modify: `crates/kernel/src/syscalls.rs` — add sys_signal
- Modify: `crates/kernel/src/wasm_api.rs` — add kernel_signal export

**Step 1: Write failing tests**

```rust
#[test]
fn test_signal_set_ignore() {
    let mut proc = Process::new(1);
    // signal(SIGUSR1, SIG_IGN) — returns old handler (SIG_DFL=0)
    let result = sys_signal(&mut proc, 10, 1); // SIGUSR1=10, SIG_IGN=1
    assert_eq!(result, Ok(0)); // Was SIG_DFL
}

#[test]
fn test_signal_set_handler() {
    let mut proc = Process::new(1);
    // Set handler to function pointer 42
    let result = sys_signal(&mut proc, 10, 42); // SIGUSR1=10
    assert_eq!(result, Ok(0)); // Was SIG_DFL
    // Set back to default, should return 42
    let result = sys_signal(&mut proc, 10, 0); // SIG_DFL
    assert_eq!(result, Ok(42));
}

#[test]
fn test_signal_sigkill_immutable() {
    let mut proc = Process::new(1);
    let result = sys_signal(&mut proc, 9, 1); // SIGKILL, SIG_IGN
    assert_eq!(result, Err(Errno::EINVAL));
}
```

**Step 2: Implement sys_signal**

```rust
/// signal() — set signal handler (legacy API, wraps sigaction semantics)
/// Returns previous handler value: SIG_DFL=0, SIG_IGN=1, or function pointer
pub fn sys_signal(proc: &mut Process, signum: u32, handler_val: u32) -> Result<i32, Errno> {
    use crate::signal::SignalHandler;

    let new_handler = match handler_val {
        0 => SignalHandler::Default,      // SIG_DFL
        1 => SignalHandler::Ignore,       // SIG_IGN
        ptr => SignalHandler::Handler(ptr),
    };

    let old = proc.signals.set_handler(signum, new_handler)
        .map_err(|_| Errno::EINVAL)?;

    let old_val = match old {
        SignalHandler::Default => 0,
        SignalHandler::Ignore => 1,
        SignalHandler::Handler(ptr) => ptr as i32,
    };

    Ok(old_val)
}
```

**Step 3: Add Wasm export**

```rust
#[unsafe(no_mangle)]
pub extern "C" fn kernel_signal(signum: u32, handler: u32) -> i32 {
    let proc = unsafe { get_process() };
    match syscalls::sys_signal(proc, signum, handler) {
        Ok(old) => old,
        Err(e) => -(e as i32),
    }
}
```

**Step 4: Run tests, verify pass**

**Step 5: Commit**

```bash
git add -A && git commit -m "feat: implement signal() as wrapper around sigaction semantics"
```

---

## Task 6: Add MSG_PEEK support to PipeBuffer and sys_recv

**Files:**
- Modify: `crates/kernel/src/pipe.rs` — add `peek()` method
- Modify: `crates/kernel/src/syscalls.rs` — check MSG_PEEK in sys_recv and sys_read for sockets

**Step 1: Write failing tests**

In pipe.rs tests:
```rust
#[test]
fn test_pipe_peek() {
    let mut pipe = PipeBuffer::new();
    pipe.write(b"hello");
    let mut buf = [0u8; 5];
    // Peek should read without consuming
    let n = pipe.peek(&mut buf);
    assert_eq!(n, 5);
    assert_eq!(&buf[..5], b"hello");
    // Data should still be available
    let n2 = pipe.read(&mut buf);
    assert_eq!(n2, 5);
    assert_eq!(&buf[..5], b"hello");
}
```

In syscalls.rs tests:
```rust
#[test]
fn test_recv_msg_peek() {
    let mut proc = Process::new(1);
    let mut host = MockHostIO::new();
    let (fd1, fd2) = {
        let result = sys_socketpair(&mut proc, 1, 1, 0); // AF_UNIX, SOCK_STREAM
        result.unwrap()
    };
    // Write data via fd1
    let data = b"peek test";
    sys_send(&mut proc, &mut host, fd1, data, 0).unwrap();
    // Peek via fd2
    let mut buf = [0u8; 32];
    let n = sys_recv(&mut proc, &mut host, fd2, &mut buf, 2).unwrap(); // MSG_PEEK=2
    assert_eq!(n, 9);
    assert_eq!(&buf[..9], b"peek test");
    // Data should still be there
    let n2 = sys_recv(&mut proc, &mut host, fd2, &mut buf, 0).unwrap();
    assert_eq!(n2, 9);
    assert_eq!(&buf[..9], b"peek test");
}
```

**Step 2: Add peek() to PipeBuffer**

```rust
/// Read data without consuming it from the buffer.
pub fn peek(&self, buf: &mut [u8]) -> usize {
    let to_read = core::cmp::min(buf.len(), self.len);
    let mut src = self.head;
    for i in 0..to_read {
        buf[i] = self.buf[src];
        src = (src + 1) % self.buf.len();
    }
    to_read
}
```

**Step 3: Update sys_recv to check MSG_PEEK**

In sys_recv, change `_flags` to `flags` and add:
```rust
let msg_peek = flags & 2 != 0; // MSG_PEEK = 2
// When reading from socket buffer, use peek() if MSG_PEEK set
```

Also update the socket read path in sys_read to support peek when called from sys_recv.

**Step 4: Run tests, verify pass**

**Step 5: Commit**

```bash
git add -A && git commit -m "feat: implement MSG_PEEK for recv() and pipe peek"
```

---

## Task 7: Enforce O_NONBLOCK for pipes

**Files:**
- Modify: `crates/kernel/src/syscalls.rs` — check O_NONBLOCK in pipe read/write paths

**Step 1: Write failing tests**

```rust
#[test]
fn test_pipe_read_nonblock_eagain() {
    let mut proc = Process::new(1);
    let mut host = MockHostIO::new();
    let (read_fd, write_fd) = sys_pipe(&mut proc).unwrap();
    // Set read end to non-blocking
    sys_fcntl(&mut proc, read_fd, 4, O_NONBLOCK).unwrap(); // F_SETFL
    // Read with nothing in pipe — should get EAGAIN
    let mut buf = [0u8; 16];
    let result = sys_read(&mut proc, &mut host, read_fd, &mut buf);
    assert_eq!(result, Err(Errno::EAGAIN));
}

#[test]
fn test_pipe_read_nonblock_with_data() {
    let mut proc = Process::new(1);
    let mut host = MockHostIO::new();
    let (read_fd, write_fd) = sys_pipe(&mut proc).unwrap();
    sys_fcntl(&mut proc, read_fd, 4, O_NONBLOCK).unwrap(); // F_SETFL
    // Write some data
    sys_write(&mut proc, &mut host, write_fd, b"hello").unwrap();
    // Read — should succeed
    let mut buf = [0u8; 16];
    let n = sys_read(&mut proc, &mut host, read_fd, &mut buf).unwrap();
    assert_eq!(n, 5);
    assert_eq!(&buf[..5], b"hello");
}

#[test]
fn test_pipe_write_nonblock_eagain_when_full() {
    let mut proc = Process::new(1);
    let mut host = MockHostIO::new();
    let (read_fd, write_fd) = sys_pipe(&mut proc).unwrap();
    sys_fcntl(&mut proc, write_fd, 4, O_NONBLOCK).unwrap(); // F_SETFL
    // Fill pipe buffer (64KB)
    let big = [0u8; 65536];
    sys_write(&mut proc, &mut host, write_fd, &big).unwrap();
    // Next write should get EAGAIN
    let result = sys_write(&mut proc, &mut host, write_fd, b"x");
    assert_eq!(result, Err(Errno::EAGAIN));
}
```

**Step 2: Implement O_NONBLOCK enforcement**

In the pipe read path of sys_read (around line 134-141), add:
```rust
FileType::Pipe => {
    let pipe_idx = (-(ofd.host_handle as i64) - 1) as usize;
    let pipe = proc.pipes[pipe_idx].as_mut().ok_or(Errno::EBADF)?;
    let n = pipe.read(buf);
    if n == 0 && pipe.write_open() {
        // Write end open but no data
        if ofd.status_flags & O_NONBLOCK != 0 {
            return Err(Errno::EAGAIN);
        }
        // Without O_NONBLOCK, return 0 (would block in real implementation)
    }
    Ok(n)
}
```

Similarly for the pipe write path, when buffer is full and O_NONBLOCK set, return EAGAIN.

**Step 3: Run tests, verify pass**

**Step 4: Commit**

```bash
git add -A && git commit -m "feat: enforce O_NONBLOCK for pipe reads and writes"
```

---

## Task 8: Implement O_NOFOLLOW validation in sys_open

**Files:**
- Modify: `crates/shared/src/lib.rs` — add O_NOFOLLOW constant
- Modify: `crates/kernel/src/syscalls.rs` — validate O_NOFOLLOW after open

**Step 1: Add O_NOFOLLOW constant**

In shared flags module:
```rust
pub const O_NOFOLLOW: u32 = 0o400000;
```

**Step 2: Write failing tests**

```rust
#[test]
fn test_open_nofollow_regular_file_ok() {
    let mut proc = Process::new(1);
    let mut host = MockHostIO::new();
    // Regular file with O_NOFOLLOW should succeed
    let result = sys_open(&mut proc, &mut host, b"/tmp/test", O_RDONLY | 0o400000, 0);
    // MockHostIO returns regular file, so this should be OK
    assert!(result.is_ok());
}

#[test]
fn test_open_nofollow_symlink_eloop() {
    let mut proc = Process::new(1);
    let mut host = MockHostIO::new();
    host.set_is_symlink(b"/tmp/link", true);
    // Open symlink with O_NOFOLLOW should fail with ELOOP
    let result = sys_open(&mut proc, &mut host, b"/tmp/link", O_RDONLY | 0o400000, 0);
    assert_eq!(result, Err(Errno::ELOOP));
}
```

Note: The test for ELOOP requires MockHostIO to support lstat detection. If MockHostIO doesn't support this, implement a simpler approach: pass O_NOFOLLOW to host_open and let the host handle it. This is actually more correct since the host filesystem knows about symlinks.

**Alternative implementation:** Pass O_NOFOLLOW flag through to host_open. The host (Node.js) will use `O_NOFOLLOW` in its `fs.openSync` call, and the kernel doesn't need to check. Update CREATION_FLAGS to include O_NOFOLLOW.

```rust
// In sys_open, add O_NOFOLLOW to CREATION_FLAGS so it's passed through to host
const CREATION_FLAGS: u32 = O_CREAT | O_EXCL | O_TRUNC | O_CLOEXEC | O_DIRECTORY | O_NOFOLLOW;
```

Wait — that removes it from status_flags. Actually O_NOFOLLOW should be passed to host_open and NOT stored as a status flag. So add it to the flag stripping:

```rust
// Pass oflags including O_NOFOLLOW to host_open, but don't store it in status_flags
let host_flags = oflags; // Already includes O_NOFOLLOW
let status_flags = oflags & !(O_CREAT | O_EXCL | O_TRUNC | O_CLOEXEC | O_DIRECTORY | O_NOFOLLOW);
```

**Step 3: Run tests, verify pass**

**Step 4: Commit**

```bash
git add -A && git commit -m "feat: add O_NOFOLLOW support in open(), passed through to host"
```

---

## Task 9: Update POSIX status docs and add TypeScript wrappers

**Files:**
- Modify: `docs/posix-status.md` — update statuses for all new implementations
- Modify: `host/src/kernel.ts` — add TypeScript methods for new syscalls

**Step 1: Update posix-status.md**

Update these entries:
- `tcgetattr()` / `tcsetattr()`: Planned → Partial ("Kernel-simulated terminal state. Does not affect actual host I/O behavior. TCSANOW/TCSADRAIN/TCSAFLUSH all treated the same.")
- `ioctl()` (TIOC*): Planned → Partial ("TIOCGWINSZ and TIOCSWINSZ supported. Default 24x80. Other ioctls return ENOTTY.")
- `signal()`: Planned → Full ("Legacy API. Returns previous handler. Wraps sigaction() semantics.")
- `F_GETOWN`: Planned → Full ("Returns async I/O owner PID from OFD. Default 0.")
- `F_SETOWN`: Planned → Full ("Sets async I/O owner PID on OFD. SIGIO delivery deferred to signal delivery phase.")
- Update `recv()` notes to mention MSG_PEEK support
- Update `pipe()` notes to mention O_NONBLOCK enforcement
- Update `open()` notes to mention O_NOFOLLOW support

**Step 2: Add TypeScript methods**

```typescript
tcgetattr(fd: number): Buffer | number { ... }
tcsetattr(fd: number, action: number, attrs: Buffer): number { ... }
ioctl(fd: number, request: number, buf: Buffer): number { ... }
signal(signum: number, handler: number): number { ... }
```

**Step 3: Commit**

```bash
git add -A && git commit -m "docs: update POSIX status and add TypeScript wrappers for Phase 9"
```

---

## Summary

This plan adds 7 new capabilities:
1. Terminal attributes (tcgetattr/tcsetattr) — simulated state
2. Terminal ioctls (TIOCGWINSZ/TIOCSWINSZ) — window size
3. fcntl F_GETOWN/F_SETOWN — async I/O ownership
4. signal() — legacy signal API
5. MSG_PEEK for recv() — non-consuming read
6. O_NONBLOCK enforcement for pipes — EAGAIN semantics
7. O_NOFOLLOW validation — symlink protection

Total: ~25 new tests, 9 tasks, no new host functions needed.
