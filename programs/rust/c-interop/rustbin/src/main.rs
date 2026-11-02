//! Rust program linked against a C static library (../clib). Prints one
//! line per check and exits nonzero if any check fails.

use std::ffi::{c_char, c_int, c_void, CStr, CString};

/// Mirrors `struct record` in clib/cside.c.
#[repr(C)]
#[derive(Default)]
struct Record {
    tag: u8,
    big: u64,
    small: u16,
    ratio: f64,
}

extern "C" {
    fn c_record_size() -> usize;
    fn c_libc_type_size(id: u32) -> usize;
    fn c_libc_type_align(id: u32) -> usize;
    fn c_sigaction_flags_offset() -> usize;
    fn c_raise_signal(signal_number: c_int) -> c_int;
    fn c_record_fill(r: *mut Record);
    fn c_u128_muldiv(a: u64, b: u64, d: u64) -> u64;
    fn c_sort_ints(
        v: *mut c_int,
        n: usize,
        cmp: extern "C" fn(*const c_void, *const c_void) -> c_int,
    );
    fn c_describe(n: c_int) -> *mut c_char;
    fn c_set_errno(e: c_int);
    fn c_getenv(key: *const c_char) -> *const c_char;
    fn free(p: *mut c_void);
}

extern "C" fn descending(a: *const c_void, b: *const c_void) -> c_int {
    let (a, b) = unsafe { (*(a as *const c_int), *(b as *const c_int)) };
    b.cmp(&a) as c_int
}

static SIGNAL_SEEN: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
extern "C" fn siginfo_handler(number: c_int, info: *mut libc::siginfo_t, _context: *mut c_void) {
    if !info.is_null() && unsafe { (*info).si_signo } == number {
        SIGNAL_SEEN.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }
}

