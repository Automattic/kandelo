# Child outcome and lifecycle source owners

CP-002/003/005/006/008/010 and the process-family child ownership observations have
partial source implementations. The exact audited Node 26.13.0 pin and
frozen audit are unchanged. No child-process finding or family closes.

## Actual source and dependency routes

The bootstrap creates an actual instance of its exported ChildProcess class,
with spawnfile/spawnargs, pid, connected, exitCode and signalCode state.
Successful native launch schedules spawn before observing terminal status.
Normal and signal termination publish their real values, destroy owned stdin,
emit exit, and close once the read-stream owners retire. Callback completion
has a separate once gate so error followed by close cannot invoke it twice.
Failed launches expose their actual errno, close created descriptors and
destroy pipe stream owners; ignored/inherited stdio has null stream slots.
Live ref/unref select the exact native wait Promise token; retired owners do
not signal or change a reused process identifier.

Patch 66 selects child-wait.h in the engine's native watch loop. The private
wait API admits an exact positive pid, claims that pid before Promise init
hooks can reenter, and shares an existing prepared same-context owner.
Different-context or initializing duplicate owners fail visibly. WNOHANG
polling retries EINTR; stopped/continued notifications stay pending. Actual
exit codes, termination signals and errors remain in the owner after reap
until conversion/delivery succeeds. A failed JS conversion cannot trigger
another wait and manufacture successful exit zero from ECHILD. Delivery uses
the Promise's actual realm; a failed settlement stops the current loop pass.
Context shutdown retires its child roots without invoking JS, inventing an
exit, signaling the child or reaping twice.

The route is unchanged guest posix_spawn/waitpid/kill -> musl syscall bridge
-> runtime-core spawn/wait/process ownership -> existing host process launch.
The kernel's exact-pid atomic reap and error publication were already real;
this slice changes their engine/JS consumers, not the kernel or libc. No
host import, syscall number, channel layout or wire ABI changes. Node hosts
and Chromium/Firefox/WebKit select the same guest source. Outer-host child
processes below are fixture controls, never substituted into the guest.

## Exceptional wait errors remain a public-policy gap

The pinned libuv unix process owner retries EINTR, ignores ECHILD without
calling its exit callback, and aborts on other unexpected wait errors. Its
normal public onexit callback is not evidence for stolen-wait behavior.
Kandelo instead currently rejects the private operation with actual errno
and syscall, emits error, retires streams and closes with unknown null/null
status. That explicit behavior removes fabricated success but is still an
unresolved Node semantic deviation, not an accepted platform boundary.

ECHILD is a POSIX errno absent from libuv's public error map. The private
bridge preserves its compiler-selected errno name separately; public util
error maps do not gain invented libuv entries. Other unknown errors remain
visible. Native policy and JS exceptional-path controls have distinct scope.

## Focused evidence and limitations

The compiled portable header is exercised with real native POSIX children:
pending WNOHANG, exit 37, SIGTERM, actual stopped notifications, reaped ECHILD,
invalid selectors and retained results after a failed sink. An injected
initial EINTR checks retry into real waitpid; it is not an observed interrupted
syscall. The fixture bounds its lifetime and kills/reaps only its own still
waitable children on failure.

Four JS controls exercise actual bootstrap lifecycle source over explicit
native Node process/stream boundaries. Normal status and signal traces are
compared with the exact native Node reference. Native failed-spawn errors
feed a synchronous private failure boundary; no guest spawn is executed.
The exceptional wait rejection is deliberately injected and is not native
libuv ECHILD parity. Five existing signal/stdin lifecycle controls also pass.
The first combined run retained one fixture error: expecting ECHILD from
the libuv error map. Its inputs and failure remain recorded separately.

Patch forward/reverse, hash/archive identities, generation and syntax checks
are source evidence only. The new JSAPI integration and engine are uncompiled.
These controls establish neither guest POSIX conformance nor runtime
compatibility on any of the four hosts. No overall suite or product rebuild
ran. implementation-state.json records exact inputs, results and snapshots.

## Remaining implementation and validation

Complete direct ChildProcess.spawn/constructor/prototype/symbol/subclass
contracts; normalization and shell/argv0/windows/URL/environment overloads;
extra stdio/IPC/fork/disconnect/channel/serialization ownership; uid/gid and
permission activation; preparation/allocation/partial-failure rollback;
abort/timeout/maxBuffer/encoding and exec Promise contracts; native request
providers/callback/GC/realm/fatal behavior; full signal naming/subscriptions;
sync process outcome/lifecycle controls and OS measurements remain open.
Explicit wait-loss policy must be reconciled with the target before closure.

Later validation needs unchanged upstream spawn/exit/error/stdio/kill/ref/
IPC/exec files, native differential controls for each supported overload and
failure branch, and built guest process/pipe/signal tests on all four hosts.
Conversion failure, duplicate/reentrant ownership, context shutdown, GC,
pending output after exit and child/descendant resource cleanup need actual
engine evidence. Move next to independent audited owners rather than treating
this scoped test campaign as complete child-process compatibility.
