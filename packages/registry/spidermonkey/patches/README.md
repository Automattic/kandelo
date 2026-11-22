# SpiderMonkey Patches

These patches apply to the Firefox ESR 153.7.0esr source tarball and cover the
Kandelo wasm32 integration points needed by the standalone SpiderMonkey shell
and its Node-compatible entry point. `build-spidermonkey.sh` applies every
`*.patch` here in name order; the numbering does not need to be contiguous.
Each patch starts with a header that explains what it changes and why, and
notes what changed when it was rebased onto ESR 153.

Every patch is a plain `diff -u` against the pristine tree with the previous
patches applied, and must apply in order at fuzz 0 with both GNU patch (the
dev shell's) and the system `patch`.

## Platform integration

- `0001-allow-static-cxx-runtime-for-wasm-linux.patch`: skips Mozilla's
  static-libstdc++ link probe for wasm32, where the static libc++ from the
  Kandelo sysroot is the intended runtime.
- `0002-map-kandelo-wasm-linux-rust-target.patch`: maps the Kandelo wasm32
  Linux C target to Rust's `wasm32-unknown-unknown` target.
- `0003-jsonprinter-size-t-wasm32.patch`: adds the `size_t` overload that
  wasm32 needs, as Darwin, OpenBSD and WASI already have.
- `0004-disable-wasm32-return-address-stackwalk.patch`: disables
  return-address stack walking, which the wasm backend cannot provide.
- `0005-getrandom-custom-backend-wasm32.patch`: supplies the getrandom 0.3
  custom backend for `wasm32-unknown-unknown` through libc `getrandom(2)`.
- `0006-randomnum-use-sys-random-on-wasm32.patch`: uses `<sys/random.h>`
  instead of the Linux UAPI header.
- `0007-skip-elf-network-check-for-wasm-target.patch`: skips an ELF-only
  configure-time binary check.
- `0008-use-wasm-trap-for-moz-crash.patch`: reports the crash or assertion
  text and executes a wasm trap instead of Mozilla's bad-address store.
- `0009-use-wasm-frame-address-for-native-stack-base.patch`: records the
  native stack base from the startup frame address, as WASI does.
- `0010-use-wasm-icu-data-section-syntax.patch`: uses the wasm object-format
  section syntax for the embedded ICU data.
- `0011-heap-autorunparallel-task-on-wasm32.patch`: heap-allocates transient
  GC helper tasks to avoid stack-allocated multiple-inheritance task layout
  corruption in Kandelo worker threads.
- `0014-disable-mozglue-interposers-on-wasm32.patch`: skips mozglue's Linux
  interposers, which need ELF `dlsym(RTLD_NEXT, ...)` semantics and abort
  `setenv()` / `unsetenv()` in the static Kandelo executable.
- `0023-use-flag-visibility-on-wasm32.patch`: uses `-fvisibility=hidden`, as
  Mozilla does on Darwin and the BSDs, instead of the `gcc_hidden.h`
  visibility pragma, which libc++ 23's `<system_error>` cannot be parsed
  under.

## Node-compatible runtime

- `0012-kandelo-node-compat-shell-entry.patch`: the `node` /
  `spidermonkey-node` shell entry point. It runs the generated node-compat
  bootstrap, adds POSIX file/fd/env helpers, native crypto, zlib and TCP/TLS
  hooks, and integrates socket watches into the shell event loop.
- `0013-kandelo-join-shell-workers.patch`: `joinWorkerThreads()` for the
  `worker_threads` adapter.
- `0015-kandelo-esm-bare-specifier.patch`: resolves bare ES module
  specifiers through node-compat.
- `0016-kandelo-import-meta.patch`: populates `import.meta.url`, `dirname`
  and `require` through node-compat.
- `0018-kandelo-require-module.patch`: synchronous `require()` of ES modules
  through the shell module registry.
- `0019-kandelo-link-evaluating-cycle.patch`: lets module linking and
  evaluation accept a dependency that is still evaluating on an outer,
  suspended evaluation, for incremental require/import cycles.
- `0020-kandelo-vm-context.patch`: isolated realms for node-compat's `vm`
  module, with per-context code-generation policy.
- `0021-kandelo-zstd-decompress.patch`: native zstd decompression.
- `0022-kandelo-async-subprocess.patch`: posix_spawn/pipe/waitpid/kill seams,
  child reaping, real-delay timers in the event loop, and `SIGPIPE` ignored at
  startup as Node does.

`0017-kandelo-default-explicit-resource-management.patch` was dropped in the
ESR 153 upgrade. ESR 153 enables explicit resource management (`using` /
`await using`) by default, both at configure time
(`--disable-explicit-resource-management` defaults to enabled in
`js/moz.configure`) and in the runtime pref
(`javascript.options.experimental.explicit_resource_management` defaults to
`true` in `modules/libpref/init/StaticPrefList.yaml`).

## Event loop and timers

In node mode the shell event loop is `RunShellJobs`, which node-compat drives
through `drainJobQueue()`. Each turn:

1. runs the microtask queue (`js::RunJobs`);
2. runs the shell task queue (`MaybeRunShellTasks`: FinalizationRegistry
   cleanup callbacks, plus the shell's `setTimeout` callbacks in plain `js`
   mode), and returns if a task called `quit()`;
3. reaps exited children and polls socket, TLS and pipe watches without
   blocking (`KandeloSocketDispatch`); a completed watch settles its promise,
   which queues microtasks for the next turn;
4. fires node-compat's due timers and reads the next deadline
   (`KandeloRunDueTimers`, calling `__kandeloRunDueTimers` and
   `__kandeloNextTimerDelay` from `node-compat/adapter.js`).

The loop ends when a turn makes no progress and there are no watches or
pending timers. A turn that makes no progress but still has work outstanding
sleeps until the next timer deadline, at most 1 ms.

ESR 153 added a shell `setTimeout` builtin that feeds the same task queue. It
queues zero-delay callbacks only: it treats any other delay as zero and has
no handle and no `clearTimeout`, so it cannot implement Node's timers. In
node mode, `RunKandeloNodeBootstrap` (0012) deletes it from the global before
the bootstrap runs, and the bootstrap installs the Node-shaped `setTimeout`,
`setInterval` and `setImmediate` backed by the adapter's `os.setTimeout`:
zero-delay timers run as microtasks, and delayed timers fire from the wheel
in step 4. Plain `js` mode keeps the shell builtin.

Revisit this set when bumping ESR versions. Most patches are
Kandelo-specific integration glue, but any general wasm32 or POSIX portability
fixes should be considered for upstreaming.