fn main() {
    let mut failures = 0;
    let mut check = |ok: bool, what: &str| {
        println!("{} {what}", if ok { "ok" } else { "FAIL" });
        if !ok {
            failures += 1;
        }
    };

    let libc_layouts = [
        (
            "sigset_t",
            std::mem::size_of::<libc::sigset_t>(),
            std::mem::align_of::<libc::sigset_t>(),
        ),
        (
            "sigaction",
            std::mem::size_of::<libc::sigaction>(),
            std::mem::align_of::<libc::sigaction>(),
        ),
        (
            "siginfo_t",
            std::mem::size_of::<libc::siginfo_t>(),
            std::mem::align_of::<libc::siginfo_t>(),
        ),
        (
            "stack_t",
            std::mem::size_of::<libc::stack_t>(),
            std::mem::align_of::<libc::stack_t>(),
        ),
        (
            "pthread_attr_t",
            std::mem::size_of::<libc::pthread_attr_t>(),
            std::mem::align_of::<libc::pthread_attr_t>(),
        ),
        (
            "pthread_mutex_t",
            std::mem::size_of::<libc::pthread_mutex_t>(),
            std::mem::align_of::<libc::pthread_mutex_t>(),
        ),
        (
            "pthread_cond_t",
            std::mem::size_of::<libc::pthread_cond_t>(),
            std::mem::align_of::<libc::pthread_cond_t>(),
        ),
        (
            "pthread_rwlock_t",
            std::mem::size_of::<libc::pthread_rwlock_t>(),
            std::mem::align_of::<libc::pthread_rwlock_t>(),
        ),
        (
            "pthread_barrier_t",
            std::mem::size_of::<libc::pthread_barrier_t>(),
            std::mem::align_of::<libc::pthread_barrier_t>(),
        ),
        (
            "sem_t",
            std::mem::size_of::<libc::sem_t>(),
            std::mem::align_of::<libc::sem_t>(),
        ),
        (
            "timespec",
            std::mem::size_of::<libc::timespec>(),
            std::mem::align_of::<libc::timespec>(),
        ),
        (
            "timeval",
            std::mem::size_of::<libc::timeval>(),
            std::mem::align_of::<libc::timeval>(),
        ),
        (
            "pollfd",
            std::mem::size_of::<libc::pollfd>(),
            std::mem::align_of::<libc::pollfd>(),
        ),
        (
            "iovec",
            std::mem::size_of::<libc::iovec>(),
            std::mem::align_of::<libc::iovec>(),
        ),
        (
            "msghdr",
            std::mem::size_of::<libc::msghdr>(),
            std::mem::align_of::<libc::msghdr>(),
        ),
        (
            "cmsghdr",
            std::mem::size_of::<libc::cmsghdr>(),
            std::mem::align_of::<libc::cmsghdr>(),
        ),
        (
            "stat",
            std::mem::size_of::<libc::stat>(),
            std::mem::align_of::<libc::stat>(),
        ),
        (
            "statfs",
            std::mem::size_of::<libc::statfs>(),
            std::mem::align_of::<libc::statfs>(),
        ),
        (
            "sysinfo",
            std::mem::size_of::<libc::sysinfo>(),
            std::mem::align_of::<libc::sysinfo>(),
        ),
        (
            "fd_set",
            std::mem::size_of::<libc::fd_set>(),
            std::mem::align_of::<libc::fd_set>(),
        ),
        (
            "cpu_set_t",
            std::mem::size_of::<libc::cpu_set_t>(),
            std::mem::align_of::<libc::cpu_set_t>(),
        ),
        (
            "utsname",
            std::mem::size_of::<libc::utsname>(),
            std::mem::align_of::<libc::utsname>(),
        ),
        (
            "passwd",
            std::mem::size_of::<libc::passwd>(),
            std::mem::align_of::<libc::passwd>(),
        ),
        (
            "tm",
            std::mem::size_of::<libc::tm>(),
            std::mem::align_of::<libc::tm>(),
        ),
        (
            "sockaddr_in",
            std::mem::size_of::<libc::sockaddr_in>(),
            std::mem::align_of::<libc::sockaddr_in>(),
        ),
        (
            "sockaddr_un",
            std::mem::size_of::<libc::sockaddr_un>(),
            std::mem::align_of::<libc::sockaddr_un>(),
        ),
        (
            "epoll_event",
            std::mem::size_of::<libc::epoll_event>(),
            std::mem::align_of::<libc::epoll_event>(),
        ),
        (
            "termios",
            std::mem::size_of::<libc::termios>(),
            std::mem::align_of::<libc::termios>(),
        ),
        (
            "winsize",
            std::mem::size_of::<libc::winsize>(),
            std::mem::align_of::<libc::winsize>(),
        ),
    ];
    for (id, (name, size, align)) in libc_layouts.into_iter().enumerate() {
        let c_size = unsafe { c_libc_type_size(id as u32) };
        let c_align = unsafe { c_libc_type_align(id as u32) };
        check(
            size == c_size && align == c_align,
            &format!("libc {name}: Rust {size}/{align}, C {c_size}/{c_align}"),
        );
    }
    check(
        std::mem::offset_of!(libc::sigaction, sa_flags) == unsafe { c_sigaction_flags_offset() },
        "libc sigaction flags offset matches C",
    );
    let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
    action.sa_sigaction = siginfo_handler as *const () as usize;
    action.sa_flags = libc::SA_SIGINFO;
    unsafe {
        assert_eq!(libc::sigemptyset(&mut action.sa_mask), 0);
        assert_eq!(
            libc::sigaction(libc::SIGUSR1, &action, std::ptr::null_mut()),
            0
        );
        assert_eq!(c_raise_signal(libc::SIGUSR1), 0);
    }
    check(
        SIGNAL_SEEN.load(std::sync::atomic::Ordering::SeqCst) == 1,
        "C raise dispatches the Rust three-argument signal handler",
    );

    let mut r = Record::default();
    unsafe { c_record_fill(&mut r) };
    check(
        unsafe { c_record_size() } == std::mem::size_of::<Record>()
            && r.tag == 7
            && r.big == 0x0123_4567_89ab_cdef
            && r.small == 0xbeef
            && r.ratio == 0.25,
        "repr(C) struct layout",
    );

    // compiler-rt (C) and compiler_builtins (Rust) both define these.
    let from_rust = (u64::MAX as u128 * 3 / 5) as u64;
    check(
        unsafe { c_u128_muldiv(u64::MAX, 3, 5) } == from_rust,
        "u128 muldiv matches Rust",
    );

    let mut v = [3, 9, 1, 7];
    unsafe { c_sort_ints(v.as_mut_ptr(), v.len(), descending) };
    check(v == [9, 7, 3, 1], "Rust callback called from C qsort");

    let s = unsafe { c_describe(42) };
    check(
        unsafe { CStr::from_ptr(s) }.to_str() == Ok("C says 42"),
        "C-owned string",
    );
    unsafe { free(s.cast()) };

    unsafe { c_set_errno(2) };
    check(
        std::io::Error::last_os_error().raw_os_error() == Some(2),
        "shared errno",
    );

    unsafe { std::env::set_var("INTEROP_FROM_RUST", "yes") };
    let key = CString::new("INTEROP_FROM_RUST").unwrap();
    let v = unsafe { c_getenv(key.as_ptr()) };
    check(
        !v.is_null() && unsafe { CStr::from_ptr(v) }.to_bytes() == b"yes",
        "shared environment",
    );

    println!(
        "{}",
        if failures == 0 {
            "RUST-CALLS-C OK"
        } else {
            "RUST-CALLS-C FAILED"
        }
    );
    std::process::exit(if failures == 0 { 0 } else { 1 });
}
