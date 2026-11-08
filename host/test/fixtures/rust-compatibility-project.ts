// Real offline workloads for guest native linking and Rust compatibility.
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
  "compatibility/native-probe/native.c": `int c_answer(void) { return 42; }\n`,
  "compatibility/native-probe/native.cpp": `#include <vector>
static std::vector<int> values{3,4};
extern "C" int cpp_answer() { return values[0]+values[1]; }
`,
  "compatibility/native-probe/src/lib.rs": `include!(concat!(env!("OUT_DIR"),"/generated.rs"));
unsafe extern "C" { fn c_answer()->i32; fn cpp_answer()->i32; }
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
   let mut input=String::new(); std::io::stdin().read_to_string(&mut input).unwrap();
   println!("child={} input={input}",std::env::var("PROBE_ENV").unwrap());
   writeln!(std::io::stderr(),"child stderr").unwrap(); std::process::exit(23);
  },
  Some("--panic")=>panic!("subprocess panic sentinel"),
  Some("--wait")=>{ println!("timeout probe started"); std::io::stdout().flush().unwrap(); loop { std::thread::sleep(std::time::Duration::from_millis(100)); } },
  _=>{ let (c,cpp)=native_probe::native_answers(); println!("C/C++={c}/{cpp}; generated={}",native_probe::GENERATED); }
 }
}
`,
  "compatibility/native-probe/tests/process.rs": `use std::process::{Command,Stdio};
#[test] fn subprocess_streams_environment_and_exit() {
 use std::io::Write;
 let mut child=Command::new(env!("CARGO_BIN_EXE_native-probe")).arg("--child").env("PROBE_ENV","present")
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
