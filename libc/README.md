# Libc

Kandelo's C runtime integration lives here.

- `musl/` is the upstream musl submodule.
- `musl-overlay/` contains Kandelo's wasm32/wasm64 musl architecture files,
  source overrides, and headers.
- `glue/` contains the syscall channel glue linked into user programs.

The kernel does not link this code directly. User programs link musl plus glue,
then communicate with the Rust kernel through the channel ABI.
