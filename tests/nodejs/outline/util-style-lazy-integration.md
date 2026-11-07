# Native lazy util exports and pinned styleText

Base: `cf61d7ff23a16cb9ab9be8b359a37e343c9203b2` (committed source180).
Private tree: `.context/agent-worktrees/util-arguments-style`. Target remains
Node26.13.0, source18b32a3b1552e199a01f1a8d9fd64aa756d3b75b, with the exact
existing native Darwin arm64 reference. No pin/ABI/native engine change.

## Original finding and corrected source route

Original scope is `tests/nodejs/audit/values.md#V-008:L35`, supplemented by
values-contracts.md:186-197. The immutable broad matrix initially missed the
later `_installNodeUtilAlgorithms` owner and incorrectly described parseArgs,
diff, debounce and throttle as absent. The source-only additive correction
`.context/breadth-reconciliation-correction180` **supersedes those statements**.
Both old seals stay unchanged. No existing algorithms are rewritten here.

Current bootstrap2573 already loads complete pinned parseArgs/diff/debounce/
throttle over genuine argv/immutable startup eval, timer/AbortSignal/native
handled-Promise and monotonic clock owners. build.py1751 validates their
whole source/selected section hashes. Current sources.json:3364-3464 retains
all exact original upstream identities; this slice adds only two selections
from its already-retained complete public lib/util.js.

## Real lazy DATA property owner

Before this slice util-algorithms-adapter.js:41 installed ES get/set functions.
That is visibly different for descriptors, inherited reads and integrity
operations. Current engine/native bridge capability already exists and is
consumed by Worker exports. Reusing it is substantive owner routing, not
making descriptor-shaped metadata in JS.

After this slice util-algorithms-adapter.js:37-48 captures the actual native
capability, retains the current private module require/cache in the loader
closure, and supplies module id/name/real data attributes7. No accessor,
proxy, public sentinel or fallback remains. parseArgs and diff share the
same already-real owning helper; debounce/throttle definitions are unchanged.

Bootstrap2575 passes `_nodeNative.defineNativeLazyDataProperty` through the
existing curated native adapter (spidermonkey/node-compat/adapter.js:484).
`native-lazy-data.cpp` stores the JS loader/data in traced slots and performs
an ordinary JS call in the actual holder realm via the real engine API.
Engine property shapes, descriptors, materialization, inherited identity,
GC and integrity transitions remain that capability owner's responsibility.
No new C++ bridge, engine patch, resource registry or host import is added.
Its initial admission to absent own properties on extensible PlainObjects
fits the actual util namespace at this installation point. No generic
support for other holders or recursive-load/retirement semantics is claimed.

## Full styleText owner and actual public wiring

`util-style-adapter.js:3` installs complete unchanged styleText plus every
ANSI/cache/nesting/hex helper (pinned lib/util.js:113-328), and the unchanged
lazy color owner at81-85. Manifest selections record exact offsets/lengths/
hashes; build.py1770 emits these sections without source rewriting. This is
not host util.styleText delegation, hard-coded sample output or an export
whose implementation is missing.

The new bootstrap2644 install follows actual classic/Web stream and FD
owner creation. It supplies the current process, Buffer, inspection colors,
shared errors/validators and actual internal/streams/utils predicates.
The retained internal/util/colors -> internal/tty algorithms determine
color policy from real process streams/environment. The new implementation
sets no isTTY, color depth, hasColors or platform field. User-supplied stream
properties remain inputs exactly as in the target algorithm; genuine native
PTY controls separately exercise actual terminal resources.

Shared inspection/Buffer/TTY/stream behavior remains a real dependency.
This slice does not implement public selected-fd TTY constructors, alter
OFD/raw-mode policy, or cure the existing master/unreopenable/mode-restoration
nonpasses. Exact text/cache/hex validation/order/metadata belongs to the
unchanged source. No setTraceSigInt facade is introduced.

## Evidence boundaries and retained nonpasses

