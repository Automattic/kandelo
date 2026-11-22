This is the existing fork instrumenter's in-process C library, built for the
Kandelo guest through the normal Rust SDK. It retains the original side-module
transform and validation. It does not depend on the instrumenter CLI or Binaryen.

The C caller supplies a synchronous private-file factory, normally using the
existing guest `memfd_create` with `MFD_CLOEXEC`. Every file transfers exclusively
to Rust. Results and borrowed output/error strings are released through this
same library; C must never free their Rust allocations. See the installed header
and `docs/fork-instrumentation.md` for ownership and storage contracts.

The current guest Rust target aborts on unexpected Rust panics and OOM. Ordinary
input, file and transform errors return status plus an owned error result.
Unwind-enabled builds catch panics before returning through C; this does not
make guest panics recoverable. Complete FFI failure/lifetime qualification is
still required. This library does not itself generate typed FFI adapters, load
guest modules, or establish working Node FFI or CLI execution.
