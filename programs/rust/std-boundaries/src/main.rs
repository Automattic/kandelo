//! Kandelo Rust guest fixture: std's failure and boundary paths. Each one
//! reads errno or reaches a capability Kandelo does not provide, which
//! the success-path demos never do. Prints one line per check and exits
//! nonzero if any fails; `panic` as the first argument ends in a panic,
//! which aborts (Kandelo's Rust is panic=abort).

use std::backtrace::{Backtrace, BacktraceStatus};
use std::io::{ErrorKind, Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::os::fd::{AsFd, AsRawFd};
use std::process::Command;
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

fn main() {
    if std::env::args().nth(1).as_deref() == Some("panic") {
        panic!("deliberate panic");
    }

    let mut failures = 0;
    let mut check = |ok: bool, what: &str| {
        println!("{} {what}", if ok { "ok" } else { "FAIL" });
        if !ok {
            failures += 1;
        }
    };

    // errno through std::io::Error (ENOENT = 2).
    let err = std::fs::File::open("/no/such/file").unwrap_err();
    check(
        err.kind() == ErrorKind::NotFound && err.raw_os_error() == Some(2),
        "File::open of a missing path is NotFound (ENOENT)",
    );

    // Clones share the open file description, but own separate descriptors.
    let mut file = std::fs::OpenOptions::new()
        .read(true).write(true).create(true).truncate(true)
        .open("/tmp/rust-fd-clone.txt").unwrap();
    file.write_all(b"abcdef").unwrap();
    file.seek(SeekFrom::Start(0)).unwrap();
    let mut clone = file.try_clone().unwrap();
    let mut bytes = [0; 2];
    file.read_exact(&mut bytes).unwrap();
    check(&bytes == b"ab", "original descriptor reads its first bytes");
    clone.read_exact(&mut bytes).unwrap();
    check(&bytes == b"cd", "File::try_clone shares the file offset");
    let owned = clone.as_fd().try_clone_to_owned().unwrap();
    check(owned.as_raw_fd() != clone.as_raw_fd(), "OwnedFd clone has a distinct descriptor");
    // F_GETFD and FD_CLOEXEC are both 1 in Kandelo's public musl ABI.
    unsafe extern "C" { fn fcntl(fd: i32, command: i32, ...) -> i32; }
    check(unsafe { fcntl(owned.as_raw_fd(), 1) } & 1 == 1, "OwnedFd clone is close-on-exec");
    drop(file);
    let mut owned_file = std::fs::File::from(owned);
    owned_file.read_exact(&mut bytes).unwrap();
    check(&bytes == b"ef", "closing the original keeps cloned descriptors usable");

    // Independently opened files have separate open file descriptions and
    // contend for locks even within one process. Clones share their lock.
    let lock_path = "/tmp/rust-file-lock.txt";
    let first = std::fs::OpenOptions::new()
        .read(true).write(true).create(true).truncate(true)
        .open(lock_path).unwrap();
    let second = std::fs::OpenOptions::new()
        .read(true).write(true).open(lock_path).unwrap();
    first.lock().unwrap();
    check(matches!(second.try_lock(), Err(std::fs::TryLockError::WouldBlock)),
        "exclusive lock blocks an independent exclusive lock");
    check(matches!(second.try_lock_shared(), Err(std::fs::TryLockError::WouldBlock)),
        "exclusive lock blocks an independent shared lock");
    let clone = first.try_clone().unwrap();
    clone.unlock().unwrap();
    second.try_lock().unwrap();
    second.unlock().unwrap();
    check(true, "a cloned descriptor can release its shared open-file-description lock");
    first.lock_shared().unwrap();
    second.try_lock_shared().unwrap();
    let third = std::fs::OpenOptions::new()
        .read(true).write(true).open(lock_path).unwrap();
    check(matches!(third.try_lock(), Err(std::fs::TryLockError::WouldBlock)),
        "shared locks coexist and block an independent exclusive lock");
    first.unlock().unwrap();
    check(matches!(third.try_lock(), Err(std::fs::TryLockError::WouldBlock)),
        "releasing one shared lock leaves the other held");
    drop(second);
    third.try_lock().unwrap();
    third.unlock().unwrap();
    check(true, "closing the final shared lock permits exclusive reacquisition");

    // A port nothing listens on: bind one, then close it.
    let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let refused = TcpStream::connect(("127.0.0.1", port)).unwrap_err();
    check(refused.kind() == ErrorKind::ConnectionRefused, "connect to a closed port is ConnectionRefused");

    let spawn = Command::new("/no/such/program").status().unwrap_err();
    check(spawn.kind() == ErrorKind::NotFound, "spawning a missing program is NotFound");

    // Rust's timed parking uses an absolute futex deadline. Treating that
    // deadline as a relative duration stalls here until the runner watchdog.
    let timeout = Duration::from_millis(20);
    let deadline = Instant::now() + timeout;
    while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
        std::thread::park_timeout(remaining);
    }
    check(Instant::now() >= deadline, "thread::park_timeout reaches its deadline");

    let mutex = Mutex::new(false);
    let condvar = Condvar::new();
    let started = Instant::now();
    let (_guard, result) = condvar
        .wait_timeout_while(mutex.lock().unwrap(), timeout, |ready| !*ready)
        .unwrap();
    check(
        result.timed_out() && started.elapsed() >= timeout,
        "Condvar::wait_timeout_while expires without a notification",
    );

    // Kandelo has no unwinder to walk the stack with.
    check(
        Backtrace::force_capture().status() == BacktraceStatus::Unsupported,
        "Backtrace is Unsupported",
    );

    println!("{}", if failures == 0 { "STD BOUNDARIES OK" } else { "STD BOUNDARIES FAILED" });
    std::process::exit(if failures == 0 { 0 } else { 1 });
}
