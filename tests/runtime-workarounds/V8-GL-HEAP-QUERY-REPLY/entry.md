# V8-GL-HEAP-QUERY-REPLY

Status: suspected. No standalone reproduction or named affected runtime
version has been established. No upstream report is authorized or filed.

## Defect

The historical libGLESv2 query comment attributed stale stack-local reply
loads after cross-worker copyout to V8. That attribution is unconfirmed.
The preserved behavior uses heap-owned response storage, then memcpy to the
application destination. A defect in Kandelo's marshalling, pointer width,
source/destination lifetime, synchronization or an older toolchain remains
possible. This entry does not establish a specification violation.

## Why Kandelo is affected

Synchronous GL queries copy output through the kernel/host into process
memory. Returning stale query bytes would break reads and checked mutation
acceptance. The generic compound submit/query path retains heap ownership
for both the nested reply and phase receipt on every host.

## Workaround and its cost

The tagged site is libc/glue/libglesv2_stub.c, _wpk_gl_query_into. It retains
one heap allocation, zeroing and copying replies instead of receiving them
straight into the application's stack buffer. Compound packets share that
allocation. Cost is not measured here. This does not add engine detection,
flags, a transport retry, a result substitution or a second implementation.

## Evidence

The preceding source comment is the only historical evidence reviewed here;
it reported a failure of stack-local loads and success with heap storage.
Its runtime version, OS, build identity and standalone failure artifacts are
unknown. During the ordered transport change, heap storage was preserved and
the comment qualified. Focused C device-double and Rust checks can validate
transport semantics; they cannot confirm a browser engine visibility defect.
There is no observed reproduced=true record or self-judging reproduction.

## Why this is not a Kandelo defect

Not established. First reduce exact source/output ranges, pointer widths,
copyout ordering and lifetimes through the normal runtime, then reproduce
without Kandelo using independently owned shared memory and a self-judging
Wasm load. A Kandelo marshalling/ownership correction that eliminates the
failure would retire this entry as a Kandelo defect.

## Draft upstream report

Not filed and not ready. No confirmed cause, affected version or standalone
attachment exists. Do not infer confirmation from the historical comment.

## Removal criteria

After a self-judging reduction identifies the cause, remove the extra heap
response path only with appropriate compiled guest and Node/browser controls
that preserve caller outputs and checked mutation acceptance on failure.
If the fault is Kandelo's, fix it and retire this entry; if an outside runtime
is confirmed, follow the registry's released-runtime removal requirements.
