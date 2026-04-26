# Framebuffer + fbDOOM Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement Linux `fbdev` (`/dev/fb0`) in the kernel — open, ioctls (`FBIOGET_VSCREENINFO`, `FBIOGET_FSCREENINFO`, `FBIOPAN_DISPLAY`), `mmap` of the pixel buffer — plus host-side canvas rendering, plus an unmodified fbDOOM build running in the browser as `examples/browser/pages/doom/` with keyboard input and session-persistent saves.

**Architecture:** Pixel buffer lives inside the process's wasm `Memory` SAB. On `mmap` of `/dev/fb0`, the kernel allocates a region in process memory (existing `mmap_anonymous`) and calls a new `HostIO::bind_framebuffer(pid, addr, len, w, h, fmt)` callback. Host caches the process Memory SAB, builds an `ImageData` view over `[addr, addr+len)`, and `putImageData`s every `requestAnimationFrame` tick. No new SABs, no per-frame syscalls. Companion design doc: `docs/plans/2026-04-26-framebuffer-fbdoom-design.md`.

**Tech Stack:** Rust kernel (wasm64), TypeScript host (browser + Node), C user programs cross-compiled with `wasm32posix-cc`, fbDOOM (https://github.com/maximevince/fbDOOM), shareware `doom1.wad`.

**Three PRs, single coordinated merge.** Each task is committed as a single commit. Three PR boundaries are marked. **None merge** until Phase C's manual browser verification passes and the user explicitly confirms — see `framebuffer-fbdoom-initiative.md` in memory.

**Verification gauntlet** (CLAUDE.md): all of the below must pass with zero regressions before any PR is opened, and re-run before the final merge:

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib
(cd host && npx vitest run)
scripts/run-libc-tests.sh
scripts/run-posix-tests.sh
scripts/run-sortix-tests.sh --all
bash scripts/check-abi-version.sh
```

`XFAIL` / `TIME` are acceptable; `FAIL` that isn't pre-existing is a regression.

---

## Phase A — Kernel fbdev surface (PR #1)

### Task A1: Shared ABI constants & structs

**Files:**
- Modify: `crates/shared/src/lib.rs` — add fbdev module near other ABI types.

**Step 1: Add the constants and structs**

Append to `crates/shared/src/lib.rs` (or place inline with the other `pub mod` blocks; mirror the structure used by `mqueue`/`socket` in the same file):

```rust
/// Linux fbdev ABI constants and marshalled structs.
///
/// These are part of the kernel↔user-space ABI: any change requires bumping
/// `ABI_VERSION` (see crate root) and updating `abi/snapshot.json`.
pub mod fbdev {
    /// `FBIOGET_VSCREENINFO` — read variable screen info.
    pub const FBIOGET_VSCREENINFO: u32 = 0x4600;
    /// `FBIOPUT_VSCREENINFO` — write variable screen info (mode set).
    pub const FBIOPUT_VSCREENINFO: u32 = 0x4601;
    /// `FBIOGET_FSCREENINFO` — read fixed screen info.
    pub const FBIOGET_FSCREENINFO: u32 = 0x4602;
    /// `FBIOPAN_DISPLAY` — pan / present.
    pub const FBIOPAN_DISPLAY: u32 = 0x4606;

    /// `FB_TYPE_PACKED_PIXELS`.
    pub const FB_TYPE_PACKED_PIXELS: u32 = 0;
    /// `FB_VISUAL_TRUECOLOR`.
    pub const FB_VISUAL_TRUECOLOR: u32 = 2;

    /// Linux `struct fb_bitfield` — one channel of pixel layout.
    /// Total: 12 bytes. No padding.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct FbBitfield {
        pub offset: u32,
        pub length: u32,
        pub msb_right: u32,
    }

    /// Linux `struct fb_var_screeninfo` — variable screen info (160 bytes).
    /// Field order and offsets must match the Linux ABI exactly.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct FbVarScreenInfo {
        pub xres: u32,                // 0
        pub yres: u32,                // 4
        pub xres_virtual: u32,        // 8
        pub yres_virtual: u32,        // 12
        pub xoffset: u32,             // 16
        pub yoffset: u32,             // 20
        pub bits_per_pixel: u32,      // 24
        pub grayscale: u32,           // 28
        pub red: FbBitfield,          // 32 (12)
        pub green: FbBitfield,        // 44 (12)
        pub blue: FbBitfield,         // 56 (12)
        pub transp: FbBitfield,       // 68 (12)
        pub nonstd: u32,              // 80
        pub activate: u32,            // 84
        pub height: u32,              // 88
        pub width: u32,               // 92
        pub accel_flags: u32,         // 96
        pub pixclock: u32,            // 100
        pub left_margin: u32,         // 104
        pub right_margin: u32,        // 108
        pub upper_margin: u32,        // 112
        pub lower_margin: u32,        // 116
        pub hsync_len: u32,           // 120
        pub vsync_len: u32,           // 124
        pub sync: u32,                // 128
        pub vmode: u32,               // 132
        pub rotate: u32,              // 136
        pub colorspace: u32,          // 140
        pub reserved: [u32; 4],       // 144 (16)
                                      // total: 160
    }

    /// Linux `struct fb_fix_screeninfo` — fixed screen info (80 bytes on the
    /// 32-bit user-space ABI we expose).
    ///
    /// On real Linux this struct uses native pointer width for `smem_start`
    /// and `mmio_start`. fbDOOM only reads `id`, `smem_len`, `line_length`,
    /// `type`, and `visual` — we report 0 for the address-shaped fields,
    /// keeping the struct 32-bit-flavoured to match what musl's
    /// `<linux/fb.h>` exposes to user-space programs built with `wasm32posix-cc`.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct FbFixScreenInfo {
        pub id: [u8; 16],             // 0
        pub smem_start: u32,          // 16  (always 0 in our model)
        pub smem_len: u32,            // 20
        pub fb_type: u32,             // 24  (FB_TYPE_PACKED_PIXELS)
        pub type_aux: u32,            // 28
        pub visual: u32,              // 32  (FB_VISUAL_TRUECOLOR)
        pub xpanstep: u16,            // 36
        pub ypanstep: u16,            // 38
        pub ywrapstep: u16,           // 40
        pub _pad: u16,                // 42
        pub line_length: u32,         // 44
        pub mmio_start: u32,          // 48  (always 0)
        pub mmio_len: u32,            // 52
        pub accel: u32,               // 56
        pub capabilities: u16,        // 60
        pub reserved: [u16; 3],       // 62 (6)
                                      // total: 68... but Linux pads to 80 to
                                      // align with the 64-bit smem_start variant.
        pub _pad_to_80: [u8; 12],     // 68 (12) → 80
    }
}
```

**Step 2: Add a static-assert test**

Append to `crates/shared/src/lib.rs` test module (or create one if absent):

```rust
#[cfg(test)]
mod fbdev_tests {
    use super::fbdev::*;
    use core::mem::size_of;

