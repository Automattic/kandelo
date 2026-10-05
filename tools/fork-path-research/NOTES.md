# Fork-path precision research notes

Working notes for `docs/plans/2026-10-01-fork-path-precision.md`. Every number
says what kind of bound it is. "Closure" = functions the instrumenter would
transform (activations reachable backwards from `kernel.kernel_fork`).

## Phase 0: reproduction (2026-10-01)

- Prior inputs (st-georges `qsmap/quickshell.mangled.wasm`, prior
  `calltypes-all.tsv`), prior tool: baseline 108,867, typed+registries
  108,429. Reproduced exactly.
- `fpa` signature mode equals `fork_instrument::call_graph` exactly
  (+0/-0) on every module tried (quickshell, bash, git, foot, ruby,
  python, qtgallery).
- **The prior 108,429 is not sound as computed.** Two defects in the prior
  registry model:
  - musl `exit/atexit.c`'s `call` (the `atexit` dispatcher) was filed under
    the `pthread_once` registry, so `atexit` handlers were not admitted
    from it;
  - hubs were matched by bare function name, so any static `start`, `call`
    or `handler` in any library was restricted as if it were musl's.
  `fpa` binds hubs to their defining source file, and binds every Wasm
  function to its exact input object (wasm-ld map + SHA-256 of the object or
  archive member) instead of by name.

## Tooling

- `plugin/KandeloCallTypes.cpp` (v3): CFI icall type ids;
  `-fwhole-program-vtables` type tests for *all* virtual calls (cfi-vcall
  skips classes with public LTO visibility: every exported Qt class and all
  of `std::`); constant / pass-through call arguments; per-parameter
  conditional reachability of call sites; registrations (incl. sigaction
  structs, `__synccall`); flow facts (where function addresses are stored,
  where indirect callees are loaded from) collected before optimization.
  Object code is byte-identical with and without the plugin on every
  fixture tried; v2 replays of 2,319 Qt units: see prior work.
- `scripts/make-shims.sh`: research `WASM_POSIX_LLVM_DIR` (plugin on wasm
  compiles, compile-and-link split, pre-wasm-opt link capture + map + input
  hashes) and `WASM_POSIX_FORK_INSTRUMENT` capture wrapper.
- `scripts/build-corpus.sh`: package + closure into a scratch source-only
  cache; `runtime-side.sh` (musl in a scratch copy), `libcxx-side.sh`
  (libc++ recipe standalone; its cache identity binds `LLVM_PREFIX`).
- `fpa`: closures under rules signature / typed / registry (+ const, flow,
  cancel), dominator census, oracle comparison, guard-cost estimate.
- Oracle: `oracle-fork-stack-log.patch` (host hook, env-gated),
  `oracle-host.sh on|off` (applies it and rebuilds `host/dist`),
  `oracle/run-workload.ts`, `oracle/stacks.py`, `oracle-swap.sh`.
- `scripts/shape.py`: named equivalent of the shipped (post-wasm-opt)
  instrumenter input + experiment allowlist instrumenter (copy of
  crates/fork-instrument outside the tree) -> real instrumented sizes.

## Findings so far (v2 plugin data unless noted)

### Shipped wasm-opt pipelines (reproduced byte-exactly from the link)
foot: none (ships the raw link, with names). bash: `-O2` then `-O2`.
git: `-O2` then `-g -O2`. python: `-O2`. ruby: wasm-opt + the Ruby
local-root spill pass (not reproduced; its input keeps names).

### Closures (functions instrumented), v2 data

| program | local fns | instrumenter | direct-only | typed | +registry | +const | notes |
|---|---|---|---|---|---|---|---|
| quickshell (PR #1449) | 149,905 | 108,861 | 318 | 107,857 | 107,857 | 107,830 | v2 lacks public-class vcall types |
| qtgallery | 39,342 | 26,587 | 95 | 26,551 | 26,551 | 26,544 | qtgallery.cpp unbound in v2 |
| foot | 4,763 | 3,001 | 32 | 2,795 | 2,794 | 2,793 | |
| foot + cancel rule | | | | 1,044 | 1,041 | 1,040 | pthread_cancel/timer_create not linked |
| git | 6,218 | 5,294 | 1,902 | | 5,292 | | build-tree archives unbound in v2 |
| ruby | 10,210 | 9,752 | 7,259 | | 9,630 | 9,629 | VM re-entry is genuine |
| python | 10,966 | 9,169 | 6 | | 9,102 | 9,097 | interpreter re-entry is genuine |
| bash | 2,483 | 1,941 | 619 | 1,941 | 1,941 | 1,941 | dlopen: every indirect caller is a seed |

### Shipped-shape sizes (foot; code section / file without names+DWARF)
baseline 5.39 MB / 6.29 MB; typed+registry 4.85 / 5.75; +cancel rule
3.06 / 3.94 (instrumentation overhead +3.16 MB -> +0.84 MB of code).
Experiment-instrumenter baseline code is byte-identical to the shipped
output.

### wasm-opt order (measured 2026-10-02, after #1462, static)
Pre-#1462 measurement said instrument-then-wasm-opt shrank files 12-15%
(quickshell 82.2 -> 71.6 MB); #1462 shrank per-function instrumentation and
that is no longer true. Code-section size vs today's order (wasm-opt ->
instrument), captured links, `-O2` where the package pipeline was not
reproduced:

| program | wasm-opt, instrument, wasm-opt | instrument, wasm-opt |
|---|---|---|
| foot | -3.3% | -1.8% |
| bash | -3.7% | -3.5% |
| git | -3.9% | -4.9% |
| python | -3.9% | -4.1% |
| php | -5.8% | -5.9% |
| waybar | -4.4% | -1.1% |
| ruby | -3.9% | -4.9% |
| qtgallery | -4.4% | +12.5% |
| quickshell | -4.2% | +18.7% |

wasm-opt before instrumenting halves Qt's fork-path set (quickshell
108,860 -> 51,960 functions); instrumenting the raw link loses that.
Chosen: wasm-opt -> instrument -> wasm-opt (the CLI's `--post-optimize`).
All nine outputs of both orders pass ABI 46 host policy with 10-25 unused
`__wpk_fork_*` imports removed. Scripts: `.context/fpr/postopt46/` (not
committed): sweep.sh, today-order.sh, hybrid.sh, counts.sh.

### Dynamic oracle (union of functions on stacks at kernel_fork)
All observed functions are inside every static closure (soundness check).

| program | workload | forks | distinct fns |
|---|---|---|---|
| bash | builtin-heavy script (pipes, subshells, $(), coproc, traps) | 28 | 34 |
| git | init/commit/log/rebase/merge/archive/... (exec of helpers fails: ENOEXEC, see below) | 8 | 24 |
| ruby | fork/system/spawn/popen/initialize/at_exit/trap | 17 | 57 |
| python | os.fork in plain, __del__, recursion, signal handler, key= | 9 | 38 |
| foot | host/test/foot-smoke.test.ts | 1 | 8 |
| waybar | host/test/waybar-smoke.test.ts | 0 (forks only in dash) | 0 |

### Chokepoints (census = dominator tree over the reached graph)
- foot: syscall return path `__syscall_cp_check -> __pthread_exit -> exit
  -> atexit handlers` (cancellation; removed by the cancel rule), the
  "exit" registry being unknown only because LLVM synthesizes
  `.Lregister_call_dtors` (now modelled), `main` unbound because clang
  names it `__main_argc_argv` (fixed), libwayland's `wl_log` handler
  colliding with foot's `void(const char*, void*)` callbacks (flow), an
  untyped pixman scanline-fetch site.
- quickshell: `__do_syscall_impl` (signal delivery after every syscall ->
  musl `__synccall` handler -> `void(void*)` callback -> anything) dominates
  27,423 functions; `free`/`malloc` (via munmap/mmap syscalls) 8.5k/3.4k;
  `QMetaObject::activate` 4.3k via an untyped site; public-class vcalls
  untyped in v2.
- ruby/python: universal callback types (`VALUE(VALUE)`,
  `PyObject*(PyObject*, PyObject*)`) and genuine interpreter re-entry
  (`rb_class_new_instance` runs a user `initialize`).
- bash: links dlopen; the instrumenter treats every function with a
  call_indirect as a boundary into a possible side module.

## Incidental platform findings (not fixed here)
- Process workers load `host/dist/worker-entry.js` whenever it exists, with
  no freshness check (the kernel worker does fingerprint its inputs), so a
  host source change silently does not reach process workers until
  `host/dist` is rebuilt.
- Node exec of `/bin/*` programs installed as lazy references fails with a
  bare ENOEXEC ("prepared exec target is not a WebAssembly module"); the
  kernel discards the reason. Seen with stock dash/bash in this worktree;
  not yet checked on a clean main checkout.
- Kandelo's CPython reports `[Errno 95] wasi does not support processes`
  from `subprocess`: it was configured as WASI, which disables subprocess
  even though fork/exec work.
- git commit fails on the Node host's default `/tmp`: "unable to append to
  '.git/logs/HEAD': Not supported".
