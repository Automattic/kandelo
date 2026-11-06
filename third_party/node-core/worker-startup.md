# Worker startup arguments and lazy-property prerequisites

The custom Worker constructor now captures/coerces argv before filename and
environment handling, using the pinned internal/worker.js block. It retains the
selected eval branch instead of invoking the options.eval getter again while
forming native bootstrap data. The existing native worker packet and startup
owners consume those captured values; no worker capability is synthesized.

The SpiderMonkey prefix creates classic eval process.argv with `[worker eval]`
and appends the captured argv using the ArrayPrototypePushApply semantics in
pinned internal/main/worker_thread.js. Array species may produce a non-iterable
array-like mapped value. Spread is observably different. Main-thread file/eval
argument construction is unchanged. This slice covers supported classic eval
and file workers, not unimplemented module/data-URL/TypeScript/input-type modes.

The focused fixture executes the actual candidate constructor and exact prefix
startup source, intercepting native create before it launches a guest thread.
It compares those results and getter/coercion/error order against actual pinned
Node worker messages and completed exit events. It does not execute the guest
native worker, native clone hooks, JSAPI or event loop. Native reference workers
retain their ordinary real thread ownership; no test keeper is added. Only
process.argv[1:] is compared because argv[0] names each actual executable.

Run with NODE_WORKER_STARTUP_REFERENCE and NODE_WORKER_STARTUP_OUT through the
declared dev shell, invoking tests/worker-startup/run-controls.sh. The assertions
require exact Node26.13.0; no missing artifact/version is counted as a pass.

## R-015 remains open

Pinned worker_threads.js:59-63 calls defineLazyProperties. node_util.cc:364-439
uses V8 SetLazyDataProperty: its getter has no JavaScript function representation
and obtains the holder's creation Realm before invoking builtin module require.
The existing JS locks/util accessors do not implement that property model.

Actual native controls establish: keys/has/set/delete/inherited-set do not load
internal/locks; descriptor lookup and defineProperty do. Seal, freeze and
preventExtensions preserve lazy state; later reads produce data descriptors
with the correct restricted attributes. An inherited read caches the holder,
without a new receiver property; a foreign vm receiver works. These are native
reference observations, not a candidate lazy-property pass.

SpiderMonkey's public native getter definition still exposes an accessor.
CustomDataProperty currently dispatches only array-length and arguments-object
get/set logic (NativeObject.cpp:2056-2077,2352-2367); its PropertyInfo flag is not a
general embedding lazy-data hook. A normal resolve hook cannot leave an own
lazy data property present through non-extensibility. The existing external
ObjectOps store is also insufficient: it refuses preventExtensions. Native
SetIntegrityLevel otherwise freezes native shapes rather than external stored
properties; the generic frozen path instead obtains full descriptors and would
materialize the value. Neither is the required lazy-data integrity owner. A proxy/manual accessor/placeholder value would not establish
ordinary native data-property semantics.

A genuine generic owner must cover native get/get-own-descriptor/define/set,
non-materializing own-key/has/integrity operations, holder/receiver creation
realm, deletion/shadowing/reentry/OOM, weak target/loader GC ownership and JIT/IC
shape paths. It must not let a hidden loader/cell escape as a slot value. That
owning-layer prerequisite is not implemented by this slice and is not an
accepted engine exclusion. No speculative engine patch is supplied.

## Global Navigator remains open

Pinned pre_execution.js:454-463 installs the native-lazy Navigator constructor
and the replaceable lazy navigator attribute. internal/navigator.js owns the
branded instance and its real CPU/default-locale/process identity bindings.
Its locks getter loads the original internal/locks singleton, independent of a
subsequently overwritten worker_threads.locks export. Native controls confirm
that distinction and the disabled-global CLI flag behavior.

Kandelo currently lacks that complete global owner/routing, the generic native
lazy-data property above, an availableParallelism adapter binding, and the
Navigator config/default-locale binding. This task adds no host navigator alias,
constant CPU/language value, substitute constructor descriptor or fabricated
worker metadata. Source and runtime acceptance remain separate. R-015, earlier
lock query/termination differences, real JSAPI/GC/clone/OOM/worker teardown,
other Worker options and four-host conformance remain open.
