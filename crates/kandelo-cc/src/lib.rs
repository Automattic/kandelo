//! The Kandelo SDK compiler driver.
//!
//! `wasm32posix-cc` and `wasm32posix-c++` (and their wasm64 forms) turn an
//! ordinary `cc` command into the clang and wasm-ld jobs that build a
//! Kandelo program: Kandelo's target flags, its libc glue compiled the same
//! way for every program, the link layout the kernel expects, the compiler
//! facts fork instrumentation reads, and clang's post-link optimization
//! applied only to modules that do not carry those facts.
//!
//! The same source builds the build machine's driver and the driver inside
//! Kandelo, so a program built inside Kandelo goes through exactly the jobs
//! it would on the build machine. Only toolchain discovery differs
//! (`toolchain`, `plugin`).

pub mod arch;
pub mod driver;
pub mod exec;
pub mod flags;
pub mod node_path;
pub mod plugin;
pub mod toolchain;
pub mod tools;
pub mod wasm;

pub type Result<T> = std::result::Result<T, String>;
