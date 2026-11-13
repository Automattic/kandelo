# Native lazy data properties

This is a partial review of `util.defineLazyProperties`, required by original
`buffer.js` during principal startup. The complete util binding and backend
catalog remain incomplete. The pinned native contract and twelve indexed call
sites are in [util-lazy-properties-contracts.json](util-lazy-properties-contracts.json).
No upstream Node JavaScript or C++ function body is copied or rewritten here.

The SpiderMonkey extension stores a traced native callback record in a real
property slot. Its distinct property flag prevents ordinary data-slot fast paths
from exposing the record. Reads and descriptor queries invoke the native
callback and materialize an ordinary data value. There is no observable getter
Function. Plain assignment replaces an unresolved record without loading its
module; deletion and integrity-level changes also avoid loading. Descriptor
operations, including attribute-only `Object.defineProperty`, observe the current
value and therefore can load or throw. Enumeration of names alone does not load.

A successful computation caches only if the same record still owns the
property. It retains the actual latest attributes, including a freeze during
computation. Reentrant assignment, deletion or deletion followed by a new record
cannot be overwritten by the old computation. Throws leave an unresolved
property available for a real retry. Callback data and producer values are
traced from the slot across moving GC; native callback storage is finalized
with its record rather than held in a process-global map.

The util binding enters the target holder's actual creation realm and calls that
realm's protected original BuiltinRequire closure with a null receiver. It reads
the named value from the actual module exports. The original JavaScript loader
continues to own caching, cycles, source compilation and exceptions. Borrowing a
binding from another realm does not change the holder's loader. A failed owner
cannot load through a live caller. Proxy targets currently fail explicitly;
non-Node creation realms and full security/OOM/worker/cancellation coverage
remain open.

Principal-body admission now checks the actual registered principal realm
before compiling `internal/bootstrap/node`. The original native Node entry
assigns this body to PrincipalRealm. Secondary realms reject with the exact
`Error: Native Node bootstrap requires the principal realm`, enter the actual
failed phase, and retire their owned bindings. Earlier diagnostic fixtures had
incorrectly attempted this body in secondary realms. Those controls now test
admission and retirement explicitly. Genuine principal-body attempts remain
separate controls. The complete original Buffer principal-context assertion
remains intact and still has its direct fatal driver.

Nineteen shared native observations cover descriptors, deferral, attributes,
assignment, inheritance, retry identity, freezing, descriptor redefinition,
key-get exceptions, array targets and value enumeration. The authenticated
native reference runs without a restored Node snapshot. Ten additional
engine/embedding controls cover GC, private record lifetime, unusual keys,
numeric array slots, reentrancy and actual cross-realm ownership. Six fatal
argument-contract drivers preserve the original native assertion order. Job and
exit drivers exercise real Promise draining and unresolved-property retirement.
These observations are bounded evidence, not full interface conformance.

Native reentrant write/delete probes abort inside the authenticated reference;
redefining the currently computed property through a descriptor recurses.
The retained subprocess evidence is under `.context/node-lazy/integration/`.
Kandelo record-identity checks do not attempt to reproduce a native internal
assertion. These reentrant cases are engine-only controls and are excluded from
the nineteen exact native differential groups. The first expanded fixture also
recursively installed a record on its own unresolved property; its failed report
is retained. The final replacement control deletes before installing the new
record, so it tests actual replacement identity without recursive descriptor
materialization.

Original principal startup now reaches `JSONParse(binding.config)` at
`internal/bootstrap/node:135`, where the unavailable builtins metadata backend
throws `ERR_KANDELO_NOT_IMPLEMENTED`. This is a captured failure, not startup
acceptance. The next prerequisite is build-owned Kandelo/SpiderMonkey metadata
for frozen `process.config`, with an audit of its upstream consumers. Copying a
native V8 configuration or inventing empty configuration/feature flags would not
satisfy that interface. Normal node mode remains the legacy bootstrap.
