//! Kandelo Rust guest fixture: std's failure and boundary paths. Each one
//! reads errno or reaches a capability Kandelo does not provide, which
//! the success-path demos never do. Prints one line per check and exits
//! nonzero if any fails; `panic` as the first argument ends in a panic,
//! which aborts (Kandelo's Rust is panic=abort).

use std::backtrace::{Backtrace, BacktraceStatus};
use std::fs::OpenOptions;
use std::io::{Read, Seek, SeekFrom, Write};
use std::io::ErrorKind;
use std::net::{TcpListener, TcpStream};
use std::os::fd::{AsFd, OwnedFd};
use std::os::unix::fs::FileExt;
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

    let path = format!("/tmp/rust-descriptor-{}", std::process::id());
    let mut source = OpenOptions::new().read(true).write(true).create_new(true).open(&path).unwrap();
    std::fs::remove_file(path).unwrap();
    source.write_all(b"original bytes").unwrap();
    source.seek(SeekFrom::Start(3)).unwrap();
    let owned: OwnedFd = source.as_fd().try_clone_to_owned().unwrap();
    let mut duplicate = std::fs::File::from(owned);
    let mut prefix = [0; 4];
    duplicate.read_exact_at(&mut prefix, 0).unwrap();
    duplicate.write_all_at(b"new", 0).unwrap();
    check(prefix == *b"orig" && source.stream_position().unwrap() == 3
        && duplicate.stream_position().unwrap() == 3, "positioned IO preserves shared descriptor offsets");
    duplicate.read_exact(&mut prefix).unwrap();
    check(source.stream_position().unwrap() == 7, "ordinary IO shares the duplicated descriptor offset");
    drop(source);
    let mut clone = duplicate.try_clone().unwrap();
    drop(duplicate);
    clone.read_exact_at(&mut prefix, 0).unwrap();
    check(prefix == *b"newg", "owned descriptor clones retain independent lifetimes");

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
