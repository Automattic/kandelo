# Shared-library executables: design spike

Status: design spike, 2026-11-15. This document reports findings and a
recommendation. It does not change current behavior; the prototype code
lives on the unmerged branch
[`brandonpayton/shared-lib-exec-spike`](https://github.com/Automattic/kandelo/tree/brandonpayton/shared-lib-exec-spike)
(commit `4accdf30c`, based on `develop` at `768475048`).

## Question

Kandelo executables cannot be linked against shared libraries. `wasm-ld`
stops with "attempted static link of dynamic object", and `cc -shared`
builds side modules that only `dlopen()` can load. The SDK works around
this in each build system: the shipped Libtool reports no dynamic linker
(`packages/registry/libtool/patches/0002-kandelo-no-dynamic-linker.patch`),
CMake's `Platform/Kandelo` sets `TARGET_SUPPORTS_SHARED_LIBS` false
(`packages/registry/cmake/patches/0001-kandelo-platform.patch`), and the
Meson cross files set `default_library = 'static'`
(`sdk/meson/wasm32posix.ini`). Projects that require shared libraries,
build plugins against a host program's libraries, or use `LD_PRELOAD`
cannot build or run the way upstream intends.

The spike asks what it would take for an executable to declare needed
libraries that are loaded at startup, and whether that is worth doing.

## POSIX boundary

POSIX specifies `dlopen`, `dlsym`, `dlclose` and `dlerror`. Kandelo
implements them for side modules. POSIX does not specify linking an
executable against shared libraries, `DT_NEEDED`, sonames, run paths,
`LD_LIBRARY_PATH` or `LD_PRELOAD`. Those are toolchain and ELF/ld.so
conventions shared by Linux, the BSDs and Solaris. They matter here
because they decide whether ordinary Unix software ports with its default
build. Any work below that adopts one of these conventions needs the
maintainer's approval under the POSIX-first scope rule; the open
questions at the end list each one.

## Findings in brief

1. The existing loader already does most of the work. It resolves a side
   module's `dylink.0` needed list, applies relocations, keeps GOT cells,
   stages initialization so constructors run as ordinary Wasm-to-Wasm
   calls, and replays everything into fork children and pthread Workers.
2. `wasm-ld` 21 (the SDK's LLD) can link a **non-relocatable** executable
   against `.so` inputs with `--experimental-pic -Bdynamic`. The output
   keeps Kandelo's fixed layout (no `__memory_base` import), imports the
   libraries' functions (`env.<fn>`) and data (`GOT.mem.<sym>`,
   `GOT.func.<sym>`), and records the libraries in a `dylink.0` section.
   A position-independent main executable is not required.
3. A prototype on that model runs an executable linked with
   `cc main.o -L dir -lfoo` on Node, including library constructors before
   `main`, data shared through GOT, callbacks from the library into the
   executable, `LD_LIBRARY_PATH` and run-path lookup, an ld.so-style
   missing-library error, and `fork()` from the executable.
4. `fork()` from inside a library fails when the executable reaches the
   library through a direct import, and succeeds when it reaches it
   through a function pointer. The fix is a PLT-style lowering of the
   executable's library imports to `call_indirect`, which the fork
   instrumenter already handles.
5. Costs measured on Node (noisy machine, see below): about +8 to +18 ms
   startup for a tiny library, about +120 ms for a 1 MB library, and
   about +2.4 ns per cross-library call. Side modules are compiled once
   per Worker today, not shared through the kernel's module cache, so
   code memory scales with processes and threads.
6. `wasm-ld` does not record sonames, does not export or extract archive
   members for symbols a shared library references, and Wasm shared
   libraries bind their own symbols locally (no interposition). Each needs
   SDK handling or an explicit documented boundary.

## How dlopen works today

**Building a side module.** `cc -shared -fPIC` selects
`shared_link_flags()` in `crates/kandelo-cc/src/flags.rs`:
`-nostdlib --experimental-pic --shared --shared-memory --export-all
--allow-undefined`. The library carries no libc. Its undefined symbols
(including all of libc) become imports resolved against the executable
at load time. The SDK filters `-Wl,-soname,` and `-Wl,-rpath,`
(`IGNORED_PREFIXES` in `flags.rs`), so neither reaches the linker.

**Exporting the executable's symbols.** Executables link with an explicit
export list (`link_flags()`), so side modules see only what the program
exports. Packages that host plugins add `-Wl,--export-all` and force
libc members with `-u` (for example `packages/registry/php/build-php.sh`
and `packages/registry/scummvm/build-scummvm.sh`). `wasm-ld` does not do
this itself (finding 6).

**Loading.** `dlopen()` in `libc/glue/dlopen.c` stats and reads the file
through ordinary syscalls, then drives the staged host imports
`__wasm_dlopen_prepare` and `__wasm_dlopen_next`
(`host/src/worker-main.ts`, `buildDlopenImports`). The host's
`DynamicLinker` (`host/src/dylink.ts`) parses `dylink.0`, compiles the
module with `new WebAssembly.Module`, allocates its data with an
anonymous `mmap` in the process's own linear memory, grows the process
function table, resolves imports against the global symbol table (main
exports plus `RTLD_GLOBAL` libraries), and fills GOT cells. Each
`__wasm_dlopen_next` call returns one bootstrap, relocation or
constructor entry that libc calls after the import has returned, so no
host import calls back into Wasm.

**Dependencies.** A side module's `dylink.0` needed entries are loaded
first, through `resolveLibrarySync` in `worker-main.ts`: absolute name;
the requesting library's directory; the bare name (relative to the
current directory); then `/lib`, `/usr/lib`, `/usr/local/lib`. There is
no `LD_LIBRARY_PATH` and no run path. `dlopen()` itself opens a bare
name relative to the current directory and does not search.

