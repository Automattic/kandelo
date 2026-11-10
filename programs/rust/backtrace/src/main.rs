use std::backtrace::{Backtrace, BacktraceStatus};

#[inline(never)]
fn user_inner() -> Backtrace {
    Backtrace::force_capture()
}

#[inline(never)]
fn user_outer() -> Backtrace {
    user_inner()
}

#[inline(never)]
fn user_panic() {
    panic!("backtrace panic fixture");
}

fn main() {
    match std::env::args().nth(1).as_deref() {
        Some("panic") => user_panic(),
        Some("thread") => {
            let trace = std::thread::spawn(user_outer).join().unwrap();
            assert_eq!(trace.status(), BacktraceStatus::Captured);
            // The creating thread and its worker have exited before lookup.
            println!("THREAD_BACKTRACE\n{trace}");
        }
        Some("subprocess") => {
            let result = std::process::Command::new(std::env::args().next().unwrap())
                .arg("capture")
                .env("RUST_BACKTRACE", "0")
                .output()
                .expect("launch backtrace child");
            assert!(result.status.success(), "{:?}", result);
            assert!(result.stderr.is_empty(), "{:?}", result);
            println!("SUBPROCESS_BACKTRACE\n{}", String::from_utf8(result.stdout).unwrap());
        }
        _ => {
            assert_eq!(Backtrace::capture().status(), BacktraceStatus::Disabled);
            let saved = user_outer();
            assert_eq!(saved.status(), BacktraceStatus::Captured);
            let resolved = user_outer();
            let before = resolved.to_string();
            let later = user_inner();
            assert_eq!(later.status(), BacktraceStatus::Captured);
            let thread_trace = std::thread::spawn(user_inner).join().unwrap();
            assert_eq!(thread_trace.status(), BacktraceStatus::Captured);
            assert_eq!(resolved.to_string(), before, "a later capture changed saved frames");
            // Resolve this capture for the first time after both later
            // captures and the creating worker of thread_trace have exited.
            println!("CAPTURED_BACKTRACE\n{saved}\nDEBUG_BACKTRACE={saved:?}");
        }
    }
}