    #[test]
    fn struct_sizes_match_linux_abi() {
        assert_eq!(size_of::<FbBitfield>(), 12);
        assert_eq!(size_of::<FbVarScreenInfo>(), 160);
        assert_eq!(size_of::<FbFixScreenInfo>(), 80);
    }
}
```

**Step 3: Run the test and verify it passes**

```bash
cargo test -p wasm-posix-shared --target aarch64-apple-darwin --lib fbdev_tests
```

Expected: 1 test passes. If sizes don't match, fix the field layout (struct attributes, padding) before moving on. Layout bugs surface here cheaply; they're invisible later.

**Step 4: Commit**

```bash
git add crates/shared/src/lib.rs
git commit -m "kernel(fbdev): add fb_var_screeninfo / fb_fix_screeninfo ABI types"
```

---

### Task A2: `VirtualDevice::Fb0` variant + path matching

**Files:**
- Modify: `crates/kernel/src/syscalls.rs` (the `VirtualDevice` enum and `match_virtual_device` near line 48–94)

**Step 1: Write a failing test**

Append to `syscalls.rs` test module:

```rust
#[test]
fn match_virtual_device_recognizes_fb0() {
    assert_eq!(match_virtual_device(b"/dev/fb0"), Some(VirtualDevice::Fb0));
    assert_eq!(match_virtual_device(b"/dev/fb1"), None);  // single-fb only
}

#[test]
fn fb0_has_unique_host_handle_sentinel() {
    let h = VirtualDevice::Fb0.to_host_handle();
    // Distinct from Null/Zero/Urandom/Full
    assert_eq!(VirtualDevice::from_host_handle(h), Some(VirtualDevice::Fb0));
    assert_ne!(h, VirtualDevice::Null.to_host_handle());
    assert_ne!(h, VirtualDevice::Zero.to_host_handle());
    assert_ne!(h, VirtualDevice::Urandom.to_host_handle());
    assert_ne!(h, VirtualDevice::Full.to_host_handle());
}
```

**Step 2: Run the test, observe failure**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib match_virtual_device_recognizes_fb0
```

Expected: compile error, `Fb0` variant unknown.

**Step 3: Implement**

In `crates/kernel/src/syscalls.rs`, extend `enum VirtualDevice` with `Fb0`. Update:

- `to_host_handle`: add `VirtualDevice::Fb0 => -5,`
- `from_host_handle`: add `-5 => Some(VirtualDevice::Fb0),`
- `to_minor`: add `VirtualDevice::Fb0 => 5,` (or whatever non-colliding minor — grep first)
- `match_virtual_device`: add `b"/dev/fb0" => Some(VirtualDevice::Fb0),`

Also extend `virtual_device_stat` to return `S_IFCHR` with major 29, minor 0 (Linux fbdev convention) for `Fb0`. Look at how the function handles `Null` / `Zero` and follow the same shape.

**Step 4: Run the tests**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib match_virtual_device_recognizes_fb0 fb0_has_unique_host_handle_sentinel
```

Expected: both pass.

**Step 5: Commit**

```bash
git add crates/kernel/src/syscalls.rs
git commit -m "kernel(fbdev): add VirtualDevice::Fb0 + /dev/fb0 path match"
```

---

### Task A3: devfs entry for `/dev/fb0`

**Files:**
- Modify: `crates/kernel/src/devfs.rs`

**Step 1: Failing test**

Append to `devfs.rs` test module:

```rust
#[test]
fn fb0_is_listed_in_dev_dir() {
    let entries = devfs_dir_entries(b"/dev").unwrap();
    let names: Vec<&[u8]> = entries.iter().map(|(n, _, _)| n.as_slice()).collect();
    assert!(names.iter().any(|n| *n == b"fb0"));
}

#[test]
fn fb0_stat_is_chr() {
    let st = match_devfs_stat(b"/dev/fb0", 0, 0).unwrap();
    assert_eq!(st.st_mode & wasm_posix_shared::S_IFMT, wasm_posix_shared::S_IFCHR);
}
```

(Adjust signatures to match this codebase's `match_devfs_stat` arity — grep first.)

**Step 2: Run, observe failure**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib fb0_is_listed_in_dev_dir fb0_stat_is_chr
```

**Step 3: Implement**

In `devfs.rs`, follow the same pattern as `null` / `zero` / `urandom`:

- Add `entries.push((b"fb0".into(), DT_CHR, devfs_ino(b"/dev/fb0")));` in the `/dev` listing.
- Wire `match_devfs_stat` to delegate to `virtual_device_stat(VirtualDevice::Fb0, uid, gid)` for `b"/dev/fb0"`. (May already work via the catch-all path that defers to `match_virtual_device` — verify.)

**Step 4: Run, expect pass**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib fb0_is_listed_in_dev_dir fb0_stat_is_chr
```

**Step 5: Commit**

```bash
git add crates/kernel/src/devfs.rs
git commit -m "kernel(fbdev): list /dev/fb0 in devfs"
```

---

### Task A4: `HostIO::bind_framebuffer` / `unbind_framebuffer` trait methods

**Files:**
- Modify: `crates/kernel/src/process.rs` (trait at line 25)
- Modify: `crates/kernel/src/wasm_api.rs` (`impl HostIO for WasmHostIO` near line 115)
- Modify: `crates/kernel/src/syscalls.rs` (`MockHostIO` ~8014, `TrackingHostIO` ~11777, plus `NetMock` / `SymlinkMock` / `LoopMock` / `RelSymlinkMock` — all of them) to add no-op implementations.

**Step 1: Add to the trait**

In `crates/kernel/src/process.rs`, append to `pub trait HostIO`:

```rust
    /// Notify the host that process `pid` has mapped its `/dev/fb0` framebuffer
    /// at the given offset within its wasm `Memory`. The host should mirror
    /// the byte range `[addr, addr+len)` to whatever display surface it owns.
    ///
    /// `fmt` is reserved for future format negotiation (currently always BGRA32).
    fn bind_framebuffer(
        &mut self, pid: i32, addr: usize, len: usize,
        w: u32, h: u32, stride: u32, fmt: u32,
    );
    /// Notify the host that the framebuffer for `pid` is gone (`munmap`,
    /// process exit, or exec). Idempotent: calling unbind on a pid with no
    /// binding is a no-op.
    fn unbind_framebuffer(&mut self, pid: i32);
```

**Step 2: No-op default for all impls**

In each `impl HostIO for ...` block in `crates/kernel/src/syscalls.rs` (5 mock impls; grep `impl HostIO for` to enumerate), add:

```rust
fn bind_framebuffer(&mut self, _pid: i32, _addr: usize, _len: usize,
                    _w: u32, _h: u32, _stride: u32, _fmt: u32) {}
fn unbind_framebuffer(&mut self, _pid: i32) {}
```

In `WasmHostIO` (`wasm_api.rs:115`), wire to two new extern host imports — leave the bodies as `extern "C"` declarations and forward calls. Mirror what `host_kill` / `host_exec` / `host_clone` do for cross-the-wasm-boundary patterns. Until Task B-series wires the host TS side, these will resolve to host-side stubs that we'll write in Phase B.

```rust
extern "C" {
    fn host_bind_framebuffer(pid: i32, addr: usize, len: usize,
                             w: u32, h: u32, stride: u32, fmt: u32);
    fn host_unbind_framebuffer(pid: i32);
}

