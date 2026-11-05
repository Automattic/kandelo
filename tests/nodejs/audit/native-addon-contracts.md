# Node-API, addon and embedding contract audit

This is a source audit, with no addon compilation, runtime execution or
new conformance capture. Node source references use the exact Node
26.13.0 commit and verified source tree in [target-pins.md](target-pins.md).
The member matrix and documentation crosswalk distinguish missing guest
APIs from concrete binary/engine boundaries.

## Exposure and actual lower owners

There is no Node-API environment, registration bridge or public C ABI in
the candidate SpiderMonkey recipe, patches, native core implementations,
compatibility adapters or SDK sources inspected. In particular, no
`napi_*`/`node_api_*` implementation or registration export was found.
The builtin module registry is not a Node-API registry. Most Node-API
functions are native C exports, not JavaScript module properties.

`bootstrap.js`:6250–6330 reads candidate modules as source. The separate
preserved Bun asset loader explicitly rejects its `napi` classification;
this is not an ordinary Node addon loader. `Module._extensions['.node']`
is null at 6129, and implicit extension resolution does not add `.node`.
No public `process.dlopen` bridge supplies Node registration. Exact
loading defects remain linked to L-021 and NI-005; the Claude/npm/Bun
remainder was not edited.

The real Wasm loader in `libc/glue/dlopen.c` and
`host/src/dylink.ts`, called from `worker-main.ts`, supplies library
transactions, relocations, symbol addresses, initializers and close.
It does not supply JavaScript value handles, environment identity,
registration/version negotiation, GC roots or Node addon callbacks.
Existing `native-work.cpp`, `native-async.cpp`, buffer/clone owners and
SpiderMonkey GC/job/worker APIs are potential prerequisites, not a
Node-API implementation. There is also no owned `uv_loop_t` implementing
the libuv pointer contract already identified for FFI.

All four hosts run the same guest bridge and therefore share these
missing APIs by source inference. Host linking, shared memory, pthread
dispatch and worker shutdown still require distinct later evidence.
Embedding Node's own native addons do not establish guest support.

## Node-API requirements

The companion `native-addon-requirements.json` preserves per-section
requirements, exact header declarations and conditional compilation gates.
It includes API types and narrative requirements, without inventing a
`node:n-api` builtin. The following contracts govern every function;
none has a reachable candidate implementation.

