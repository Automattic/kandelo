//! Kandelo Rust guest fixture: fd duplication through std.
//! `OwnedFd::try_clone` (fcntl F_DUPFD_CLOEXEC) must share the file
//! description, and `StdioExt::take_fd`/`set_fd` (dup2) must redirect
//! stdout. tokio's mio registry needs the first; both were `Unsupported`
//! on every wasm32 target.
#![feature(stdio_swap)]

use std::fs::File;
use std::io::{Read, Seek, Write};
use std::os::fd::OwnedFd;
use std::os::unix::io::StdioExt;

fn main() {
    let path = "/tmp/kandelo-fd-demo";
    let original: OwnedFd = File::create(path).unwrap().into();
    let clone = original.try_clone().expect("OwnedFd::try_clone");
    File::from(original).write_all(b"foo").unwrap();
    assert_eq!(File::from(clone).stream_position().unwrap(), 3, "clone does not share the offset");
    println!("OwnedFd::try_clone shares the file description");

    let saved = std::io::stdout().take_fd().expect("StdioExt::take_fd");
    println!("baz");
    std::io::stdout().set_fd(File::create(path).unwrap()).expect("StdioExt::set_fd");
    println!("qux");
    std::io::stdout().set_fd(saved).expect("restore stdout");

    let mut text = String::new();
    File::open(path).unwrap().read_to_string(&mut text).unwrap();
    assert_eq!(text, "qux\n", "stdout was not redirected");
    std::fs::remove_file(path).unwrap();
    println!("std fd duplication OK");
}