**Symbol resolution.** Libraries share one memory, one function table and
one stack pointer with the executable. `RTLD_LOCAL`/`RTLD_GLOBAL`,
dependency scopes and provider lifetimes are tracked. Names beginning
with `__` are not published from side modules (`isPublicDylinkExport`).
`RTLD_NEXT` is not supported, and `dladdr` attributes every address to
the executable (`docs/posix-status.md`).

**TLS.** Side-module TLS has a fixed reservation that is replayed across
`fork`; musl's general dynamic TLS vector is not implemented
(`tls_get_new-dtv_dso` is an expected failure).

**Fork.** Side modules are fork-instrumented with the side-entry role.
The process archive records modules, bases, handles and GOT state, and a
fork child recreates them in dependency order before activation replay
(`docs/fork-instrumentation.md`, "Fork from a dlopened side module").
A main program instrumented with the default `--side-modules=traced-entries`
records which of its functions can return through fork, and `dlopen`
refuses a library that imports one of them. `assume-all-entries-fork-returning`
lifts that restriction at a size cost.

**Threads.** Each pthread Worker keeps a local linker replica and
reconciles from the process archive. Each replica compiles its own copy
of every side module.

**Compilation and memory.** Executables compile once in the kernel
worker's content-addressed cache (`host/src/wasm-module-cache.ts`) and
the module is posted to every process and thread Worker that runs it.
Side modules do not use that cache: every process and every pthread
Worker compiles its own copy. A library's data lives in the process's
linear memory and counts against the process memory ceiling like any
`mmap`. No new `WebAssembly.Memory` is created, so the WebKit
reservation-budget concern in `host/src/runtime-memory-profile.ts` does
not grow with libraries; compiled-code memory does.

## What the linker supports

Experiments with the SDK's LLD 21.1.7 (commands under "Reproduction"):

