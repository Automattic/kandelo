# Native live environment object and remaining process owners

Source107 addresses portions of PROC-001/PROC-013 and the environment-object
dependency discovered under R-013. The frozen audit, exact target/source/native
pins and prior results remain unchanged. No finding or family is complete.

Follow-up: the [targeted kernel admission and guest controls](kernel-admission-integration.md)
resolve the old kernel rejection and record three matching native/actual
Node-host guest cases on engine107. These are separate from the earlier
native addon's retained snapshot nonpass and do not establish browser or
complete environment conformance. Statements below describe the original107
checkpoint before that follow-up.

## Owning representation

`native-environment-object.cpp` implements a native virtual Object with actual
lookup/get/set/has/define/descriptor/delete/enumeration hooks. Its traced reserved
slot owns the private callback record; it has no public scripted Proxy, cached
property dictionary or process.env marking exception. The callbacks in
`process-state-adapter.js` reach the existing live native process environment
or the existing per-worker environment store through the production adapter.
Main-process libc names/values are still copied under the real environment
mutex before JS allocation; set/unset reaches actual guest process state.

The owner normalizes indexed keys to strings, supplies live enumerable/writable/
configurable data descriptors, preserves descriptor restrictions and symbol
coercion, and delegates missing string reads to the current prototype. Symbol
reads are intercepted as undefined while prototype membership remains a real
has operation. Inherited writes follow the actual receiver and ordinary
writable/accessor rules, using SpiderMonkey's existing SetPropertyByDefining
body; they do not update the environment merely because it appears in a
prototype chain. No shadow JS property is created after a rejected POSIX name.

Patch100 adds an explicit generic virtual-Object model and extensibility policy
on the engine's ClassExtension. The new object's real ObjectOps/newEnumerate
hooks implement that model. GetBuiltinClass and clone traversal can therefore
use Object semantics instead of rejecting a custom opaque class. Prevention of
extensions is refused because its externally owned key set remains mutable.
The engine's existing enumeration/copy/clone fast paths already exclude classes
with the newEnumerate hook; no parser/test/platform spoof supplies these keys.
The environment-name array now defines own elements instead of invoking a
poisoned Array prototype setter.

The public worker marking APIs now receive a real non-Proxy object, so ordinary
Proxy rejection and environment private marks need no whitelist. Shared private
registry and clone admission from106 remain the owners of marks. NativeObject
setter linkage and internal JSAPI ClassExtension layout change together in the
fresh engine build; no kernel/host/program wire ABI or serialization format is
changed. No host memory ceiling, full product build or host-specific path is added.

## Compilation and bounded evidence

The normal targeted wasm32 engine107 compile succeeds. Its exact artifact,
prebuild inputs rechecked after compilation and build receipt are retained in
`.context/node26-engine-r107-accepted/report.json`. This is not guest execution
or a complete immutable SDK/kernel/host closure. The retained old kernel-policy
preparation rejection is not bypassed, restamped or credited as a new run.

The final native-dependency frontend report has16cases:15pass/1fail. Eleven
existing process/version/umask/lifetime cases pass. Four new cases pass for
native property identity/private transfer marks, inherited receivers, symbol
get versus prototype membership, and refusal to seal a live key set. Candidate
JS property policies execute through a compiled V8 interceptor dependency over
actual native environment state; the guest JSAPI implementation/GC/JIT/clone
writer are not executed. Native reference scripts separately confirm actual
Node environment prototype, receiver/symbol/integrity behavior and snapshot/
mark semantics. No environment variable contents are published by those scripts.

The snapshot assertion remains a failed case. Node's serializer has a dedicated
EnvProxy-template branch in node_messaging.cc; the test addon's custom native
interceptor object is outside that branch and is rejected as an unsupported
host object. Removing its Node ObjectWrap/internal field did not make it the
actual Node environment template. The assertion was preserved, not replaced
with acceptance of failure, a skip or a synthetic clone. An independent native
reference using Node's actual environment constructor passes the unchanged
snapshot/private-mark expectations. Guest snapshot/mark behavior is still
unvalidated. This fixture boundary is not an accepted Kandelo platform exclusion
and does not count as passing compatibility.

The native control's source and binary identity are retained. Its repeatable
builder runs inside the repository dev shell, verifies source archive/header
identities against the exact audited Node pin, and builds only that native
helper. With the pinned source prepared, run:

```sh
scripts/dev-shell.sh bash tests/nodejs/build-environment-native-control.sh
```

`KANDELO_ENVIRONMENT_NATIVE_HELPER` selects an explicit helper; absence is a
visible preparation error. There is no fallback to a JS Proxy or native
process.env that would bypass the candidate policy callbacks. These native
source controls need no admitted guest product. Source checks verify the two
unchanged Node reference files, bundle/bootstrap syntax, exact patch application/
reversal over six engine files, the unchanged Mozilla checker and the untouched
Bun loader remainder. No unchanged upstream test file was newly run this slice.

## Nonpasses retained

The first source preparation named a nonexistent node_env_var.h; the actual
KVStore declaration/reference is util.h. The initial source checker rejected
inline-header order in the generated native unit; the generator now orders
inline implementation headers after ordinary declarations, with the checker
unchanged. Raw failed checker diagnostics and both source-check directories
are retained.

The first native addon compile failed against changed V8 API signatures; the
correct target headers supplied the required callbacks/prototype operation.
A later compile rejected a private constructor through make_unique; ownership
construction was corrected without changing its policy. Both failed sources/
logs remain retained. Three successful native helper compiles and two failed
attempts are separately accounted. Frontend run2 and run3 each preserve the
14pass/1fail clone-boundary result; final run4 is15pass/1fail after an independent
marking control. Repeated cases are not additional API coverage. Original failed
input/source/binary copies and final identities remain in the evidence snapshot.

## Remaining owners and validation

- Native guest execution must verify actual hooks, private marks and graph
  snapshots, receiver/prototype/descriptors, key order and JIT cache freshness,
  cross-realm/CCW/GC/OOM/teardown and poisoned intrinsic behavior. The native
  interceptor cannot validate SpiderMonkey's virtual-property model.
- Node's actual environment prototype has an anonymous native constructor and
  a separate Object prototype layer. This source keeps the earlier Object
  prototype; complete constructor/prototype/realm/descriptor behavior remains
  an implementation gap, not fabricated constructor metadata.
- Integer-name enumeration ordering, exotic reflect/set/define overloads,
  complete UTF8/NUL/POSIX-name/store error behavior and generic integrity-error
  messages need exact source/native/guest reconciliation. The owner is not
  certified complete by the representative native controls.
- Pending deprecation/warning ordering, TZ/date-cache invalidation, privileged
  reads/permissions and public environment replacement remain independent
  process-policy requirements. Main libc writes and existing worker copies do
  not supply SHARE_ENV, full worker store semantics or lifecycle ownership.
- The custom native control still needs a faithful snapshot-delegate boundary,
  or actual admitted guest checks must supply that evidence. Its failed assertion
  stays visible meanwhile; source-only control collection is not a full pass.
- Current kernel/image admission and all four hosts remain prerequisites for
  runtime claims. Browser memory/lifecycle gates and applicable conformance
  belong to the later authorized validation phase. No accepted platform limit
  or individual API closure is added here.

Continue breadth-first work on independent audited owners. Preserve the failed
snapshot case and existing historical results; keep overall suites and the full
product rebuild deferred.
