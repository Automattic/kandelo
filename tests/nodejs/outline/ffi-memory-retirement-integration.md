# FFI memory and native environment retirement

Source188 integrates the immutable memory and teardown handoffs over source187.
The audited target/source/native reference and ABI55 are unchanged. Exact
origin/main is already an ancestor; no merge or unrelated edit is discarded.

## Actual implementation

Twenty scalar accessors read/write real unaligned guest memory, with actual
pointer/size/value admission. Raw pointer extraction captures the real backing
and view offset without extending caller lifetime. UTF-8 string conversion,
default-copy buffers/ArrayBuffers, caller-owned zero-copy aliases and the pinned
export algorithms consume genuine bytes. Borrowed Allocation/Owner/Span objects
own metadata only; they never free or charge caller payload as a new allocation.
The native Buffer function traces the private FastBuffer prototype in a reserved
slot. Null foreign Buffer backing is genuinely detached after creating its view;
its untransferable mark is distinct from plain ArrayBuffer transfer behavior.

Main, Worker and destructor fallback now share an idempotent native retirement
owner. Existing worker joins, native-job cancellation/waits, watchers, ports and
socket consumers retire before FFI libraries unload. Native async/context cleanup
remains last. Exit listeners retain live resources until they finish. Selected
exit status is normalized before cleanup, failure promotes only success, and
terminal status remains durable on reentry. Completion is set after actual
shutdown calls return, never when shutdown is merely requested.

Root184 checked-wrapper denial and mounted-VFS null-path corrections survive.
GetSymbol still validates type and NUL before checking closed state. Registration
is one additive zero-fuzz patch0137 plus actual declared memory/reference inputs.
Normal native staging, generated bundle/bootstrap and unchanged Mozilla checker
are used; no checker, assertion, target or platform identity is weakened.

## Evidence and exact scope

- Current selected frontend and pinned native reference agree on10scalar byte
  observations,61errors and28function shapes, with copy/alias, detached/RAB/shared,
  offset/GC and extra Buffer ownership assertions. These selected frontend
  controls use native FFI at the private boundary; they do not execute new JSAPI.
- The portable memory executable uses exact current captured compiler inputs.
  It checks real alias/metadata conservation and explicit32bit arithmetic. The
  existing tiny SDK object is preserved; host64pointer identity is not guest32
  identity evidence.
- Current composed native queue/coordinator reproduces the exact compiler input
  of the identified structural executable. Real pthread/mmap readers retire
  before unmapping;3readers,2silent cancellations,0Complete callbacks after exit,
  8status cases and idempotence pass. Explicit provider instrumentation is not
  actual Node Worker/dynamic-linker or browser conformance.
- Normal source/input/bootstrap/style and14package-source checks pass. Four prior
  tiny compiles (3native,1SDK) succeeded; root reuses identified artifacts and
  performs no new compilation. Production JSAPI remains uncompiled. Accepted173
  predates current188; no current projection or four-host runtime run exists.

Exact results: `.context/node26-ffi188-source-r1/report.json` and
`focused-results.json`; package results:
`.context/node26-ffi188-affected-r1.json`.
Immutable handoffs: `.context/ffi-memory-agent/handoff` and
`.context/ffi-teardown-agent/handoff`, including seals and original nonpasses.

## Remaining implementation and validation

Blocking native I/O or noninterruptible worker execution can prevent existing
joins returning. Library bytes stay mapped during that wait; this unresolved
cancellation prerequisite is not an accepted platform boundary. Explicit user
close/free while a raw consumer is live keeps the target unsafe lifetime rules.

Public namespace source presence is33/35exports, not passing compatibility.
Generic signatures/calls/functions/dlopen convenience, callbacks/closures and
getCurrentEventLoop remain absent. Full enabled permissions, Node mounted-VFS
images and Node-API/addon lifecycle remain open. Future consumers must join the
same retirement protocol. The existing native FFI error renderer still defines
its own code property; exact target setter/name/stack/error policy remains open.

Actual guest GC/realm/security wrappers/OOM/resize/detach/shared/transfer/native
allocation pressure and teardown/cancellation behavior need identified-artifact
conformance on all four hosts. No finding/family closes. Full product rebuild
and overall suites remain deferred. Nested guest Wasm execution stays in scope,
scheduled last; the existing outer guest memory/dynamic-linker path is separate.

## Preserved failures

Keep both private missing-baseline generation failures, detached-null/public
Buffer factory frontend failures, initial teardown status durability failure,
original unsafe unload ordering and initial private target setup error. The
root first patch preflight failed because bootstrap context changed after the
handoff; no source was applied then. The root composes the narrow addition over
the current getter and preserves that preflight log. These failures are not
converted into passing API or runtime results.
