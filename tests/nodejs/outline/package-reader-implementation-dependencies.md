# Package file/parser/cache and CJS package entry owners

This partial loading-family source slice follows L-003/L-004 and related
package/type/error/cache obligations. The exact audited Node26.13.0 source/
native target, immutable audit and separate Claude/npm/Bun remainder stay
unchanged. No individual public API observation or family closes here.

## Actual implementation

* node-simdjson packages the exact Node-vendored simdjson.cpp/header/gyp and
  license inputs through normal SDK/resolver/private-sysroot roots. Both
  architecture source plans verify the exact pin; wasm32 was built normally.
  No parser feature, CPU or platform identity is spoofed. Its pinned one-TU
  gyp target has no extra feature overrides. A wasm64 build is still pending.
* package-config.h owns actual close-on-exec POSIX open/stat/read/growth/close,
  owned raw bytes, positive/negative file caching and real parent traversal.
  Only ENOENT/ENOTDIR/EISDIR become cached absence. Other read errors remain
  errors; malformed packages are not cached, so a correction can be retried.
  Parent traversal follows std::filesystem, trailing-directory context and
  the pinned root/node_modules stopping rules.
* generate-package-parser.py retains the exact native field parsing body and
  fields. The sole embedding changes replace its V8 error callback with a
  boolean invalid result and its USE macro with an explicit ignored result.
  The full field/type/duplicate/escaped-key/raw imports/exports algorithm stays
  intact. Actual simdjson, not JSON.parse approximation, parses native bytes.
* A real context-owned native cache class owns parser/maps/strings and frees
  them on finalization. The private bridge returns independently allocated
  six-field serialization arrays, native read status and actual diagnostic
  paths. Wrapper/string capacities are accounted; parser internals/map buckets/
  allocator overhead and complete overflow/OOM accounting remain incomplete.
* The full unchanged package_json_reader.js consumes this owner. Its caches,
  lazy imports/exports data, traversal path policy and scope/type helpers are
  real. File URL traversal uses the shared URL owner; Node VFS/permissions and
  complete private URL semantics remain dependencies, not platform exclusions.
* Pinned _readPackage getter/setter, tryPackage and extension/file helpers now
  serve actual CJS directory main selection. Public _readPackage overrides
  affect that selection. Main fallback/warnings, registered extensions and
  invalid-main/config errors replace swallowed JSON errors and index shortcuts.
  CJS type detection uses the real nearest-parent reader. Realpath errors are
  raised rather than silently returning the failed path.
* Recipe68/patch78 connect the native parser/cache, dependency, bundle and
  bootstrap through the normal engine package route. Public findPackageJSON,
  exports/imports resolution and package maps are not claimed from copying a
  private reader; their resolver/activation/engine owners remain unfinished.

## Bounded evidence

Six candidate reader/Module/bootstrap scenarios pass in
.context/node26-package-controls-r1/report.json. They cover main/custom
extensions, malformed metadata/invalid main, field data, public read hooks,
cache behavior and nested type diagnostics. The explicit fixture backend uses
pinned native parsePackageJSON and native VM/URL/fs/brands. Virtual-file and
UTF-8 string transport boundaries do not validate guest native byte/I/O paths.
Eighteen existing entry/record tests pass in
.context/node26-package-affected-modules.log, with zero skips/failures.

Twenty-three portable native file/parser/cache comparisons pass in
.context/node26-package-native/report.json. Actual pinned simdjson and POSIX
operations compare with native Node for duplicate/escaped fields, malformed
and invalid-UTF8 data, absent/directory/non-directory files, parent/trailing/
node_modules scope and positive/negative/invalid cache behavior. This is not
23 unique APIs or guest conformance. Cache-copy tests normalize only the known
physical candidate/reference filename identities, not outcomes.

The added invalid-parent diagnostic initially compared a fresh candidate
cache with a native path already negatively cached by an earlier case. That
22-pass/one-fail setup and inputs are retained. A fresh independent path now
compares strict native-derived diagnostics; assertions were not weakened.
An earlier unused candidate-derived diagnostic normalization was removed;
final expected values come from the native result/error alone. The initial
parser selector-tail and Mozilla include-order errors remain retained as
static/harness failures; the checker and pinned source were not modified.

Normal wasm32 dependency acceptance is retained in
.context/node26-simdjson-wasm32-accepted. Full pinned source/archive/section
identities, both architecture plans, generated bundle/bootstrap syntax, exact
patch apply/reverse and unchanged Mozilla include checks pass. These source/
backend results are separate from engine/package acceptance and guest runtime.

## Remaining dependencies

1. Connect actual CJS/ESM exports/imports/conditions/self-reference/package-map
   owners, full path resolution/realpath/cache and ESM graph/format/URL identity.
   Existing legacy bare resolution still does not enforce all exports policy.
2. Implement full CLI/default conditions and symlink/preload/module activation.
   Preserve-symlink options are not admitted by the current CLI; this slice
   implements the ordinary default CJS path, not those option/ESM modes.
3. Public findPackageJSON/default ESM resolver, hooks, source maps, TypeScript,
   public Node VFS and Permission Model, unmount cache ownership and source/
   prose questions remain missing or partial. The reserved VFS route explicitly
   refuses instead of silently reading a different filesystem.
4. Complete private URL/brand/getter/encoded-path behavior, error class/stack/
   descriptor fidelity, special files/read-error/race behavior, parser/cache
   allocation/GC/realm/shutdown/accounting and native failure cleanup.
5. Build/validate the actual guest bridge and identified artifacts on Node,
   Chromium, Firefox and WebKit. The future unchanged upstream catalog is not
   executed coverage; all nonpasses must remain separate. No overall suite or
   full product rebuild ran. Continue dependent package resolution next, without
   turning this into a larger loader-only validation campaign.

The normal targeted wasm32 engine68 build subsequently succeeded in 227.0
seconds with all 578 frozen source identities unchanged. The exact duration,
artifacts and original checks are in .context/node26-engine-r68-accepted.
This compiles the actual guest bridge; four-host runtime execution remains
pending and all resolution/URL/GC/resource gaps above remain open.
