# LLVM-WASM32-ASMPRINTER-EMITGLOBALVARIABLE-CRASH

Status: suspected. Not reduced, not filed. This entry registers a claim
made in the Redis build script; it does not confirm it.

## Defect

The Redis build script says that compiling the full `src/tls.c` for wasm32
crashes the LLVM backend in `AsmPrinter::emitGlobalVariable`.
`docs/package-management.md` adds "at `-O1` and above, LLVM 21.1.8" and
that the file compiles at `-O0`. A compiler crash on any input is a defect
in the compiler by definition; what is unknown is the input and the
conditions.

## Why Kandelo is affected

Redis is a packaged program and its build compiles `tls.c`.

## Workaround and its cost

The build replaces `tls.c` with a stub that reports the TLS connection type
as not built in. The build also sets `BUILD_TLS=no`, so the stub matches the
configured feature set; the cost today is that TLS cannot be turned on.
Enabling it would need a per-file `-O0` rule.

## Evidence

Only the comment and the package doc. The crash output, the LLVM
assertion and the reduced input were not kept.

## Why this is not a Kandelo defect

Not established. Still unknown: whether the crash still happens with the
pinned clang; whether it depends on a Kandelo flag or on the sysroot's
OpenSSL headers; and whether the stub is needed at all, since with
`BUILD_TLS=no` upstream `tls.c` may reduce to a few lines that compile fine
(the crash would then have come from a different configuration). A reduction
is the smallest `.c` file that reproduces the crash under
`clang --target=wasm32-unknown-unknown -O1`; `-O0` is the control. Use
`clang -c` with `-emit-llvm` to separate the front end from the backend, and
use `llvm-reduce` or `creduce` on the preprocessed file.

## Draft upstream report

Not ready. Component: LLVM WebAssembly backend / CodeGen AsmPrinter.
Compiler crashes are reported with the preprocessed source and the crash
log.

## Removal criteria

Redis `tls.c` compiles unmodified at the build's optimization level with the
pinned clang. Then delete the stub step and retire the entry.