// inside impl HostIO for WasmHostIO:
fn bind_framebuffer(&mut self, pid: i32, addr: usize, len: usize,
                    w: u32, h: u32, stride: u32, fmt: u32) {
    unsafe { host_bind_framebuffer(pid, addr, len, w, h, stride, fmt) }
}
fn unbind_framebuffer(&mut self, pid: i32) {
    unsafe { host_unbind_framebuffer(pid) }
}
```

**Step 3: Build to confirm trait coherence**

```bash
cargo build -p wasm-posix-kernel --target aarch64-apple-darwin
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib --no-run
```

Expected: clean compile. Any "trait method not implemented" errors mean a mock impl was missed.

**Step 4: Commit**

```bash
git add crates/kernel/src/process.rs crates/kernel/src/wasm_api.rs crates/kernel/src/syscalls.rs
git commit -m "kernel(fbdev): HostIO bind_framebuffer / unbind_framebuffer trait methods"
```

---

### Task A5: `Process::fb_binding` field + `FB0_OWNER` single-open guard

**Files:**
- Modify: `crates/kernel/src/process.rs` — add `pub fb_binding: Option<FbBinding>` and define `FbBinding` near it.
- Modify: `crates/kernel/src/process_table.rs` or wherever a process-global is appropriate — add `FB0_OWNER: AtomicI32`.

**Step 1: Failing test**

Append to `crates/kernel/src/syscalls.rs` test module (the same one that has other open-related tests):

```rust
#[test]
fn open_dev_fb0_is_single_owner() {
    let (mut proc, mut host) = test_helpers::new_proc();
    let fd1 = sys_open(&mut proc, &mut host, b"/dev/fb0", O_RDWR, 0).unwrap();
    let err = sys_open(&mut proc, &mut host, b"/dev/fb0", O_RDWR, 0).unwrap_err();
    assert_eq!(err, Errno::EBUSY);
    sys_close(&mut proc, &mut host, fd1).unwrap();
    // After close, another open succeeds
    let _fd2 = sys_open(&mut proc, &mut host, b"/dev/fb0", O_RDWR, 0).unwrap();
}
```

(Adjust the helper invocation to whatever this codebase uses — grep `fn test_helpers` or look at neighbouring tests in the file.)

**Step 2: Run, observe failure**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib open_dev_fb0_is_single_owner
```

**Step 3: Implement**

Add to `crates/kernel/src/process.rs`:

```rust
/// Per-process binding tracking the live mmap of `/dev/fb0`.
#[derive(Clone, Copy, Debug)]
pub struct FbBinding {
    pub addr: usize,
    pub len: usize,
    pub w: u32,
    pub h: u32,
    pub stride: u32,
    pub fmt: u32,
}
```

Add `pub fb_binding: Option<FbBinding>` to `struct Process`. Initialize to `None` in `Process::new` and any other constructor (e.g. `Process::fork_from`).

Add a process-table-level static (or a field on the table itself):

```rust
// crates/kernel/src/process_table.rs (or wherever owner state belongs)
use core::sync::atomic::{AtomicI32, Ordering};
pub static FB0_OWNER: AtomicI32 = AtomicI32::new(-1);  // -1 = nobody
```

In the open path (`sys_open` → CharDevice branch), when the path resolves to `VirtualDevice::Fb0`:

```rust
// pseudo: in the open branch that handles VirtualDevice
if dev == VirtualDevice::Fb0 {
    let pid = proc.pid;
    match FB0_OWNER.compare_exchange(-1, pid, Ordering::SeqCst, Ordering::SeqCst) {
        Ok(_) => { /* we own it now */ }
        Err(other) if other == pid => { /* re-open by same process — allow */ }
        Err(_) => return Err(Errno::EBUSY),
    }
}
```

In the close path: if the closed fd was the *last* one referencing the Fb0 OFD, and the process owns FB0_OWNER, release it (`FB0_OWNER.compare_exchange(pid, -1, ...)`). Refcount the OFD or check via OFD-reference iteration; mirror how PTY ownership cleanup works (`pty.rs`).

Process-exit cleanup (`Process::drop` or `kernel_remove_process`): if `fb_binding.is_some()`, release `FB0_OWNER` (CAS pid → -1) and call `host.unbind_framebuffer(pid)`.

**Step 4: Pass**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib open_dev_fb0_is_single_owner
```

**Step 5: Commit**

```bash
git add crates/kernel/src/process.rs crates/kernel/src/process_table.rs crates/kernel/src/syscalls.rs
git commit -m "kernel(fbdev): single-owner /dev/fb0 with FB0_OWNER guard"
```

---

### Task A6: ioctl handlers (FBIOGET_VSCREENINFO / FBIOGET_FSCREENINFO / FBIOPAN_DISPLAY / FBIOPUT_VSCREENINFO)

**Files:**
- Modify: `crates/kernel/src/syscalls.rs::sys_ioctl`

**Step 1: Failing tests**

Append to test module:

```rust
#[test]
fn fbioget_vscreeninfo_returns_640x400_bgra32() {
    use wasm_posix_shared::fbdev::*;
    let (mut proc, mut host) = test_helpers::new_proc();
    let fd = sys_open(&mut proc, &mut host, b"/dev/fb0", O_RDWR, 0).unwrap();
    let mut buf = [0u8; 160];
    sys_ioctl(&mut proc, fd, FBIOGET_VSCREENINFO, &mut buf).unwrap();
    let v: FbVarScreenInfo = unsafe { core::ptr::read_unaligned(buf.as_ptr() as *const _) };
    assert_eq!(v.xres, 640);
    assert_eq!(v.yres, 400);
    assert_eq!(v.bits_per_pixel, 32);
    // BGRA32: blue at offset 0, green at 8, red at 16, alpha at 24
    assert_eq!(v.blue.offset, 0); assert_eq!(v.blue.length, 8);
    assert_eq!(v.green.offset, 8); assert_eq!(v.green.length, 8);
    assert_eq!(v.red.offset, 16); assert_eq!(v.red.length, 8);
    assert_eq!(v.transp.offset, 24); assert_eq!(v.transp.length, 8);
}

#[test]
fn fbioget_fscreeninfo_reports_correct_smem_len() {
    use wasm_posix_shared::fbdev::*;
    let (mut proc, mut host) = test_helpers::new_proc();
    let fd = sys_open(&mut proc, &mut host, b"/dev/fb0", O_RDWR, 0).unwrap();
    let mut buf = [0u8; 80];
    sys_ioctl(&mut proc, fd, FBIOGET_FSCREENINFO, &mut buf).unwrap();
    let f: FbFixScreenInfo = unsafe { core::ptr::read_unaligned(buf.as_ptr() as *const _) };
    assert_eq!(&f.id[..6], b"wasmfb");
    assert_eq!(f.smem_len, 640 * 400 * 4);
    assert_eq!(f.line_length, 640 * 4);
    assert_eq!(f.fb_type, FB_TYPE_PACKED_PIXELS);
    assert_eq!(f.visual, FB_VISUAL_TRUECOLOR);
}

#[test]
fn fbiopan_display_succeeds() {
    use wasm_posix_shared::fbdev::*;
    let (mut proc, mut host) = test_helpers::new_proc();
    let fd = sys_open(&mut proc, &mut host, b"/dev/fb0", O_RDWR, 0).unwrap();
    let mut buf = [0u8; 160];   // pan reads a fb_var_screeninfo, ignores it
    sys_ioctl(&mut proc, fd, FBIOPAN_DISPLAY, &mut buf).unwrap();
}

