//! Process glue the driver needs from the C runtime it is linked into.
//!
//! Ownership: the driver is a static library inside an ordinary SDK-built C
//! program, so the program's musl owns the heap and the process. The Rust
//! heap is musl's `malloc` (one allocator per process, so memory the driver
//! and the program allocate behaves alike under fork, exec and RLIMIT_AS),
//! and a driver panic ends the process with `abort()`, raising SIGABRT the
//! way a failed C assertion would. Nothing here unwinds: the library is
//! built with `panic = abort`.

#[cfg(not(test))]
use core::ffi::c_int;
#[cfg(all(target_arch = "wasm32", not(test)))]
use core::ffi::c_void;
use core::fmt::{self, Write};

#[cfg(not(test))]
unsafe extern "C" {
    fn write(fd: c_int, buf: *const u8, count: usize) -> isize;
}

#[cfg(all(target_arch = "wasm32", not(test)))]
unsafe extern "C" {
    fn malloc(size: usize) -> *mut c_void;
    fn free(ptr: *mut c_void);
    fn realloc(ptr: *mut c_void, size: usize) -> *mut c_void;
    fn aligned_alloc(align: usize, size: usize) -> *mut c_void;
}

#[cfg(not(test))]
unsafe extern "C" {
    fn abort() -> !;
}

#[cfg(all(target_arch = "wasm32", not(test)))]
mod heap {
    use super::{aligned_alloc, c_void, free, malloc, realloc};
    use core::alloc::{GlobalAlloc, Layout};
    use core::ptr;

    /// musl's `malloc` aligns every block for any object of fundamental
    /// alignment, at least `2 * sizeof(size_t)` (8 on wasm32). Stricter
    /// layouts go through `aligned_alloc`.
    const MALLOC_MIN_ALIGN: usize = 8;

    struct MuslAlloc;

    unsafe impl GlobalAlloc for MuslAlloc {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            unsafe {
                if layout.align() <= MALLOC_MIN_ALIGN {
                    malloc(layout.size()) as *mut u8
                } else {
                    aligned_alloc(layout.align(), layout.size()) as *mut u8
                }
            }
        }

        unsafe fn dealloc(&self, ptr: *mut u8, _layout: Layout) {
            unsafe { free(ptr as *mut c_void) }
        }

        unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
            unsafe {
                if layout.align() <= MALLOC_MIN_ALIGN {
                    return realloc(ptr as *mut c_void, new_size) as *mut u8;
                }
                // C `realloc` keeps only fundamental alignment, so an
                // over-aligned block moves through a fresh aligned one.
                let moved = self.alloc(Layout::from_size_align_unchecked(new_size, layout.align()));
                if !moved.is_null() {
                    ptr::copy_nonoverlapping(ptr, moved, layout.size().min(new_size));
                    self.dealloc(ptr, layout);
                }
                moved
            }
        }
    }

    #[global_allocator]
    static ALLOC: MuslAlloc = MuslAlloc;
}

/// Accumulates one diagnostic line and hands it to `sink` in pieces of at
/// most `N` bytes, so a long message is never truncated and a short one is
/// a single `write`.
struct Line<const N: usize, F: FnMut(&[u8])> {
    buf: [u8; N],
    len: usize,
    sink: F,
}

impl<const N: usize, F: FnMut(&[u8])> Line<N, F> {
    fn flush(&mut self) {
        if self.len > 0 {
            (self.sink)(&self.buf[..self.len]);
            self.len = 0;
        }
    }
}

impl<const N: usize, F: FnMut(&[u8])> Write for Line<N, F> {
    fn write_str(&mut self, s: &str) -> fmt::Result {
        for &byte in s.as_bytes() {
            if self.len == N {
                self.flush();
            }
            self.buf[self.len] = byte;
            self.len += 1;
        }
        Ok(())
    }
}

/// Formats `kandelo-gl: <args>\n` into `sink`.
fn format_line<const N: usize>(args: fmt::Arguments, sink: impl FnMut(&[u8])) {
    let mut line = Line::<N, _> { buf: [0; N], len: 0, sink };
    // A formatting error can only come from a user `Display` impl; the
    // driver's own arguments never fail, and a diagnostic must not panic.
    let _ = line.write_str("kandelo-gl: ");
    let _ = line.write_fmt(args);
    let _ = line.write_str("\n");
    line.flush();
}

/// A negative errno as a kgpu call returned it, displayed by name
/// (`ENOSPC`) when it is one, else as the number.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Errno(pub i32);

