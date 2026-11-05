# Process environment, creation mask and parent ownership

PROC-001/002/013 and related DOC-010/CP environment findings now have
partial source owners. The exact Node 26.13.0 pin and frozen audit remain
unchanged. This is not complete process, worker or four-host compatibility.

## Actual source and lower-layer routes

process-state-adapter.js presents a live environment Proxy over the native
environment owner. It does not seed a whitelist, synthesize PATH, cache
reads, or keep successfully assigned shadow values. Native mutation and
enumeration therefore feed later reads, own-key/has/descriptor queries and
the existing child environment snapshot code. Symbol coercion uses actual
ToString behavior; descriptor restrictions follow the target native policy.

process-state.h serializes its environment operations and copies borrowed
libc values/names while mutations through this owner are excluded. No
borrowed environ pointer survives the lock or a JavaScript allocation.
All compatibility std/native reads/writes/deletion use this same owner.
Arbitrary external native-library environment mutation is not covered by
that mutex; the target also requires coordination of native mutations.

The actual path is JS frontend -> private engine hook in patch 58 ->
process-state.h -> musl getenv/setenv/unsetenv and __environ, initialized
from the program's envp. The OS shell already had setters; the previous
adapter discarded mutations and described an old package configuration
problem. Its no-op/comment is removed. This is a Kandelo adapter gap, not
evidence of an outside runtime defect. No runtime workaround is introduced.

The pinned main-thread and worker wrappedUmask functions are selected
unchanged from the full target bootstrap files. Main validation delegates
to the actual shared parseFileMode; the native owner performs a serialized
libc umask query/restore or update and returns the previous mask. Worker
wrapper policy rejects mutation, but integration with a complete worker
bootstrap remains open. The real path is libc musl/src/stat/umask.c ->
existing channel syscall -> runtime-core sys_umask -> Process.umask.

process.ppid is now a live getter: private hook -> getppid -> existing
sys_getppid -> kernel Process.ppid. No environment-derived or fixed parent
identity is supplied. No syscall, channel, host import, kernel state layout
or ABI meaning is changed by these private package bindings.

## Evidence and its limits

* Three focused process-state frontend controls and seven affected URL/exit
  regressions pass with the exact native reference. Native environment and
  mask owners are explicit dependency substitutions, not the guest bridge.
* Four unchanged upstream files (environment symbols, deletion, descriptor
  restrictions and process umask) pass over the candidate frontends and
  separately as native controls. Test bodies and assertions are unchanged.
* The standalone C++ helper is compiled/executed on the native host. It
  checks live libc state, copied-value lifetime, invalid names, concurrent
  bridge mutation/enumeration, stable mask queries, actual created-file
  permission bits and the real parent PID against the launching process.
* Patch forward/reverse preflight and source generation checks do not
  compile the engine. No guest/four-host conformance or overall suite is
  established by these controls. Raw logs/source identities remain separate.

## Remaining dependencies

Exact environment prototype/constructor/exotic-object behavior, numeric-key
ordering, UTF-8-invalid native strings, TZ/engine timezone refresh, pending
deprecation/trace/CLI policy and full permission enforcement remain gaps or
unresolved controls. The source proxy is not advertised as an identical V8
exotic object. Node's setter ignores underlying setenv status; the source
does likewise rather than inventing successful shadow state for invalid
names. Node-specific error inspection/stack metadata still needs its owner.

Worker default copied environments, SHARE_ENV, worker-native getenv,
case/platform policy, per-worker process-state access and actual teardown
must be implemented with the worker/bootstrap owner. A tested read-only
wrapper is not a working worker. Complete spawn/exec/fork inheritance,
native external mutation, concurrent file creation and guest syscall/error
behavior need built-artifact evidence. The full product rebuild remains
deferred; no host process environment or parent is substituted in the guest.

The subsequent resource-usage slice reached targeted engine76 acceptance.
Five previously tracked wrong-success numeric/report/space values are removed;
actual nominal GC budget is measured, while guest usage/report/space providers
remain implementation gaps. See resource-usage-implementation-dependencies.md
for original evidence, native/guest scope and remaining requirements. No
overall suite/full product rebuild or family closure is established.
