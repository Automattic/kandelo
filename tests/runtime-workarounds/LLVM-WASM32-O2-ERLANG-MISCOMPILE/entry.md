# LLVM-WASM32-O2-ERLANG-MISCOMPILE

Status: suspected. Not reduced, not filed. This entry registers a claim
made in the Erlang build script; it does not confirm it.

## Defect

The Erlang package build says that LLVM's wasm32 backend, at `-O2`:

- miscompiles aggregate initialization of structs that hold pointers to
  shadow-stack local arrays (OTP's `ESTACK` and `WSTACK` macros in
  `erts/emulator/beam/global.h`);
- miscompiles `erl_unicode.c` (iodata traversal returns garbage),
  `erl_db_util.c` (`db_is_fully_bound` out-of-bounds crash) and
  `erl_db_hash.c` (`match_traverse` corruption).

`docs/package-management.md` ("Optimization-level workarounds") calls it
a Heisenbug: adding an `fprintf` inside the function hides it. The LLVM
version is given there as LLVM 21.

## Why Kandelo is affected

The OTP emulator (BEAM) is built for wasm32 with the SDK's clang. Without
the workaround, Erlang code that walks iodata or uses ETS tables fails.

## Workaround and its cost

`build-erlang.sh` compiles the three translation units at `-O1` through
Makefile rules, and `patches/patch-global-h.py` replaces the aggregate
initialization with explicit field assignments. The cost is slower code in
those units and a patched OTP header. Neither change touches Kandelo
syscall or POSIX behavior.

## Evidence

Only the comments in the build script, the patch script and
`docs/package-management.md`. No reduction, no LLVM bug report, no
bisection and no compiler version beyond "LLVM 21".

## Why this is not a Kandelo defect

Not established. Still unknown:

- whether the fault is in LLVM, or in undefined behavior in OTP that
  `-O2` exposes (a Heisenbug that moves with code layout fits both);
- whether Kandelo's own pipeline is involved: the shadow-stack pointer
  corruption is the kind of failure a wrong stack-pointer convention in
  Kandelo's libc or instrumentation could cause, and the clang `-O2` build
  was not compared with a plain wasm32 build without the fork-instrument
  step;
- whether the three files are one defect or three.

A reduction would compile the smallest struct-initialization pattern from
`ESTACK` with the pinned clang for `wasm32-unknown-unknown` at `-O1` and
`-O2` and compare the stored values by running the module in Node. If it
miscompiles with no Kandelo flags, libc or instrumentation, the entry can
become `confirmed`; if it only fails with them, the fault is Kandelo's.

## Draft upstream report

Not ready. Component: LLVM WebAssembly backend. It will need the smallest
C function, the exact clang version and flags, and the observed and
expected stored values.

## Removal criteria

A released LLVM that the SDK pins builds OTP at `-O2` with the three
Makefile rules and the `global.h` patch removed, and the Erlang test suite
passes. Then delete both and retire the entry.
