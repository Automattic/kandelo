# getCallSites raw frontend

The public frontend consumes the pinned Node26.13.0 validators and overload
order, including inherited options, repeated sourceMap getter reads and count
validation. It invokes the existing native capture directly, preserving the
actual SavedFrame owner and its two private-frame skips. Frame IDs/positions
are never parsed from Error.stack or manufactured from source text.

A sourceMap:true request with no actual cached source-map entry returns the
original native call sites, as pinned reconstructCallSite does. The real
loader currently publishes no source-map cache. This fallback is not source
mapping support, and adds no always-undefined public cache/export or enabled
metadata. Mapping-required cases remain implementation gaps: actual compiler
sourceURL/sourceMapURL extraction, weak module-cache lifetime and URI identity,
global activation/default policy, native error/source lookup/stack formatting
and the getCallSites mapping consumer must still be connected together.

The existing SourceMap class decoder is real and stays unchanged. Historical
revision94 tests substituted only that class while native Node owned loader,
cache and stack behavior. They do not establish cache integration. The later
source-map-owner-prerequisite assessment also made no implementation change.

Raw frontend controls use a genuine pinned native CallSites binding. They do
not validate guest SavedFrame positions, realm/GC/reentry/Worker behavior, or
four-host runtime compatibility. Public mapping-required failures must not be
counted as passing compatibility merely because a no-entry request succeeds.
The pinned validation body derives from lib/util.js under the existing Node
license in third_party/node-core/LICENSE.