| Contract | Exact target source and required behavior |
|---|---|
| ABI/version and registration | `node_version.h`:100–115 requires direct module ABI 147, supports Node-API 1–10 and defaults addon API version to **8**. `node_api.h`:36–90 defines legacy registration and symbol-based initialization/version functions. `node_api.cc`:686–817 selects version-specific initialization; initializer return replaces exports, null preserves supplied exports. Defining `NAPI_EXPERIMENTAL` exposes additional APIs and finalization constraints; it is not permission to claim every experimental API stable. |
| Opaque values and environments | `n-api.md`:478–1034: per-agent environment and per-addon instance data; an env cannot be reused across workers or after teardown. JS handles and callback info have real engine ownership, not numeric lookalikes. Instance-data replacement does not call the former finalizer. |
| Errors and exceptions | `n-api.md`:1036–1520: status/out-parameter results, pending-exception behavior, last-error lifetime, permitted cleanup calls while an exception is pending, throw/create error families with optional code/name changes, get-and-clear, fatal exception versus non-returning fatal error. Extended diagnostic text is not a stable assertion contract. |
| Roots, scopes and references | `n-api.md`:1522–1903: nested scopes close in reverse order, one escaped handle per escapable scope, weak/strong reference counts, collected weak values return null. API version 10 additionally permits references to all value types; primitives have no weak semantics. Local, global and well-known symbols differ in collectability. |
| Cleanup/finalization | `n-api.md`:1905–2049: LIFO hooks, duplicate/missing synchronous-hook abort conditions, asynchronous removal handles and completion, cleanup before finalization, forced worker teardown with JS execution disallowed. Basic finalizers cannot use JS-affecting APIs; post-finalizer work runs outside GC. |
| Values and conversions | `n-api.md`:2170–4003: actual array/object/date/buffer/external/string/symbol/BigInt creation; lossless flags and 64-bit-word ordering; encoding lengths/truncation/NUL rules and optional output pointers; references protect borrowed data. Number conversions retain target truncation/nonfinite rules and differ from BigInt conversion. |
| External/shared storage | `n-api.md`:2524–2660,3098–3226 and `js_native_api.h`:427–450: external buffers retain foreign storage until finalization. External strings may copy, reporting `copied` and immediately finalizing the original in that case. Experimental external SharedArrayBuffer uses a **no-env** finalizer on an arbitrary thread and may outlive its originating environment. Public documented `napi_no_external_buffers_allowed` is a possible concrete runtime restriction, not an accepted unexplained Kandelo exemption. |
| Abstract operations and brands | `n-api.md`:4005–4445: real ECMA coercion, reentry and pending exceptions, distinct null/external type values, brand tests, equality and detachability. `napi_is_buffer` accepts Buffer or Uint8Array; do not substitute only the public Buffer.isBuffer result. |
| Keys/descriptors/prototypes | `n-api.md`:4447–5131: ordered key filtering with own/prototype and number/string modes, symbols, inherited versus own lookups, getters/proxies and exceptions; real property attributes and static class members; freeze/seal; experimental prototype and multi-property object creation. Default descriptor flags do not equal normal assignment flags. |
| Calls/classes/wraps | `n-api.md`:5133–5930: real `this`, constructor/new.target and callback data; argument-count query/truncation/undefined filling; native class instance mapping; duplicate wraps reject, remove-wrap cancels finalization, type tags survive prototype manipulation; finalizer/reference ordering and delayed finalization. |
| Async work/callback scopes | `n-api.md`:5931–6272: execution off the JS thread, completion on its owner with async context; cancellation only before execution and exactly-once cancelled completion; do not delete before completion. Custom callback scopes restore context and drain nextTick/Promise work before returning to native code. |
| Deferreds/scripts/memory | `n-api.md`:6337–6556: promises tied to one deferred released on settlement; external-memory accounting informs actual GC without guaranteeing a collection. Run-script executes in the global scope without caller lexical access or caller strictness inheritance. |
| Thread-safe functions | `n-api.md`:6588–6931: bounded/unbounded queue behavior, blocking/nonblocking modes and queue-full status, owner-thread callback dispatch, acquisition count distinct from event-loop ref/unref, abort/closing and shutdown cleanup with null env/JS callback. Version 10 sends uncaught callback errors through uncaughtException. No specific number of callbacks per tick is promised. |
| Metadata/native loop | `n-api.md`:6274–6335,6558–6586,6935–6958: truthful supported API/version/release fields; actual environment `uv_loop_t`; module filename is an env-owned absolute URL or empty if unavailable. A task queue pointer or embedding-host loop is not the guest libuv object. |

The public headers extend heading-only discovery. `js_native_api_types.h`
includes `napi_float16_array`, `node_api_noenv_finalize` and legacy
nogc/basic aliases. These must retain exact enum/typedef compatibility.
`node_api.h`:5–9,53–58 and `js_native_api.h`:15–19 explicitly contain
`__wasm__` declarations (`napi` import namespace and
`napi_register_wasm_v1`). Their presence alone does not establish a
supported native Node Wasm-addon loading workflow. That admission path
is an explicit unresolved target question, rather than grounds to remove
portable Node-API behavior from the inventory.

## Addon admission and direct-engine boundaries

`addons.md`:1–45 separates Node-API from nan and direct V8/Node/libuv
addons. The last two are tied to V8 and its C++ object/layout/API model.
Unchanged ELF/Mach-O/PE machine code cannot execute as a Wasm guest
library. Unchanged V8 C++ addons cannot link against SpiderMonkey's
different C++ API. Those are concrete artifact/engine boundaries;
implementing engine-independent Node-API against SpiderMonkey remains a
missing bridge, not such a boundary.

Node-API ABI stability does not include arbitrary linked libuv, Node C++
or V8 APIs (`n-api.md`:92–154). Source-build recipes require guest target
headers/ABI and actual C/C++ tooling; npm packaging or `.node` suffix
alone does not make a downloaded host binary admissible. No new toolchain
or build configuration was changed or exercised in this audit.

