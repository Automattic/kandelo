# Private object marks and shared clone/transfer admission

Source106 addresses portions of worker finding R-013 and the shared Buffer/
clone policy. The frozen audit and exact Node26.13.0/source/native-reference
pins remain unchanged. This does not close a finding or establish worker,
structured-clone, environment-object or four-host conformance.

## Actual owners and upstream reuse

The two public transfer-mark functions are selected unchanged from pinned
`lib/internal/buffer.js`. The full pinned worker IO module still supplies
`markAsUncloneable`. Three private-key reads/writes are adapted to native
operations with exact source/selection checks, leaving primitive guards and
public function metadata in the upstream functions. The actual builtin route
installs those functions on the shared worker_threads API.

`native-object-marks.cpp` supplies the real engine operations. Patch99 owns a
GC-traced weak registry on the guest JSContext, with private own-object marks
that do not add observable JS keys or traverse prototypes. It keeps transfer
and clone denial distinct. Cross-realm keys are checked/unwrapped, then wrapped
into the registry's realm. This is engine state, not a facade WeakSet used to
pretend that a later serializer respects marks.

The actual transfer-list parser checks transfer denial before graph traversal
or buffer detachment. Buffer pool creation writes the same private mark and
its existing native non-detachable flag; the public predicate tests the mark,
not every reason a buffer might be non-detachable. Standard ArrayBuffer
transfer therefore continues to respect the actual detach restriction.

The actual graph serializer consults clone denial for the pinned target's
ordinary/custom-host object and Error dispatch. It leaves native Array,
ArrayBuffer/view, Map/Set/Date/RegExp serialization policy separate, following
the inspected V8 value-serializer source. Internal host re-registration resets
the clone override and preserves the distinct transfer prohibition. Marks do
not become clone payload properties and do not propagate to a copied object.

The public native binding rejects actual scripted proxies with the target's
TypeError/message and no user trap call. Reading their public transfer mark
returns false. The initial105 source allowed those proxies; its successful
compile is preserved but superseded by106. This follows the observed Node
private-key assignment policy, not an engine defect or accepted exclusion.

These are shared guest-engine/compatibility changes on every host. No host
adapter, kernel wire protocol, ABI version, serialization format or declared
memory ceiling is changed. New engine state uses ordinary traced WeakMap
allocation/lifetime rather than an untraced native table retaining JS objects.

## Evidence and exact limits

The normal resolver engine105 compilation and prebuild inputs are preserved
in `.context/node26-engine-r105-accepted`; that artifact predates the required
Proxy rejection correction and cannot validate the final source106 behavior.
The final106 artifact compiled through the normal resolver and is preserved in
`.context/node26-engine-r106-accepted/report.json`:49,674,334bytes, SHA256
`36b753e5dd02b6ad6e161dc1c659d8d8ce770a6284325c9b48eba7621aa7113e`.
Selected prebuild identities match the source checked after compilation. This
is not a complete immutable SDK/kernel/host closure or guest runtime result.

`.context/node26-object-marks-frontend-r3.json` records15passing controls:
four new public-marking cases and eleven affected port/Buffer cases. New cases
exercise actual public export aliases/metadata, primitive guards, frozen/sealed
objects, marks not inherited or reflected, proxy errors/no trap execution,
foreign-realm objects, validation before graph getters/detachment, actual Buffer
pool backing marks, copied marks and builtin/custom-host clone distinctions.
Their marking, serialization, port, Blob/Response, realm and event-loop
providers are explicit native Node dependencies. They do not execute the new
guest WeakMap registry, admission checks, native error construction or GC paths.

Two unchanged upstream files run in candidate and native modes:
`test-worker-message-mark-as-uncloneable.js` and
`test-worker-message-transfer-port-mark-as-untransferable.js`.
Source bytes are verified against the exact pinned archive. Candidate preload
replaces only the three marking frontends; native Node continues to own the
private marks, actual serializers, ports, Blob/Response and loop. Two files
executed twice are not four distinct passing APIs, full candidate port transfer
or guest conformance. Raw command/log/source identities remain in
`.context/node26-object-marks-upstream/report.json`.

Source checks compare seven unchanged Node/V8 reference files with the pinned
archive, verify the selected functions/private adaptations, regenerate/check
the bundle/bootstrap, apply/reverse patch99 exactly over four engine files,
run the unchanged Mozilla style checker and preserve the separate Bun loader
remainder. No new guest case, overall suite or full product rebuild ran.

## Nonpasses and decisions retained

The first frontend run passed14/15. Its new Proxy case incorrectly expected
successful marking. A separate exact native reference checked seven Proxy
forms, including empty handlers, property traps, callable and revoked proxies.
All public writes throw TypeError without invoking a trap; reads return false.
V8 objects.cc/message-template.h explain the private-key rejection. The test
expectation and actual native implementation were corrected to that behavior;
the original nonpass, original source105 and its compiled artifact remain
preserved. No upstream assertion, platform identity or skip policy changed.

A native-only environment reference accepts both marks on process.env and then
returns a true transfer mark. Kandelo's envProxy is a scripted JS Proxy. Its
current representation therefore conflicts with the required ordinary-Proxy
rejection policy. This is a concrete process/environment implementation gap;
there is no process.env whitelist or synthetic successful mark. Completing the
native environment exotic-object owner is a shared prerequisite. The public
marking surface remains partial for that reason as well as pending validation.

## Remaining dependencies and later validation

- Implement the actual environment exotic-object owner and shared/copy worker
  environment stores; reconcile marking, reflection and cloning through that
  owner. R-013 and process environment findings remain open.
- Exercise the real weak registry and private native binding with admitted,
  identified guest artifacts: frozen/sealed/revoked/proxy/foreign-realm objects,
  identity after GC/CCW collection, OOM/teardown, internal re-registration,
  mark persistence and clone/transfer failure/detach ordering. Compilation and
  native dependency controls cannot establish these properties.
- Reconcile all target builtin/prototype/host/error variants and error stacks,
  descriptors and standard ArrayBuffer transfer methods. All public clone and
  transfer entry points must use the same real state.
- Implement endpoint/context movement and registered native host transfer,
  BroadcastChannel/thread routing, shared locks, full Worker options/stdio/
  resource/lifecycle/measurement and parent/descendant ownership. Marking an
  object does not provide any of these capabilities.
- Keep historical engine83 guest worker results bound to those earlier bytes;
  no result is reassigned to106. Current kernel/image admission and four-host
  conformance remain required. No new accepted platform exclusion is declared.

Continue breadth-first implementation across independent audited owners.
Overall validation stays deferred until that pass and the authorized artifact
prerequisites are complete; failures/skips/unsupported/timeouts/harness errors
remain nonpasses.

## Source107 followup

The environment dependency now has an actual native virtual-Object
representation and property hooks; it no longer uses a scripted Proxy. The
new owner and receiver/extensibility/clone model compile in engine107. This is
source/compilation progress, not closure of R-013 or a guest marking result.
The native control reaches private marks without a Proxy exemption, but its
snapshot assertion remains a nonpass at Node's custom-addon serialization
boundary. Complete prototype/constructor/store/warning and real guest/GC/JIT/
clone behavior remain pending; see the
[environment dependency record](environment-object-implementation-dependencies.md).