| Link | Result |
|---|---|
| Executable + `libfoo.so`, default flags | `attempted static link of dynamic object` |
| `--experimental-pic -pie` + `.so` | Works. Relocatable main: imports `__memory_base`/`__table_base`, `dylink.0` lists `libfoo.so`. |
| `--experimental-pic -Bdynamic` (not PIE) + `.so` | Works. Fixed layout, defined `__stack_pointer`; imports `env.foo`, `GOT.mem.foo_counter`; `dylink.0` lists `libfoo.so`. |
| `--unresolved-symbols=import-dynamic` + `.so` | `attempted static link of dynamic object` (`-Bdynamic` is what admits `.so` inputs) |
| Non-PIC object referencing library **data** | `relocation R_WASM_MEMORY_ADDR_LEB cannot be used against symbol foo_counter; recompile with -fPIC` |
| Non-PIC object calling or taking the address of a library **function** | Works (`env.foo`, `GOT.func.foo`) |
| `-fPIE` object referencing library data | Works (GOT); the SDK currently drops `-fPIE` |
| Undefined symbol defined nowhere | Link error, as before |
| `-soname libfoo.so.1`, link `libfoo.so.1.0.0` | Needed entry is the input's base name `libfoo.so.1.0.0`; `dylink.0` has no soname record |
| Library references a symbol only in `libc.a`, or defined but unused in main | Not extracted and not exported; the library would fail at load |
| Library calls its own exported function | Bound locally (inlined at `-O2`); no interposition |

ELF executables avoid `-fPIC` through copy relocations; Wasm has none, so
an executable that reads a library's data must be compiled PIC (or PIE).
For a non-relocatable executable this is close to free: the 4000-function
benchmark below linked statically to 938,597 bytes with non-PIC objects
and 938,595 bytes with `-fPIC` objects. Runtime cost of PIC code in an
executable was not measured.

## Prototype

Branch `brandonpayton/shared-lib-exec-spike`, commit `4accdf30c`.

**SDK** (`crates/kandelo-cc/src/dynlink.rs`, hooks in `driver.rs`). When
an executable link names a shared library (a `.so` operand, or `-lfoo`
that resolves through `-L` to `libfoo.so` before `libfoo.a`), the SDK:

1. adds `-Wl,--experimental-pic -Wl,-Bdynamic` before the caller's `-l`
   options;
2. reads each library's imports and adds `-u` and `--export-if-defined`
   for every symbol the libraries do not define themselves, so libc
   members a library needs are linked and exported;
3. adds the dlopen glue and a generated constructor (priority 101, ahead
   of user constructors) that `dlopen`s each needed library with
   `RTLD_NOW | RTLD_GLOBAL`, searching `LD_LIBRARY_PATH`, the link's
   `-Wl,-rpath` values, then `/lib`, `/usr/lib`, `/usr/local/lib`, and
   exits 127 with `error while loading shared libraries: ...` when one is
   missing or refused;
4. renames the executable's `dylink.0` to `kandelo.dylink.0`. Every
   existing consumer reads `dylink.0` as "side module": the fork
   instrumenter selects its side-module analysis on it
   (`crates/fork-instrument/src/native/analysis.rs`), package
   installation assigns roles from it, and the host loader accepts a
   module as a loadable library because of it.

**Host** (`host/src/main-dynamic-imports.ts`, hooks in `worker-main.ts`
and `env-imports.ts`). For an executable with `kandelo.dylink.0`:

- `env` function imports the host does not declare are admitted (the
  existing check otherwise refuses them before instantiation);
- each such import is satisfied by a generated Wasm stub that
  tail-calls (`return_call_indirect`) through a private table, so no stub
  or JavaScript frame stays on the stack;
- each `GOT.mem`/`GOT.func` import is a fresh mutable global;
- after every committed `dlopen`, and after fork replay, the host fills
  the stub table and GOT values from the linker's global scope.

The same hooks are wired into the pthread instantiation path but were
not exercised.

### Results

`host/test/spike-shared-lib-exec.test.ts` on Node (fixtures in
`host/test/fixtures/spike-shared-lib-exec/`; fork and large-library
inputs are prebuilt with its `build.sh`):