#[test]
fn fbioput_vscreeninfo_rejects_mismatched_geometry() {
    use wasm_posix_shared::fbdev::*;
    let (mut proc, mut host) = test_helpers::new_proc();
    let fd = sys_open(&mut proc, &mut host, b"/dev/fb0", O_RDWR, 0).unwrap();
    let mut v = FbVarScreenInfo::default();
    v.xres = 320; v.yres = 200; v.bits_per_pixel = 32;
    let mut buf = [0u8; 160];
    unsafe { core::ptr::write_unaligned(buf.as_mut_ptr() as *mut _, v); }
    let err = sys_ioctl(&mut proc, fd, FBIOPUT_VSCREENINFO, &mut buf).unwrap_err();
    assert_eq!(err, Errno::EINVAL);
}

#[test]
fn unknown_fb_ioctl_returns_enotty() {
    let (mut proc, mut host) = test_helpers::new_proc();
    let fd = sys_open(&mut proc, &mut host, b"/dev/fb0", O_RDWR, 0).unwrap();
    let mut buf = [0u8; 8];
    let err = sys_ioctl(&mut proc, fd, 0x46FF, &mut buf).unwrap_err();
    assert_eq!(err, Errno::ENOTTY);
}
```

**Step 2: Run, observe failures**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib fbio
```

**Step 3: Implement**

In `sys_ioctl`, add an early branch (after the FIONBIO/FIOASYNC/FIONREAD generic branches) that detects the OFD belongs to `VirtualDevice::Fb0`. Sketch:

```rust
let ofd = proc.ofd_table.get(ofd_idx).ok_or(Errno::EBADF)?;
if ofd.file_type == FileType::CharDevice {
    if let Some(VirtualDevice::Fb0) = VirtualDevice::from_host_handle(ofd.host_handle) {
        return handle_fb_ioctl(proc, request, buf);
    }
}
```

Then `fn handle_fb_ioctl` writes the appropriate bytes:

```rust
fn handle_fb_ioctl(_proc: &mut Process, request: u32, buf: &mut [u8]) -> Result<(), Errno> {
    use wasm_posix_shared::fbdev::*;
    match request {
        FBIOGET_VSCREENINFO => {
            if buf.len() < 160 { return Err(Errno::EINVAL); }
            let mut v = FbVarScreenInfo::default();
            v.xres = 640; v.yres = 400;
            v.xres_virtual = 640; v.yres_virtual = 400;
            v.bits_per_pixel = 32;
            v.blue   = FbBitfield { offset: 0,  length: 8, msb_right: 0 };
            v.green  = FbBitfield { offset: 8,  length: 8, msb_right: 0 };
            v.red    = FbBitfield { offset: 16, length: 8, msb_right: 0 };
            v.transp = FbBitfield { offset: 24, length: 8, msb_right: 0 };
            unsafe { core::ptr::write_unaligned(buf.as_mut_ptr() as *mut _, v); }
            Ok(())
        }
        FBIOGET_FSCREENINFO => {
            if buf.len() < 80 { return Err(Errno::EINVAL); }
            let mut f = FbFixScreenInfo::default();
            f.id[..6].copy_from_slice(b"wasmfb");
            f.smem_len = 640 * 400 * 4;
            f.line_length = 640 * 4;
            f.fb_type = FB_TYPE_PACKED_PIXELS;
            f.visual = FB_VISUAL_TRUECOLOR;
            unsafe { core::ptr::write_unaligned(buf.as_mut_ptr() as *mut _, f); }
            Ok(())
        }
        FBIOPAN_DISPLAY => Ok(()),  // accepted, ignored
        FBIOPUT_VSCREENINFO => {
            if buf.len() < 160 { return Err(Errno::EINVAL); }
            let v: FbVarScreenInfo = unsafe { core::ptr::read_unaligned(buf.as_ptr() as *const _) };
            if v.xres != 640 || v.yres != 400 || v.bits_per_pixel != 32 {
                return Err(Errno::EINVAL);
            }
            Ok(())
        }
        _ => Err(Errno::ENOTTY),
    }
}
```

**Step 4: Pass**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib fbio
```

**Step 5: Commit**

```bash
git add crates/kernel/src/syscalls.rs
git commit -m "kernel(fbdev): FBIOGET_VSCREENINFO / FSCREENINFO / PAN / PUT ioctls"
```

---

### Task A7: mmap binding path

**Files:**
- Modify: `crates/kernel/src/syscalls.rs::sys_mmap` (around line 3754)

**Step 1: Failing test**

```rust
#[test]
fn mmap_fb0_records_binding_and_calls_host() {
    let (mut proc, mut host) = test_helpers::new_proc_with_tracking_host();
    let fd = sys_open(&mut proc, &mut host, b"/dev/fb0", O_RDWR, 0).unwrap();
    let len = 640 * 400 * 4;
    let addr = sys_mmap(&mut proc, &mut host, 0, len, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0).unwrap();
    assert_ne!(addr, 0);
    assert!(proc.fb_binding.is_some());
    let b = proc.fb_binding.unwrap();
    assert_eq!(b.addr, addr);
    assert_eq!(b.len, len);
    assert_eq!(b.w, 640); assert_eq!(b.h, 400);
    // TrackingHostIO records bind/unbind calls
    assert_eq!(host.bind_framebuffer_calls.len(), 1);
    assert_eq!(host.bind_framebuffer_calls[0].pid, proc.pid);
}

#[test]
fn second_mmap_of_fb0_returns_einval() {
    let (mut proc, mut host) = test_helpers::new_proc_with_tracking_host();
    let fd = sys_open(&mut proc, &mut host, b"/dev/fb0", O_RDWR, 0).unwrap();
    let len = 640 * 400 * 4;
    let _addr = sys_mmap(&mut proc, &mut host, 0, len, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0).unwrap();
    let err = sys_mmap(&mut proc, &mut host, 0, len, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0).unwrap_err();
    assert_eq!(err, Errno::EINVAL);
}
```

You'll need to extend `TrackingHostIO` to record `bind_framebuffer` / `unbind_framebuffer` calls in vectors — see how it currently records `host_kill` etc. (Existing pattern in the file.)

**Step 2: Run, observe failure**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib mmap_fb0 second_mmap_of_fb0
```

**Step 3: Implement**

`sys_mmap` currently takes no `host` argument — but other syscalls do. Add `host: &mut dyn HostIO` to `sys_mmap` (and propagate the call site change in `wasm_api.rs::kernel_mmap`). At the top of `sys_mmap`, after fd validation, if the fd resolves to `VirtualDevice::Fb0`:

```rust
// Detect framebuffer fd
if !flags_contains_anonymous && fd >= 0 {
    let entry = proc.fd_table.get(fd)?;
    let ofd = proc.ofd_table.get(entry.ofd_ref.0).ok_or(Errno::EBADF)?;
    if ofd.file_type == FileType::CharDevice
        && VirtualDevice::from_host_handle(ofd.host_handle) == Some(VirtualDevice::Fb0)
    {
        if proc.fb_binding.is_some() { return Err(Errno::EINVAL); }
        if len != 640 * 400 * 4 { return Err(Errno::EINVAL); }
        let addr_out = proc.memory.mmap_anonymous(addr, len, prot, flags | MAP_ANONYMOUS);
        if addr_out == MAP_FAILED { return Err(Errno::ENOMEM); }
        proc.fb_binding = Some(FbBinding {
            addr: addr_out, len, w: 640, h: 400, stride: 640 * 4, fmt: 0 /* BGRA32 */,
        });
        host.bind_framebuffer(proc.pid, addr_out, len, 640, 400, 640 * 4, 0);
        return Ok(addr_out);
    }
}
// ... existing path
```

**Step 4: Pass**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib mmap_fb0 second_mmap_of_fb0
```

**Step 5: Commit**

```bash
git add crates/kernel/src/syscalls.rs crates/kernel/src/wasm_api.rs
git commit -m "kernel(fbdev): mmap(/dev/fb0) records binding and notifies host"
```

---

### Task A8: munmap / close / process-exit cleanup

**Files:**
- Modify: `crates/kernel/src/syscalls.rs::sys_munmap`, `sys_close`
- Modify: `crates/kernel/src/process.rs` (process drop / cleanup hook)
- Modify: `crates/kernel/src/wasm_api.rs::kernel_remove_process` if a hook lives there

**Step 1: Failing tests**

```rust
#[test]
fn munmap_of_fb_region_clears_binding_and_unbinds_host() {
    let (mut proc, mut host) = test_helpers::new_proc_with_tracking_host();
    let fd = sys_open(&mut proc, &mut host, b"/dev/fb0", O_RDWR, 0).unwrap();
    let len = 640 * 400 * 4;
    let addr = sys_mmap(&mut proc, &mut host, 0, len, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0).unwrap();
    sys_munmap(&mut proc, &mut host, addr, len).unwrap();
    assert!(proc.fb_binding.is_none());
    assert_eq!(host.unbind_framebuffer_calls.len(), 1);
    assert_eq!(host.unbind_framebuffer_calls[0], proc.pid);
}

#[test]
fn process_exit_releases_fb0_owner_and_unbinds() {
    let mut host = test_helpers::new_tracking_host();
    {
        let mut proc = test_helpers::new_proc_with(host.borrow_mut());
        let fd = sys_open(&mut proc, &mut host, b"/dev/fb0", O_RDWR, 0).unwrap();
        let len = 640 * 400 * 4;
        let _addr = sys_mmap(&mut proc, &mut host, 0, len, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0).unwrap();
        // proc dropped here, simulating exit
    }
    // Owner released:
    assert_eq!(crate::process_table::FB0_OWNER.load(Ordering::SeqCst), -1);
    // Host unbind called:
    assert!(!host.unbind_framebuffer_calls.is_empty());
}
```

(Adapt to the codebase's process-lifecycle test patterns — there are existing tests for ofd cleanup; mirror them.)

**Step 2: Run, observe failure**

**Step 3: Implement**

`sys_munmap` needs `host: &mut dyn HostIO` so it can call `unbind_framebuffer`. After the existing `proc.memory.munmap(addr, len)` call:

```rust
if let Some(b) = proc.fb_binding {
    if addr <= b.addr && addr + len >= b.addr + b.len {
        proc.fb_binding = None;
        host.unbind_framebuffer(proc.pid);
    }
}
```

`sys_close` of an Fb0 fd: if this was the last fd referencing the OFD AND the binding has been munmap'd, release `FB0_OWNER`. (If the binding survives close — Linux semantics — we don't release the owner until munmap or exit.) Simpler rule: release owner when *all* of (no fb_binding, no Fb0 fds) is true.

Process exit / `kernel_remove_process`: explicit cleanup — if `proc.fb_binding.is_some()`, call `host.unbind_framebuffer(proc.pid)`; then CAS `FB0_OWNER` from `proc.pid` → -1.

**Step 4: Pass**

**Step 5: Commit**

```bash
git add crates/kernel/src/syscalls.rs crates/kernel/src/process.rs crates/kernel/src/wasm_api.rs
git commit -m "kernel(fbdev): munmap/close/exit clean up fb binding and ownership"
```

---

### Task A9: ABI snapshot regen + version bump

**Files:**
- Modify: `crates/shared/src/lib.rs` (`ABI_VERSION` line 20)
- Modify: `abi/snapshot.json` (regenerated by script)

**Step 1: Run snapshot update**

```bash
bash scripts/check-abi-version.sh update
git diff abi/snapshot.json | head -100
```

**Step 2: Decide if version bump is needed**

If the diff shows the new `FbVarScreenInfo` / `FbFixScreenInfo` struct entries (expected): bump.
If only host-imports changed and the structural snapshot is unchanged: no bump.

**Step 3: Bump (if needed)**

In `crates/shared/src/lib.rs`, change `pub const ABI_VERSION: u32 = 5;` to `pub const ABI_VERSION: u32 = 6;`.

**Step 4: Verify**

```bash
bash scripts/check-abi-version.sh
```

Expected: exit 0.

**Step 5: Commit**

```bash
git add crates/shared/src/lib.rs abi/snapshot.json
git commit -m "kernel(fbdev): bump ABI_VERSION 5→6 for fbdev structs"
```

---

### Task A10: Phase A — full test gauntlet + open PR #1

**Files:** none (verification only)

**Step 1: Run all five test suites + ABI**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib
(cd host && npx vitest run)
scripts/run-libc-tests.sh
scripts/run-posix-tests.sh
scripts/run-sortix-tests.sh --all
bash scripts/check-abi-version.sh
```

Expected: zero new failures vs the branch baseline. If anything regresses, fix before opening the PR.

**Step 2: Push branch and open PR #1**

```bash
git push -u origin kernel-processes-writing-to-framebuffer
gh pr create --draft --title "kernel(fbdev): /dev/fb0 device + ioctls + mmap binding" --body "..."
```

PR body: link to `docs/plans/2026-04-26-framebuffer-fbdoom-design.md`, summarise what landed, note this is part 1/3 of a coordinated stack. Mark the PR `Draft` and explicitly note in the description: "Holds for merge until Phase C (browser DOOM demo) is verified — see plan."

---

## Phase B — Host registry + Vitest (PR #2)

### Task B1: `FramebufferRegistry` module

**Files:**
- Create: `host/src/framebuffer/registry.ts`
- Create: `host/src/framebuffer/index.ts` (barrel)
- Create: `host/test/framebuffer-registry.test.ts`

**Step 1: Failing test**

```ts
// host/test/framebuffer-registry.test.ts
import { describe, expect, it } from 'vitest';
import { FramebufferRegistry } from '../src/framebuffer/registry.js';

describe('FramebufferRegistry', () => {
  it('binds and retrieves', () => {
    const reg = new FramebufferRegistry();
    reg.bind({ pid: 5, addr: 0x1000, len: 1024 * 1024,
               w: 640, h: 400, stride: 2560, fmt: 'BGRA32' });
    const b = reg.get(5);
    expect(b?.w).toBe(640);
    expect(b?.view).toBeNull();        // lazy
  });

  it('unbinds idempotently', () => {
    const reg = new FramebufferRegistry();
    reg.bind({ pid: 5, addr: 0x1000, len: 100, w: 1, h: 1, stride: 4, fmt: 'BGRA32' });
    reg.unbind(5);
    reg.unbind(5);  // no throw
    expect(reg.get(5)).toBeUndefined();
  });

  it('rebindMemory invalidates cached view', () => {
    const reg = new FramebufferRegistry();
    const sab = new SharedArrayBuffer(1024);
    reg.bind({ pid: 5, addr: 0, len: 4, w: 1, h: 1, stride: 4, fmt: 'BGRA32' });
    const b = reg.get(5)!;
    b.view = new Uint8ClampedArray(sab, 0, 4);  // simulate cache
    reg.rebindMemory(5, new SharedArrayBuffer(2048));
    expect(reg.get(5)?.view).toBeNull();
  });
});
```

