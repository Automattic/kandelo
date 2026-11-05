# Shared module syntax, format and CommonJS compilation

Source103 addresses parts of L-010/L-011/L-026 and source/compiler ownership
under the loading-family audit. It does not close those findings, the
539 original loading obligations, any family or four-host conformance. The
frozen audit and exact Node26.13.0 source/native pins remain unchanged.

## Real parser/compiler ownership

`native-module-syntax.cpp` uses SpiderMonkey's actual `CompileFunction` with
Node's five CommonJS parameters and `CompileModule`, without executing the
function body or instantiating/evaluating a speculative module. Source uses
stable UTF-16 storage and its full length, preserving embedded NULs instead
of truncating at a native C string boundary. Ordinary CJS compilation returns
the actual compiled function, registers referring-script metadata for nested
dynamic import and retains the existing exports receiver/argument dispatch.
It no longer evaluates concatenated `(function ...` wrapper source. Invalid
wrapper-escape text is rejected as a function-body syntax error rather than
executed as a separate script. The old evaluator remains for its separately
owned consumers; no Bun asset branch is altered.

Syntax detection first compiles with CJS bindings. Success means CommonJS.
The engine's private import/export/import.meta syntax diagnostics identify
module syntax, mirroring the target contextify policy's immediate diagnostic
class. Other syntax rejection tries the actual module goal; a valid module
means ESM, invalid syntax in both goals remains a CJS error. Only actual
private syntax reports are consumed. OOM, interruption and other failures
propagate. The pinned complete node_contextify.cc is a reference input, not
compiled V8 code or a reason to match SpiderMonkey errors by English strings.
Actual diagnostic ordering, grammar, source origins and error semantics still
need native/guest reconciliation; no engine boundary is accepted here.

`module-syntax-platform-adapter.js` selects the exact pinned CJS filename/
package/type setup and entry-loader-selection function. The production
bootstrap supplies real package state, path policy, ordinary configured
options and compiler. Unsupported loader/import flags continue to reject at
CLI; normal empty option lists do not establish hooks or preloading support.
Typeless/ambiguous CJS files use the compiler predicate, explicit commonjs
stays CommonJS, and actual entry selection retains the pinned package and
suffix policy. ESM consumers call the existing full pinned get_format owner
with source; source-syntax requests now have a native implementation rather
than the previous explicit missing-parser error. This removes the regex
classifier, including comment/string false positives and missed side-effect
imports/import.meta/await/lexical-wrapper-binding cases.

## Scoped evidence and exact compilation

`.context/node26-module-syntax-frontend-r2.json` records6new controls plus18
existing Module/entry controls passing. These use actual native26 contextify,
VM compilation, filesystem, URL and package cache dependencies. They cover
source classification/no source execution, actual file/package formats,
wrapper-escape rejection/cache cleanup, real CJS binding/receiver/return,
shebang/Unicode/NUL behavior, explicit-CJS admission and compile construction
without body execution. They do not execute the new SpiderMonkey predicate
or prove actual guest ESM loading. The ESM boundary in the CJS fixture fails
explicitly rather than returning a fabricated namespace.

The initial report had21passes/3failures because new controls compared a
VM-realm SyntaxError against the outer realm's constructor. Those original
inputs/report remain retained. Corrected controls require actual native-error
branding and the SyntaxError name across the realm boundary; they still
require rejection, no side effects and cache rollback. No upstream assertion
or expected runtime result was weakened.

Source checks in `.context/node26-module-syntax-source-r1/report.json` bind
three complete pinned reference files, two unchanged selected sections,
generated bundle/bootstrap syntax, native assembly, Mozilla's existing style
checker, exact patch97 forward/reverse with fuzz0, evidence registration,
whitespace and preservation of the separate Bun asset branch.

The normal targeted engine103 build succeeds. Its declared js.wasm is
49,587,583 bytes, SHA256
`6a1de05cb9af1b64a7461d8aba11914682b6e0848a32a0f8dc46c7821ea0d772`.
`.context/node26-engine-r103-accepted/report.json` retains the artifact,
normal-resolver receipt/logs, selected prebuild103 identities checked after
compilation and the selected prior102+103 identity comparison. This is not
a complete immutable SDK/kernel/host closure. It also compiles source101's
comparison bridge and102's HKDF/common-operation changes. The normal
instrumenter retains its compiler-facts hash-mismatch/bounded-baseline
notice. No validation bypass was introduced.

No new guest case ran: the previous old-kernel artifact-policy rejection is
still a prerequisite, not a new result or passing compatibility. No current
kernel/image/host/product rebuild, overall suite, merge, publication or
deployment occurred. No unchanged upstream loader file is newly run in this
slice; earlier unchanged Module evidence retains its exact old identities.

## Remaining owners and next broad work

- Actually execute identified103 artifacts with admitted kernel/image on all
  four hosts; compare native syntax decisions including invalid syntax,
  diagnostic ordering, lexical collisions, nested grammar, OOM/interruption,
  full byte/filename/realm/source-map and loader lifetime behavior.
- Complete CJS wrapper overrides, syntax/error/stack details, module-source
  transformations, hooks, cache/preload/watch/permission behavior and namespace
  contracts. Explicit Module._compile of ESM/TypeScript source remains an
  implementation gap; it must not silently execute unrelated disk contents.
- Complete native ESM URL/query/fragment/symlink/namespace/JSON attributes and
  cache identity, parser-dependent exports, static async-graph/cycle admission,
  dynamic import and actual provided-source execution. Resolving or parsing
  source does not establish those execution and lifecycle contracts.
- TypeScript stripping, Wasm/addons, data/JSON/text source ownership, loader
  hooks, compile/source-map caches and remaining CLI activation stay open.
  Copied format labels/options do not establish unsupported feature execution.

Continue independent transport/shared foundations breadth first. Preserve
all failures and the full rebuild/overall-suite deferrals. Compilation and
native-dependency controls do not mark any family or current host conformant.
