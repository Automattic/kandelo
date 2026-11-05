# Legacy constants and sys modules

The source audit of these two module contracts is complete with concrete
gaps. This does not complete util, fs, crypto, OS or the values family,
and establishes no runtime conformance. No tests or builds ran.

## Constants aggregation, identity and descriptors

Pinned `lib/constants.js`:25–41 copies, in order, os.dlopen, os.errno,
os.priority, os.signals, fs and crypto constants onto its own normal
CommonJS exports object, then freezes that object. It is a separate
object from fs.constants and does not export nested os/fs/crypto
namespaces. Object.assign followed by freezing makes the copied own
properties enumerable, non-writable and non-configurable. Module caching
preserves its identity across ordinary bare/node: imports and CJS/ESM
paths, subject to the separate loader/cache rules.

`src/node_constants.cc`:126–1316 supplies the real constant families with
conditional OS/backend macros, including the string defaultCoreCipherList.
`node.h`:1154–1168 defines the numeric native property attributes.
Constants derive from the **guest** SDK, runtime and actual cryptographic
backend. A saved Darwin native descriptor list is not a requirement to
copy Darwin errno values or make Linux/Windows-only constants appear on
Kandelo. Conversely, known supported guest flags/signals/errors cannot
be omitted simply because the whole module is deprecated.

`bootstrap.js`:5804 instead aliases fs.constants. Its source is the
native getFsConstants function reached through adapter.js:552. The
generator `third_party/node-core/generate-fs-constants.py`:18–34 creates
a **plain**, extensible object, with readonly/permanent enumerable
numeric definitions, using pinned Node FS constant source and actual
guest SDK fcntl/stat/unistd macros plus the pinned portable/POSIX libuv
constants. It does not aggregate OS errno/signals/priority/dlopen or
crypto constants and does not create/freeze a separate legacy export.
The fs owner does not later replace fs.constants in the inspected final
assignments. The source candidate remains unbuilt.

V-012 therefore covers more than missing property names: module identity,
aggregate ownership, extensibility and freezing are wrong. The
`legacy-module-requirements.json` records per-name target definitions and
compile conditions, the saved native descriptor identities and whether a
name has a candidate FS definition. A source-defined FS constant is
source-backed/pending-conformance, not a proven numeric-value pass.

The runtime no-JIT recipe or embedding browser does not prevent correct
constant aggregation. Appropriate conditional absence/value differences
are guest OS/backend applicability, not permission to spoof platform
identity or populate invented native capabilities.

### V-026: crypto initialization changes the aggregate's input

`lib/crypto.js`:285–309 adds a configurable enumerable defaultCipherList
accessor to the shared native crypto constant object. Its first read
replaces it with the current --tls-cipher-list value; its setter replaces
it with the assigned value. If crypto initializes before the legacy
aggregate, Object.assign reads that property and the legacy export freezes
the resulting value. If the aggregate initialized earlier, its frozen
snapshot does not retroactively acquire that property. The saved capture
contains both defaultCoreCipherList and defaultCipherList. This is a
module-initialization/CLI dependency beyond the C++ constant definitions,
not permission to hard-code the saved capture as every startup's exports.
The later native controls must preserve and distinguish fresh-process
load orders. No new reference execution was performed.

### V-024: fs.constants has the wrong prototype

The same getFsConstants generator uses JS_NewPlainObject. Pinned
`src/node_constants.cc`:1368–1369 creates the FS constant object with a
null prototype. Unchanged `test/parallel/test-fs-constants.js`:25 checks
that prototype explicitly. Individual readonly numeric properties do not
repair that object-level mismatch. This also illustrates why checking
that the generator imports upstream definition lines is insufficient.

## Sys alias and runtime warning

Pinned `lib/sys.js`:23–33 sets `module.exports = require('util')` and
emits DEP0025 with type DeprecationWarning and the specified message.
Its properties, descriptors, callable identities, accessors and future
mutations are those of the **same util object**, not a cloned namespace.
Actual util method semantics remain assigned to the separate util audit.

No sys factory or final alias exists in the candidate registry. Policy
inventory recognition cannot supply it. V-025 records the missing alias
and load effect; every captured sys property is unavailable through that
entry point. This is a missing implementation on all four hosts, without
an accepted engine/platform boundary.

The deprecations are different: DEP0008 (`deprecations.md`:228–247)
is documentation-only and must not gain a runtime warning. DEP0025
(`deprecations.md`:598–616) is a runtime deprecation. Warning suppression,
redirection, trace/throw flags, delivery ordering and CommonJS cache-once
behavior depend on the actual process warning and module loader owners.
Neither label removes the module from this target's public scope.

## Existing evidence and proposed controls

The native capture supplies own descriptors for 236 constants and 225
sys rows, including aliases and function prototype metadata; it does not
evaluate getter results or establish other guest-platform values. Those
exact identities remain in the obligation crosswalk. Current-candidate
runtime evidence is absent; common-helper baseline failures remain
failures before most relevant assertions, not API conformance.

Later unchanged candidates are test-constants.js, test-sys.js,
test-fs-constants.js and relevant OS/crypto constant consumers. The first
uses --expose-internals and compares a private binding to public values;
its current unsupported launch must not be converted into a pass by
removing that flag or fabricating the private binding. Add native/guest
differential controls for frozen/separate identity, exact guest macro
values, aliases, ESM/CJS exposure and mutation, and load-warning count,
code/type/message/flags. All execution still requires authorization.