| Case | Result |
|---|---|
| `cc main.o -Llib -lfoo -Wl,-rpath,<dir>`; library constructor before `main`, library data through GOT, function pointer to a library function, library calling back into the executable, library using `qsort` that the executable never references | Pass |
| No run path; `LD_LIBRARY_PATH=/nonexistent:<dir>` | Pass |
| No run path, no `LD_LIBRARY_PATH` | Pass: exit 127, `error while loading shared libraries: libfoo.so: cannot open shared object file: No such file or directory` |
| Fork-instrumented executable forks after startup loading; child calls the library and sees copied library data | Pass |
| Library calls `fork()`; executable reaches it through a direct import (instrumented with `assume-all-entries-fork-returning`) | **Fails**: `process continuation: activation 0 cannot consume frame for activation 1`. Kept as an expected failure. |
| Same, executable reaches it through a function pointer | Pass |
| Library calls `fork()`; executable instrumented with the default `traced-entries` | Load refused, as designed: `refused by the main program's fork contract: it imports fork ...` |

Also observed: once a library imports `fork`, the executable must define
and export `fork`, which makes it fork-capable; the host then refuses an
uninstrumented executable ("ABI 43 fork artifact retains 1 native Wasm
start section ..."). A dynamic executable therefore needs the normal
fork-instrumentation step whenever any needed library can fork.

Existing suites run after the host change: `dlopen-e2e`,
`fork-dlopen-replay-e2e`, `fork-from-dlopen-side-module-e2e`,
`dylink`, `dlopen-host-imports` (106 passed, 1 skipped). `cargo test -p
kandelo-cc` passed.

### Measurements

Node 24, macOS arm64, one machine shared with other agents' builds
(1-minute load average 9 to 12 on 14 CPUs). Each value is the median
wall time of `runCentralizedProgram`, which includes kernel boot. Treat
the numbers as order-of-magnitude. The browser was not measured.

| Program | Static | Dynamic |
|---|---|---|
| Tiny library (1 KB `.so`): startup, 10 runs, two sessions | 65.6 / 74.0 ms | 83.6 / 81.6 ms |
| Tiny library: executable size | 37,693 B | 47,598 B (+ 1,008 B `.so`) |
| 4000-function library (1.03 MB `.so`): startup, 5 runs, two sessions | 96.5 / 104.6 ms | 210.5 / 225.0 ms |
| Same: 20M calls to a one-line library function | 1.57 / 1.62 ns per call | 3.94 / 4.02 ns per call |
| Fork test executable, default vs `assume-all-entries-fork-returning` | 55,802 B | 79,788 B |

V8 compiles the 1 MB library in about 1 to 2 ms (lazy compilation), so
compilation is not where the extra 120 ms goes on Node. The rest was not
profiled. Candidates are reading the file through guest syscalls into a
`malloc` buffer and copying it to the host, the host's section parsing
and reflection passes, publishing 4000 exports, and the linear table
scans in `functionTableIndex`/`symbolAddress`. Other engines compile
eagerly and would add compile time.

## Where each approach breaks

- **Fork through a library call.** The fork instrumenter seeds only the
  fork entry, `__wasm_dlopen` and (for side modules) every import
  (`native/analysis.rs`). An executable's direct call to a library
  function is an ordinary import call, so the child cannot rewind across
  it. A `call_indirect` boundary works because a dynamic-linking main is
  instrumented conservatively at every `call_indirect`.
- **Fork contract.** With the default `traced-entries`, any library that
  imports a fork-returning function is refused. Dynamic executables whose
  libraries can fork need `assume-all-entries-fork-returning` or a more
  precise contract computed from the needed libraries at link time.
- **Undefined symbols in libraries.** `wasm-ld` ignores a shared
  library's imports when linking the executable. Without the SDK's
  export computation a library fails at load with an unresolved symbol.
  The prototype handles direct inputs only, not the transitive needed
  closure.
- **Sonames.** `dylink.0` has no soname. Linking `-lfoo` through the
  development symlink records `libfoo.so`, not `libfoo.so.1`, so
  versioned installs would depend on the development symlink.
- **Interposition.** Wasm shared libraries bind their own definitions
  (`-Bsymbolic` behavior), and libc lives in the executable. An
  executable cannot interpose library-internal calls, and `LD_PRELOAD`
  could only interpose symbols that are resolved through the global
  scope; it could never replace libc's `malloc`.
- **Name keys.** The generated constructor opens libraries by full path,
  while `DT_NEEDED` resolution keys modules by needed name. A library
  needed both by the executable and by another library could load twice.
  The production loader must key by soname.
- **Code memory.** Side modules are compiled per Worker. N processes with
  T threads each that share a library compile it N x T times. This matters
  most under SpiderMonkey's 2 GiB compiled-code cap.
- **Constructors.** Libraries load at constructor priority 101. Executable
  constructors with a lower `init_priority` run before the libraries are
  loaded.
- **`__`-prefixed symbols.** The loader does not publish side-module
  exports whose names begin with `__`, so an executable cannot import
  them from a library.

## Options

### A. Plugins through build systems, static for executables

Teach the build systems to build `dlopen` modules: Libtool `-module`,
CMake `add_library(MODULE)`, Meson `shared_module()`, all mapped to
`cc -shared`. Keep `SHARED` libraries static for executables.

- ABI: none. Fork: none. Hosts: none.
- Unblocks plugin-based software (interpreter extensions, codec and
  output plugins) with upstream build files.
- Leaves projects that require shared libraries, or install a library
  that both an executable and its plugins use, unsupported.
- Plugins built against a library that the executable links statically
  must find that library's symbols in the executable's exports; this is
  today's PHP/ScummVM pattern and needs documenting.

### B. Resolve shared libraries statically at link time

Make `cc -shared` also keep the library's PIC objects (as a sidecar
archive or custom section) and have executable links substitute them for
the `.so`.