**Step 2: Run, observe failure**

```bash
(cd host && npx vitest run framebuffer-registry)
```

**Step 3: Implement**

```ts
// host/src/framebuffer/registry.ts
export type FbFormat = 'BGRA32';

export type FbBinding = {
  pid: number;
  addr: number;
  len: number;
  w: number;
  h: number;
  stride: number;
  fmt: FbFormat;
  view: Uint8ClampedArray | null;
  imageData: ImageData | null;
};

export class FramebufferRegistry {
  private bindings = new Map<number, FbBinding>();
  private listeners = new Set<(pid: number, ev: 'bind' | 'unbind') => void>();

  bind(b: Omit<FbBinding, 'view' | 'imageData'>): void {
    this.bindings.set(b.pid, { ...b, view: null, imageData: null });
    for (const l of this.listeners) l(b.pid, 'bind');
  }

  unbind(pid: number): void {
    if (!this.bindings.has(pid)) return;
    this.bindings.delete(pid);
    for (const l of this.listeners) l(pid, 'unbind');
  }

  get(pid: number): FbBinding | undefined {
    return this.bindings.get(pid);
  }

  rebindMemory(pid: number, _newSab: SharedArrayBuffer): void {
    const b = this.bindings.get(pid);
    if (!b) return;
    b.view = null;
    b.imageData = null;
  }

  list(): FbBinding[] { return [...this.bindings.values()]; }

  onChange(fn: (pid: number, ev: 'bind' | 'unbind') => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
```

```ts
// host/src/framebuffer/index.ts
export { FramebufferRegistry } from './registry.js';
export type { FbBinding, FbFormat } from './registry.js';
```

**Step 4: Pass**

```bash
(cd host && npx vitest run framebuffer-registry)
```

**Step 5: Commit**

```bash
git add host/src/framebuffer host/test/framebuffer-registry.test.ts
git commit -m "host(fbdev): FramebufferRegistry"
```

---

### Task B2: Wire `host_bind_framebuffer` / `host_unbind_framebuffer` into kernel-worker

**Files:**
- Modify: `host/src/kernel-worker.ts` (or wherever the kernel wasm imports are bound — grep `host_kill` / `host_exec` to find the imports object)
- Modify: `host/src/centralized-kernel-worker.ts` or similar — wherever `FramebufferRegistry` lives at runtime
- Modify: `host/test/centralized-test-helper.ts` — expose `kernel.framebuffers` for tests

**Step 1: Failing test (integration)**

Skip a unit test here — Task B3 will be the integration test that exercises this end-to-end.

**Step 2: Implement**

Find the kernel wasm import object construction. Add:

```ts
const framebuffers = new FramebufferRegistry();

const imports = {
  // ... existing
  env: {
    // ...
    host_bind_framebuffer(pid: number, addr: number, len: number,
                          w: number, h: number, stride: number, fmt: number) {
      framebuffers.bind({ pid, addr, len, w, h, stride, fmt: 'BGRA32' });
    },
    host_unbind_framebuffer(pid: number) {
      framebuffers.unbind(pid);
    },
  },
};
```

Expose `framebuffers` on the worker / kernel object so tests and demo pages can reach it: `kernel.framebuffers`.

Hook the existing memory-replaced event (search for the path that updates per-process Memory after `memory.grow`) to call `framebuffers.rebindMemory(pid, newSab)`.

**Step 3: Type-check + build**

```bash
(cd host && npx tsc --noEmit)
```

**Step 4: Commit**

```bash
git add host/src
git commit -m "host(fbdev): wire bind/unbind imports into kernel worker"
```

---

### Task B3: `fbtest.c` test program + Vitest integration test

**Files:**
- Create: `examples/test-programs/fbtest.c`
- Modify: `scripts/build-programs.sh` (or wherever test fixtures are listed) to compile `fbtest.c`
- Create: `host/test/framebuffer-integration.test.ts`

**Step 1: Write `fbtest.c`**

```c
// examples/test-programs/fbtest.c
#include <fcntl.h>
#include <linux/fb.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <unistd.h>

int main(void) {
    int fd = open("/dev/fb0", O_RDWR);
    if (fd < 0) { perror("open"); return 1; }
    struct fb_var_screeninfo v;
    if (ioctl(fd, FBIOGET_VSCREENINFO, &v) < 0) { perror("FBIOGET_VSCREENINFO"); return 1; }
    struct fb_fix_screeninfo f;
    if (ioctl(fd, FBIOGET_FSCREENINFO, &f) < 0) { perror("FBIOGET_FSCREENINFO"); return 1; }
    uint32_t* px = mmap(NULL, f.smem_len, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (px == MAP_FAILED) { perror("mmap"); return 1; }
    for (uint32_t r = 0; r < v.yres; r++)
        for (uint32_t c = 0; c < v.xres; c++)
            px[r * v.xres + c] = 0xFF000000u | ((uint32_t)r << 16) | (uint32_t)c;
    write(1, "ok\n", 3);
    pause();
    return 0;
}
```

**Step 2: Add a minimal `<linux/fb.h>` to the sysroot**

If `wasm32posix-cc -E` can't find `<linux/fb.h>`, add a minimal version under `sysroot/include/linux/fb.h` with the four ioctl numbers + struct definitions matching the Linux ABI. Cross-check by compiling `fbtest.c` and resolving any missing symbols.

**Step 3: Wire into the build**

Append `fbtest.c` to whatever loop in `scripts/build-programs.sh` produces test wasm binaries. Verify it builds:

```bash
scripts/build-programs.sh
ls -la build/test-programs/fbtest.wasm
```

**Step 4: Vitest test**

```ts
// host/test/framebuffer-integration.test.ts
import { describe, expect, it } from 'vitest';
import { runProgram } from './centralized-test-helper.js';

describe('framebuffer integration', () => {
  it('mmap of /dev/fb0 binds and surfaces pixels through the SAB', async () => {
    const { kernel, pid, stdout } = await runProgram('build/test-programs/fbtest.wasm');
    await stdout.waitFor('ok\n');
    const b = kernel.framebuffers.get(pid);
    expect(b).toBeDefined();
    expect(b!.w).toBe(640); expect(b!.h).toBe(400);
    // Read raw bytes from the bound region of the process Memory SAB
    const sab = kernel.getProcessMemorySab(pid);
    const view = new DataView(sab, b!.addr, b!.len);
    // Sample row=10, col=20 → expected 0xFF000000 | (10 << 16) | 20 = 0xFF0A0014
    const off = (10 * 640 + 20) * 4;
    expect(view.getUint32(off, true)).toBe(0xFF0A0014);
    // Send SIGTERM, expect unbind
    await kernel.killProcess(pid, 15);
    await new Promise(r => setTimeout(r, 100));  // let cleanup run
    expect(kernel.framebuffers.get(pid)).toBeUndefined();
  });

  it('second open of /dev/fb0 in same process returns EBUSY', async () => {
    // Tiny C helper that double-opens and reports errno; build similarly.
    // ... or assert at the kernel-test level if a helper exists.
  });
});
```

