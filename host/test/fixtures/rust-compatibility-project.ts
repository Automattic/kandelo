// Real offline workloads for guest native linking and Rust compatibility.
export const nativeCSource = `#include <signal.h>
#include <errno.h>
int c_answer(void) { return 42; }
int process_is_absent(int pid) { return kill(pid, 0) == -1 && errno == ESRCH; }
`;

export const rustCompatibilityFiles: Record<string, string> = {
  "compatibility/Cargo.toml": `[workspace]
members=["native-probe"]
resolver="3"
[profile.dev]
debug=0
codegen-units=1
incremental=false
`,
  "compatibility/native-probe/Cargo.toml": `[package]
name="native-probe"
version="0.1.0"
edition="2024"
`,
  "compatibility/native-probe/build.rs": `use std::{env,fs,path::PathBuf,process::Command};
fn checked(program:&str,args:&[&str]) {
 let status=Command::new(program).args(args).status().expect(program);
 assert!(status.success(),"{program}: {status}");
}
fn main() {
 let out=PathBuf::from(env::var_os("OUT_DIR").unwrap());
 let c=out.join("c.o"); let cpp=out.join("cpp.o"); let archive=out.join("libnative_probe.a");
 checked("wasm32posix-cc",&["-O1","-c","native.c","-o",c.to_str().unwrap()]);
 checked("wasm32posix-c++",&["-O1","-fwasm-exceptions","-c","native.cpp","-o",cpp.to_str().unwrap()]);
 checked("wasm32posix-ar",&["rcs",archive.to_str().unwrap(),c.to_str().unwrap(),cpp.to_str().unwrap()]);
 fs::write(out.join("generated.rs"),"pub const GENERATED: u32 = 17;\\n").unwrap();
 println!("cargo:rustc-link-search=native={}",out.display());
 println!("cargo:rustc-link-lib=static=native_probe");
 // The SDK linker supplies its system runtime. Bundle our own native
 // archive into the Rust library; link libc++ once at the final executable.
 println!("cargo:rustc-link-lib=c++");
 println!("cargo:rustc-link-lib=c++abi");
 println!("cargo:rerun-if-changed=native.c");
 println!("cargo:rerun-if-changed=native.cpp");
}
`,
  "compatibility/native-probe/native.c": nativeCSource,
  "compatibility/native-probe/native.cpp": `#include <vector>
static std::vector<int> values{3,4};
extern "C" int cpp_answer() { return values[0]+values[1]; }
`,
  "compatibility/native-probe/src/lib.rs": `/// Executes the archive built by build.rs.
///
/// \`\`\`
/// assert_eq!(native_probe::native_answers(), (42, 7));
/// std::fs::write("/tmp/rust-doctest-executed", b"native doctest ran").unwrap();
/// \`\`\`
///
/// \`\`\`compile_fail,E0308
/// let _: u32 = "intentional type error";
/// \`\`\`
///
/// \`\`\`no_run
/// std::fs::write("/tmp/rust-doctest-no-run", b"must not execute").unwrap();
/// panic!("no_run executed");
/// \`\`\`
///
/// \`\`\`ignore
/// this intentionally does not compile
/// \`\`\`
///
/// \`\`\`should_panic
/// panic!("expected doctest panic");
/// \`\`\`
pub fn documented_native_answers()->(i32,i32) { native_answers() }
include!(concat!(env!("OUT_DIR"),"/generated.rs"));
unsafe extern "C" { fn c_answer()->i32; fn cpp_answer()->i32; pub fn process_is_absent(pid:i32)->i32; }
pub fn native_answers()->(i32,i32) { unsafe { (c_answer(),cpp_answer()) } }
#[cfg(test)] mod tests {
 #[test] fn native_code_and_generated_source() { assert_eq!(super::native_answers(),(42,7)); assert_eq!(super::GENERATED,17); }
 #[test] #[should_panic(expected="expected sentinel")] fn expected_panic() { panic!("expected sentinel"); }
 #[test] fn synchronization() {
  use std::sync::{Arc,Barrier,Condvar,Mutex,mpsc};
  let start=Arc::new(Barrier::new(3));
  let state=Arc::new((Mutex::new(false),Condvar::new()));
  let (tx,rx)=mpsc::channel(); let mut threads=Vec::new();
  for value in [20,22] {
   let start=start.clone(); let state=state.clone(); let tx=tx.clone();
   threads.push(std::thread::spawn(move|| {
    start.wait(); let (lock,ready)=&*state;
    let mut released=lock.lock().unwrap();
    while !*released { released=ready.wait(released).unwrap(); }
    tx.send(value).unwrap();
   }));
  }
  start.wait(); { *state.0.lock().unwrap()=true; state.1.notify_all(); }
  drop(tx); assert_eq!(rx.iter().sum::<i32>(),42);
  for thread in threads { thread.join().unwrap(); }
 }
}
`,
  "compatibility/native-probe/src/main.rs": `use std::io::{Read,Write};
fn main() {
 match std::env::args().nth(1).as_deref() {
  Some("--child")=>{
   assert_eq!(std::env::current_dir().unwrap(),std::path::PathBuf::from("/tmp"));
   assert!(std::env::var_os("HOME").is_none());
   let mut input=String::new(); std::io::stdin().read_to_string(&mut input).unwrap();
   println!("child={} input={input}",std::env::var("PROBE_ENV").unwrap());
   writeln!(std::io::stderr(),"child stderr").unwrap(); std::process::exit(23);
  },
  Some("--panic")=>{
   struct Dropped;
   impl Drop for Dropped { fn drop(&mut self) { println!("panic destructor ran"); } }
   let _guard=Dropped;
   let _=std::panic::catch_unwind(|| panic!("subprocess panic sentinel"));
   println!("panic recovered");
  },
  Some("--check-pids")=>{ for pid in std::env::args().skip(2) { assert_eq!(unsafe { native_probe::process_is_absent(pid.parse().unwrap()) },1,"process {pid} survived timeout"); } println!("timed-out family reaped"); },
  Some("--wait-parent")=>{
   println!("timeout parent={}",std::process::id()); std::io::stdout().flush().unwrap();
   let mut child=std::process::Command::new(std::env::current_exe().unwrap()).arg("--wait").spawn().unwrap();
   let _=child.wait(); panic!("timeout child exited before cancellation");
  },
  Some("--wait")=>{ println!("timeout child={}",std::process::id()); std::io::stdout().flush().unwrap(); loop { std::thread::sleep(std::time::Duration::from_millis(100)); } },
  _=>{ let (c,cpp)=native_probe::native_answers(); println!("C/C++={c}/{cpp}; generated={}",native_probe::GENERATED); }
 }
}
`,
  "compatibility/native-probe/tests/process.rs": `use std::process::{Command,Stdio};
#[test] fn subprocess_streams_environment_and_exit() {
 use std::io::Write;
 let mut child=Command::new(env!("CARGO_BIN_EXE_native-probe")).arg("--child").env_clear().env("PROBE_ENV","present").current_dir("/tmp")
  .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
 child.stdin.take().unwrap().write_all(b"payload").unwrap();
 let result=child.wait_with_output().unwrap(); assert_eq!(result.status.code(),Some(23));
 assert_eq!(String::from_utf8(result.stdout).unwrap(),"child=present input=payload\\n");
 assert_eq!(String::from_utf8(result.stderr).unwrap(),"child stderr\\n");
}
#[test] fn panic_aborts_only_the_child() {
 use std::os::unix::process::ExitStatusExt;
 let result=Command::new(env!("CARGO_BIN_EXE_native-probe")).arg("--panic").output().unwrap();
 assert_eq!(result.status.signal(),Some(6));
 assert!(String::from_utf8(result.stderr).unwrap().contains("subprocess panic sentinel"));
 assert!(result.stdout.is_empty(),"abort must not unwind or recover: {:?}",result.stdout);
}
`,
  "compatibility/macro/Cargo.toml": `[workspace]
members=["expander","consumer"]
resolver="3"
[profile.dev]
debug=0
codegen-units=1
incremental=false
`,
  "compatibility/macro/expander/Cargo.toml": `[package]
name="expander"
version="0.1.0"
edition="2024"
[lib]
proc-macro=true
`,
  "compatibility/macro/expander/src/lib.rs": `extern crate proc_macro;
#[proc_macro] pub fn answer(_:proc_macro::TokenStream)->proc_macro::TokenStream { "42u32".parse().unwrap() }
`,
  "compatibility/macro/consumer/Cargo.toml": `[package]
name="macro-consumer"
version="0.1.0"
edition="2024"
[dependencies]
expander={path="../expander"}
`,
  "compatibility/macro/consumer/src/main.rs": `fn main() { assert_eq!(expander::answer!(),42); println!("real macro expansion=42"); }\n`,
};