- No runtime or ABI change and no startup or call cost.
- Observable state differs from what was built: a plugin that needs
  `libfoo.so` would get a second copy of `libfoo` with separate globals,
  unless the executable declares that it provides `libfoo` and the loader
  honors it. Replacing a library without relinking does not work.
- This presents a dynamic link that did not happen. It conflicts with the
  platform rule to prefer a truthful failure over a convenient illusion.
  Not recommended.

### C. Dynamic executables, fixed layout (prototyped)

Link executables with `-Bdynamic`, keep the non-relocatable layout, and
load needed libraries at startup through the existing loader.

- ABI: a new program artifact shape (an executable carrying a needed list
  and `GOT.*` imports) that current hosts refuse. It needs a snapshot
  section and, because hosts must understand it to run new programs, an
  `ABI_VERSION` decision. If loading moves into the host (below), a new
  staged import is also program surface.
- Fork: lower library function imports to `call_indirect` (a PLT) so the
  existing conservative `call_indirect` instrumentation covers them;
  choose the side-module contract from the needed libraries.
- Hosts: shared runtime code in `worker-main.ts`; Node and browser take
  the same path. Tail calls are already required by fork
  instrumentation. Browser behavior, budgets and VFS image contents are
  untested.
- Keeps the memory layout, fork base assumptions and reserved regions.

### D. Relocatable (PIE) executables

Link executables with `-pie`, as Emscripten's main-module model does.

- Moves the executable's memory and table bases to load time, which
  changes the process layout that `--global-base`, the channel and
  control regions, fork replay and the ABI snapshot assume.
- Gains nothing over C for this problem: `-Bdynamic` already admits
  `.so` inputs without relocating the executable.
- Not recommended.

## Recommendation

Do A now, and pursue C as a planned feature with the maintainer's
approval of the conventions it adopts. Do not pursue B or D.

C is feasible with bounded changes: the linker already supports the
shape, the loader already does dependency resolution, staged
initialization and fork replay, and the prototype runs the core cases
with small host and SDK changes. The remaining work is concentrated in
three places that already own the relevant contracts: the SDK (export
computation, sonames, run paths), the fork instrumenter (PLT lowering and
contract selection) and the host loader (search path and module cache).

### Phased plan

**Phase 0: no ABI change.**
- Build systems: Libtool `-module`, CMake `MODULE`, Meson
  `shared_module()` produce side modules. Document the pattern for
  plugins that need the executable to export a library's symbols.
- Route side-module compilation through the kernel's content-addressed
  module cache and post the module to process and thread Workers, as
  executables already are. This reduces code memory for existing `dlopen`
  users and is a prerequisite for C at scale.