The21 new groups run both under ordinary file startup and real -e startup;
this repeats21 groups in two modes, not42 independent APIs. They compare
native descriptors, inherited get/set, seal/freeze/preventExtensions, exact
argv tokens/defaults, style/cache/hex/errors, actual stream predicates and
foreign realm holder use. Four stdio scenarios include a pipe and real PTY
with ordinary/explicit FORCE_COLOR0/3; eight existing unchanged algorithm
scenario assertions still pass. Existing test setup now requires the actual
V8 lazy DATA reference addon, rather than supplying a getter/proxy substitute.

The addon is reused byte-identically from the immutable Worker capsule,
SHA dda644589ed4964d343f0dc0e7d923c2b2ab008faff7f91f2c6b6d96288bb1f6.
Its retained current C++ source calls genuine pinned V8 SetLazyDataProperty.
No new native compilation occurred. This validates JS consumers against a
real native reference dependency, not SpiderMonkey implementation/GC proof.

Three unchanged upstream files run in native/candidate modes. parse-args
records117pass/0skip in each. Pipe styletext runs retain their whole-script
TTY skip, and pipe hex runs retain22pass/1skip in each; those skips are not
passing coverage. Follow-up real-PTY runs of both unchanged style files
complete without skips; hex records31pass/0skip in each. Main subject util
owners are candidate, but native assertion/common/node:test, TTY/stream/color/
argv and spawned child helpers remain explicit boundaries. The real -e
focused control separately executes candidate argv-default selection.

The exact old bundle fails the same strict descriptor assertion (exit1,
get/set versus target value/writable). That expected regression control is
retained as a nonpass, not relabeled compatibility. Current focused controls
and real-PTY upstream runs have no new failure. The source input checker
truthfully exits1 for the one new undeclared production input; parent must
add `third_party/node-core/util-style-adapter.js` before normal build admission.

Guest linkage, actual SM lazy-owner GC/realm/invalidation/lifetime behavior,
real guest Buffer/TTY/color/stream dependencies and all four hosts remain
unvalidated. Earlier sealed nonpasses stay open. V-008, VALUES and the overall
goal are not complete. No blanket engine/platform exclusion is accepted.


## Current parent integration and exact evidence

Source186 composes the nine narrow util leaves over185, replacing only
utilAlgorithms in the current manifest and regenerating the combined bundle.
The actual new style adapter is now declared. Normal current bundle/bootstrap/
unity/declared-input/unchanged-style checks and14package checks pass. No newer
HTTP/TLS/Response/FFI/shared-error/module source is overwritten by old postimages.

Fresh parent controls pass21groups under ordinary and real-e startup,4stdio
scenarios including actual PTYs and8existing unchanged algorithm scenarios.
Three whole unchanged util upstream files run per native/candidate: parseArgs
117pass/0skip each; hex style31pass/0skip each on realPTY; plain style exits0
without skip marker on realPTY and has no framework denominator. Existing
pipe whole-script/individual skips and the old exact strict descriptor failure
remain immutable evidence. The real V8lazy DATA addon is reused byte-identically;
this does not execute the SpiderMonkey lazy owner or guest dependencies.

## V-024 actual native constants allocation

The owning generate-fs-constants.py now uses
JS_NewObjectWithGivenProto(cx,nullptr,nullptr) instead of JS_NewPlainObject.
The exact single replacement is recorded, and all selected SDK constant body
bytes and numeric descriptors are retained. No JS prototype patch, copied
constant table or fabricated platform identity repairs the result. The unchanged
native test-fs-constants.js reference passes; candidate JSAPI/guest execution
has not run. Normal staging contains the actual corrected native allocator.
This is source implementation progress, not a runtime V-024closure. Legacy
node:constants aggregation/initialization/order, sys alias/warning and other
values requirements remain separate real gaps.

Original audit bytes and broad source matrices remain immutable. The additive
V-008 correction takes precedence over prior incorrect API-absence statements;
existing parseArgs/diff/debounce/throttle were genuine and were not rewritten.
No new compiler invocation, engine/kernel/library/product build, overall suite
or full rebuild ran. Accepted173predates current186; actual guest lazy/constant/
Buffer/TTY/stream/clock/realm/GC/fatal behavior and four-host evidence remain open.
No finding/family closes. Nested guest Wasm execution stays in scope, scheduled
last after independent core-module work.
