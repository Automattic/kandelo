# WASM-LD-LAZY-SIGNATURE-MISMATCH

Status: confirmed.

## Defect

A WebAssembly link can see a function's lazy definition (an archive member,
or an object between `--start-lib` and `--end-lib`) before an object that
references the function with a different signature, such as an
unprototyped C call. In that order, wasm-ld extracts the definition without
its signature check. It gives no "function signature mismatch" warning and
emits a direct call with the caller's arguments. The module is invalid
("not enough arguments on the stack for call"). In the other order, or with
a plain object, wasm-ld warns and calls a trapping stub, which is valid.
Input order should not decide whether the output is a valid module.

## Why Kandelo is affected

The SDK driver (`crates/kandelo-cc`) links the dlopen loader
(`libc/glue/dlopen.c`) as a lazy member. Autoconf's function checks declare
the function as `char dlopen (void);` and call it, which is that kind of
mismatched reference. With the loader ahead of the caller's inputs, every
such check linked an invalid module. At `-O2` the driver's wasm-opt then
failed to parse it ("popping from empty stack"), so configure decided dlopen
was missing. Vim built that way on LLVM 23 lost `dlopen()` and `dlsym()`.

## Workaround and its cost

The driver does not put the loader first. `loader_position` in
`crates/kandelo-cc/src/driver.rs` places it just before a libc the caller
names itself (`-lc`, `-l c`, `-l:libc.a` or a `libc.a` path), which would
otherwise offer musl's static stubs first. Otherwise it goes after the
caller's inputs, where `libc.a` is. A mismatched reference that the caller
puts after its own `-lc` still meets the defect, as it does with musl's
`libc.a` without the loader. Supporting that case would need the loader
first, and that waits for a fixed wasm-ld.

## Evidence

- `repro/run.sh` with LLD 23.1.3 (nixpkgs-unstable, macOS):
  - the object, archive-after and `--start-lib`-after links are valid;
  - the `--start-lib`-first and archive-first links are invalid.
- Vim's `dlopen()` check, an unprototyped call, under the SDK driver with
  the loader first: the link at `-O0` was invalid, and at `-O2` wasm-opt 133
  refused the module. With `loader_position`, both link, and wasm-ld reports
  the mismatch.
- The SDK test `host/test/sdk-plugin-modules.test.ts` ("an Autoconf-style
  dlopen probe links to a valid module") checks the `char dlopen (void);`
  probe with no `-ldl`, with `-ldl` and with `-lc`.
- Not checked: wasm-ld before 23.1.3.

## Why this is not a Kandelo defect

The reproduction uses only clang, wasm-ld, llvm-ar and Node's
`WebAssembly.Module` on two four-line C files. No Kandelo code, SDK or
sysroot is involved.

## Draft upstream report

Not filed.

- **Title**: [lld][WebAssembly] Lazy definition before a mismatched
  reference yields an invalid call instead of a signature-mismatch stub
- **Product**: LLVM, component lld (wasm).
- **Summary**: when an archive member or `--start-lib` object defining
  `int foo(int, int)` appears on the command line before an object that
  calls `foo()` unprototyped, wasm-ld emits a direct call with no
  arguments. There is no warning, and the module fails validation. With
  the definition after the reference, wasm-ld warns "function signature
  mismatch" and links its trapping stub.
- **Steps**: run `repro/run.sh` (it builds `foo.c` and `main.c`, then links
  five orderings).
- **Expected**: every ordering warns and produces a valid module.
- **Actual**: `--start-lib foo.o --end-lib main.o` and `libfoo.a main.o`
  produce invalid modules, with no warning.
- **Versions**: LLD 23.1.3.

## Removal criteria

When a released wasm-ld that Kandelo pins makes `repro/run.sh` print
`not-reproduced`, the driver can place the loader ahead of all caller
inputs. Then remove `loader_position`'s libc detection and its tag, and
update `the_dlopen_loader_precedes_a_libc_the_caller_names` in
`crates/kandelo-cc/tests/driver.rs`.
