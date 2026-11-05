# Error location extensions and shared native construction

Source110 addresses the shared engine dependency behind the source109
AssertionError reflection failure, within the remaining V-029/V-035 work.
No completed audit, exact Node target/source/native pin or prior result is
changed. No finding or module family is complete.

## Owning implementation

Patch101 introduces `JS::ContextOptions::errorLocationExtensions`, enabled by
default for ordinary SpiderMonkey embeddings. It controls the engine's
non-standard Error filename/line constructor arguments and the associated
fileName/lineNumber/columnNumber own properties. The option must be selected
before any global is created and remain fixed for that context because Error
initial shapes are cached per realm.

Shell context registration selects the policy from the actual program mode.
Node contexts disable the extensions before self-hosted code or globals are
initialized. The same registration path serves the root context, shell workers
and public Node workers; VM realms subsequently use their context's policy.
Standalone `js` keeps the normal enabled policy. There is no JavaScript public
property filter, assertion-specific branch or post-construction property edit.

`ErrorObject.cpp` skips the extension-property initial shape when disabled and
keeps the matching debug invariants conditional on that shape. Native filename,
source ID, line, column, saved stack, error report, message and cause reserved
slots retain their real initialization and ownership. Engine error reporting
therefore continues to consume native metadata even though those extension
names are absent from public reflection. New ordinary user properties remain
ordinary properties rather than aliases to native location slots.

The constructor also ignores primitive options/extra positional location
arguments when extensions are disabled. Standard options/cause handling keeps
its upstream property lookup and coercion order. Poisoned ignored arguments
must not be converted merely because the engine supports a standalone shell
extension. Direct calls, constructors, native-generated errors and cloned
errors share the actual engine owner.

This is shared guest-engine behavior on Node, Chromium, Firefox and WebKit.
The new internal C++ context-option layout requires a coherent engine build;
it adds no host/kernel/program wire ABI, syscall, serialization format or
declared memory ceiling. The shared compatibility bundle and separate Bun
loader remainder are unchanged.

## Bounded checks and runtime evidence

Source checks apply/reverse the patch exactly over three retained engine files,
run the unchanged Mozilla checker, verify the unchanged compatibility bundle
and frozen audit/target, and check whitespace. The report is retained in
`.context/node26-error-location-source/report.json`. These are source checks,
not native engine execution or runtime conformance.

Three native reference controls establish exact target behavior for location
arguments/properties, full Error reflection and worker construction. They use
the unchanged checksum-verified Node26.13.0 reference. A separate native source
observation records the own stack getter/setter descriptors, shared accessor
identity and absence of Error.prototype.stack. Native observations do not
validate the candidate C++ implementation.

The focused guest selection retains five earlier assertion/environment sources
and adds location construction/cause/clone/VM/native-error checks, full Error
layout and a public worker control. The complete reflected keys and stack
descriptors stay in the layout comparison. A separate standalone SpiderMonkey
control checks preservation of its extension behavior; it has no native Node
comparator and must not count as Node conformance.

The canonical targeted110engine build succeeds with all eight dependency
libraries cached. Its normal admitted/stamped49,698,990-byte artifact has SHA256
`4a821fd801ac784ffaf547d174ae624d5e28921f5c68f923fd6416c4bb353719`.
Kernel and program contract digests match. The receipt, projection, exact
prebuild source identities rechecked after compilation and artifact are retained
in `.context/node26-engine-r110-accepted/`.

The actual Node-host guest report has8cases:7pass/1fail, zero skipped,
unsupported, timed out or harness-error cases. All8same-source native references
pass. The original assertion diagnostic case, validation and three environment
cases pass. New location and public worker cases pass; the full-layout case
exits zero with mismatching output and remains failed. The earlier three native
reference controls are repeated within this differential selection and are not
three additional candidate APIs. No native-dependency frontend or unchanged
upstream file was rerun this slice.

The separate standalone SpiderMonkey control passes with real legacy location
properties and primitive constructor arguments. Its outcome is independent of
the Node denominator. Sources, exact engine/kernel/image identities, process
outputs, result markers, timings and per-case outcomes are retained under
`.context/node26-error-location-controls/`. No assertion or expected key list
was changed to turn the generic layout failure into success. No browser or
overall conformance is established.

## Remaining dependencies

- The pinned Node target gives fresh Errors an own lazy stack accessor, with
  configurable/non-enumerable descriptors and shared native getter/setter
  functions. Error.prototype has no stack property. Current guest construction
  still uses SpiderMonkey's prototype accessor. This independent implementation
  gap remains in the full-layout comparison.
- Stack capture/recapture, limits, stackStartFn, source-expression recovery,
  formatting and stack/cause/realm/GC ownership still need actual shared engine
  implementations and exact reference controls.
- Error subclasses, AggregateError/SuppressedError, native report conversion,
  lazy/accessor behavior, poisoned prototypes/options, cross-realm wrappers,
  clone/worker transport and teardown need broader API-specific reconciliation.
- The prior compiled108bootstrap failure, source109diagnostic mismatch, native
  environment fixture snapshot failure and all other historical nonpasses
  remain separately preserved. A later passing slice cannot rewrite them.
- Four-host conformance and the other nineteen-family obligations remain open.
  Overall suites and the full product rebuild remain deferred.
