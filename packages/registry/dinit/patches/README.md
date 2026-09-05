# dinit patches

`build-dinit.sh` applies every `*.patch` here, in lexical order, to the
verified upstream dinit source before cross-compiling it for wasm32-posix.

Both patches below are **platform-level adaptations/optimizations for Kandelo**,
not package-specific hacks or workarounds for a single demo. They keep dinit's
semantics and its service contract intact.

## 0001 — `wasm-sjlj-pselect-noexcept`

A **compatibility** fix for the WebAssembly toolchain boundary. Clang lowers
Wasm `setjmp`/`longjmp` to an exception transfer; dasynq's pselect backend
places its `sigsetjmp` landing pad inside `pull_events()` but marks that
function `noexcept`, so a `SIGCHLD` reaches `std::terminate` before the landing
pad can consume the `longjmp`. The patch removes only that one conflicting
`noexcept` (dinit's real try/catch paths keep C++ EH). Without it dinit aborts
on the first child signal.

## 0002 — `posix-spawn-simple-service-launch`

A deliberate **optimization for Kandelo**. On this kernel an ordinary `fork()`
is expensive: the child pays an eager memory copy plus a wasm-fork-instrument
continuation replay before it can reach `exec`. dinit launches every service
with `fork()+execvp()`, so it pays that whole cost and discards the
reconstructed child state microseconds later at `exec` — pure waste for the
spawn-then-exec pattern.

musl's `posix_spawn()` issues `CLONE_VM|CLONE_VFORK`, which routes to Kandelo's
vfork path: the child borrows the parent's memory and execs immediately,
skipping the replay. This patch takes that cheaper primitive for **simple**
service launches (no socket activation, no readiness-notification fd, no
control-socket fd, default stdin, no uid change, no rlimits, not on the
console, NONE/LOGFILE log with no ownership change). Anything more — and any
spawn error — falls through to the **unchanged** `fork()`+`run_child_proc`
path, which still reports the precise failing exec stage. Behavior is
identical; only the common case gets cheaper.

**Scope (honest):** this speeds up the fork-then-**exec** service-launch path
that every `fork()+exec` spawner uses. It does **not** speed up pure `fork()`
with no exec (e.g. php-fpm's static worker prefork), where vfork cannot apply
because the child keeps running as a worker. It is worth landing as a correct,
low-risk platform optimization, independent of any single demo's boot time.

See the header comment in `0002-posix-spawn-simple-service-launch.patch` and the
extensive in-code comments the patch adds to `src/baseproc-service.cc` for the
full rationale and the parent-side state-machine details.