- Profile the 1 MB library load and remove avoidable copies and linear
  scans.

**Phase 1: dynamic executables (C).**
- SDK: detect shared-library inputs; add `--experimental-pic -Bdynamic`;
  compute required exports over the transitive needed closure (the
  equivalent of ELF's export of symbols referenced by shared objects,
  with a link error for symbols no one defines); stop filtering
  `-Wl,-soname` and `-Wl,-rpath`; record a soname in libraries and
  rewrite executables' needed entries to sonames; make PIC (or PIE)
  codegen the default for executables, or report a clear error for
  non-PIC data references.
- Artifact: keep the needed list in a Kandelo section (or teach every
  `dylink.0` consumer to distinguish a non-relocatable executable);
  record it in the ABI snapshot; decide the `ABI_VERSION` bump.
- Fork instrumenter: lower each library function import to a local PLT
  function (`GOT.func` load plus `call_indirect`) before analysis, reusing
  the import-to-helper machinery that `LegacyLoaderPlan` uses; select the
  side-module contract from the needed libraries' imports.
- Host loader: load the needed closure in the host's staged transaction
  (one search implementation with `LD_LIBRARY_PATH`, run path,
  `$ORIGIN`, defaults), keyed by soname; constructors still run from
  libc through the staged protocol. Satisfy `GOT.*` imports with the
  linker's GOT cells. Pthread and fork replay as for `dlopen`.
- Tests on Node and browser: needed closure with shared dependencies,
  versioned sonames, missing and refused libraries, pthreads, `fork` and
  `vfork`/`posix_spawn` from executable and library, `exec` of a dynamic
  executable, memory budgets with `./run.sh test browser-memory`.

**Phase 2: ecosystem.**
- Libtool: replace `dynamic_linker=no` with a real description
  (`library_names_spec`, `soname_spec`, `shlibpath_var=LD_LIBRARY_PATH`).
  CMake: `TARGET_SUPPORTS_SHARED_LIBS` true with shared-library variables
  and run-path flags. Meson: allow `default_library=shared`.
- Packages and images: install `.so` files and soname symlinks, declare
  runtime library dependencies in the resolver, and add them to VFS
  images.
- Diagnostics: an `ldd`-like listing of needed libraries.

**Not planned without separate approval:** `LD_PRELOAD`, libc as a shared
library, and `RTLD_NEXT`.

## Open questions for the maintainer

1. Is support for linking executables against shared libraries, a
   non-POSIX convention, approved as a goal given that it is what lets
   upstream `SHARED` builds port unchanged?
2. Which search conventions should the loader adopt: `LD_LIBRARY_PATH`,
   `DT_RUNPATH`-style run paths, `$ORIGIN`? Should `dlopen()` of a bare
   name search the same path (POSIX leaves this implementation-defined;
   today it opens relative to the current directory)?
3. Should the executable artifact keep the standard `dylink.0` name, with
   all consumers taught to classify non-relocatable executables, or use a
   Kandelo section?
4. Should Phase 1 make PIC codegen the default for executables, or fail
   with a clear message when a non-PIC object reads library data?
5. Is `LD_PRELOAD` wanted? With libc inside the executable it can only
   interpose symbols resolved through the global scope.
6. Should the SDK pick `assume-all-entries-fork-returning` automatically
   when a needed library can reach `fork`, accepting the size cost (about
   +43% on the small test executable)?

## Reproduction

On the spike branch, in `scripts/dev-shell.sh`:

```sh
./run.sh setup sysroot && ./run.sh setup sdk && ./run.sh setup kernel
(cd host && npm ci)
bash scripts/build-kandelo-cc.sh
bash host/test/fixtures/spike-shared-lib-exec/build.sh
(cd host && npx vitest run test/spike-shared-lib-exec.test.ts)
```

Linker mode experiments used `$LLVM_BIN/clang --target=wasm32-unknown-unknown
-matomics -mbulk-memory -O2` and `$LLVM_BIN/wasm-ld --no-entry
--export=_start --import-memory --shared-memory` with the flag sets in the
table above, inspected with `wasm-objdump -x`.