**Step 5: Run**

```bash
(cd host && npx vitest run framebuffer-integration)
```

Expected: pass.

**Step 6: Commit**

```bash
git add examples/test-programs/fbtest.c scripts/build-programs.sh sysroot/include/linux/fb.h host/test/framebuffer-integration.test.ts
git commit -m "host(fbdev): integration test — fbtest.c writes pixels through bound mmap"
```

---

### Task B4: Phase B — full gauntlet + open PR #2

**Files:** none (verification only)

Same as Task A10:

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib
(cd host && npx vitest run)
scripts/run-libc-tests.sh
scripts/run-posix-tests.sh
scripts/run-sortix-tests.sh --all
bash scripts/check-abi-version.sh
```

Then push and open PR #2 (draft, hold-for-merge).

---

## Phase C — Browser canvas + DOOM demo (PR #3)

### Task C1: `attachCanvas` browser renderer

**Files:**
- Create: `host/src/framebuffer/canvas-renderer.ts`

**Step 1: Implement (no unit test — DOM-bound; Vitest jsdom doesn't usefully exercise `putImageData`, manual browser test is the gate)**

```ts
// host/src/framebuffer/canvas-renderer.ts
import type { FramebufferRegistry } from './registry.js';

export interface CanvasAttachOpts {
  getProcessMemorySab(pid: number): SharedArrayBuffer;
}

export function attachCanvas(
  canvas: HTMLCanvasElement,
  registry: FramebufferRegistry,
  pid: number,
  opts: CanvasAttachOpts,
): () => void {
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('canvas 2d context unavailable');

  let raf = 0;
  const tick = () => {
    const b = registry.get(pid);
    if (b) {
      if (canvas.width !== b.w) canvas.width = b.w;
      if (canvas.height !== b.h) canvas.height = b.h;
      if (!b.view) {
        const sab = opts.getProcessMemorySab(pid);
        b.view = new Uint8ClampedArray(sab, b.addr, b.len);
        b.imageData = new ImageData(b.view, b.w, b.h);
      }
      // BGRA32 in memory, ImageData expects RGBA — we'll need a swizzle.
      // putImageData accepts the underlying view in whatever order; canvas
      // is RGBA. fbDOOM writes BGRA per Linux fbdev convention. We swizzle
      // R↔B in place, present, then... no, swizzling in place corrupts the
      // process's view. Instead, allocate a parallel RGBA scratch buffer
      // and copy with channel swap.
      swizzleBgraToRgba(b.view, scratchRgba);
      ctx.putImageData(new ImageData(scratchRgba, b.w, b.h), 0, 0);
    }
    raf = requestAnimationFrame(tick);
  };
  let scratchRgba = new Uint8ClampedArray(0);
  raf = requestAnimationFrame(() => {
    const b = registry.get(pid);
    if (b) scratchRgba = new Uint8ClampedArray(b.len);
    tick();
  });
  return () => cancelAnimationFrame(raf);
}

