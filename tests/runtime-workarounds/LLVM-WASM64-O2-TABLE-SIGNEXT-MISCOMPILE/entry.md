# LLVM-WASM64-O2-TABLE-SIGNEXT-MISCOMPILE

Status: suspected. Not reduced, not filed. This entry registers a claim
made in the MariaDB build script; it does not confirm it.

## Defect

The MariaDB build script says that the LLVM 21 wasm64 backend has `-O2`
miscompilation bugs, specifically the sign extension of an `i32` to an
`i64` in table lookups, and that the wasm64 build therefore uses `-O1`
"until the LLVM wasm64 backend matures". `docs/profiling.md` repeats the
claim as "an LLVM 21 wasm64 backend miscompilation in table-lookup
sign-extension".

## Why Kandelo is affected

wasm64 is a supported Kandelo architecture and MariaDB is built for it.

## Workaround and its cost

`MARIADB_OPT_LEVEL` defaults to `-O1` for wasm64 (wasm32 keeps the build
default). The cost is slower wasm64 MariaDB code; it has not been measured.

## Evidence

Only the comment and the profiling doc line. There is no failing input, no
reduction, no clang version more precise than "LLVM 21", and no record of
which MariaDB function misbehaved or how.

## Why this is not a Kandelo defect

Not established. Still unknown: which table and which lookup; whether the
fault is a wrong extension (a sign extension where a zero extension is
needed, or the reverse) in LLVM or a type confusion in MariaDB code on a
64-bit-pointer target (for example `int` used as an index); and whether
`-O2` with the current pinned clang still fails. A reduction would be a C
function indexing a constant table with a 32-bit index, built for wasm64 at
`-O1` and `-O2`, run in Node, comparing results. If only MariaDB shows it,
find the miscomputed source expression first.

## Draft upstream report

Not ready (see above).

## Removal criteria

MariaDB wasm64 built at `-O2` with the pinned clang passes its test run.
Then drop the `-O1` default and the profiling doc sentence, and retire the
entry.