impl fmt::Display for Errno {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match u32::try_from(-i64::from(self.0)).ok().and_then(wasm_posix_shared::Errno::from_u32) {
            Some(name) => write!(f, "{name:?}"),
            None => write!(f, "{}", self.0),
        }
    }
}

/// Writes one `kandelo-gl: <args>` line to standard error.
///
/// It formats on the stack, never allocates, and ignores write failures:
/// it is the path that reports allocation failures and driver defects,
/// so it must not depend on the heap or fail in turn.
///
/// Test builds capture the line for the calling thread instead
/// (`take_diagnostics`), so tests can assert on it and libtest's output
/// stays clean.
pub fn diag(args: fmt::Arguments) {
    #[cfg(test)]
    {
        let mut line = std::vec::Vec::new();
        format_line::<256>(args, |bytes| line.extend_from_slice(bytes));
        let line = std::string::String::from_utf8(line).expect("diagnostics are UTF-8");
        CAPTURED.with(|c| c.borrow_mut().push(line));
    }
    #[cfg(not(test))]
    format_line::<256>(args, |bytes| {
        let mut rest = bytes;
        while !rest.is_empty() {
            let n = unsafe { write(2, rest.as_ptr(), rest.len()) };
            if n <= 0 {
                break;
            }
            rest = &rest[n as usize..];
        }
    });
}

/// A defined entry point received a valid enum the driver does not model
/// yet: it says so on stderr and ends the process with `abort()` (SIGABRT),
/// rather than answering a made-up value (plan scope, "Only implemented
/// entry points are defined"). Test builds panic instead, so a test can
/// expect it.
pub fn not_implemented(function: &str, value: u32) -> ! {
    diag(format_args!("{function} {value:#06x} not implemented"));
    #[cfg(not(test))]
    unsafe {
        abort()
    }
    #[cfg(test)]
    panic!("{function} {value:#06x} not implemented")
}

#[cfg(test)]
std::thread_local! {
    static CAPTURED: core::cell::RefCell<std::vec::Vec<std::string::String>> =
        const { core::cell::RefCell::new(std::vec::Vec::new()) };
}

/// The diagnostic lines this thread wrote since the last call, each with
/// its `kandelo-gl: ` prefix and newline.
#[cfg(test)]
pub(crate) fn take_diagnostics() -> std::vec::Vec<std::string::String> {
    CAPTURED.with(|c| core::mem::take(&mut *c.borrow_mut()))
}

#[cfg(all(target_arch = "wasm32", not(test)))]
#[panic_handler]
fn panic(info: &core::panic::PanicInfo) -> ! {
    use core::sync::atomic::{AtomicBool, Ordering};
    // A panic while reporting a panic must not recurse.
    static PANICKING: AtomicBool = AtomicBool::new(false);
    if !PANICKING.swap(true, Ordering::Relaxed) {
        diag(format_args!("panic: {}", info.message()));
    }
    unsafe { abort() }
}

#[cfg(test)]
mod tests {
    use super::format_line;
    use std::vec::Vec;

    fn collect<const N: usize>(args: core::fmt::Arguments) -> Vec<Vec<u8>> {
        let mut pieces = Vec::new();
        format_line::<N>(args, |bytes| pieces.push(bytes.to_vec()));
        pieces
    }

    #[test]
    fn a_short_line_is_one_write() {
        assert_eq!(collect::<64>(format_args!("glClear {:#x} not implemented", 0x100)),
            [b"kandelo-gl: glClear 0x100 not implemented\n".to_vec()]);
    }

    #[test]
    fn errnos_display_by_name() {
        assert_eq!(super::Errno(-28).to_string(), "ENOSPC");
        assert_eq!(super::Errno(-5).to_string(), "EIO");
        assert_eq!(super::Errno(-4095).to_string(), "-4095");
        assert_eq!(super::Errno(i32::MIN).to_string(), "-2147483648");
    }

    #[test]
    fn a_test_build_captures_diagnostics() {
        super::diag(format_args!("x {}", 1));
        assert_eq!(super::take_diagnostics(), ["kandelo-gl: x 1\n"]);
        assert!(super::take_diagnostics().is_empty());
    }

    #[test]
    fn a_long_line_is_split_but_complete() {
        let pieces = collect::<8>(format_args!("{}", "x".repeat(30)));
        assert!(pieces.iter().all(|p| p.len() <= 8));
        let joined: Vec<u8> = pieces.concat();
        assert_eq!(joined, [b"kandelo-gl: ".as_slice(), &[b'x'; 30], b"\n"].concat());
    }
}