function swizzleBgraToRgba(src: Uint8ClampedArray, dst: Uint8ClampedArray): void {
  for (let i = 0; i < src.length; i += 4) {
    dst[i]     = src[i + 2];
    dst[i + 1] = src[i + 1];
    dst[i + 2] = src[i];
    dst[i + 3] = src[i + 3];
  }
}
```

**Note on swizzling**: A naïve per-frame swizzle is ~1MB of byte ops at 60Hz = 60MB/s. Browsers handle this comfortably. If profiling shows it's a bottleneck (it won't), revisit with a Wasm SIMD swizzler or a WebGL texture upload.

**Step 2: Type-check**

```bash
(cd host && npx tsc --noEmit)
```

**Step 3: Commit**

```bash
git add host/src/framebuffer/canvas-renderer.ts host/src/framebuffer/index.ts
git commit -m "host(fbdev): canvas-renderer with BGRA→RGBA swizzle"
```

---

### Task C2: fbDOOM cross-compile script

**Files:**
- Create: `examples/libs/fbdoom/build-fbdoom.sh`
- Possibly: `examples/libs/fbdoom/patches/*.patch` (only if cross-compile hygiene demands it; do NOT patch around platform gaps)

**Step 1: Write the build script**

```bash
#!/usr/bin/env bash
# examples/libs/fbdoom/build-fbdoom.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
SRC="$HERE/fbdoom-src"

if [ ! -d "$SRC" ]; then
    git clone --depth 1 https://github.com/maximevince/fbDOOM "$SRC"
fi

cd "$SRC/fbdoom"

# Clean previous build
make clean || true

# Cross-compile. NOSDL=1 selects the framebuffer-only path.
make CC=wasm32posix-cc \
     LD=wasm32posix-cc \
     CFLAGS="-O2 -DNORMALUNIX -DLINUX -D_DEFAULT_SOURCE" \
     LDFLAGS="" \
     NOSDL=1

# Run fork-instrument as the last wasm pipeline step (project convention).
"$REPO_ROOT/tools/bin/wasm-fork-instrument" fbdoom "$HERE/fbdoom.wasm"

ls -la "$HERE/fbdoom.wasm"
```

**Step 2: Run it**

```bash
chmod +x examples/libs/fbdoom/build-fbdoom.sh
examples/libs/fbdoom/build-fbdoom.sh
```

**Expected pitfalls** (handle whichever surfaces):
- Missing `<linux/fb.h>` — covered by the sysroot header from Task B3.
- `i_sound.c` audio backend — fbDOOM ships a `nullaudio` build option; pick that, don't `#ifdef`.
- `KDSKBMODE` / `<linux/kd.h>` — if fbDOOM uses raw scancode mode, decide whether to add a stub `<linux/kd.h>` (returning sensible no-ops via ioctl) or use fbDOOM's termios-only path. Termios path is preferred.

**Step 3: Smoke-test the wasm**

Confirm the binary at least imports `__channel_base` and exports the expected symbols:

```bash
wasm-objdump -x examples/libs/fbdoom/fbdoom.wasm | grep -E "__channel_base|_start" | head -5
```

**Step 4: Commit**

```bash
git add examples/libs/fbdoom/
git commit -m "examples(fbdoom): cross-compile script for maximevince/fbDOOM"
```

---

### Task C3: WAD bundling via lazy-load

**Files:**
- Create / modify: `examples/browser/pages/doom/main.ts` (later in C4) — register doom1.wad lazily
- Asset: `examples/browser/public/assets/doom/doom1.wad` — the freely-redistributable shareware WAD

**Step 1: Place the WAD**

Download from a known-good shareware mirror (id Software releases the shareware WAD freely). Place at `examples/browser/public/assets/doom/doom1.wad`. Approximate size 4MB.

**Step 2: Register it lazily**

The wiring goes in the demo page (Task C4). Verify the lazy-file path works by adding a one-line script that calls `MemoryFileSystem.registerLazyFile('/usr/local/games/doom/doom1.wad', '/assets/doom/doom1.wad')` and checks the file appears under `/usr/local/games/doom/`.

**Step 3: Commit (the asset and any infrastructure change)**

```bash
git add examples/browser/public/assets/doom/doom1.wad
git commit -m "examples(fbdoom): bundle doom1.wad shareware (lazy-loaded)"
```

(Note: if the WAD is large, prefer a `.gitattributes` LFS entry or fetch-on-build script — check whether the repo already uses LFS by inspecting `.gitattributes`.)

---

### Task C4: DOOM demo page

**Files:**
- Create: `examples/browser/pages/doom/index.html`
- Create: `examples/browser/pages/doom/main.ts`
- Modify: `examples/browser/vite.config.ts` (or whatever registers pages) to include the new page
- Modify: `examples/browser/package.json` if a script entry is needed

**Step 1: HTML**

```html
<!-- examples/browser/pages/doom/index.html -->
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>DOOM (fbDOOM on wasm-posix-kernel)</title>
  <style>
    body { background: #111; color: #ccc; font-family: monospace; margin: 0; padding: 20px; }
    canvas { image-rendering: pixelated; width: 1280px; height: 800px;
             display: block; outline: none; background: #000; }
    #status { margin-top: 8px; }
  </style>
</head>
<body>
  <h1>DOOM</h1>
  <button id="start">Start</button>
  <canvas id="fb" tabindex="0" width="640" height="400"></canvas>
  <div id="status">Click Start to boot.</div>
  <script type="module" src="./main.ts"></script>
</body>
</html>
```

**Step 2: TypeScript**

```ts
// examples/browser/pages/doom/main.ts
import { BrowserKernel } from '../../lib/browser-kernel.js';
import { attachCanvas } from '../../../host/src/framebuffer/canvas-renderer.js';

const startBtn = document.getElementById('start') as HTMLButtonElement;
const canvas = document.getElementById('fb') as HTMLCanvasElement;
const status = document.getElementById('status')!;

const KEY_MAP: Record<string, number[]> = {
  'ArrowUp':    [0x1b, 0x5b, 0x41],
  'ArrowDown':  [0x1b, 0x5b, 0x42],
  'ArrowRight': [0x1b, 0x5b, 0x43],
  'ArrowLeft':  [0x1b, 0x5b, 0x44],
  'Enter':      [0x0d],
  'Escape':     [0x1b],
  'Space':      [0x20],
  'ControlLeft':  [0x06],  // Ctrl+F (fire) — tune to fbDOOM's bindings
  'ControlRight': [0x06],
};

startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  status.textContent = 'Booting...';

  const kernel = await BrowserKernel.create();

  // Lazy-register the WAD
  kernel.fs.registerLazyFile('/usr/local/games/doom/doom1.wad', '/assets/doom/doom1.wad');
  kernel.fs.mkdirRecursive('/home/doom');

  status.textContent = 'Spawning fbdoom...';
  const wasmBytes = await fetch('/assets/fbdoom/fbdoom.wasm').then(r => r.arrayBuffer());
  const pid = await kernel.spawn(new Uint8Array(wasmBytes), {
    argv: ['fbdoom', '-iwad', '/usr/local/games/doom/doom1.wad'],
    env: ['HOME=/home/doom', 'TERM=linux'],
    cwd: '/home/doom',
  });

  attachCanvas(canvas, kernel.framebuffers, pid, {
    getProcessMemorySab: (p) => kernel.getProcessMemorySab(p),
  });

  canvas.focus();
  canvas.addEventListener('keydown', (e) => {
    const bytes = KEY_MAP[e.code]
      ?? (e.key.length === 1 ? [e.key.charCodeAt(0)] : null);
    if (bytes) {
      kernel.appendStdinData(pid, new Uint8Array(bytes));
      e.preventDefault();
    }
  });
  canvas.addEventListener('click', () => canvas.focus());

  status.textContent = 'Running. Click canvas + use arrows/Enter/Esc/Ctrl/Space.';
});
```

**Step 3: Run dev server**

```bash
cd examples/browser && npm run dev
```

Open the printed URL, navigate to the DOOM page, click Start, observe the title screen.

**Step 4: Commit**

```bash
git add examples/browser/pages/doom/ examples/browser/vite.config.ts
git commit -m "examples(fbdoom): browser demo page wiring kernel + canvas + keyboard"
```

---

### Task C5: Manual browser verification (the gate)

**Files:** none (manual)

Per CLAUDE.md "for UI or frontend changes, start the dev server and use the feature in a browser before reporting the task as complete."

**Run through the success criteria from the design doc**:

1. Title screen renders within ~5s of clicking Start.
2. Arrow keys navigate the main menu; Enter starts a new game.
3. E1M1 loads, player can walk forward (up arrow), strafe, fire (Ctrl).
4. Save game (F2) and load game (F3) round-trip across a quit-and-restart of the process within the same tab.
5. Frame rate is "playable" (eyeball test, target ≥20 fps).

**If any step fails**: do NOT compromise fbDOOM. Identify whether the gap is in (a) an unimplemented kernel surface, (b) a host glue bug, or (c) a build / sysroot issue, and fix the root cause. Add a regression test where possible.

**If all succeed**: take a screenshot of the title screen and a screenshot of E1M1 gameplay, save locally, and let the user upload them to the PR description.

**Step 1: Re-run the full gauntlet**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib
(cd host && npx vitest run)
scripts/run-libc-tests.sh
scripts/run-posix-tests.sh
scripts/run-sortix-tests.sh --all
bash scripts/check-abi-version.sh
```

**Step 2: Update docs**

- `docs/posix-status.md` — add fbdev row.
- `docs/architecture.md` — short framebuffer subsection.
- `docs/browser-support.md` — note canvas/keyboard requirements.
- `README.md` — fbDOOM in "Software ported".

```bash
git add docs/ README.md
git commit -m "docs(fbdev): document /dev/fb0 surface and fbDOOM browser demo"
```

**Step 3: Push and open PR #3**

```bash
git push
gh pr create --draft --title "examples(fbdoom): /dev/fb0 + browser DOOM demo" --body "..."
```

PR body: link to the design doc, summarise what landed, note this is part 3/3.

**Step 4: Notify user**

Tell the user: "All three PRs are open and verified. The browser DOOM demo runs through the success criteria. Ready to merge in order #1 → #2 → #3?" Wait for explicit approval before any merge.

---

## Final coordinated merge

When the user confirms:

```bash
gh pr ready <pr1>
gh pr merge <pr1> --squash
gh pr ready <pr2>
gh pr merge <pr2> --squash
gh pr ready <pr3>
gh pr merge <pr3> --squash
```

Then on `main`, run the full gauntlet one more time to confirm the merged state matches the validated state.

```bash
git checkout main && git pull
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib
(cd host && npx vitest run)
scripts/run-libc-tests.sh
scripts/run-posix-tests.sh
scripts/run-sortix-tests.sh --all
bash scripts/check-abi-version.sh
```

Update memory: mark `framebuffer-fbdoom-initiative.md` as **shipped** with the merge commit SHA, ABI bump, and a note about the swizzle-on-RAF approach.
