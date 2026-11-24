# SpiderMonkey engine library

Builds the pinned SpiderMonkey 153.7 ESR archive through Mozilla's build system,
without its JavaScript shell. Outputs are the static C++/Rust libraries, public
and generated headers, private headers matching those libraries, and pkg-config
metadata. The engine owns execution, parsing and GC; upstream Node owns startup,
loaders, options, scheduling and resource policy.

Apply every complete patch in `base-patches/`, then every patch in `patches/`,
in filename order. These directories contain only production engine changes.
The build rejects patch failures, fuzz and offsets and generates its provenance
receipt in the private build directory. There is no historical patch-selection
manifest and no dependency on the standalone shell package's patch chain.

Node builds its internal bridge in `spidermonkey-node/bridge` over this engine.
This library alone is not a Node-compatible SDK. Keeping it cached separately
avoids rebuilding Mozilla for Node adapter changes. The standalone SpiderMonkey
shell still uses its independent upstream build; it does not yet share this
library build.

The simplified source tree and develop reconciliation have not been built or
tested. Earlier receipts describe earlier artifacts, not this review update.

## Maintained embedding boundary

Node context fields use SpiderMonkey's global application slots. Node private
keys use engine-owned hidden properties: upstream Node JavaScript deliberately
reads `object[privateKey]`, which an external WeakMap cannot supply. The bridge
creates and converts the keys; the engine owns lookup, reflection, proxy rules
and tracing of the actual property values. This is separate from language
`#private` fields. Async-context snapshots use the original job host-data APIs; the
small `preservesHostDefinedData` option retains that data for observable
optimized reactions. The engine owns its original queues and dispatch.

Corrections to buffer ownership, saved sources, parser metadata and compiler
locations are folded into their final capability patches. The direct Rust
target mapping describes Kandelo without a temporary Linux profile. The
standalone shell's independent patch selection is unchanged.

These source reductions are unbuilt and untested. Dynamic-import completion
still uses the previous extension. Node can supply cross-compartment namespaces
and controls whether to evaluate returned modules and how to validate import
attributes. A plain replacement with engine module completion changes those
contracts; a complete replacement needs further review.

## Patch justifications

Every patch in `base-patches/` and `patches/` starts with a comment explaining
its consumer, why the current build or bridge needs it, and possible replacements.
These comments are patch metadata; they do not change the applied engine code.
Retention is provisional. In particular, the inherited parallel-GC task change
and legacy module-cycle relaxation still lack current-baseline necessity evidence.
Comments describe that uncertainty rather than establish an upstream defect.

## Future work: platform omissions

- [ ] Review a narrower generic engine interface for native private keys,
  backed by bridge storage if it can preserve ordinary JavaScript access,
  hidden enumeration, own-only lookup, proxies, frozen objects and GC. Native
  `SetPrivate`/`GetPrivate` tests alone missed Node's bootstrap read. Keep the
  restored capability until a faithful replacement passes both kinds of access.
- [ ] Review **every retained engine patch and each separate purpose within it**
  for missing Kandelo platform support before treating it as a permanent engine
  requirement. The Node bridge/package maintainer owns this review and must
  identify the responsible SDK, libc, kernel, host or bridge owner for each
  proposed replacement.

For each patch, trace the actual consumer and check upstream configuration and
public/friend APIs first. Determine whether it compensates for an OS/SDK omission,
implements Node policy that belongs in the bridge, or supplies a genuinely
missing engine capability. Record the concrete replacement, ownership and cleanup
rules, remaining private interfaces, upgrade cost and evidence needed for removal.
A build reference alone does not justify a patch, and an API with a similar name
does not establish equivalent behavior.

The current combined source cleanup moves constructor-name selection/history,
saved-source records, buffer leases, native property callback records and decoded
cache-origin mapping into the bridge. Engine changes retain generic observation,
GC/lifetime and compiler operations. The bridge registers the resident fatal
logger, so this core library no longer depends on Node's logger, libuv or
v8-tracing. Rust entropy implementation and Wasm symbol inspection live in
package-owned `platform/` sources. All these changes remain unbuilt/unqualified.

Continue reviewing exact pthread stack bounds, the unproven parallel-GC task
workaround, legacy module-cycle relaxation and shared Rust runtime/personality
ownership. The latter remains unresolved; weak linkage is not proof that mixed
Rust runtimes agree. Preserve their evidence-dependent patches until a faithful
replacement and its required qualification are established.

Preserve real GC, thread, context, callback, exception and shutdown behavior.
Keep the agreed dynamic-import extension until a faithful replacement is reviewed.
Any source iteration requires review before implementation, followed by a diff
review before separately authorized builds or tests. Validate replacements through
the normal package pipeline on Node, Chromium, Firefox and WebKit against exact
artifacts; preserve existing assertions, timeout budgets and failure accounting.
Do not remove required behavior to reduce patch counts. The complete 19-family
Node conformance effort and B6 catalog/roadmap review remain required.
