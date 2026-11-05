# Public SourceMap ownership and loader dependencies

Current integration checkpoint: the normal targeted engine96 build compiles
the source through95 with guest OpenSSL3.5.9; four focused Node-host
differential controls pass. Current source99 includes metadata97, sync whole-file98 and queued
promise write/append99 owners; these remain guest-uncompiled. Changed kernel/host
and complete four-host conformance remain outstanding. Recipe-stage
compilation statements below describe their historical checkpoints. See
[the current build and evidence record](engine96-integration.md).

Recipe94 adds the full unchanged pinned SourceMap class to the actual Module
owner. This advances L-009/L-033 in scope only. Exact Node26.13.0 target,
source and native-reference pins and the frozen audit remain unchanged.
There is no new native bridge or compilation in this slice. The accepted
guest engine remains88; source94 and the combined candidate are unvalidated
on the four hosts.

## Reused implementation

source-map-platform-adapter.js supplies captured primordials and the shared
real validators to the complete lib/internal/source_map/source_map.js. The
manifest checks the full file identity and build.py embeds it without any
algorithm or assertion adaptation. V8/Blink BSD copyright/license headers
remain verbatim in both retained input and generated bundle.

The class owns payload handling, actual base64 VLQ decoding including signed
integer edges, indexed-section offsets, mapping sort/range search, names,
source fields, findEntry and one-based findOrigin queries. It owns real
decoded mappings rather than predetermined answers or a host-source-map
alias. The normal bootstrap installs it as Module.SourceMap, with the same
Module/module/node:module object and normal property descriptor.

The stored source_map_cache.js and lib/module.js are source references, not
installed cache/support implementations. Native Node findSourceMap and its
cache are used only by the explicitly native upstream control. No production
cache, stack mapping or support flag is synthesized by this class.

## Exact target semantics clarified

The audit's general clone/line-length descriptions must not be interpreted
as a deep snapshot guarantee. Source inspection and exact native controls
agree on the following:

* Payload and its top-level array fields are copied. Reading payload returns
  another such copy; mutating a returned sources/names array does not modify
  the stored one.
* The constructor retains a nonempty input lineLengths array. The getter
  returns a copy, but later mutation of the original input remains visible.
* Section/map objects inside the top-level sections array remain referenced.
  A later nested mutation can appear in payload, while the already-decoded
  mappings keep their initial values.
* The standalone constructor uses its supplied sources, without applying
  sourceRoot URL normalization. Loader/cache preprocessing has a separate
  responsibility for canonical source identities.

These refine the implementation interpretation using the exact pin; no target
pin, upstream assertion or frozen audit record was changed. No upstream defect
or broader engine/platform exclusion is asserted.

## Scoped evidence

source-map-finding-progress.json records source/artifact identities.

* .context/node26-source-map-frontend-r1.json: five new source controls and
  eight affected Module-record controls pass (13/0/0). Real pinned map
  fixtures, indexed/ordinary queries, negative/VLQ ranges, actual source names,
  payload/alias/descriptor/receiver behavior and the actual bootstrap binding
  are checked against native26. Native VM/filesystem/module dependencies are
  explicit; this is not a guest loader or browser test.
* .context/node26-source-map-upstream-r1/report.json: one unchanged public API
  file passes in native and adapted modes, with no skips. Adapted mode
  substitutes only SourceMap. Capture/findSourceMap/stack assertions in that
  mixed file remain native Node controls; their success does not validate
  Kandelo's absent owners. Constructor/query branches execute the candidate.
* .context/node26-source-map-source-r1/report.json: four source commands and
  exact archive/input/map fixture/frozen-audit/pin/license/registration checks
  pass. This checks generated bundle/bootstrap syntax, not guest compilation.

The evidence dimensions overlap and are not completed API/family counts.
Historical nonpasses, including the separate Performance milestone failure,
remain retained. No overall suite or full product rebuild was run.

## Remaining ownership and validation

The loader must still capture real CJS/ESM/generated source and source-map
URLs at actual compile/graph transitions; normalize source roots and file/
data/URL identities; retain/invalidate cache entries with Module, error,
worker, VFS and failed-load lifetimes; read external or inline map bytes;
and connect enabled/node_modules/generated-code policy to actual native
stack/callsite remapping. Public findSourceMap/getSourceMapsSupport/
setSourceMapsSupport are not implemented by exporting SourceMap. Neither
copied cache reference source nor native control results establish them.

Exact guest private-field/error/descriptor/realm behavior and normal product
loading need identified-artifact controls across Node, Chromium, Firefox and
WebKit. The rest of L-009/L-033 (hooks/compile cache) and the complete loading,
CLI, module identity and all other-family audit obligations remain open.
Continue independent source owners before deepening this helper's test
campaign. Overall suites and the full product rebuild remain deferred.
