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

## Upstream Node campaign target profile

The ESR153 build metadata rebase retains all 47 existing native source entries
across the bridge patches, in sorted lists without duplicates. Include-checker
changes adjust only the existing literal path lists; its checking algorithms
are unchanged. Native compilation uses `-ferror-limit=0` to collect the complete
compiler failure set during the planned broad integration build. These entries
are the current bridge inventory, not the full enabled Node component closure.

Buffer patches 0040, 0046 and 0048 now use ESR153 contexts. Patch 0040 retains
the original upstream capacity-copy helper instead of replacing its allocation
and copy. Its tracked case remains pending new-baseline runtime controls. Native
accounting uses a flag bit separate from the new immutable-buffer bit, and the
key-authorized detach entry preserves the engine's immutable-buffer rejection.

Module patches 0027–0029 preserve current request phases, module types and
complete attribute metadata. Node-owned dynamic imports use the selected native
value callback; other imports retain ESR153's original loading/completion path.
The old shell module-type reconstruction is gone upstream and is omitted.
The old native ModuleWrap owner still needs replacement before building.

Stack patches 0030, 0064 and 0065 retain ESR153's original frame counting and
constructor trimming. The former `countAfterStart` parameter and call-chain
changes are unnecessary on this baseline and are removed. Error hooks connect
at the current ErrorObject entry points; saved frames retain real compilation
identity and source ownership. These are source adaptations, with runtime
graph, error, GC and retirement qualification still pending.

Continuation patch 0045 now uses ESR153's existing microtask records and host
data instead of reinstating the removed `QueuedJob` representation. Registered
context survives unused-result reaction optimization; native scope restoration
covers every existing JS job dispatch branch. Original queues, capability
rules and debugger handling remain in place. Native rethrows use ESR153's
existing exception-status/restoration methods; patch 0059's duplicate accessors
are removed.

Patch 0059 now owns request/active/cancel state in the engine context. Request
and cancellation share an atomic record; active cancellation changes an epoch
so native catch scopes can retire their saved termination on the owning thread.
The bridge no longer keeps a shell-only stop mirror or requires an Environment
for the stop API. Original engine interrupt callback, GC and notification bodies
remain intact.

Patch 0073 enforces cleanup restrictions before engine entry, preserves existing
errors/termination, and uses a pre-interned primitive for a new throw. Fatal
denial uses the existing complete native logger and guest abort via the declared
v8-tracing header/library entry, without a JavaScript realm or Environment.
Native scopes retain their owner and restore restrictions on the owning thread.
Source checks do not qualify interruption races, GC/resource lifetimes, actual
guest signals or shutdown; native callback retirement is still required.

Patch 0075 declares only the maintained native FIFO include to Mozilla's style
checker. Its checking algorithms remain unchanged. The complete-source native
relocation and Environment destructor adaptation live in
[`node-upstream/native-source-patches`](../node-upstream/native-source-patches/README.md).
Those source changes do not establish complete producer shutdown or activation
of the original Environment owner.

The first ESR153 bridge source rebase covers `0024` (hidden native keys),
`0050` (native lazy data), and `0067`/`0068` (construction provenance).
Hidden keys now use ESR153's atoms-zone reference path rather than its
ordinary unique-symbol wrappers. Native property hooks retain the engine's
new wrapper-preservation step. Construction provenance uses the release's
zone-owned `WeakMap` template, tracing and memory-accounting APIs; the old
out-of-line weak-map instantiation is no longer needed.

These source adaptations do not qualify the remaining bridge patches or
Node policy owners. Keep the original Environment/timer/loader migrations
and aggregate enabled-native build as separate outstanding work. No
successful runtime result follows from a source patch applying cleanly.

`0074-kandelo-posix-target-profile.patch` replaces the original port's Linux
target identity with `wasm32-unknown-kandelo`. It extends Mozilla's target
model and config.sub, and adjusts patch 0002's Rust mapping to the new target.
The compiler defines `__kandelo__`; the normal SDK supplies the Unix macros.
This retains Mozilla's POSIX pthread backend, rather than selecting WASI's
no-op thread implementation. The recipe rejects Linux identity overrides.

This patch follows the preserved Node bridge patches in lexical order.
It changes target selection, not the required Node module scope. Source
application and syntax checks do not qualify actual configure selections,
resource lifetimes or runtime behavior; those remain integration obligations.