`node_binding.cc`:743–921 establishes permission and --no-addons gates,
argument coercion, loading errors, initializer lookup, version checks,
cleanup before errors and unlocking before user initializer reentry.
`addons.md`:114–279 requires context-aware registration and worker-safe
per-instance data, LIFO synchronous/asynchronous cleanup. Direct
ObjectWrap destructor/GC behavior is separate from explicit shutdown
cleanup. Portable argument/callback/object-factory semantics still need
the owning engine bridge, even when unchanged V8 source is out of scope.

`addons.md`:439–465 and `esm/translators.js`:655 onward expose native
addon static/dynamic imports behind `--experimental-addon-modules`,
with a warning and null loader source. A CJS loader by itself does not
implement this activation, ESM namespace or permission behavior.

### NI-011: target documentation/source conflict for VFS addons

SEA docs:307–311 say `.node` files cannot load directly from the VFS.
However, `lib/internal/vfs/setup.js`:1054–1074 installs a real
`process.dlopen` wrapper that reads VFS bytes and calls the internal
`dlopenBinary`. `src/node_binding.cc`:743–921 materializes a private image,
requires addon and temporary-file write permission, and closes/cleans
failed loads; Linux uses memfd, other platforms use their actual paths.
The wrapper preserves the no-flags native call rather than forwarding
undefined as flags.

Unchanged `test/parallel/test-vfs-addon.js` explicitly tests this behavior
and cleanup. It requires `--experimental-vfs` and a built hello-world
addon; its fixture-not-built skip must remain nonpassing evidence.
The source test's comment about a public binary option is also stale:
the current implementation uses an internal separate binding. This audit
records the inconsistency, keeps the target unchanged and proposes a
native differential control later. It accepts no blanket VFS-addon
restriction based solely on the contradictory prose.

## C++ embedding

`embedding.md` delegates the API to public `src/node.h`; it does not
promise C++ ABI stability across Node majors. The example needs Node/V8
per-process initialization, CLI error/early-return state, a registered
MultiIsolatePlatform and per-instance environment, actual `v8::Isolate`,
main context, ArrayBuffer allocator and `uv_loop_t`. Environments sharing
IsolateData share the loop. FreeEnvironment closes its own handles while
other environments' callbacks may still run.

LoadEnvironment's internal require is builtin-only; ordinary disk require
is explicitly constructed through Module.createRequire. SpinEventLoop
and Stop/worker-like termination need their real event-loop semantics.
The candidate SpiderMonkey shell's lifecycle and outer `KernelHost` do
not implement these C++ symbols or ABI. Exact V8 C++ embedding is a
concrete engine/source-interface boundary. Public guest JS behaviors
illustrated by the example remain assigned to their compatibility owners
instead of being excluded with that boundary.

The separate [header/packaging review](native-packaging-embedding-contracts.md)
now records the complete public own-header contracts, overloads, members,
flags and inline algorithms, including node_buffer.h/node_object_wrap.h
and installation applicability. Direct V8 handles/layout remain an exact
interface boundary; portable Node-API and core behavior remain missing
implementation, with no new runtime evidence.

## Proposed later validation and remaining questions

Preserve unchanged `test/node-api`, `test/addons`, `test/js-native-api`,
`test/embedding` sources and their category launchers/build fixtures.
Use reference-native addons for the actual Darwin arm64 reference and
separately built guest Wasm artifacts for Kandelo. Fixture architecture
must never be faked to suppress a loader error. Verify registration/version
failure cleanup, environment/thread identity, GC/scopes/references,
callbacks/reentry, teardown, queue saturation/cancellation, errors, shared
storage and real handle leaks. Each host needs identified artifact and
status accounting. No cases were executed by this audit.

Open questions: Node's
`__wasm__` header admission workflow; exact guest external/shared buffer
capabilities and Float16 engine support; real guest libuv integration;
VFS documentation/source discrepancy resolved by later native control.
These questions do not change the definite missing Node-API bridge.
