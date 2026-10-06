# Honest Program Links and Kernel-Owned Host Stdin — Design

Date: 2026-09-27
Branch: `brandonpayton/honest-links-kernel-stdin`
Origin: gaps G2 and G4 in the FFmpeg campaign
(`docs/plans/2026-09-26-ffmpeg-gap-ledger.md` on
`brandonpayton/ffmpeg-on-kandelo`, PR #1426). This PR merges first; the FFmpeg
PR rebases on it.

## §1. Why

Two platform defects surfaced while porting FFmpeg. Both make Kandelo report
success where the system is wrong, which the platform-values contract forbids.

**G2 — links accept functions that do not exist.** The SDK links every
executable with `-Wl,--allow-undefined`. wasm-ld documents that flag as
`--import-undefined` plus `--unresolved-symbols=ignore-all`: any call to a
function no library defines links anyway and becomes an `env` import. At load
time the host fills every such import it does not recognise with a stub that
throws `Unimplemented import`. So:

- configure-time link checks report missing functions as present (FFmpeg's
  configure claimed `closesocket`, `gethrtime`, and `sysctl`), and
- shipped programs crash only when the missing function is first called.
  Today `coreutils --coreutils-prog=expr abcdef : 'a.*d'` dies with
  `Unimplemented import: env.re_compile_pattern`, because coreutils' configure
  believed libc provided GNU's regex API and never compiled gnulib's own.

No package-level flag can undo it: `--import-undefined` turns the missing
symbol into an import before any unresolved-symbol policy runs, so
`--unresolved-symbols=report-all`, `--error-unresolved-symbols`, and
`--warn-unresolved-symbols` all link silently (tested).

**G4 — host-supplied stdin is lost across fork.** The host keeps stdin bytes
supplied through `NodeKernelHost.spawn({ stdin })`, `setStdinData`, and
`appendStdinData` in maps keyed by pid (`stdinBuffers`, `stdinFinite` in
`host/src/kernel-worker.ts`). The kernel maps fd 0 to host handle 0, and
`host/src/kernel.ts` answers a read of handle 0 through the `onStdin` callback
for the *current pid*. POSIX makes fd 0 after `fork` the same open file
description, shared by parent and child with one read offset; here a child
that inherits it gets nothing and blocks forever. `sh -c 'cat'` with host
stdin hangs.

## §2. Scope

1. **Honest executable links (G2).** Executables may leave undefined only the
   imports the platform really provides, and that list is generated from one
   declaration rather than maintained by hand.
2. **Host stand-ins for library functions move into libraries.** The host
   currently implements ~20 C/C++ runtime functions in JavaScript (§4). Honest
   links would otherwise just relocate the lie into the declaration.
3. **Kernel-owned host stdin (G4).**
4. **One ABI version bump** covering all of the above, with a regenerated
   `abi/snapshot.json` and every artifact rebuilt.
5. **Every package the honest link breaks is fixed at its own layer** (§5).

Out of scope: side modules (§3.4), the `sdl2`/`sdl3` platform patches, the
PTY stdin path (unchanged).

## §3. Design: honest links

### §3.1 One declaration

`crates/shared` gains a declaration of every import the host supplies to a
user program from the `env` module, alongside the existing declarations of
kernel imports and process-expected globals. Each entry has a name, a kind
(function, global, memory, table, tag), and a one-line reason.

From today's host (`host/src/worker-main.ts`), the legitimate entries are:

- `memory`, `__channel_base` — process memory and the channel base global;
- `__wasm_dlopen_prepare`, `__wasm_dlopen_next`, `__wasm_dlopen_main`,
  `__wasm_dlsym`, `__wasm_dlclose`, `__wasm_dlerror` — the dynamic loader;
- `__wasm_posix_vm_interrupt_after` — the reserved VM-interrupt hook;
- `__cpp_exception`, `__c_longjmp` — exception tags, resolved by name;
- the `__wpk_fork_*` fork-runtime imports — added by fork instrumentation
  after linking; they are declared for load-time enforcement but are not part
  of the link-time allowance.

The implementation plan confirms the exact set by reading `worker-main.ts`;
anything the host provides that is not a real platform service goes to §4,
not into the declaration.

### §3.2 Generated, not maintained

The existing ABI generator (`xtask dump-abi`, which already produces
`abi/snapshot.json` and `host/src/generated/abi.ts`) emits:

- a `host_env_imports` section in `abi/snapshot.json`;
- the generated TypeScript list the host enforces;
- a plain symbol file installed into each sysroot by `scripts/build-musl.sh`
  (`sysroot/lib/kandelo-host-imports.txt`), one link-time-allowed name per
  line.

### §3.3 Enforcement

- **Link time.** `linkFlags()` in `sdk/src/lib/flags.ts` replaces
  `-Wl,--allow-undefined` with
  `-Wl,--allow-undefined-file=<sysroot>/lib/kandelo-host-imports.txt`. A call
  to anything else is a link error, so configure checks become truthful and a
  program that needs a missing function fails to build.
- **The second copy of the link flags.** `scripts/build-programs.sh` carries its
  own `-Wl,--allow-undefined`. It must use the same generated file (preferably
  by linking through the SDK) so the two paths cannot diverge.
- **Load time.** `worker-main.ts` stops inventing stubs. An `env` import that
  is not declared makes the host refuse to instantiate the program, with an
  error naming the import, the same way ABI mismatches fail. A test proves
  every declared import is implemented, and one proves an undeclared import is
  refused.
- **Artifact guard.** The reserved-import allowance in
  `scripts/wasm-artifact-guards.sh` (currently a hand-written
  `env.__wasm_posix_vm_interrupt_after` exception) reads the same generated
  list.

### §3.4 Side modules stay dynamic

`SHARED_LINK_FLAGS` keeps `--allow-undefined`: a side module's undefined
symbols are resolved against the main program by the dynamic loader at
`dlopen`, a real dynamic-linking boundary. The plan verifies that an
unresolvable side-module symbol already fails `dlopen` loudly; if it does not,
that is fixed here.

## §4. Design: host stand-ins move into libraries

The host currently implements in JavaScript:

- `operator new`/`delete` in eight forms (`_Znwm`, `_Znam`, `_ZdlPv`,
  `_ZdlPvm`, `_ZdaPv`, `_ZdaPvm`, and the two `nothrow` news);
- `__cxa_atexit`, `__cxa_guard_acquire`, `__cxa_guard_release`,
  `__cxa_guard_abort`, `__cxa_pure_virtual`, `__dynamic_cast`;
- `__cxa_thread_atexit` as a no-op that reports success — so thread-local
  destructors silently never run (`mariadbd` imports it);
- libc++'s `__libcpp_verbose_abort` and one instantiation of `std::__sort`.

These belong in the C++ runtime: the `libcxx` package's `libc++abi.a`/`libc++.a`
or the SDK's `libc/glue/cxxrt.c`, which already has weak `operator new` and
`delete`. With honest links, a C++ program that does not link its runtime fails
to build instead of borrowing JavaScript. `__cxa_thread_atexit` gets a real
implementation (per-thread destructor list run at thread exit and `exit`).

## §5. Packages the honest link will break

From the `env` imports of every program built on 2026-09-26 (excluding the
declared platform imports):

| Program | Missing functions | Expected fix layer |
|---|---|---|
| coreutils | `re_search`, `re_match`, `re_compile_pattern`, `re_compile_fastmap`, `isapipe` | none needed: honest configure selects gnulib's replacements |
| tar | `rpmatch` | same (gnulib) |
| bash | `locale_charset` | bash's configure / libcharset linkage |
| php, php-fpm | `getcontext`, `makecontext`, `swapcontext` | PHP fibers fall back to ucontext because the package disables fiber asm; ucontext is a documented unsupported API in `docs/posix-status.md`. Decide in the plan how PHP builds honestly (see §8). |
| ruby | `sqlite3_column_database_name`, `backtrace`, `backtrace_symbols` | the sqlite3 extension's link, and execinfo (musl has none) |
| mariadbd (wasm32, wasm64) | `__cxa_thread_atexit` | §4 |
| espeak-ng | `_Znwm`, `_ZdlPvm`, `__cxa_throw`, `__cxa_allocate_exception`, `std::bad_array_new_length` | link the C++ runtime (§4) |

Configure checks also change for packages that link nothing missing today;
every package is rebuilt, and any other failure is a new gap handled the same
way. Existing `config.site` seeds that compensated for lying checks become
redundant; they are kept unless wrong.

## §6. Design: kernel-owned host stdin

When the host supplies stdin to a process, the kernel creates a **pipe**. fd 0
is the pipe's read end, an ordinary open file description; the host holds the
write end through new kernel exports.

- `setStdinData(pid, bytes)` writes the bytes and closes the write end;
  `appendStdinData(pid, bytes)` writes without closing; closing gives the
  readers end-of-file once drained.
- The pipe is **bounded**. Kernel linear memory never shrinks, and WebKit
  charges declared memory ceilings up front, so the host keeps a queue of
  bytes the pipe has not yet accepted and feeds it as readers drain. That
  queue is keyed by the pipe, not the pid.
- Sharing across `fork`, `dup`, and `exec`, `poll` readiness, non-blocking
  reads, `fstat` (FIFO), and `lseek` (`ESPIPE`) all come from the existing pipe
  implementation.
- Removed: `stdinBuffers`, `stdinFinite`, the `onStdin` callback, and the
  handle-0 branch in `host/src/kernel.ts`. `isStdinConsumed()` becomes a query
  of the pipe's state.
- Unchanged: the PTY path used by the terminal.

**Risks.** (1) The host must feed a bounded pipe with backpressure rather than
hand over a whole buffer — more host logic than today. (2) Browser framebuffer
demos (fbDOOM, Quake) deliver keyboard bytes through `appendStdinData`; a pipe
write wakes blocked readers at once, but this is the most visible regression
surface and needs their browser input tests. (3) Observable behaviour moves to
POSIX: a child that outlives its parent can read the remaining bytes, and
stdin with no data waits until the host closes the pipe. (4) Node and browser
share `kernel-worker.ts`; both need validating.

## §7. ABI

New kernel exports (host stdin write and close), the `host_env_imports`
declaration, and the host refusing undeclared imports are ABI changes: one
`ABI_VERSION` bump in `crates/shared/src/lib.rs`, a regenerated
`abi/snapshot.json`, and every artifact rebuilt through the normal package
path. `docs/abi-versioning.md` records the epoch.

## §8. Open decision for implementation

**PHP fibers.** With honest links PHP can no longer silently build its ucontext
fiber backend. The implementation plan determines what PHP's configure does
(error, or build without Fibers) and brings a concrete proposal — for example
re-enabling PHP's own wasm-compatible fiber path if one exists, or building
without Fibers with the boundary documented — before changing PHP's feature
set.

## §9. Validation

- **G2:** a guest test that `expr abcdef : 'a.*d'` prints `4` through the shipped
  coreutils; a link test that a call to a nonexistent function fails to link
  through `wasm32posix-cc`; host tests that an undeclared import is refused
  and every declared import is implemented; a survey showing no rebuilt
  program imports anything outside the declaration.
- **§4:** C++ runtime tests: `new`/`delete`, static-local guards, pure virtual,
  `dynamic_cast`, and thread-local destructors actually running at thread exit.
- **G4:** Node and browser guest tests that a child reads inherited host stdin
  to end-of-file (`sh -c cat`); partial reads by parent then child share one
  offset; a large input (tens of MB) with a bounded pipe; the fbDOOM/Quake
  keyboard Playwright tests.
- **Suites:** cargo tests, host Vitest, libc-test, the POSIX suite, sortix
  os-test, and browser Playwright, before and after; a full local rebuild of
  every package.
- **Docs:** `docs/sdk-guide.md` (link contract), `docs/posix-status.md`
  (stdin semantics), `docs/abi-versioning.md`, and `docs/porting-guide.md`
  (configure checks are now truthful; `config.site` seeds for missing functions
  are unnecessary).
