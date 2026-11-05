# Shared package resolution, maps, conditions and filename identity

This partial loading-family slice follows L-003/L-004 and related public
Module/package/URL/activation obligations. It does not close a finding,
individual API observation or family. Exact audited Node26.13.0 source/native
pins, original audit and separate Claude/npm/Bun remainder are unchanged.

## Actual owners and consumers

The full unchanged target ESM resolver, format module and package-map module
execute over the actual package reader/cache, filesystem, URL and process
owners. Pinned CJS conditions, ESM conditions, filename/path lookup, exports,
imports, self-reference, finalization, watch reporting and error helpers are
selected from full hash-checked references. Public Module.findPackageJSON is
the actual unchanged reader function; its default-resolver dependency now
exists rather than a copied function being exposed without its owner.

CommonJS resolution uses actual _findPath and _resolveFilename policy. It
honors exports encapsulation, conditional/pattern/array/null targets, imports,
self-reference and exclusive package maps. Custom extensions and main/file
fallback keep their real owners. Module loading consumes the selected
filename directly; a second realpath no longer undoes preserve-symlinks
policy. Synthetic CJS-interop keys preserve that selected alias as well.

The engine's existing resolver callback consumes the shared URL resolver,
including its resolution-only operation. Package errors propagate through
its existing failing JS-call path instead of being swallowed and retried as
unrestricted filesystem lookup. Resolution-only node: URLs follow the pinned
resolver's policy rather than requiring an instantiable builtin. Actual ESM
execution/namespace/source/graph/cache identity remain separately incomplete;
resolved URLs and executing modules are different contracts.

Package maps load/parse/realpath their real file and own actual lazy state,
dependencies and caches. Lookup failures do not fall through into unlisted
node_modules. The actual CLI admits repeatable --conditions/-C, package-map
paths and preserve-symlinks/main, including environment/command-line parsing.
An immutable bootstrap snapshot supplies private policy input. Existing
unsupported switches still reject; their absence is not passing support.

Legacy package-main probing uses real file state and the pinned 7/10 probe
order. Bounded actual four-byte reads distinguish extensionless Wasm. The
unchanged format module classifies files; a source-syntax-parser dependency
explicitly rejects when requested. It is not supplied by the old execution
heuristic. TypeScript/addon format classification is not successful stripping,
addon loading or complete execution. The pinned header and native reference
confirm addon modules default enabled; that classification was corrected.

## Evidence, boundaries and retained failures

The final focused report .context/node26-package-policy-controls-r7/report.json
compares eleven actual-source profiles with separate pinned native processes.
They cover exports, conditional/pattern/invalid/null targets, imports and
builtin/external targets, self-reference, maps with/without exports, symlink
resolve/load and main identities, file-type metadata, URL queries/fragments,
public package-JSON discovery and the engine-facing resolution-only consumer.
Exact errors/warnings/results are native-derived. Only realm object prototypes
are normalized by serializing the result/error fields; stacks and unselected
metadata are not claimed. Each native process and candidate use the same
physical fixture tree and current directory. Native parser/cache, URL/VM/fs/
Buffer/error/process dependencies are explicit; this is not guest JSAPI,
CLI, kernel/backend or four-host runtime conformance.

Fourteen portable CLI comparisons compile the actual candidate tokenizer,
string/boolean options and argument parser. Native actual option values and
execArgs agree, including environment ordering/quotes, conditions aliases,
map paths, symlink negation and missing-argument failures. The first 12-pass/
two-fail report retained empty and separate-dash conditions being accepted;
both parser branches were corrected without changing expected results.
.context/node26-package-policy-cli-r2/report.json retains the final controls.

Eighteen affected entry/record tests and three unchanged Module files run
separately as candidate/native. The upstream test/assert/common and native
VM/fs/URL/environment dependencies remain native; these are bounded public
Module/record/require/lookup controls, not a full loader suite. Original
assertions, source identities and all results remain retained.

The added main-symlink scenario initially used a native path boundary whose
host cwd differed from the candidate process boundary. Its failed result is
retained; the fixture now aligns actual cwd with the reference process and
restores it in finally. The added extensionless-metadata scenario exposed a
missing Buffer dependency in the control VM, not in guest bootstrap; that
10-pass/one-fail report and original inputs are retained before supplying the
actual native dependency. Initial source-selector preparation failures also
remain recorded. Neither mismatch was turned into a skip or normalized away.

## Remaining owner requirements

* Compile the actual CLI/bundle bridge and validate identified artifacts on
  Node, Chromium, Firefox and WebKit. No overall suite/full product rebuild
  ran, and no scoped source/native pass becomes guest conformance.
* Complete execution-source syntax detection, TypeScript stripping, addon
  loading, source maps, hooks, preloads/config/CLI/permission/worker modes,
  Module load/cache transactions and pending/cyclic require(esm) graphs.
* Complete native ESM URL/query/fragment/namespace/format/async graph/cache
  identity and metadata. Alias-aware resolution does not close that engine
  lifecycle or the existing execution heuristic.
* Shared private URL brands/getters/coercions/encoded paths, raw filesystem
  names, read/close/error/permission/race behavior, parser/cache GC/realm/OOM/
  accounting and public VFS roots/unmount ownership remain open. Header-read
  and portable legacy-probe controls do not prove those dependencies.
* Target default conditions describe normal configured resolution policy,
  not fabricated backend capability. Remaining feature/config/module-list
  claims and unsupported option modes still need their actual owners.
* Reconcile each original public observation and later unchanged upstream
  fixture/flag/worker/IPC coverage before overall suites. No new engine or
  platform exclusion is accepted by this slice.

Continue other independent audited owners breadth first rather than growing
this into a loader-only validation campaign.

The normal targeted wasm32 engine71 build subsequently succeeded in
193.3 seconds, with all 612 frozen selected source identities unchanged.
Unchanged Mozilla checks, optimization and fork instrumentation passed.
The retained artifacts/report are in .context/node26-engine-r71-accepted.
This compiles actual package policy and native CLI input; execution/GC/realm
and four-host runtime validation remain pending. No overall suite
or full product rebuild ran.
