# Upstream AssertionError and shared error ownership

Follow-up: [source110 native Error location policy](error-location-implementation-dependencies.md)
repairs the original reflected-location mismatch. Its eight-case actual
Node-host selection has7pass/1fail; the new full generic Error-layout comparison
retains the own lazy stack/prototype gap. Earlier108/109results below remain
historical evidence for their exact artifacts and unchanged inputs.

Source108 addresses portions of V-029/V-035. It replaces the custom assertion
error class with the exact pinned `lib/internal/assert/assertion_error.js` and
`lib/internal/assert/myers_diff.js`. The full unchanged files are retained under
`third_party/node-core/upstream/`; `sources.json` records their exact origin and
hashes. Their bytes were checked against the unchanged audited Node26.13.0
archive. The target/source/native pins and completed audit are unchanged.

Source109 corrects the bootstrap dependency order exposed by the actual108
guest run. The pinned color module observes process.stderr during loading;
the assertion module must load after the actual FD stream owner exists.
The five source108guest cases all failed during bootstrap before their
assertions, with a lexical initialization error for `_nodeFdStreamPlatform`.
Their exact sources, stamped artifact and raw results remain retained. This
is a candidate implementation regression, not a platform exclusion or a
failed native reference. Moving assertion initialization after FD setup
keeps the real color/stream consumers and their behavior unchanged.

## Shared owners

`adapter.js` now loads the full error and Myers diff algorithms alongside the
existing pinned assertion/comparison modules. Generated/simple/full diffs,
operator-specific messages, truncation, color formatting, error-cause copying,
details records, property descriptors and custom inspection belong to those
upstream algorithms. Six generic local TypeError constructors and the partial
handwritten AssertionError are removed.

Assertions now consume the same real errors, validators and color module as
other compatibility modules. They use the full captured primordial initializer
instead of a second hand-maintained subset. The core's types can initialize
the shared value owner before the lazy assertion/comparison modules load.
Production bootstrap order follows that dependency, and failed factories are
removed from the module cache rather than retaining partial exports.

`process.stderr` is the actual guest stream used for terminal width. Inspection,
byte comparisons and intrinsic brands continue to use their shared owners.
This change adds no host-specific implementation, syscall, native engine API,
ABI change, memory ceiling or public compatibility exception.

## Explicit diagnostic adaptations and remaining gaps

The guest still lacks Node stack recapture/filtering and source-expression
recovery. The generated AssertionError calls native capture only when it exists;
otherwise it retains the actual stack captured by its Error superclass. The
assertion utility returns no expression when capture is unavailable, then uses
the existing default-message adaptation. It does not attach a stack from a
different synthetic Error. The raw upstream files remain unchanged, and each
generation adaptation requires one exact expected source occurrence.

These are implementation gaps, not accepted engine/platform exclusions.
Exact stackStartFn/stackStartFunction behavior, limits, stack formatting,
source-expression recovery, engine inspection/Unicode width and complete
cross-realm/poisoned-intrinsic/lifecycle behavior remain open. Reusing the error
algorithms does not close V-029, V-035 or the values family.

## Focused evidence

The final native-dependency frontend run has18passing cases, zero failures or
skips:11assertion cases and7affected native key controls. Three new assertion
cases cover generated/simple/full diffs, descriptors/details/custom inspection,
shared constructor/public-overload diagnostics and operation without native
stack recapture. The existing assertion cases retain their adversarial matching,
strict/loose/partial comparisons, aliases and async outcomes. Nested comparisons
are checks within cases, not separately counted APIs.

The source fixture runs the actual candidate assertion/error/diff/validator
code with explicit native inspection, stack and engine-brand dependencies.
Custom inspection uses a controlled input stack in both candidate and native
reference; it does not claim stack-capture conformance. The missing-capture
fixture removes that intrinsic from the actual primordial dependency and
verifies the error still has its real superclass stack.

Four unchanged upstream files pass in candidate and exact native-reference
modes: `test-assert-myers-diff.js`, `test-assert-deep-with-error.js`,
`test-assert-fail.js` and `test-assert-class-destructuring.js`. The candidate
preloader redirects only subject assertion/diff modules; unchanged common
harness, native node:test, inspection and engine owners remain explicit.
Eight executions are four distinct test files, not eight APIs. Commands,
archive-verified file identities and raw outcomes are retained in
`.context/node26-assertion-upstream/report.json`.

Source generation/syntax and pinned-file checks are separate in
`.context/node26-assertion-source-r3/report.json`. The first generation attempt
incorrectly passed `--check` to the positional bootstrap generator and failed
before generation; its log is retained. The correct invocation passed. The
initial frontend run had17passes; the final18-case run adds the no-capture
dependency control. Repeated cases are not additional coverage.

Canonical targeted engine108 compilation succeeded, including eight dependency
library nodes. Normal admission accepted its stamped program and kernel with
matching contract digests. The first inspection requested the wrong relative
artifact name, js.wasm, instead of programs/js.wasm; that failed preparation
and its source/log remain preserved. The correct request passed without any
policy change. Native/frontend passes did not detect the guest bootstrap
ordering regression described above.

The corrected canonical109build succeeds, reusing all eight dependency library
cache entries. The stamped49,698,917-byte engine has SHA256
`fb62ed5709c1f3b2ac62dccb2fb791be49545fc800f4ee5c93eb5dd2e3f26dcf`.
Normal program/kernel admission accepts the same contract digest on both.
Five actual Node-host guest controls have4pass/1fail, zero skipped/unsupported/
timeouts/harness errors. All five native references pass. Public assertion
validation and the three affected environment cases pass; the diagnostic case
exits zero with output that differs from the native reference and remains failed.
Exact sources, artifacts, raw outputs and analysis are retained in
`.context/node26-assertion-guest-r109-controls/`.

Seven diagnostic scenarios differ only in Reflect.ownKeys(error): the guest
has fileName, lineNumber and columnNumber. All other compared fields, property
descriptors, generated/simple/full messages, details and custom inspection
match in these scenarios; those subfield observations do not turn the case
into a pass. `js/src/vm/ErrorObject.cpp:542–553` creates these properties in
reserved slots, and init at604–608 assumes their shape. Node-compatible error
construction must reconcile that engine owner, reserved metadata, all error
creation and realm paths. The source trace and exact local reference bytes
are retained; this is an integration gap, not an accepted engine boundary.
The public key assertion and all failed108/109results remain unchanged.

The older107environment evidence and these five focused109cases do not
establish broader guest or four-host conformance. Overall suites and the full
product rebuild remain deferred. No finding or family is complete.
