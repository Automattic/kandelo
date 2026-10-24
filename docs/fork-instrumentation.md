# Fork Instrumentation

`wasm-fork-instrument` is an in-tree Rust tool that rewrites wasm user-program
binaries with save/restore machinery so POSIX `fork()` works. The tool source
lives at [`crates/fork-instrument/`](../crates/fork-instrument/).
Build scripts and tests should invoke
[`scripts/run-wasm-fork-instrument.sh`](../scripts/run-wasm-fork-instrument.sh),
which uses `tools/bin/wasm-fork-instrument` when present and otherwise builds
the tool from Cargo on demand. Every build script that targets a fork-using
program invokes the tool after linking. Asyncify is not an active implementation
path: do not use `wasm-opt --asyncify`, do not accept `asyncify_*` exports, and
do not add Asyncify compatibility fallbacks. This document is the
living reference for the tool's behavior, exported ABI, and save-buffer format.
Some conservative-GC package builds run an additional local-root visibility
pass before fork instrumentation. That pass is not part of the fork ABI; see
[`crates/wasm-local-root-spill/README.md`](../crates/wasm-local-root-spill/README.md)
for its Ruby-focused rationale, risk profile, and extension limits.
For motivation, tradeoffs, and the rollout plan that led here, read
[`plans/2026-04-20-fork-instrumentation-design.md`](plans/2026-04-20-fork-instrumentation-design.md);
for the post-rollout switch-dispatch redesign and non-fork-path-call gating
that fix the kernel-side-effect re-fire bug, read
[`plans/2026-04-22-fork-instrument-switch-dispatch-redesign.md`](plans/2026-04-22-fork-instrument-switch-dispatch-redesign.md).
ABI version: `46` (see
[`crates/shared/src/lib.rs`](../crates/shared/src/lib.rs) — see
[abi-versioning.md](abi-versioning.md) for the policy).

## Policy

- `wasm-fork-instrument` is mandatory for any program that performs `fork()` or
  fork-like operations. That includes `fork()`, `vfork()`, `_Fork()`, shell
  pipelines, command substitution, `system()`, `popen()`, and fork-backed helper
  processes.
- Missing instrumentation is a build/runtime error, not an optional feature
  loss. A fork-using program without complete `wpk_fork_*` exports cannot
  resume the child at the fork call site.
- Every value needed after replay must be either activation-owned bytes in the
  linked continuation or the output of a versioned deterministic
  reconstruction recipe in the fresh child. Module globals and tables are
  instance state, not evidence that a value survived `fork()`.
- ABI 43 fork artifacts must carry the activation-state-safe capability. The
  capability means that activation references, exceptions, mutable reference
  globals, and mutable table state have versioned reconstruction owners. An
  incomplete, malformed, or old-ABI ownership contract fails during
  instrumentation or pre-launch artifact validation; it must not become a
  child-only trap.
- Binaries exporting legacy `asyncify_*` symbols are stale and must be rebuilt.
  Do not add host support for them.
- Do not keep compiler/linker flags solely for the retired legacy path. The
  fork instrumenter does not require preserved function names or onlylists; if
  a build keeps debug-info flags, it should be for a current diagnostic reason.
- On Unix hosts, the CLI preserves the input Wasm file's permission mode on
  its output, including when `--output` names the input file. Package build
  scripts can therefore instrument installed executables in place without
  making them non-executable.

## Streaming migration (experimental)

`fork_instrument::streaming` provides an original-binary scanner, a compact
conservative call-closure resolver, definition-only compiler-fact binding,
Kandelo-owned typed function IR, and a writer-based remapping emitter.
The scanner validates one function at a time and preserves original operator
byte offsets. It retains shared validator header resources so a body provider
can load any original function directly by its byte range for fixed-point
analysis, without decoding preceding bodies or retaining an instruction cache.
The native IR borrows wasmparser operators, resolves symbolic
control regions/exception arms and captures validator-typed call stacks,
operand heights and operator arities.
Reference liveness and definitely-null analysis run on one original function
before synthetic dispatch locals exist, with explicit state/work/output
budgets. The emitter visits
every body, including bodies outside a fork closure, and spools code and
data sections to private temporary files. Its default limits are 32 MiB per
source/emitted function and 64 MiB per buffered metadata section; these are
emitter buffer limits, not a process-memory guarantee. Compiler-fact text is
read as bounded lines across concatenated plain/compressed custom sections;
compressed objects are not materialized in full. Defaults are 1 MiB per line,
512 MiB decoded per object and 16 GiB decoded total. Definition-only binding
does not validate call-site type facts.

Helper function/type declarations can be frozen before emission; their bodies
are generated and spooled one at a time. The source table barrier and segment
drop rewrites also have a native implementation: they consume frozen hook
indices and visit all functions, without filtering by fork activation.
The source hook also composes with already-lowered indirect transports: it
preserves the selected direct/tail route and reconciles its physical table
before invocation. A separate guard lookup supports generated call sites.
Native sparse-table ownership and runtime hooks now supply those frozen indices,
as described below; production composition remains unfinished.
Validator-canonical concrete heap identities are resolved to source type
indices before output remapping; they are never encoded as binary indices.

`facts::call_facts_from_scan` now uses `facts::storage::FactsStore`: interned
names, binding, call-site, conversion, slot-flow and resolved-target relations
live in a private temporary SQLite database. It preserves the oracle's
signature-agreement fallback, ambiguous-definition unions, callback registry,
cleanup and longjmp-facts policies. Planning is bound to the exact original
module before lowering. The store exposes one target group at a time for the
native sink planner. The compatibility `CallFacts` projection has
a separate resident metadata budget and fails instead of collecting an
unbounded target matrix.

Default storage budgets are a 32 MiB page-cache target for each main/temp
schema, 1 MiB name cache,
128 MiB resident metadata/projection budget, 8 GiB maximum main database size
and one quadrillion estimated work steps. Work includes SQLite VM instructions
and minimum batch charges for short queries; it is a generous sanity check.
With `WPK_FORK_PROGRESS=1`, stage diagnostics report database bytes and work
counts without scanning relations. Query temporaries use files; their disk
space is additional to the main database limit. SQLite's page cache is a
[suggested limit](https://www.sqlite.org/pragma.html#pragma_cache_size), not a
hard process-memory ceiling. Row/work/disk failures are explicit, the private
store is discarded on failed construction, and no unbounded Walrus fallback
is introduced. Physical-footprint guards remain a separate validation layer.

`streaming::sink` now includes a function-local abstract interpreter and
disk-backed module metadata. The interpreter models normal/child control,
recorded post-call states, injected child results, modern/legacy handlers,
integer values and shadow-stack slots. Its environment supplies call effects
and target refinements. A normal return/throw workqueue loads and discards one
body per evaluation and borrows the summary array instead of cloning it;
the policy interpreter and child-continuation planner use this driver.
Differential fixtures compare results and
original call coordinates with the unchanged Walrus interpreter. Unsupported
operators are explicit and cannot prove a boundary. Default limits are
4,294,967,295 abstract state values, one trillion work units, 16,384 nested control
regions, 4,096 frame slots and 1,048,576 call-target memberships per body.
The state limit reserves a conservative bound for structured-control scratch
and recorded states before evaluation; it is not a physical-memory ceiling.
It is deliberately a generous sanity check: the estimate reserves the full
frame-slot allowance at every active control level, even for a function that
only writes one slot. Normal memory savings come from retaining one function
and its active control states, then discarding them. Explicit smaller budgets
remain available to library callers and resource-failure tests. Deep structured
control uses temporary native stack segments through `stacker` on the same
analysis thread. Segments are acquired only when needed and released on return;
they do not retain module instruction IR or alter the guest stack. A 2,000-level
fixture runs with precise frame tracking on a 256 KiB calling thread stack.
Work includes state copies and fixed-point revisits; its default is a generous
runaway-analysis check. Aggregate passes allow sixteen trillion units, leaving
room for nested specialization while a caller's allowance is reserved. Both
allowances scale down on narrower hosts while preserving that headroom.
Increasing them allocates no memory.
Set `WPK_FORK_PROGRESS=1` for native phase timings and periodic analysis-function
counters on stderr. Local work-limit errors include the original function and
the requested, remaining and allowed work.
Other native passes share the generous local/module work ceilings. Pipeline
and activation catalogs allow a 1 GiB metadata estimate; their actual storage
grows with entries, and individual body buffers retain separate bounds.
Unused trailing local declarations are omitted from abstract states while
referenced locals keep their original coordinates. Delegation and nested
mixed modern/legacy handlers remain explicitly unsupported by this analysis
until semantic normalization is integrated; they cannot prove a sink.

Sink metadata keeps compact function/global headers resident and caller,
table-member and constant-slot relations on disk, using the same private
storage budgets as compiler facts. `FactsStore::empty` creates planning storage
without claiming a compiler-facts solution. Reference-call dependencies are
included when finding callers to revisit, including declared function-subtype
chains. References in table/global initializers remain visible to dispatch.
Unknown reference imports and element expressions retain an external-call
possibility; the sink planner seeds that external vertex even when no dlopen
import is present. Element expressions containing null slots disable
constant-slot refinement rather than shifting later functions into those
slots. These are experimental analysis APIs; none certifies a
complete fork-instrumented module.

Parameter-target proofs record direct-call arguments to disk in a separate
serial pass, then resolve forwarding chains/cycles with recursive disk sets.
They do not recursively load caller IR. Unknown values, escaping functions
and unsupported callers retain signature fallback; proved missing table slots
produce an empty target set. Calls may throw during the recording pass so
handler registrations are included. Escaping shadow-stack frames are repeated
without slot tracking. No literal-slot proof is attempted when table slots are
mutable or unknown.

`PolicyPlan` adds checked libc callback registries, cancellation cuts, signal
dispatch policy, per-caller cleanup sets and sparse setjmp/longjmp buffer
masks. Cleanup retains the original caller identity. Unknown atexit slots
retain signature fallback; unknown side calls retain generic exception
possibilities. Signal gate mode records required runtime guards; this library
analysis does not emit those guards itself. `SinkInterpreter` connects these
policies to the normal-summary driver and local evaluator. Small-callee
specialization is limited to depth three, uses a bounded FIFO cache (4 MiB by
default) cleared per root evaluation, and never specializes an unresolved
side-module call.

`plan_sinks` resolves original call-site targets into indexed disk relations,
computes the reverse fork closure, probes exception-handler landings, and
solves child return/throw and boundary fixed points. Only compact per-function
summaries/masks and the current body's target/injection sets stay resident.
Vfork mode is checked independently of literal-table parameter refinement.
Paths through unresolved external dispatch remain open, and results intersect
the conservative activation/control closure. Signal gate requirements are
returned explicitly for later runtime generation. Resource exhaustion returns
an error without a partial plan; unsupported analysis scope returns `None`,
requiring the conservative closure. Raw legacy loader/longjmp imports, missing
dynamic-link facts, oversized tag masks and unsupported body operations cannot
produce a sink proof. Such inputs still require conservative closure planning;
generated loader callbacks do not acquire original compiler facts. Production
orchestration and backend integration remain unfinished. Production continues
to use the unchanged Walrus implementation.

`FrozenImports` freezes added runtime imports and optional conversions of
original function imports into local helpers. Retained function imports
compact after explicit removals; imported tables, memories, globals and tags
retain their indices. Definitions shift by the resulting import delta.
Reencoding applies the mapping to instructions, names, start, exports,
initializers and segments. Descriptors use final output type/heap indices.
Removed imports must resolve to declared helpers with the same original
function types; mismatches fail before writing the module header. Import and
local declaration layouts include these mappings in their source binding.
The writer inserts absent sections in canonical order and emits one source
or helper body at a time.

`LegacyLoaderPlan` replaces historical `env.__wasm_dlopen` imports with local
staged adapters while preserving every original function identity. It accepts
the existing two-, four- and five-argument integer/pointer shapes, including
mixed widths. Canonically equivalent staged imports are reused. Missing name
ranges and flags keep their historical defaults; empty four/five-argument
ranges select main-program lookup. The adapter calls prepare and tail-calls a
shared scalar driver, removing dead byte/name pointer parameters before guest
initializers or deferred-signal checkpoints can fork. The canonical function
table can be table32 or table64. As in the old transform, an absent canonical
table gets an unexported fallback, and prepare/next reports that unavailable
linker contract before an initializer can use it.

`NativeLoaderActivation` captures the generated driver using a small validated
source domain of its own. Original functions keep their exact input bytes and
compiler-fact coordinates. The fixed-size driver body is regenerated, planned
and emitted separately with the normal continuation machinery. Its only user
locals are the i32 transaction token and entry; its frame is 24 bytes on both
pointer widths. All three checkpoint sites and the indirect initializer call
use frozen transports. The initializer transport reconciles the process table
before normal or private resume routing. The generated driver gets a resume
catalog entry after the original activation entries. Callers must seed the
original loader imports and enable conservative external dispatch in the
original closure, then include this generated activation in resume planning.
Raw protocol emission alone does not claim fork capability.

Standalone fixtures compare staged call order, argument defaults, main/failure
paths, checkpoint counts and function-reference identity with unchanged
Walrus. Linked fixtures execute initializer and all three checkpoint fork
sites, fresh-instance replay and allocation failure at each of the three
captured frames. They cover both memory/table widths, all three historical
argument counts and shared/inline scalar codecs. Replay does not repeat
prepare, next or commit work. The original caller retains its live reference
while the driver has no reference vector. One old runtime defect is recorded
separately: its generated `wpk_fork_resume_thread` can pass an i32 index to the
canonical table64, producing invalid Wasm. Native table64 fixtures validate
and execute strictly; positive oracle paths keep the same runtime assertions.

`ModuleDeclarationBuilder` reserves final indices for appended local tables,
memories, tags, globals and element segments, plus new exports. It rejects
duplicate exports and bounds declaration metadata. Frozen catalogs bind both
the original input and the import layout; a mismatched layout fails before
output begins. The writer appends existing sections or inserts absent ones
in canonical order. Passes may extend a catalog during planning and combine
helper type/function catalogs, then freeze them before serial emission. Large
data payloads remain on the writer/spool path.

`NativeRuntime` now generates the seven linked-runtime control exports and
four private globals, along with frame, resume-table, private-tag and reference
codec imports. It lays out the source module's mutable scalar snapshot prefix
in declaration order, skips reference globals and the child-owned
`env.__channel_base` binding, and emits one control body at a time. Pointer
width follows the original primary memory. A memoryless module can instead
reserve an explicit process-memory import before providers are planned; runtime
controls, GC and exception exchanges then share that frozen binding and pointer
width. Changed bindings reject before emission. All source memory/global uses
are remapped after added imports. End controls call the optional codec cleanup,
release the buffer alias, then publish NORMAL. Typed local codec providers may
be supplied as already planned final-index overrides or reserved helper
ordinals relative to the frozen function base. Conflicting overrides and
index overflow fail during planning; no placeholder codec imports are needed.
These controls have
native/Walrus layout and import-signature comparisons and wasm32/wasm64 Node
execution tests for capture, rewind and abort. A composed native fixture also
executes table/drop tracking outside the fork closure.

These runtime controls alone do not install the continuation, reference or
module-state components and do not certify an artifact. Emitting these controls
alone produces no fork capability marker and is not a complete
fork-instrumented program. No browser, ABI integration
or end-to-end memory claim follows from these component tests.

`NativeExceptionCodec` now plans and serially emits the owning module's eight
exact-tag exception helpers. It uses the original process memory for bounded
transaction exchange ranges, keeps `exnref` values in private Wasm tables, and
crosses the JavaScript broker boundary with scalar IDs. Encoding claims recipe
identity before recursive payload encoding. Decoding releases exchange memory
before decoding child recipes and caches reconstructed exceptions by shared
recipe ID. Tag handlers pool typed locals across layouts, so repeated static
tag signatures do not multiply physical helper locals. Planning, import
reservation, signature interning, encoding and decoding are separate modules.

Its descriptor matches the unchanged Walrus codec byte-for-byte for scalar,
reference and vector layouts. A shared Node fixture executes both backends;
the native provider additionally runs on memory64. It covers exact local tags
in fresh instances, scalar/vector bits, recursively nested exceptions, alias
identity, brokered values, ingress, cache cleanup, invalid IDs and disjoint
transaction scratch. Budget tests reject metadata, work and output exhaustion;
256 repeated tag signatures keep the same physical local count. These
providers now compose with activation frame vectors in the linked catch
fixtures below. The GC providers described next also compose with these exact
exception recipes. Production bootstrap integration remains unfinished.
Provider metadata alone certifies no artifact.

`NativeGcPlan` discovers aggregate layouts and constructor provenance before
runtime helpers are declared. It records aligned scalar fields, reference
ordinals, immutable allocation dependencies, mutable non-null GC seed inputs,
subtype dispatch order and all required array constructor variants. Discovery
visits retained original instructions one function at a time, including code
outside the fork closure. Repeated sites share a catalog entry. Separate
metadata, work and function-IR limits fail explicitly before unbounded growth.
Inheritance depths are memoized with an iterative walk.

The GC catalog uses validated Wasm type identity, with frozen output indices
for payload types. Ordinary descriptors match Walrus byte-for-byte. Recursive
groups expose two oracle differences: Walrus can retain two layouts for one
equivalent runtime type, and its shallow type interning can merge distinct
runtime types. A Node fixture observes `ref.test` return false in the original
and native round trip, but true after the unchanged Walrus round trip. Native
planning preserves the original distinction. Metadata tests cover every array
constructor, constructor sites outside fork, source retention, field/seed
ownership and resource failures; 10,000 repeated sites retain two layouts
within an 8 KiB catalog budget. This is planning evidence, not measured process
memory or a working GC provider.

`GcConstructorPlan` reserves typed wrapper declarations and provenance imports
before indices freeze. `FrozenGcConstructors` rewrites original constructor
sites without changing their coordinates, including sites outside fork. Each
wrapper evaluates the original allocation first, then records scalar operand
bits and required reference seeds through the existing host protocol. Trapping
allocations publish no provenance. Packed/vector operands, data/element ranges,
empty non-null arrays and seeds separated by scalar fields are covered by Node
execution against unchanged Walrus on both memory widths. Operand effects run
once in source order, and the transit slot is cleared after publication.
Catalogs reject source/type-mapping mismatches and enforce metadata, work,
signature and output limits. GC and exception catalogs share the immutable
activation import.

`GcCodecPlan` freezes nine core GC helper declarations plus private typed seed
functions. `NativeGcCodec` emits probing, graph encoding, cached decoding,
externref bridges, allocation and filling one body at a time. Encoding publishes
identity before recursive edges and gives each recursive activation a separate
exchange-memory reservation. Allocation installs mutable shells before filling
their edges; immutable and non-defaultable constructors consume their recorded
inputs. Replayed values register constructor provenance for a subsequent fork.
Private function and exception seeds inhabit mutable non-null fields until
filling replaces them. Concrete function seeds retain the original nominal
function type. Added seeds and tags stay outside original source catalogs.

Native and unchanged Walrus output execute the same standalone Node assertions
on both memory widths. They cover self-cycles, mutual GC/exception cycles,
constructor seeds that differ from final fields, function/externref identities,
signed i31 values, packed/scalar/vector bits, every array constructor variant,
empty typed arrays and child-to-grandchild reconstruction. Successful helpers
release every exchange range, and unknown allocation/fill routes trap. Planning
and emission enforce metadata, work and output limits. The complex helpers
retain nine scalar/pointer locals with either one or 256 distinct GC layouts;
they narrow references at use rather than allocating a local for every type.
This validates provider components, not a complete native fork artifact,
production bootstrap, browser behavior or end-to-end memory improvement.

`ModuleBootstrapPlan` discovers active segment schedules without copying data
payloads. `FrozenModuleBootstrap` freezes three initialization phases. Parent
bootstrap applies elements, then data, then the original start, once. Thread
bootstrap applies local table baselines and consumes converted active segments
without copying data or calling start. Fork restore applies only table baselines
after globals have been restored; it keeps constructor segments physically live
until the later module-state finish phase. Offset expressions become immutable
globals, preserving the VM's extended-constant evaluation. Logical initial drop
flags still describe the original active, passive and declared segments.

The bounded writer can defer original initialization: active segments become
passive at their original indices, the original start moves to its explicit
helper, and a missing data-count section is inserted before code. Data payloads
continue through the disk spool. Node tests cover memory32/table32 and
memory64/table64, overlapping initializer order, empty segments, extended
constant offsets, shifted local indices and copied-memory preservation. Parent
and thread assertions compare unchanged Walrus; native segment lifetime checks
also compare the original module. Metadata/work/output failures reject
explicitly.

`NativeRootState` composes original global roots with these bootstrap phases.
Its catalog exports every original global with its original one-based owner
ordinal, excluding all generated controls and provider storage. Save records
cover mutable locals and imported globals, except the child-owned
`env.__channel_base`. Immutable local globals are not snapshot roots. Imported
global descriptors retain the existing format, including repeated module/name
imports with distinct original owners. Restore changes mutable globals only.
Scalar/vector bits retain the existing record layout; reference records carry
recipe IDs decoded and narrowed inside Wasm by the real typed providers.

Source drops update compact logical bitmaps after their instructions succeed.
Restore applies global roots and the bootstrap table baseline, while finish
reinstates saved segment drops after graph reconstruction. Exact-byte bitmap
loads avoid reading allocator padding at the end of memory. Each root helper
uses one reusable payload-pointer local, independently of the number of roots.
Metadata, work, output and optional source-hook maps have explicit limits.

Node fixtures compare fresh-instance replay and imported-global descriptor
bytes with unchanged Walrus on both memory widths. They cover scalar/vector
bits, function/externref identities, typed and abstract aliases, self-cycles,
mutual GC/exception cycles and arrays reconstructed from parent-dropped data
and element segments. Separate memoryless fixtures execute runtime controls
and scalar/reference replay using planned 32-bit and 64-bit process memories.

`NativeTableState` now supplies the sparse table counterpart. Catalog owners
come only from original tables; generated provider/cache/resume tables are not
captured. Repeated imported table declarations keep distinct descriptor owners,
while the host selects one canonical owner per physical table. Imported tables,
source-mutated tables and the exact dynamic-linker process table synchronize;
read-only local tables use their static baseline without a generation guard.
Imported-table descriptors preserve the existing format and match Walrus bytes.

Save emits the existing 56-byte descriptor and one full single-run record for
each dirty page. The baseline fingerprint remains an opaque 32-byte binding;
native generation hashes the exact original module and original table owner,
independently of Walrus arena identities. Restore checks that binding and page
headers, grows with a saved typed entry spanning the old end, decodes entries
inside Wasm and marks restored pages dirty. One nine-local scalar tuple serves
all original tables, including mixed table32/table64 declarations. Planning and
each emitted helper enforce metadata, work and output limits.

Dirty markers cache repeated single-page marks but publish every successful
nonempty mutation. Empty ranges and failed grows abort the writer transaction.
Source traps escaping a mutation still require the host's normal execution
boundary to release active transactions. Consumer guards use an atomic fence
load for shared process memory and a normal aligned load for unshared memory.
They cache the exact generation returned by reconciliation, so a concurrent
newer publication remains visible to the next guard.

`NativeModuleState` composes the full module-state save/restore/finish exports
and the table-only checkpoint exports. Save captures roots and canonical tables;
restore applies globals and each activation's static table baseline; finish
rejects before initialization, applies canonical physical overlays, then restores
segment drops. The process must restore all activation baselines before running
these finish helpers. Provider source identities, bootstrap ownership and
process-memory bindings must agree before composition.

Shared Node assertions run native and unchanged Walrus module-state providers
across all memory32/64, table32/64 and shared/unshared memory combinations. They
cover aliased imports, non-null typed table growth, GC/exception roots,
externrefs, empty and failed mutations, delayed segment drops, malformed baseline
and page records, and a generation publication during reconciliation. Additional
native memoryless fixtures cover both process/table widths; a mixed-width
module checks table32 and table64 in the same helper. This is component
execution evidence; process-level cross-worker replay, production integration
and artifact certification remain unfinished. Provider/activation composition
is described below.

`FrameBuilder` now plans one function's activation storage. It keeps parameters
and first-used original locals in lexical order, assigns synthetic value keys,
packs scalar fields after the unchanged 16-byte header, and overlays mutually
exclusive scalar catch payloads. Reference recipes use only header word 12;
values needed by every landing form a stable vector prefix. Non-null temporary
references have nullable local storage and explicit checked reads. Original
unused declarations consume no physical locals in the planned body.

Scalar spills of at least 256 bytes use shadow-stack scratch when the primary
memory and a mutable pointer-width `__stack_pointer` are available. User scalar
fields remain first, and the spill tail stays contiguous for bulk frame I/O.
Scratch values have no physical Wasm locals; one base and one temporary per
scalar type serve their loads/stores. Reserve/release/reseed and bulk save/
restore primitives support both pointer widths. The native activation wrapper
installs cleanup for normal, escaping-exception and tail exits; modern source
catch landings reseed scratch before entering user handlers. Discover the frame
environment and source type catalog once per module, then discard each local
frame plan.

`NativeCatchPlan` now discovers modern catch selectors and payload types, pools
typed operand scratch across arms, and assigns one shared retained exception
slot when complete recipes are required. Its scalar payloads use the existing
overlaid frame range. `FrameLayout::emit_catch_scalars` saves or restores only
the selected arm, skips selector zero and traps on unknown selectors before
accessing payload memory. Its emitted selection has constant nesting. These
pieces now compose with the native activation wrapper: typed capture blocks
intercept each modern catch arm, publish its exact selector and forward its
original operands. A first private-tag clause shields instrumentation unwind
from user handlers. Replay reconstructs the selected catch inside its original
try; normal results bypass all capture tails. The dispatcher tracks these
added labels when remapping source branches and handler destinations.

Node component fixtures execute scalar `catch` and `catch_ref` ownership on
both pointer widths, with shared and inline frame codecs, empty or multi-value
try inputs, normal try results, and forks inside the try or after its handlers.
They check exact frame payloads, fresh-instance rewind, live allocation-failure
restart and invalid-selector traps. Untyped try cases run the same assertions
against the unchanged Walrus transform. Its current catch wrapper loses try
input parameters and produces invalid Wasm for the typed-input fixture; those
native cases instead have independent Wasm validation and execution evidence.
Differential planning checks cover reference, vector and catch-all payloads,
including 448 static regions sharing constant physical temporary storage.

Linked recipe fixtures execute all four modern catch kinds with vector and
externref payloads, user/synthetic exception aliases, private-tag shielding,
fresh-instance rewind, allocation-failure restart and invalid selectors.
They run shared and inline scalar codecs on both pointer widths, with and
without virtual scratch spills. Catch-all fixtures also capture and replay
broker-owned raw values. A shared host fixture implements durable recipe IDs,
disjoint exchange ranges and frame vectors; the real generated Wasm codec
owns exception reconstruction. No JavaScript `exnref` provider substitutes for
it. Scratch release is checked against each activation's entry baseline,
including the restored fork-time stack pointer during replay.

The same journal assertions run against Walrus, with one recorded oracle
defect: when `catch_all_ref` rethrows a raw broker value, Walrus leaves its
scratch reservation behind on normal, rewind and live-abort exits. Native
emission must release that reservation completely. The fixture verifies the
known oracle failure separately instead of weakening native cleanup checks.

`LegacyHandlerPlan` discovers legacy exception ownership in one original
function. It assigns each attached handler a parent link, resolves named
rethrows and shares typed cleanup targets across repeated branches. Work
and metadata limits cover discovery and ancestor walks. Original operator
coordinates and branch signatures remain unchanged. `NativeLegacyPlan`
adds typed controls and nullable exception locals while the frame is open,
then freezes their block signatures with activation support. Emission
lowers the existing body and handler sequences directly; it does not
construct another instruction tree. Only handlers active at a call add
their exceptions to that call's reference vector. Replay throws the
restored exception before running the try body to re-enter the same arm.

Normal exits, escaping foreign exceptions, branch-table/reference exits
and modern catch jumps release exited handler ownership. Private unwind
preserves it until capture. A rethrow intercepted by an inner catch keeps
the original exception available for later rethrows and forks. Legacy
delegates become modern exception branches to typed forwarding landings
in the original target arm. Foreign forwarding clears exited owners;
private unwind reaches activation capture without clearing them.

Seventeen control fixtures execute original-input baselines, normal runs,
fresh-instance replay and live allocation-failure restart on both pointer
widths and scalar codec policies. They include nested/sibling handlers,
typed inputs, scalar/vector/reference payloads, brokered catch-all values,
reused rethrow contexts, typed exits and delegates to functions, outer
tries, loops, if arms and catch arms. A composed GC fixture also exercises
legacy typed-exception replay with indirect tail transport, module state
and virtual scratch spills. Emitted activation fixtures contain no legacy
exception instructions. Production continues to use Walrus.

The unchanged oracle runs shared positive assertions where it supports
these inputs. Separate checks record its detached-catch parser panic,
delegates bypassing frame capture or an outer handler, and premature
cleanup when an inner catch intercepts a rethrow. Additional delegate
target scopes and typed legacy inputs use original-input execution and
strict native replay assertions rather than those broken oracle paths.

`FrameCodecCatalog` interns scalar save/restore recipes before output starts.
It emits each helper serially and shares restores across save-commit policies.
Restore returns at most one value, including an optional catch selector, to
preserve recursion stack budgets. The generated scalar helper bodies match
the unchanged Walrus helper bodies byte-for-byte across scalar, selector,
commit and pointer-width fixtures. Node fixtures additionally exercise header
preservation, commit ordering, the replay cursor and virtual-spill copying.
Reference helper generation is separate from these scalar codecs. The
continuation components below compose call/region replay dispatch.

Frame planning defaults to 64 MiB of conservatively accounted local metadata,
1,000,000 logical locals and 1,000,000 reference memberships. These limits are
independent of source IR and module helper-catalog limits and are not a physical
process-memory ceiling. IR stack-value limits now include region input stacks;
calls record their current control-frame floor so inner landings do not spill
values owned by their parents. Lexical retention is shared with fact matching
and remains distinct from semantic reachability.

`plan_continuations` now partitions one original function into call and child
region landings. `if` arms and legacy handler bodies have distinct sequence
identities; each fork-bearing sequence stores only its contiguous call range.
An iterative walk propagates these ranges without keeping descendant-call
lists or recursing on source nesting. Normal chunks and replayable argument
suffixes are original instruction spans, not copied instruction vectors.
Call carryovers start at the validator's current control-frame floor; child
region landings own the parent carryovers, block inputs and `if` condition.
Entry parameters use temporary storage set on every region entry.

Argument and region-input plans replay only constants, local reads and the
oracle's whitelist of non-trapping integer operations. A backwards typed walk
finds the closed suffix without repeatedly simulating overlapping suffixes.
Other values get frame-backed spills, with all call arguments allocated before
all call carryovers. Reference plans combine normal/exception-successor
liveness, direct null restoration, synthetic operands, ancestor region inputs
and every reference parameter needed by the zero-argument resume thunk.
Replayed ancestor reference reads remain activation-owned even if the local
is dead at the original inner call. Defaults add 64 MiB of conservatively
accounted metadata, 1,000,000 value records and 104,857,600 work units per
function, independent of frame, IR and reference-analysis limits.

Differential fixtures compare argument suffixes, nested call carryover types
and region ranges with unchanged Walrus. Node fixtures exercise generated
capture/reload operations with compacted user locals, reference identity and
both local/scratch scalar storage on wasm32 and wasm64. These fixtures do not
perform a fork. Ordinary unreachable calls are excluded from the landing plan;
this API does not emit or certify a complete fork artifact.

`emit_continuation_dispatch` now emits the planned normal/replay control flow.
An iterative task stack handles source nesting and a 32-way recursive bucket
topology without native recursion. Buckets drain a boundary call's results
through the next normal chunk before closing their empty block. The last
child emits outside all bucket labels so source region results retain their
original types. Replay gates reject invalid call ordinals, skip preceding
normal chunks, enter the selected nested region and force the saved `if` arm.
Typed entry-parameter bridges preserve multi-value block and arm inputs.

Original symbolic branch targets are translated through the inserted labels,
including branch tables, reference branches, typed casts, modern catch targets,
legacy rethrows and delegates. Source local reads/writes use compacted physical
or virtual scratch storage; typed reference calls narrow the stored generic
callee before invocation. Detached source regions remain omitted and retained
tail-call suffixes remain distinct from semantic reachability. A caller can
bind the original function label and source returns to a typed common exit
block, allowing scratch cleanup after normal exits. The dispatcher delegates
frame restore/capture, escaping exceptions, tail transfers and catch reseeding
to the function-wide wrapper.

The emitter declares no helpers. Hooks supply frozen call routing and module
state/exit rewriting, and must balance any additional control frames they emit.
Default limits are 32 MiB output, 64 MiB conservatively accounted emitter
metadata and 104,857,600 work units per function; branch-table buffers are
checked separately before allocation. Node fixtures capture through a private
exception, discard activation locals, restore a test scalar frame and replay
against the source function's result and call trace. They cover wasm32/wasm64,
changed arm conditions, multi-value inputs, loops, branch tables, typed catches,
scratch spill round trips and common exit cleanup. A 4,097-call fixture crosses
all bucket levels with emitted nesting below 128, and a 1,024-region fixture
executes without recursive source emission. Reference call/branch fixtures
and legacy rethrow/delegate fixtures exercise normal execution, not reference
or owned-exception frame replay. These dispatcher fixtures use a private test
frame store. Native linked-frame composition is described below; source
exception normalization and production module-state integration remain
unfinished.

`NativeActivationPlan` and `emit_native_activation` now compose the dispatcher
with linked-frame scalar capture/restore, a function-wide private-tag catch,
live allocation-failure restart and a typed common exit. An outer exception
reference boundary releases scratch before propagating escaping exceptions.
Scalar frame I/O can use the shared codecs or inline loads/stores; scratch
payloads use bulk frame copies before commit and after restore. Planning
extensions reserve wrapper temporaries before the local layout freezes.

`ActivationSupportCatalog` freezes frame-selection, unwind-transport and
resume-thunk recipes. Frame selection preserves the call index and selects
module-owned abort scratch when reservation returns zero. Transport helpers
convert an ordinary unwind return to the private tag and consult the process
resume table during replay. Direct activation calls can remain lexical.
Scalar resume arguments follow the existing zero-argument/peek policy;
reference arguments decode the frame's universal vector prefix before entering
the source signature, including checked narrowing for non-nullable types.
Frame-selection and scalar/reference resume helper bodies have byte-for-byte
comparisons against unchanged Walrus on both pointer widths. Planning and
per-helper emission are separate; no helper retains source instruction bodies
or a module-wide activation IR. The frozen catalog retains a bounded transport
index so the emission pass can resolve existing helpers without declaring new
ones or retaining all function-local route plans.

`TailTransferPlan` consumes selected original tail points from the control
closure. Local direct tails keep their lexical target; imported, indirect and
reference tails become `return_call` to the matching frozen unwind transport.
The plan can be rebuilt against the read-only frozen catalog during emission.
Transparent tail-only bodies preserve their original locals and need no
activation frame. In a rewritten activation, the capture wrapper releases
virtual-spill scratch before every emitted tail transfer while preserving its
argument stack and tail return. Default planning limits are 64 MiB of
conservatively accounted metadata and 104,857,600 work units per function;
function emission has its separate output limit.

`FrozenReferenceKinds` maps final heap types to frozen reference codec classes
once per module. `NativeReferenceIo` plans per-function reference save/restore
guards, sharing adjacent landings that have identical slot/null sets. Saves
finish the transient vector builder and write its durable ordinal before frame
commit. Restores decode only the selected landing's live references and restore
known-null locals directly. These operations use the supplied frozen codec
providers; they do not generate the GC or exception reconstruction providers.

Focused Node fixtures compose these native pieces with the runtime import ABI
and a validating test journal. On both pointer widths, with shared and inline
scalar codecs, they check nested frame reserve/commit order, header selectors,
rewind consumption, live restart on allocation failure at either activation,
and nonlexical resume routing while preserving carried values. A separate
fresh-instance fixture checks externref aliasing, typed function reference
parameters, universal vector positions and direct null restoration at two
capture landings. Both fixtures use readable standalone JavaScript journals
under `tests/fixtures/streaming_*_replay.cjs`.
Tail fixtures execute the same journal checks against native and unchanged
Walrus function transforms on both memory/table widths. They cover a
100,000-step direct tail chain, indirect and reference tails, replay that skips
eliminated callers, and scratch cleanup before normal, private-unwind and
foreign-exception tail exits. The direct chain retains its self `return_call`
and eliminated callers neither save nor consume journal frames.
`NativeActivations` now owns the module-wide declaration schedule without
retaining these local plans. Its first pass loads one selected original body,
reserves transports, resume thunks and catch block types, then releases that
body and plan. A separate pass reloads each activation to intern scalar codecs
after support indices are final. Emission rebuilds one local plan, resolves
only frozen types/codecs/transports, emits it and releases it. Dense activation
ordinals and resume entries are the compact per-function state. Source hooks
also run for transparent tails and functions outside the capture closure.

The catalog borrows the original immutable input bytes; emission checks input
and body identity in constant time instead of hashing the full module for every
function. Default module metadata is 64 MiB, with 524,288,000 original-operator
visits across planning passes. Visits are charged before body decoding;
function-local analysis, work, IR and output limits still apply separately.
Unknown source roles, unplanned shapes, changed bytes and resource failures
reject explicitly. No all-function body or activation-layout cache is retained.

Generated indirect transports now carry the frozen source-table guard policy.
They reconcile at helper entry, before either normal invocation or private
resume-table routing. The private resume table remains outside source tracking.
Constructor provenance and table/drop hooks compose with already-lowered
source operations, preserving original program points and symbolic branches.

`NativePipeline` now owns the full native component assembly in the library.
It accepts the original scan, an original-index reaching plan and explicit
sink boundaries. It reserves loader adapters and reference providers before
freezing imports, then schedules exception recipes, bootstrap, roots, sparse
tables, source barriers, activations, generated loader capture and identity
catalogs with checked type/function cursors. Emission visits each source body
once and writes through the code/data spools. Catalog and function limits
remain explicit; output-writer failures propagate, and the same frozen plan
can be emitted again. Descriptor budgets are checked before writing a header.

The experimental `native::analyze` now applies `Options` to the original scan.
It seeds every matching fork import, every side-module function import, raw
loader imports and conservative dynamic dispatch. It rejects previous private
runtime imports, exports and metadata. Valid compiler facts use private SQLite
relations with the requested effective-type policy; unreadable facts fall back
to the bounded native baseline. Dlopen facts preserve the explicit side-module
contract, including automatic full-entry planning for returning function
pointers. No facts database survives into helper or source emission.

The frozen assembly now includes host `_start` and thread resume boundaries,
side-module constant ABI markers and sink replay selectors. Thread boundaries
guard process tables before normal dispatch or private replay; the public i32
table index is zero-extended for table64. Sink descriptors group equal result
signatures and preserve dense frame ordinals. Unexpected sink returns go back
to the host's invariant check, while genuine guest traps remain traps.

The shared full-provider replay fixtures now use this policy and assembly.
Their helper adds diagnostic exports without owning the activation schedule
or source rewriting. `NativePipeline` deliberately emits no fork capability
certificate. The higher-level `native::instrument` now finishes the artifact:
it emits the existing capability, linked-frame, module-state and unwind
descriptors for the selected role, declares features through a bounded writer,
then validates functions serially. It releases analysis and pipeline catalogs
before output validation. Its result owns immutable file-backed bytes rather
than a whole output `Vec`.

The CLI accepts `--backend native` for this complete experimental path, including
discovery and sink reports. `--backend walrus` remains the default while the
platform migration gates run; there is no automatic switch to Walrus after a
native error. The existing `instrument` library API remains the unchanged
Walrus oracle. Native entry tests
execute normal, fresh and failed-capture replay across both pointer and table
widths. The unchanged Walrus thread wrapper fails validation on table64 and
does not provide the native wrapper's table-generation guard; its other replay
assertions run unchanged on table32.

Both CLI backends now snapshot the opened input before analysis and publish
only after transformation, optional Binaryen optimization and validation
succeed. Permissions come from that same opened source. Failures leave the
destination's bytes and mode intact, including in-place instrumentation. The
final rename replaces the destination entry: an output symlink is replaced
without changing its target. A nonparticipating module keeps original section
headers and debug bytes verbatim, removing compiler facts only, and does not
run the optimizer.

On Unix, snapshots and intermediate artifacts use private unlinked files;
their last writable handles close before read-only maps escape. Mutable user
and optimizer files are never mapped. Other platforms use anonymous immutable
maps. `--max-input-bytes` and `--max-output-bytes` default to 8 GiB each; section
spools also stop during writes at their configured limit and the Wasm u32
section-length ceiling. These byte caps cover instrumenter-owned storage and
validated optimizer results; they do not bound Binaryen's own process memory.
Optimizer paths remain private, and its result is copied into an immutable
snapshot before validation and atomic publication.

Focused evidence includes file-limit/failure tests, real post-optimization,
12 main/dynamic/side and memory32/64 artifacts accepted by the production host
contract checker before/after optimization, and capture/parent replay through
the production continuation coordinator. These checks also pass through
Vitest's normal global setup. A separate 16-case native process matrix builds
existing C probes through the current SDK, compiler-facts path and default
Binaryen post-optimizer on memory32 and memory64. Real kernel/process workers
exercise direct/indirect and loop forks, stack carryovers, child/grandchild
replay, signal handlers, pthread entry replay and root/later continuation
allocation failures followed by recovery. The fixtures carry the current ABI
contract stamp and require clean stderr. The ABI snapshot check also passes.
Broader process, browser and conformance gates remain pending.
The [complete-transform memory comparison](measurements/2026-10-24-native-fork-instrumenter-full.md)
now covers seven controlled examples, three fresh runs per backend, identical
inputs, bounded atomic I/O and separate host-contract/normal-execution checks.
It excludes post-optimization and does not establish large Codex capacity.

A shared Node fixture now composes the real native GC and exact-tag exception
providers, activation frame vectors, modern reference catches, globals,
sparse tables and segment lifetimes. The same assertions run against unchanged
Walrus on both pointer widths. Native output runs with shared and inline scalar
codecs. Normal execution, fresh-child rewind and allocation failure at either
activation preserve GC/exception cycles, typed non-null resume parameters,
function/externref aliases and arrays rebuilt from parent-dropped segments.
A transparent indirect tail commits no extra frame. Wide mutable-global
arguments force virtual scratch; changing their source global before replay
still delivers the captured argument bits. Scratch checks preserve the existing
ABI's restored fork-time stack-pointer floor for replayed prologues.

`declare_function_catalog` now exports a fixed table containing only original
functions, in source ordinal order, followed by the explicit bootstrap entry.
Private runtime, provider, harvest and continuation helpers have no source
function ordinal. `NativeResumeCatalog` emits the existing descriptor and
fixed thunk table from strictly ascending frame ordinals; it supports sparse
entry subsets without changing the ordinals stored in frames.

`StaticRootPlan` discovers immutable GC global roots and aliases, allocating
nonempty table initializers and allocating live element expressions directly
from the original scan. It retains bounded source coordinates and visits no
function IR. `NativeStaticRoots` freezes a null-initialized anyref harvest table
and one helper. That helper reads globals/table slot zero or copies an exact
segment item, so it never reevaluates an allocation or hoists a permanent
reference global. The host must harvest before explicit bootstrap, register
weak coordinates, clear every buffer entry and pin only roots named by the
current replay transaction before applying overlays or segment drops. Declared
segments are already dropped at instantiation and supply no harvestable root.
Discovery and emission enforce metadata, work, index and output limits; data
payloads stay outside retained metadata.

Native and production Walrus output run shared catalog/replay assertions on
both pointer widths; native output uses both scalar codec policies. Static-root
and resume descriptor bytes match on ordinary inputs. Original function exports
and bootstrap match their catalog slots, helpers stay excluded, and harvest
adds no reference globals. Fresh replay preserves identity across imported and
aliased immutable globals, primitive/array roots, table initializers, passive
and deferred active elements, frame locals and sparse table state. Cleared
harvest buffers retain no roots. Static aggregate identities use fresh child
coordinates rather than structural clone recipes. The composed activation
fixture now resolves function recipes and resume routing through these actual
catalogs instead of export-name lists.

One additional oracle defect is recorded separately: Walrus tries to harvest
an allocating declared element expression through `table.init` after the
segment has been dropped. The original module executes, native harvest skips
the unobservable root, and the unchanged oracle harvest traps. This test does
not weaken the ordinary cross-backend replay assertions.

These remain component fixtures rather than the normal production path.
Process-level integration,
artifact certification and production backend integration remain work. No
end-to-end memory improvement is claimed.

`wasm-fork-instrument input.wasm --streaming-scan` runs that diagnostic scan
without constructing a Walrus module or producing an executable. It reports
function/operator counts, maximum source body size and, when facts are
present, hash-checked definition binding (`--no-facts` skips binding). It
does not run an optimizer.

Production `instrument`, `analyze`, `sink_report` and normal CLI output still
use the existing, unmodified Walrus implementation. The native sink planner
is not yet connected to production; complete component composition and
production artifact generation remain. No complete bounded fork transform or
measured Codex memory improvement is claimed.
See the [dependency map and migration plan](plans/2026-10-22-streaming-fork-instrumentation.md).
The [front-end memory measurements](measurements/2026-10-23-streaming-instrumenter-front-end.md)
compare six controlled examples and explicitly exclude the full transform.
The separate [facts/sink memory measurements](measurements/2026-10-23-streaming-instrumenter-sinks.md)
cover seven controlled examples through native sink planning, including the
large-body allocator regression found and corrected during measurement.

## State machine

Every instrumented module carries a single mutable i32 global, `_wpk_fork_state`,
and one mutable pointer global, `_wpk_fork_buf` (i32 for wasm32 programs, i64
for wasm64). The pointer is zero while the state is `NORMAL` and holds the
address of the active root chunk's module prefix otherwise.

```
                   wpk_fork_unwind_begin(buf)
     ┌─────────────────────────────────────────────────────────┐
     │                                                          ▼
┌────┴──────┐  wpk_fork_unwind_end()   ┌─────────────┐
│  NORMAL   │ ◀──────────────────────  │  UNWINDING  │
│  state=0  │                          │  state=1    │
│  buf=0    │  wpk_fork_rewind_begin   └─────────────┘
│           │  ─────────────────────▶  ┌─────────────┐
│           │  wpk_fork_rewind_end()   │  REWINDING  │
└───────────┘ ◀──────────────────────  │  state=2    │
                                       └─────────────┘
```

- `NORMAL` — ordinary execution. Gated ops and gated calls run normally.
- `UNWINDING` — the stack is being torn down. Each instrumented function runs
  its unwind-only call-site bridge, reserves a complete linked node before the
  first frame write, then runs its postamble to finish the payload, commit the
  node, and return a default value; the runtime-exported
  `wpk_fork_unwind_end` is called once the top of the stack is reached.
- `REWINDING` — the stack is being rebuilt from saved frames. Each
  instrumented function loads its frame and jumps straight to the matching
  call site via switch-dispatch. Body chunks before the chosen post-call
  landing are skipped, so non-fork-path calls and side-effecting operations
  in those chunks do not re-run.

The host drives the state machine externally. User code never writes to
`_wpk_fork_state` directly.

## Exported ABI

The tool injects seven exports into every instrumented module. Names are
exact — they are part of the kernel ABI and tracked by the snapshot check
(see [abi-versioning.md](abi-versioning.md)).

```
wpk_fork_unwind_begin(buf: ptr) -> ()
  Precondition:  state == NORMAL
  Postcondition: state := UNWINDING
                 _wpk_fork_buf := buf
                 *(buf + 0) := buf + frames_start_offset
                 All mutable scalar globals snapshotted into buf.

wpk_fork_unwind_end() -> ()
  Precondition:  state == UNWINDING and all frames have been drained.
  Postcondition: _wpk_fork_buf := 0
                 state := NORMAL

wpk_fork_rewind_begin(buf: ptr) -> ()
  Precondition:  state == NORMAL (in a freshly-instantiated child)
  Postcondition: state := REWINDING
                 _wpk_fork_buf := buf
                 All saved mutable scalar globals restored from buf.

wpk_fork_rewind_end() -> ()
  Precondition:  state == REWINDING and all frames have been reloaded.
  Postcondition: _wpk_fork_buf := 0
                 state := NORMAL

wpk_fork_abort_begin(buf: ptr) -> ()
  Precondition:  state == UNWINDING after a typed frame-allocation failure.
  Postcondition: state := ABORT_UNWINDING
                 _wpk_fork_buf := buf
                 All saved mutable scalar globals restored from buf.

wpk_fork_abort_end() -> ()
  Precondition:  state == ABORT_UNWINDING and all committed inner frames
                 have been reloaded.
  Postcondition: _wpk_fork_buf := 0
                 state := NORMAL

wpk_fork_state() -> i32
  Returns current state. Exported for host-side assertions.
```

ABI 42 and later modules additionally import three exact `env` functions. A module that
imports any one of them must import all three and carry the linked-frame custom
section described below.

```
__wpk_fork_frame_reserve(frame_size: ptr) -> ptr
  Reserves a complete node and returns its payload address before any frame
  bytes are written.

__wpk_fork_frame_commit(payload: ptr) -> ()
  Publishes the pending node after the activation-owned payload is complete.

__wpk_fork_frame_next(expected_frame_size: ptr) -> ptr
  Returns the next committed payload during rewind and rejects size/order
  mismatches before generated code reads it.
```

The control exports identify the state-machine ABI, but they do not prove which
import seeded call-graph discovery. The tool therefore also emits the custom
section `kandelo.wpk_fork.capabilities`. Its two-byte payload is
`[version, flags]`; version 1 defines:

- bit 0 (`0x01`): the module was instrumented with `--entry env.fork`, so an
  `env.fork`-importing side module has complete side-entry coverage;
- bit 1 (`0x02`): a default-entry main module imported Kandelo's dynamic-linker
  functions and conservatively instrumented every `call_indirect` boundary
  plus its direct callers;
- bit 2 (`0x04`, `WPK_FORK_CAP_ACTIVATION_STATE_SAFE`): the instrumenter
  emitted and validated the complete ABI 43 activation, reference, exception,
  module-state, and table-reconstruction contracts required by a fresh module
  instance.

ABI 43 requires exactly one two-byte capability section, version 1, with bit 2
set. Unknown bits, missing/duplicate/malformed sections, or a missing safety bit
fail artifact validation before execution. Role bits retain their existing
meaning and are still required for side-entry and dynamic-linking replay where
applicable. The safety bit is not inferred from the seven control exports:
ABI 42 emitted those exports while still depending on module-instance
reference tables. A copied safety claim also cannot upgrade a normal ABI 42
program because the program ABI marker must match 43.

ABI 16/18 role-marker compatibility remains historical parser-test coverage;
it is not a launch fallback for an ABI 43 kernel. Changing the capability
encoding or meaning requires another ABI bump and regenerated snapshot.

### ABI 43 deployment and rebuild boundary

ABI 43 is an artifact epoch, not a host-only update. All fork-instrumented main
programs and side modules must be rebuilt with the ABI 43 instrumenter, then
the affected package archives, bottles, binary indexes, shell closure, and VFS
images must be regenerated against the new cache keys. Kernel, host, SDK/libc,
and generated ABI constants must ship as one coordinated set.

Do not republish ABI 42 artifacts with edited metadata or a copied capability.
The ABI 43 instrumenter refuses inputs that already contain fork control
exports, linked-frame imports, or fork metadata; builds must start from raw
linker output so the new validation sees the original activation and table
state.
The source package projection may be regenerated while developing this epoch,
but broad bottle/index/VFS publication requires explicit release coordination.
Reference-bearing modern C++ exception output and Dash's fork-reachable
`exnref` cleanup state are reconstruction inputs, not package-specific
exceptions. The ABI 43 source-build path now accepts those shapes through the
typed reference and complete-exception recipes. A development rootfs containing
the configured shell closure can therefore be rebuilt, but it is not a
published release artifact. Existing ABI 42 packages, indexes, shell
closures, and VFS images must still be rebuilt through their normal source
paths and must never be relabeled. Broad publication remains a separately
coordinated release action. See the [ABI 43 activation-state-safe artifact
rebuild plan](plans/2026-07-25-abi-43-activation-state-safe-rebuild-plan.md)
for the exact registry generation count, derived-image order, and ABI 42
package isolation boundary.

`ptr` is `i32` on wasm32 user programs and `i64` on wasm64 user programs. The
tool picks the pointer width from the module's primary memory — a memory64
memory yields `i64`, anything else yields `i32`.

`wpk_fork_unwind_begin` self-initializes `*(buf + 0)` with
`buf + frames_start_offset` before touching user state. In the linked format,
that initial address is the 16-byte abort selector inside the fixed prefix.
During linked unwind and rewind, generated code overwrites the word with the
payload address returned by the corresponding host hook. The host allocates
the root chunk and passes `root + chunk_header_size` as `buf`; no caller
computes or preallocates a worst-case frame-data footprint.

Every end export clears `_wpk_fork_buf` before publishing `NORMAL`. This
removes the module's stale alias when the host releases or reuses continuation
storage. Address zero is ordinary linear memory, so the clear is an ownership
invariant and defense, not a substitute for correct generated code: no
ordinary-execution path may dereference the buffer global.

## Host Threading Contract

The continuation belongs to the channel that issued `SYS_FORK`. For a
main-thread fork this is the process worker's channel, and the child enters `_start` before
`wpk_fork_rewind_begin` replays to the saved call site.

Each process worker or pthread worker owns a separate host-side continuation
object. This is load-bearing for pthreads: thread instances share linear
memory, but separately allocated mappings and per-worker replay cursors prevent
their unwinds from sharing frame storage.

For `fork()` from a pthread worker, the host must preserve the pthread entry
context as well as the buffer:

- `CentralizedKernelWorker` creates a host-side, one-shot
  `ThreadChannelAttachment` bound to the kernel's exact clone result.
  `attachThreadChannel(attachment, offset)` records that kernel-assigned
  identity, pthread entry table index, and userdata for the thread channel;
  host code cannot provide or substitute a PID/TID.
- `centralizedThreadWorkerMain` overrides `kernel_fork` for instrumented modules
  and drives `wpk_fork_unwind_begin` / `wpk_fork_state` /
  `wpk_fork_rewind_begin` around the pthread function, using
  a dynamically mapped root chunk. `channelOffset - FORK_BUF_SIZE` now stores
  only the active root address used by the kernel-worker fork handoff.
- `handleFork` passes one `ForkLaunchRequest` through the host `onFork`
  callback. Its discriminated continuation context always carries the exact
  linked-frame anchor. For pthread forks it additionally carries `fnPtr`,
  `argPtr`, and the caller's slot range. Node and browser hosts copy that
  authority into the child init message rather than deriving an address from
  the child channel layout.
- The same context carries the caller's exact dynamic pthread slot range
  (`slotStart`, `slotLen`). After the kernel clones the child process state,
  the host calls `kernel_reserve_host_region_at(childPid, slotStart, slotLen)`
  so the child retains only the calling thread's copied TLS/fork-save/channel
  pages.
- A fork child created from a pthread enters the saved pthread function from the
  indirect-function table instead of `_start`, then starts REWIND from the
  thread's copied buffer. `_start` is not in that call chain and cannot reach
  the saved fork site.
- That pthread entry function, argument, and buffer remain the child's
  continuation root until `exec` replaces the process image. If the child
  forks again first, the host propagates the same root and buffer to the
  grandchild; launching the grandchild at `_start` or rewinding the main-thread
  buffer would replay a call chain that was never saved.

The child does not inherit every parent pthread reservation. POSIX fork resumes
only the calling thread, so dead parent pthread slots become ordinary copied
memory bytes in the child and can be reused by later child `brk`, `mmap`, or
`pthread_create()` activity. Retaining the caller's one slot avoids having to
move the saved `__tls_base`, thread-local state, and fork-save buffer during
rewind.

This path is covered by `host/test/fork-from-thread.test.ts` (including a second
fork in the child before exec), `host/test/fork-instrument-coverage.test.ts`
P-06 (`pthread_create` worker calls `fork`), and K-03
(`pthread_cleanup_push` handler calls `fork`).

## Fork from a dlopened side module

Dynamic linking participates in the same process-wide activation protocol as
the main module. The supported stack is not limited to one main-to-side call:
the event journal records arbitrary main-to-side-to-side nesting, including
calls through shared-table function pointers and side-originated
`dlopen`/`dlsym`. Each participating module owns a separate linked
continuation; the journal supplies their exact leaf-to-root
activation/function order.

The ABI 43 POSIX `dlopen()` path deliberately separates host-owned
instantiation from guest initialization:

1. Libc reads the side-module bytes through ordinary file operations and calls
   `__wasm_dlopen_prepare`.
2. The process worker copies and validates the request, claims loader
   ownership, creates a private transaction, and returns its token without
   entering guest Wasm.
3. Each `__wasm_dlopen_next` advances host-only compilation/instantiation of
   the complete `DT_NEEDED` closure as needed, recording provisional module
   identities, memory/table bases, symbol visibility, dependency/provider
   edges, and rollback ownership. ABI 43 instrumentation has removed every
   native start section and converted active segments plus the original start
   function into an explicit bootstrap, so instantiation cannot enter that
   guest path. The call publishes at most one canonical `() -> ()` bootstrap,
   relocation, or constructor entry in a transaction-owned table slot and
   returns its index.
4. Libc calls that entry only after the import has returned. The initializer is
   therefore an ordinary Wasm-to-Wasm activation and may call another side
   module or `fork()`. The next host call acknowledges the completed stage and
   either returns another entry or atomically commits the public handle.

This staged path is non-reentrant: no host import calls back into Wasm before
returning. ABI 43 libc uses only the staged `prepare`/`next` path. Before call
graph discovery, the instrumenter also replaces either historical canonical
two-, four-, or five-argument `env.__wasm_dlopen` import in place with a local
adapter. Retaining the original function identity preserves direct calls,
exports, table elements, and `ref.func` aliases. The adapter prepares the load
and then tail-calls a generated driver; after the import has returned, that
driver invokes each initializer through the process function table and commits
the transaction. The original two-argument form had no pathname and retains
its deterministic historical `dlopen:<buffer-address>:<byte-length>` module
identity. ABI 43 host and publication guards require the legacy import count
and native start-section count to be zero, so stale or forged safety metadata
cannot expose either the monolithic callback or instantiation-time guest
reentry. Source modules may contain a start section; the zero-count rule
applies to the completed instrumented artifact after its start has become an
explicit bootstrap. `DynamicLinker.dlopenSync()` remains a lower-level embedder
API, not an import reachable from an accepted ABI 43 process artifact.

The staged host can issue internal VFS and mapping channel requests while an
import is active. Those completions set the ABI 43
`REQUEST_FLAG_DEFER_SIGNAL_DELIVERY` bit because process-worker JavaScript
cannot run libc's signal trampoline. The kernel leaves a caught signal pending,
and libc performs an ordinary `getpid` checkpoint after each staged import
returns and before it calls a guest initializer. Fork and clone use the same
ownership handoff. This preserves signal delivery without calling back into a
suspended Wasm import frame and adds no continuation or activation-frame
bytes.

Moving preparation behind a kernel syscall would not eliminate the
process-worker portion of loading. Core Wasm cannot compile arbitrary module
bytes or manufacture the fresh Store-local function, exception-tag, and GC
identities needed by the process table. Those JavaScript objects also cannot
be structured-cloned from the kernel Worker. The kernel may own pathname
authorization, process policy, and serialization, but the process Worker must
still instantiate and register each side module. A syscall-based loader would
therefore require a loader request/yield/resume protocol around the same
process-local work. It could replace the named loader import with the generic
syscall import, but it would not remove the host transition. Safety comes from
returning to Wasm before any initializer is called, not from which import
performs the process-local work. ABI 43 uses the smaller staged-import
protocol.

The main fork trampoline is captured before side exports enter the symbol
table, so a later extension cannot interpose the coordinator's `fork` target.
Failed loads may leave non-shrinkable null table gaps. Successful archive
events retain exact parent memory/table bases, handle values,
`RTLD_LOCAL`/`RTLD_GLOBAL` visibility, dependency/provider edges, and nested
transaction rollback state. A fresh child recreates modules in dependency
order, pads to and validates their exact bases, registers their function and
exception catalogs, and only then applies the process table journal and
activation replay.

Mutable Dylink `GOT.func` imports are part of that saved module state.
During fresh-child instantiation, the imported-global planner reads their
existing KFMS mutable-global snapshots and initializes each loader-owned
GOT cell with the exact parent table index. It does not search the
not-yet-restored main table and append a duplicate function. Duplicate
imports of one GOT symbol must carry identical saved values, and later
side-export publication must recreate the same index. A saved self-export
index also identifies any table gap created before the parent's export
publication; replay pads to that slot before installing the fresh export,
then the normal sparse table restore replaces the temporary graph. Missing,
wrong-width, or conflicting state fails before continuation replay. This is
a host reconstruction correction within ABI 43: it does not change the KFMS
wire format or require rebuilt guest artifacts.

Only a fork child has that snapshot. A pthread Worker started after a
`dlopen`, or any live Worker reconciling a peer's publication, shares the
process and rebuilds each GOT cell the way the publishing Worker computed
it: by the loader's own resolution, which reproduces the publisher's table
index because replay places the same modules at the same archived table
bases in the same order. The activation says which applies
(`replayImportState`: `"saved"` for a fork child, `"resolved"` otherwise).
Before this distinction a later pthread demanded a fork snapshot for any
side module that took the address of a main-program function (in C++, every
vtable with a pure virtual references `__cxa_pure_virtual`), so its rebuild
failed. A failed replay also releases only its own Worker's index of the
memory it adopted: that region is the process's live mapping (or a fork
child's copy of it), and unmapping it would let the next `mmap` hand the
same addresses out zero-filled under the library still using them.

Pthread workers have distinct Wasm instances, tables, tags, and Stores; no
JavaScript reference is copied between them. Each pthread therefore owns a
local dynamic-linker replica driven by the process archive's generation
journal. A host-private loader-owner lease serializes staged initialization
across workers, while a shorter archive lock publishes complete records.
Unchanged generations take a fast path. This supports `dlopen`/`dlsym` from a
pthread and `fork()` after dynamic loading; the fork child recreates the
calling thread's local replica and process module/table state.

For TLS-bearing side modules, each archive entry also preserves the live
positive `__tls_base`. Replay restores only that mutable global using the
process pointer type. It does not call `__wasm_init_tls`: the child memory copy
already contains live TLS, and reinitialization would overwrite C++ landing-pad
and application `thread_local` state. TLS-relative exports relocate from that
base, while `__tls_size` and `__tls_align` remain scalar constants.

Every participating module owns an independent linked continuation. Side and
main nodes may occupy several mappings and may contain a frame larger than one
WebAssembly page. The coordinator completes and validates both continuations
before it sends `SYS_FORK`.

### Borrowed vfork replay

A genuine vfork child cannot run ordinary copied activation or side-module
replay over the parent's live `Shared WebAssembly.Memory`. The ABI 43 vfork
path launches a fresh child Worker that validates the parent's process-wide
module-state arena as borrowed, rebuilds the complete activation registry, and
gives every active main or side activation its own child-private fixed prefix.
Replay reads the parent's committed frame nodes and recipe records but never
marks nodes consumed, releases mappings, clears the process launch anchor, or
deallocates the module-state arena. Failure midway through attachment detaches
every child controller so the suspended parent can replay the original
transaction.

Dynamic-linker reconstruction has a matching fail-closed mode. It accepts
only shared Memory, passive data segments, and a complete loader transaction.
For ordinary wasm-ld modules it suppresses only a start function exported as
`__wasm_init_memory`; an arbitrary start or active data segment is rejected
before instantiation. Complete replay does not invoke relocations or
constructors because the borrowed address space already contains the parent's
live initialized bytes. ABI 43 instrumented side modules already lower their
start and active segments into the explicit staged bootstrap described above.
An in-flight bootstrap, relocation, or constructor is rejected because guest
code at that boundary may write arbitrary shared process memory.

The ordinary mode remains copied fork replay and retains independent
address-space ownership. ABI 43 now distinguishes `kernel_fork(FORK)` from
`kernel_fork(VFORK)`, preserves the mode through unwind and replay, maps it to
`SYS_FORK` or `SYS_VFORK`, and carries it through the kernel and child-launch
protocol. Libc `vfork()` therefore no longer aliases the `fork()` wrapper or
runs `pthread_atfork` handlers.

The vfork mode connects those borrowed APIs to the production Node and browser
launch paths. It retains the parent's Memory, parks the calling thread, and
releases that caller only after successful exec commit or exact child
teardown. The child owns private replay, loader, channel, and continuation
control state even though its ordinary guest loads and stores address the
borrowed bytes. Broad conformance, pristine upstream CRuby selection,
and real resident-memory growth remain release gates
rather than properties inferred from component tests. A sibling-delivered
fatal signal against a compute-running borrower is tested separately: because
no browser Worker API provides an exact quiescence fence in that state, every
host contains the complete shared address space instead of resuming the
parent unsafely.

## Save buffer format

All values are little-endian and all records are eight-byte aligned. `P` is
pointer width (4 on wasm32, 8 on wasm64). Instrumented modules carry exactly
one 24-byte `kandelo.wpk_fork.linked_frames` custom section. Version 1 contains
the `KLCF` magic, descriptor size, pointer width, alignment, transactional-node
flag, chunk-header size, node-header size, and module-specific fixed-prefix
size. The host validates every field before instantiation.

Continuation storage consists of page-rounded anonymous process mappings. The
root starts with a chunk header, followed by the module's fixed prefix. Later
chunks contain only a chunk header and nodes. Version-1 chunk headers are:

| Offset | Size | Field | Purpose |
|---|---:|---|---|
| `+0` | 4 | magic | `KFCH` |
| `+4` | 2 | version | Linked format version |
| `+6` | 2 | flags | Zero in version 1 |
| `+8` | `P` | root | Root chunk address |
| `+8+P` | `P` | previous | Previous chunk, or zero |
| `+8+2P` | `P` | next | Next chunk, or zero |
| `+8+3P` | `P` | capacity | Mapped byte length |
| `+8+4P` | `P` | used | First unused byte |
| `+8+5P` | `P` | committed tail | Newest committed node; meaningful on root |

The module prefix retains the runtime's active-frame pointer word, a reserved
pointer word, saved scalar globals, and a 16-byte abort selector.
`frames_start_offset = 2P + N` identifies the selector, while the host-visible
fixed-prefix size is `frames_start_offset + 16`. Frame nodes and
tagged-catch activation state are not stored in that prefix.

The prefix is mutable during rewind. Each generated function preamble stores
the payload returned by `__wpk_fork_frame_next` in its active-frame word at
offset zero. A host controller that borrows another instance's frame chain
must therefore copy all `fixed_prefix_size` bytes to separately reserved
scratch, pass the scratch address to `wpk_fork_rewind_begin`, and keep frame
callbacks pointed at the borrowed nodes. Making only the host replay cursor
read-only is insufficient: passing the owner's prefix would overwrite the
owner's active-frame word. Borrowed replay must leave node states and mappings
untouched so the owner can later replay and release them. This is an internal
host invariant used by the connected ABI 43 `vfork()` path.

This does not introduce a new linked-frame encoding. `fixed_prefix_size` has
always been a module-specific value in the version-1 descriptor, and each node
already declares its function-specific payload size. Existing artifacts retain
and report their larger historical prefix; newly instrumented artifacts report
the prefix they actually use. Import/export names, descriptor fields, and host
parsing semantics are unchanged.

After sealing a vfork capture, the process Worker sums the aligned
`fixed_prefix_size` values for exactly the active activations. The reference
transaction separately reports the page-rounded scratch-capacity high-water
observed while the same generated codecs encoded the graph. Host-intercepted
`SYS_VFORK` carries those values in arguments 0 and 1. The centralized host
accepts at most one control slot: 61,440 prefix bytes and one 65,536-byte
scratch page. It returns `EAGAIN` before `kernel_fork_process` when either does
not fit. This is host transaction metadata, not a new linked-frame field, and
the admitted storage remains host-reserved rather than a copied child address
space.

At the first fork call, the host maps one page-rounded root large enough for
the chunk header and fixed prefix. Each postamble already knows its own exact
frame size and passes it to `reserve`; no extra frame-size-counting
instrumentation or whole-stack prepass is required. When the active chunk does
not fit the next complete node, the host maps another page-rounded chunk. A
single node larger than a WebAssembly page receives a multi-page chunk.

Allocation is transactional: a reserved node is not linked from the committed
tail until all activation-owned bytes are written. If a later chunk allocation
fails, the reserve import records the positive errno, enters
`ABORT_UNWINDING`, and returns a zero pointer. The still-live activation stores
only its call-site selector in the fixed-prefix scratch and restarts; already
committed inner nodes replay back to the original fork import. The import ends
abort replay, unmaps every owned chunk, restores `NORMAL`, and returns the
negative errno. Invalid metadata, impossible transitions, and cleanup failures
remain fatal integrity errors.

A root allocation failure occurs before `wpk_fork_unwind_begin` and therefore
returns its negative errno without replay. A negative `SYS_FORK` result after a
complete unwind uses the ordinary parent rewind and is likewise returned to
the guest; neither case terminates the parent or creates a child.

The child receives the mappings through the normal process-memory copy and the
kernel's inherited mmap metadata, at the same virtual addresses in version 1.
Parent and child independently walk and unmap their copies after rewind. The
linked format makes chunk boundaries explicit, but version 1 does not rebase
internal pointers or relocate the chain in the child.

Mutable reference globals (`funcref`, `externref`, `exnref`, and typed GC
references) are not stored in the scalar linear-memory header. Generated
module-state helpers encode them into the process reference graph during
capture and restore them in the fresh activation before any continuation frame
executes. Immutable imported references use the same activation/template
catalog during early instantiation. A global outside the fork closure remains
ordinary Wasm state and does not pay activation-frame overhead.

## Frame format

Each instrumented function has a statically known payload size. The size
depends on its scalar user locals and instrumenter-owned frame locals, but the
payload header is uniform. Each payload is preceded by a linked-node header:
`KFCN` magic,
format version, transactional state, previous-node pointer, payload size, and
total aligned node size. That header costs 24 bytes on wasm32 and 32 bytes on
wasm64 before alignment.

| Offset | Size | Field                      | Purpose |
|--------|------|----------------------------|---------|
| `+0`   | 4    | `func_index`               | Ordinal assigned at instrument time |
| `+4`   | 4    | `call_index`               | Which call site within the function |
| `+8`   | 4    | exact catch selector       | Zero outside reconstructed catch flow; otherwise the exact region/arm |
| `+12`  | 4    | reference-vector ordinal   | Process-transaction recipe vector for this landing; zero when none |
| `+16`  | var  | `saved_scalars[]`          | User/synthetic scalars and scalar catch payload union, aligned |

Scalars are grouped by type, widest first (`v128`, `i64`, `f64`, `i32`,
`f32`), which also aligns each one naturally after the 16-byte header. In
scratch-spill mode only the user locals are grouped, because the spill region
must stay contiguous for its single `memory.copy`. The payload is private to
the module that wrote it: only the function's own generated code and its
resume thunk read the scalars, and the host reads only the header. Frames with
the same scalar types therefore share one generated
`__wpk_fork_frame_save_N` / `__wpk_fork_frame_restore_N` helper pair; see
[Generated code size](#generated-code-size).

References are deliberately not copied into the frame and never name a
module-static stash slot. Existing live reference locals and parameters are
encoded into a call-specific process recipe vector; the frame owns only the
ordinal in its existing header word. Definitely-null values need no recipe.
The child decodes each recipe against its own activation, function/static-root
catalog, imported-global owner, GC layout, exception codec, or durable
externref owner.

This constant-per-frame reference representation is a stack-depth requirement,
not only a space optimization. The standalone PR #701 V8 reproducer measured
an instrumented recursive function falling from 9,959 surviving calls to 6,639
when its declaration grew from four to twelve locals. PR #713 reduced the
generated-local count to eight and recovered 8,536 calls in the same
measurement context; PR #714 replayed pure scalar inputs and restored the
fixture's original four-local declaration. ABI 43 therefore does not add a
generated local or linked-frame field per live reference, recipe, catch arm, or
catch region. Reference-vector entries live in the process transaction arena,
and catch scratch is pooled by simultaneously live type/width rather than
static source count. Absolute engine limits remain platform- and tier-specific,
so these historical measurements are constraints on generated shape, not a
current performance claim.

Synthetic scalar locals include only call arguments and operand-stack
carryovers that cannot be replayed directly. Catch code uses one exact-arm
selector per function and one typed operand-scratch union sized to the maximum
simultaneously selected payload, not one tuple per static arm or region.
Reference-bearing and untagged exceptions are retained through the complete
exception recipe and do not add linked-frame payload bytes. Rewind either
rethrows a saved scalar tag payload or asks the exception codec to materialize
the complete exception before the original `Catch`, `CatchRef`, `CatchAll`, or
`CatchAllRef` control path resumes.

Rewind also avoids inserting a no-argument resume thunk in front of every
materialized direct activation. When the event journal proves that the next
activation is the direct lexical callee, the caller executes the original call
with its reconstructed arguments; the callee preamble validates the expected
activation and function through `frame_next` before consuming it. A universal
thunk would add a second native engine frame for each recursive Wasm
activation and can exhaust the engine stack well before the continuation
chain is exhausted. Indirect/reference calls, cross-module or
tail-transparent boundaries, and targets whose lexical identity is not proven
still use the process resume catalog. Every such boundary is a generated
`__wpk_fork_unwind_transport_*` helper, so the routing lives once in each
helper rather than in each caller: during replay the helper asks
`__wpk_fork_resume_peek` for the next event and either calls the resume thunk
it names or falls through to the original operation. Callers therefore emit
one lexical call for both normal execution and replay. The lexical fast path
adds no ordinary-activation local and no continuation bytes; the
non-consuming event lookup runs only during replay.

Only activations that replay can enter from outside their lexical caller get
a resume thunk and catalog record: functions exported, referenced by an
element segment or `ref.func`, or targeted by a direct `return_call`. Every
other activation is reachable only by direct calls from activations, which
re-execute the call lexically. The catalog's ordinal-to-slot records are
therefore sparse but still strictly ordered; a replay event naming a function
without a thunk fails in the host with "fork replay target ... is not
registered" rather than mis-resuming.

A resume thunk enters its function with zero for every scalar parameter when
that is the shorter encoding. The function's preamble restores each scalar
parameter from the frame before any other code reads it, and its
`frame_next` performs the same identity and size validation `frame_peek`
would. Thunks for functions with reference parameters, or whose float
parameters would make zero constants longer than frame loads, keep the
frame-reading form, because a non-nullable reference signature needs a
decoded value on entry.

## Scratch-frame spill storage

Synthetic scalar spills (per-call arguments, operand-stack carryovers,
SubRegion/IfElse carryovers) are structurally co-live as Wasm locals: each
spill's `local.set`→`local.get` straddles its call's state-gate region, and
the regions chain across every fork-reaching call site. Baseline-tier
engines (V8 Liftoff) reserve one native stack slot per *declared* local, so
a call-site-heavy function pays that co-liveness in native frame bytes.
CPython's `_PyEval_EvalFrameDefault` (~583 sites) gained ~2,676 spill
locals and a ~21.6 KB Liftoff frame; its ~26-deep import recursion needed
~0.82 MB of worker stack, overflowing browser Web Worker stacks.
`wasm-opt --coalesce-locals` cannot help (measured: ~2,705 co-live locals
remain either way).

A function whose scalar spill region is at least
`SCRATCH_SPILL_THRESHOLD_BYTES` (256) therefore stores those spills in a
per-activation scratch region carved from the guest shadow stack instead
of declaring locals:

- Entry: `SP -= scratch_size; base = SP` (one added pointer-width local),
  the same discipline as `crates/wasm-local-root-spill`. `SP = base +
  scratch_size` is emitted before every function exit — returns, tail
  calls, br-to-entry, and uncaught throws including the postamble's
  private unwind throw — and `SP = base` is reseeded at catch landings to
  reclaim scratch leaked by exception propagation.
- Spill sites store through one reused temporary local per value width
  (`local.set tmp; local.get base; local.get tmp; T.store base+off`);
  reload sites are `local.get base; T.load base+off`.
- The scratch layout mirrors the frame-node payload's spill region
  byte-for-byte (`scratch_off = node_off - spill_region_start`, offsets
  from `assign_local_offsets`). The postamble publishes the region into
  the reserved node with one `memory.copy` before commit, and the
  rewind/abort preamble refills the freshly reserved scratch from the
  selected node with one `memory.copy` after `frame_next`. Node payload
  bytes are identical to the local-based shape, so the save-buffer format,
  exports, imports, and host contract are unchanged — no ABI bump.
- Below-threshold functions keep the historical local-based shape;
  reference-typed spills always remain locals (recipe-vector path); the
  per-seq body-input-param locals are unaffected (re-set on every entry).

`__stack_pointer` is a mutable scalar global, so the existing
`wpk_fork_unwind_begin`/`wpk_fork_rewind_begin` global snapshot already
captures and restores it; replayed prologues re-reserve fresh scratch
below the restored fork-time SP exactly as LLVM's own SP-bumping frames
do during replay, and reloads are base-relative into the refilled fresh
region. A module without a locatable mutable `__stack_pointer` global of
the module pointer width falls back to the local-based shape.

Measured on the CPython stdlib import chain (2026-09-22,
`KANDELO_NODE_WORKER_STACK_SIZE_MB` sweep): worker-stack requirement
0.82 MB → 0.31 MB (uninstrumented floor ~0.27 MB); max co-live locals
4258 → 1585; `python.wasm` ~112 KB smaller. Scratch-mode capture/replay
is covered by `crates/fork-instrument/tests/scratch_spill_node.rs`.

## Generated code size

Nearly every function in a large C++ program can reach `fork()` through
indirect calls, so per-function instrumentation overhead multiplies across
most of the module (Quickshell: 51,942 of 65,901 functions). Browsers compile
all of it, and Firefox caps compiled code at 2 GiB per process. The transform
therefore keeps each rewritten function small with these encodings; none
changes the save-buffer layout, frame header, imports, exports, or custom
sections:

- **One lexical call per call site.** A call whose replay re-executes the
  same operation is emitted once, not as identical `if`/`else` arms. Direct
  activation callees validate the next frame themselves; indirect, reference,
  and imported boundaries go through transport helpers that perform the
  process resume routing (see [Frame format](#frame-format)).
- **One unwind catch per function.** Each function's body sits in a single
  `try_table` that catches the private unwind tag; the handler calls
  `__wpk_fork_select_unwind_frame(call_index, frame_size)` and branches to
  the postamble or the abort restart. A function with two or more
  fork-reaching call sites records each call's static index in one i32 local
  (`i32.const <index>; local.set`) immediately before the call; a function
  with one call site passes the constant zero and declares no local. A
  per-call `try_table` with its result and catch blocks was the largest
  per-call cost in the module and also the most expensive construct in
  baseline-compiled code. The one local is not a per-reference, per-recipe,
  or per-catch local: measured on the PR #701 recursion shape with two fork
  call sites, it did not change the surviving recursion depth on V8 (Liftoff
  and optimized) or SpiderMonkey (baseline and optimized).
- **Shared frame codecs.** The postamble passes its ordinal, catch selector,
  and local-resident scalars to `__wpk_fork_frame_save_N`, which writes the
  header and scalars and, when nothing else writes the payload, commits it.
  The replay preamble calls `__wpk_fork_frame_restore_N`, which consumes the
  frame with `frame_next`, publishes it in `*(buf + 0)` and in the
  instance-private `_wpk_fork_frame` cursor, and returns one value (the catch
  selector or the first scalar); the preamble loads the remaining scalars
  through the cursor. A helper returning every scalar as multiple results
  would keep them all live on the caller's value stack, and baseline
  compilers size the native frame for that peak: on the P-10 recursion
  fixture it cut V8 Liftoff's surviving depth by a quarter. Reference-recipe runs likewise call
  `__wpk_fork_refs_save_N` / `__wpk_fork_refs_restore_N`. Helpers are keyed by
  type shape and shared across functions. Frames whose scalar count exceeds
  engine parameter limits keep the inline sequences.
- **Compact replay dispatch.** The frame restore helper and the frame
  selector record the selected call index in the instance-private global
  `_wpk_fork_call_index`. It is added after the saveable-globals scan, so it
  is never snapshotted and is not host-visible. It is read only while
  `state >= REWINDING` (or in the postamble after selection), so its value
  outside replay is never consulted. Dispatch is a `br_if` state guard
  followed by `global.get; br_table`; a region with one landing uses only the
  guard, and a landing with nothing before it needs no dispatch.

Measured on Quickshell (29.4 MB raw link, 2026-10-02), the code section went
from 67.1 MB to 38.0 MB and the file without its name section from 80.7 MB to
51.4 MB. The added code per instrumented function went from a median of 370
bytes to 158 bytes (p90 1,697 to 672). SpiderMonkey compiled 12 copies of the
module before running out of memory with lazy tiering, up from 6 (7 with
eager tier-2, up from 3). For bash, instrumentation overhead in the code
section fell from 1.68 MB to 0.67 MB. Building the crate with
`--features size-attribution` and setting `WPK_FORK_SIZE_ATTRIBUTION=<path>`
writes a per-function TSV that attributes every output byte to the emitter
that produced it; see `crates/fork-instrument/src/size_attribution.rs`.


## Optimization around instrumentation

A fork-using program goes through Binaryen's `wasm-opt` twice:

1. **Before instrumentation.** The SDK's `-O` link runs `wasm-opt` (clang
   schedules it after `wasm-ld`), and some recipes run their own pass.
   Inlining, dead-function removal and identical-function merging shrink
   the call graph the instrumenter has to cover. Quickshell's raw link has
   108,860 functions on the fork path; after `wasm-opt -O2` it has 51,960.
2. **After instrumentation.** The CLI runs `wasm-opt -Os` over its own
   output (`--post-optimize`; `$WASM_OPT`, else `wasm-opt` on PATH). This
   pass simplifies the dispatch and frame code the transform adds, merges
   or removes generated helpers, and drops runtime imports nothing calls.

Measured on code-section size (static, captured links, 2026-10-02):

| program | wasm-opt → instrument | + wasm-opt after | instrument → wasm-opt |
|---|---|---|---|
| foot | 3,465,173 | −3.3% | −1.8% |
| bash | 1,611,255 | −3.7% | −3.5% |
| git | 5,368,248 | −3.9% | −4.9% |
| python | 8,448,545 | −3.9% | −4.1% |
| php | 16,888,534 | −5.8% | −5.9% |
| waybar | 22,532,525 | −4.4% | −1.1% |
| ruby | 12,769,437 | −3.9% | −4.9% |
| qtgallery | 11,697,323 | −4.4% | +12.5% |
| quickshell | 36,978,834 | −4.2% | +18.7% |

Instrumenting the raw link instead (last column) gives up step 1: every
function of the unoptimized graph gets instrumented, and wasm-opt does not
recover that afterwards. On C programs the difference is small; on Qt
programs it is large.

Why a pass after instrumentation is safe:

- The transform is expressed in ordinary Wasm semantics plus calls to the
  `__wpk_fork_*` imports. wasm-opt preserves the module's observable
  behaviour, including those calls, stores to the save buffer, and exports.
- The custom sections the host reads do not depend on positions that
  wasm-opt changes. Imported globals and tables are identified by kind,
  module and name (format 2, ABI 46), and owners are bound through named
  catalog exports.
- A runtime import nothing calls may be removed. Instrumentation is proven
  by the capability section, control exports and descriptors, not by
  imports. Hosts and validators treat every fork-runtime import as optional
  when absent and exact when present, with two rules: the linked-frame core
  (`__wpk_fork_frame_reserve`, `commit`, `next`) is all-or-nothing, and a
  module with frames must import the private unwind tag. A module with no
  fork-path frames of its own imports neither.
- The instrumenter scans its output and declares every Wasm feature it
  uses in `target_features` (`src/target_features.rs`), because wasm-opt
  enables only declared features. The generated code's needs depend on the
  input (atomic guards for shared memories, GC codecs only for GC
  references), so the declaration is derived, not listed.
- The pass drops the name section (no `-g`), and does not run at all when
  instrumentation left the module unchanged. The instrumenter does not carry
  DWARF through, so `-g` could only keep the names: wasm-ld writes them into
  every link, the facts need them to bind, and the runtime does not read
  them. On Quickshell (2026-10-06) the names were 10.3 MB of a 40.6 MB file,
  and `-Os` saved another 0.4 MB over `-O2`. `--keep-names` keeps the names
  for debugging, so traps and profiles show function names.
- A missing or failing `wasm-opt` is an error. `--post-optimize none`
  exists to inspect the transform's raw output; shipped artifacts do not use
  it.

Package installation determines side-module roles from the exact Wasm
custom sections. A `dylink.0` string in executable data, such as LLVM's
object-format support, does not require continuation instrumentation.
Fork imports and partial continuation markers still require the complete
contract.

Do not add `--closed-world` or other whole-program GC type passes after
instrumentation: they may rewrite the GC types the reference codecs
describe in `kandelo.wpk_fork.gc_codec`.

## Dispatch schemes

Every fork-path function uses **one of two dispatch shapes**, chosen by the
tool per-function based on call-site topology:

| Scheme                       | When picked                                                                                                                                                                                                                                                                                                                       | How replay reaches the resumed call                                                                                                                                                                                            |
|------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| switch-dispatch (top-level)  | Every fork-path call lives at the function's top level. Top-level operand-stack carryovers (values pushed before the call's args and consumed after — common in LLVM `*(sp+K) = call(...)` patterns) are absorbed via per-call spill locals (sub-commit 2.4c). Pure scalar call-argument tails can be replayed instead of spilled. | A top-level `br_table` over the `_wpk_fork_call_index` replay cursor, gated by `state >= REWINDING`, jumps directly to the matching `$POST_K` label for ordinary or abort replay (a single landing uses a `br_if`, or nothing when no code precedes it). The chunks between calls run only on the NORMAL fall-through path; carryover spill locals are reloaded in the post-call, followed by spilled or replayed call args. |
| switch-dispatch (nested)     | Some fork-path calls live inside `Block` / `IfElse` / `Loop` / `TryTable` bodies. Sub-commits 2.5/2.6 made this scheme cover: direct-call carryovers at any nesting depth (2.5c), nested-Loop-with-carryover (2.5c side benefit), multi-value-params SubRegion bodies via body-input-param prespill (2.6c). Pure scalar direct-call args and condition-only `IfElse` carryovers can be replayed instead of spilled. | Cascading `POST_K` blocks plus a per-region `br_table` route ordinary or abort replay through each enclosing instruction's own dispatch — see [Nested per-block switch-dispatch](#nested-per-block-switch-dispatch). For multi-value-params bodies, the body's input params are pre-spilled at body entry and reloaded inside POST_0 to bridge the `Simple(None)` POST_K typing. |

A third path — **guard-dispatch** — existed before commits 3-4 of the
fork-instrument mega-PR (2026-05-14). It wrapped each fork-path call site
in an in-place `state == NORMAL || (state == REWINDING && call_idx == N)`
if-else and gated every side-effect op in the body so it didn't re-fire
during REWIND's linear body replay. After:

- sub-commit 2.5c absorbed direct-call carryovers into nested switch-dispatch,
- sub-commit 2.6c absorbed multi-value-params SubRegion bodies,
- commit 9 (modern wasm-EH SDK flip) removed legacy `try`/`catch` from shipping wasm,
- the post-9 follow-up generalised `compute_carryover_types` to `Option<ValType>`,

all five conditions that previously forced guard-dispatch were closed.
Commit 3 replaced the two `instrument_one_function_guard_dispatch` call
sites in `instrument_one_function` with `panic!()` so any shipping binary
that still triggers the deleted path (e.g., hand-written legacy-EH wasm,
or LLVM output with unknown-type producers in a carryover) fails loudly
with a message naming the function. Commit 4 deleted the
`instrument_one_function_guard_dispatch` implementation and its ~838-line
helper graph.

Both shapes share:

- The state machine, exported ABI, and save-buffer header.
- The per-function frame layout (header + scalar locals).
- Activation-owned tagged-catch arm and scalar payload state.
- Catch-handler reconstruction by throwing the saved static tag.

Switch-dispatch avoids the need for per-call gating: no chunk before the
chosen `POST_K` runs on REWIND, so non-fork-path calls and side-effect ops
in those chunks never re-execute by construction. The previous Phase 4g
side-effect gating and Phase 4c non-fork-path call gating are no longer
needed.

The tool's `instrument_one_function` (in `crates/fork-instrument/src/instrument.rs`)
inspects the original body, runs `classify_nested_pattern` to decide
whether the per-region transform applies, and routes to either
`instrument_one_function_nested_switch` or `instrument_one_function_switch`
accordingly.

Indirect calls (`call_indirect`) are treated as fork-path landings when they
may dispatch to a fork-path-reachable callee in the same table with the same
signature. Discovery is table-aware: active element segments populate their
own table, passive segments count only for tables that can receive them via
`table.init`, and declared segments do not count as table initializers.

To keep dynamic interpreter/function-pointer-heavy runtimes resource-safe,
indirect closure is bounded to two dispatch hops. Direct callers of functions
found through those hops are still included. This covers normal C callback
fork paths and QuickJS's C-function trampoline shape
(`JS_CallInternal -> js_call_c_function -> js_os_exec`) without turning one
generic dispatcher into whole-runtime instrumentation. A program whose only
fork path requires three or more nested function-pointer dispatches is outside
the current static-discovery guarantee and needs a more precise value-flow
analysis before it can be supported safely.

## Per-function transform — before/after WAT

The tool applies a per-function transform that depends on the dispatch
scheme described above. The following pairs show representative fixtures
from `crates/fork-instrument/tests/instrument.rs` and
`crates/fork-instrument/tests/switch_dispatch.rs`. The transformed WAT is
simplified for readability; the actual output includes linked-node hook calls,
default values for result types, and preserved source locations.

> **Note (post-commit-4):** Examples (a) and (c) below describe the
> pre-2.5/2.6 guard-dispatch shape, which was deleted in commit 4 of
> the fork-instrument mega-PR (2026-05-14). Real LLVM-emitted C now
> goes through switch-dispatch (top-level or nested). The historical
> shape is preserved here because (a) some test fixtures still
> describe the wrapping semantics for documentation purposes, (b) the
> state-machine / preamble / postamble structure is shared across all
> dispatch schemes, and (c) the catch-handler resume in §(b) is still
> the live mechanism. For current switch-dispatch examples, see the
> fixtures under `crates/fork-instrument/tests/fixtures/switch_dispatch/`
> and the assertions in
> `crates/fork-instrument/tests/switch_dispatch.rs`.

### (a) Direct call to `fork` with no locals

Fixture: `FIXTURE_DIRECT_CALLER` in `tests/instrument.rs` (see
`wrapper_replaces_call_with_state_gated_if`). Before instrumentation:

```wat
(func $caller (result i32)
  call $fork)
```

After instrumentation (abridged):

```wat
(func $caller (result i32)
  ;; [1] Preamble: if REWINDING, load our frame and jump to matching call.
  (if (i32.eq (global.get $_wpk_fork_state) (i32.const 2 (; REWINDING ;)))
    (then
      ;; Request the next committed payload, then restore frame fields and
      ;; locals. call_index remains in the frame payload header.
      ...))

  ;; [2] Body wrapper: runs on NORMAL; on REWINDING, dispatch jumps to
  ;;     the matching post-call site using frame.call_index.
  (block $unwind_save
    (block $POST_0
      (block $dispatch_normal
        (if (i32.eq (global.get $_wpk_fork_state) (i32.const 2 (; REWINDING ;)))
          (then
            ;; Load frame.call_index from *(buf + 0) + 4.
            ...
            (br_table $POST_0 $unwind_save))))
      ;; chunk 0 would run here on NORMAL only.
    )
    ;; [3] Wrapped call site.
    call $fork
    ;; [4] Post-call unwind check: if callee returned in UNWINDING,
    ;;     write frame.call_index and jump to postamble.
    (if (i32.eq (global.get $_wpk_fork_state) (i32.const 1 (; UNWINDING ;)))
      (then
        ;; *( *(buf + 0) + 4 ) = 0
        ...
        (br $unwind_save)))
    (return))

  ;; [5] Postamble: finish writing the already-reserved node's frame header
  ;;     and serialized locals, commit it, then return a default result.
  ...
  (return (i32.const 0)))
```

Numbered callouts:

1. **Preamble (Phase 4d).** Every instrumented function opens with a state
   test. Under `REWINDING`, the preamble calls
   `__wpk_fork_frame_next(frame_size)`, stores the returned payload in
   `*(buf + 0)`, and deserializes every frame scalar: user locals,
   argument/carryover spills, and tagged-catch activation state. Dispatch reads
   `call_index` directly from that active frame payload.
2. **Body wrapper (Phase 4b/4c).** The original body is wrapped in a `$unwind_save`
   block. On `REWINDING`, a `br_table` keyed by `frame.call_index` jumps to
   the selected post-call landing. On `NORMAL`, dispatch falls through and
   executes the original chunks.
3. **Wrapped call site (Phase 4c).** The original call is kept intact. After
   the call returns in `UNWINDING`, the tool reserves the function's complete
   frame node before its first write, stores the returned payload pointer in
   `*(buf + 0)`, and writes the call site's `call_index` to `frame[+4]`.
4. **Unwind bridge (Phase 4c/4d).** The unwind-only branch writes
   `frame.call_index` and exits `$unwind_save`. If the callee did not begin
   unwinding, execution continues normally.
5. **Postamble (Phase 4d).** Emits the remaining frame header fields
   (`func_index`, `catch_region_id`, and a zero reserved word), writes every
   user and synthetic frame scalar, commits the reserved node, and returns a
   default value of the function's result type. Callers see the default on the
   unwind path but discard it because their own postamble runs next.

### (b) Fork from inside a catch handler

Fixture: `FIXTURE_FORK_FROM_CATCH_HANDLER` (see
`fork_from_inside_catch_handler_full_roundtrip`). Before instrumentation:

```wat
(func $caller (result i32)
  (local $caught i32)
  (block $handler (result i32 exnref)
    (try_table (result i32 exnref) (catch_ref $exn $handler)
      i32.const 7
      throw $exn))
  drop
  local.set $caught
  call $fork)
```

After instrumentation the `CatchRef` clause targets an injected capture block
and the try_table body gets a rewind-throw stub. The exact emitted nesting is
omitted here; the important dataflow is:

```wat
;; Inside the original try_table body:
(if (i32.and
      (i32.ge_u (global.get $_wpk_fork_state) (i32.const 2))
      (i32.eq (local.get $catch_region_id) (i32.const 1)))
  (then
    (if (i32.eq (local.get $active_arm) (i32.const 0))
      (then
        ;; The frame restored 7 (or the actual scalar payload).
        local.get $saved_payload
        throw $exn)
      (else unreachable))))

;; On CatchRef dispatch, stack = (i32 payload, non-null exnref):
local.set $temporary_exnref
local.set $saved_payload
i32.const 0
local.set $active_arm
i32.const 1
local.set $in_catch
i32.const 1
local.set $catch_region_id

;; Forward the original handler values, but retain no synthetic GC root.
local.get $saved_payload
local.get $temporary_exnref
ref.as_non_null
ref.null exn
local.set $temporary_exnref
br $handler
```

Numbered callouts:

- **Rewind-throw stub.** On replay with a matching `catch_region_id`, dispatch
  validates the restored arm index, pushes that arm's restored scalar payload,
  and executes `throw $tag`. The original `CatchRef` clause catches this new
  exception and creates a fresh exnref in the child instance.
- **Capture block.** Every statically tagged `Catch` and `CatchRef` clause is
  retargeted through a per-arm capture. It stores only the arm index and scalar
  payload in frame-backed locals. A `CatchRef` exnref is temporarily forwarded
  to the original handler; the synthetic local is nulled before the branch so
  successful replay and abort paths do not retain a stale GC root.
- **Call-site region writes.** A call inside the handler observes the
  activation-local `$in_catch_K` flag and records the lexical region in the
  frame before unwinding. There is no reference slot or module-global
  reference state.

### (c) Indirect fork through `call_indirect`

Fixture: `FIXTURE_INDIRECT` (see `call_indirect_is_wrapped_with_index_as_top_arg`).
Before instrumentation:

```wat
(func $caller (result i32)
  i32.const 0
  call_indirect (type $sig))
```

After instrumentation the wrapper shape is identical to the direct-call case,
with one addition: the table index is spilled to a synthetic local before the
state-check condition runs, and restored inside the then-branch immediately
before the `call_indirect`.

```wat
(func $caller (result i32)
  ;; ... preamble ...
  (block $unwind_save
    (i32.const 0)                 ;; original table index expression
    (local.set $arg_idx_0)        ;; [3a] spill arg before gate
    (if (<state-gate condition>)
      (then
        (local.get $arg_idx_0)    ;; [3b] restore arg before call
        (call_indirect (type $sig))
        (if (<unwinding check>)
          (then
            ;; frame.call_index = 0
            (br $unwind_save))))
      (else
        (i32.const 0)))           ;; default i32 for the call's result
    (return))
  ;; ... postamble ...)
```

Callouts:

- **Phase 3 closure.** Before instrumentation runs at all, call-graph
  discovery walks every `call_indirect` reachable from the fork seed, looks
  up the call's type signature, and adds every table-reachable function with
  a matching signature to the fork-path set. The wrapper sees indirect calls
  with the same shape as direct calls: one additional top-of-stack i32 arg
  (the table index) on the wasm32 side.
- **3a / 3b — Arg spill.** All call-site arguments (including the indirect
  table index) are spilled to synthetic scalar locals before the gate
  condition runs, so the operand stack is empty at the gate boundary and the
  else-branch can supply typed defaults.

## Nested per-block switch-dispatch

Top-level switch-dispatch only fires when every fork-path call is at the
function's entry-block depth. Real LLVM-emitted C — popen's `__fork`,
`posix_spawn`, FPM's child-spawn, and many libc paths — keeps fork-path
calls inside a `block` / `if` / `loop` / `try_table`, which would force
those functions into guard-dispatch. The popen-class hangs investigated
in `memory/fork-instrument-O2-bug-investigation.md` (external memory)
showed that guard-dispatch's body-replay diverges from NORMAL flow on
LLVM-O2-shaped inputs, even with non-fork-path call gating: the kernel_fork
wrap can be skipped entirely if a control-flow gate reads a different value
on REWIND than on NORMAL.

`instrument_one_function_nested_switch` extends switch-dispatch to nested
fork-bearing regions so those functions never enter guard-dispatch. Two
ideas combine:

### 1. Cascading POST blocks per region

`partition_region_instrs` (in `crates/fork-instrument/src/instrument.rs`)
splits each fork-bearing seq into chunks separated by **landings**. A
landing is one of:

- **DirectCall** — a direct fork-path `Call` or any `CallIndirect` at this
  seq's level. Same shape as classic switch-dispatch.
- **SubRegion** — a `Block` / `Loop` / `TryTable` whose body is
  fork-bearing. The enclosing instruction is preserved verbatim and the
  per-region `br_table` lands the function-level `call_idx` *just before*
  it; the sub-region's own internal dispatch (built bottom-up by recursive
  invocation of the same transform) routes the rest of the way.
- **SubRegionIfElse** — an `IfElse` whose `then` and/or `else` branches are
  fork-bearing. Both branch ranges are recorded so the cond rewrite (below)
  can pick the active branch on REWIND.

The function-level `br_table` maps each `call_idx` to either a direct
`POST_K` (top-level call) or a `POST_J_ENTER` label positioned right before
a sub-region landing. Sub-regions then dispatch internally via their own
`br_table` over the call_idxs that fall in their range.

### 2. IfElse cond rewrite via `select`

The standard top-level `POST_K` block has type `Simple(None)` (0 → 0).
That's incompatible with an `IfElse` landing because the chunk preceding
the IfElse has to leave the original cond on the stack. The default fix:

- At the end of the chunk inside `POST_K`, spill the original cond into a
  freshly-allocated i32 local, `cond_swap_local`.
- After `POST_K` closes, synthesize a replacement cond using a wasm
  `select`:

```wat
;; chunk leaves orig_cond on the stack, then:
local.set $cond_swap         ;; spill — handled by emit_chunk_tail_for_landing.
end                          ;; close POST_K (Simple(None) is satisfied).

;; post-landing sequence — re-create cond for the IfElse:
push force_flag              ;; 1 if active call_idx in THEN's range, else 0.
local.get $cond_swap         ;; re-push orig_cond.
push (state >= REWINDING)    ;; ordinary or abort replay
select                       ;; (is_rewind ? force_flag : orig_cond)
if (then ...) (else ...)     ;; original IfElse, untouched.
```

`force_flag` discrimination:

- only THEN has fork-path calls → `i32.const 1`
- only ELSE → `i32.const 0`
- both branches → range-membership test on THEN's call_idx range
  (`call_idx - then_lo <= then_hi - then_lo`, unsigned), reading the
  `_wpk_fork_call_index` replay cursor. The normal path selects the value
  away; reading the global touches no memory, whereas the earlier
  `*(_wpk_fork_buf + 0) + 4` load dereferenced address zero during ordinary
  execution.

On NORMAL the rewritten cond evaluates to `orig_cond`, preserving the
program's semantics. On REWIND it forces entry into whichever branch
contains the active call_idx, regardless of `orig_cond`. This avoids
re-evaluating the original cond expression during REWIND — important when
that expression has side effects or reads state that may diverge between
parent NORMAL and child/parent REWIND.

When the original condition is produced by a pure scalar suffix such as
`local.get $depth; i32.eqz`, the suffix is removed from the NORMAL chunk and
replayed in the post-landing sequence instead of allocating `cond_swap_local`
or a frame-backed carryover local. If the condition is not pure, or if an
`IfElse` landing also needs extra carryover values below the condition, the
spill-local path above remains the fallback.

### 3. Carryover-spilling at SubRegion + DirectCall landings

LLVM at -O2 inlines `posix_spawn` into `main` (and similar patterns
elsewhere) and emits a single i32 pushed *before* a fork-bearing block
that's consumed *after* it. The
`os-test/basic/spawn/posix_spawnattr_setpgroup` -O2 fixture is the
canonical instance:

```wat
local.get 0           ;; push __errno_location() — the carryover.
block (result i32)    ;; the block contains kernel_fork.
  ... kernel_fork wrap ...
end
local.tee 1
i32.store             ;; consumes both: *errno_location = posix_spawn_rc.
```

`POST_K` is `Simple(None)` (0 → 0), so the chunk before the SubRegion can't
leave anything on the stack. The fix is to spill the carryover into a
fresh **frame-resident** local at the chunk tail, then reload it BEFORE
the enclosing instruction runs (sub-commit 2.6a — push-before order
replaces the earlier push-after + tmp-result-juggle):

- `CarryoverPlan` holds `spill_locals: Vec<(LocalId, ValType)>`, ordered
  deepest-stack-first. All locals are appended to the function's frame so
  they get serialized on UNWIND and restored on REWIND, matching every
  other scalar user local.
- `emit_chunk_tail_for_landing` pops each value off the operand stack via
  `local.set`, top-of-stack-first, into the spill locals. Net stack effect
  of the chunk inside `POST_K`: 0 → 0, satisfying `POST_K`'s type.
- The post-landing sequence pushes spill_locals[0..] back onto the stack
  in order BEFORE emitting the enclosing instruction. The SubRegion's
  type-params (at the top of the post-push stack) are consumed by the
  instruction; any extra carryover beneath stays intact and ends up below
  the SubRegion's result on exit — matching the original semantics WITHOUT
  needing a tmp_result_local juggle.

The same machinery applies to **DirectCall landings inside nested seqs**
(sub-commit 2.5b/c). At each fork-path call site inside a non-entry seq,
per-call carryover spill locals (allocated from
`compute_nested_carryover_types`, keyed by call_idx) round-trip the
carryover values across UNWIND/REWIND.

The SubRegion spill list is computed by `analyze_subregion_spill_types`
(sub-commit 2.6a; replaces the older `analyze_carryover_depths`), which
tracks the typed operand stack as `Vec<Option<ValType>>` and reports the
full list of values to spill per landing — covering both the SubRegion's
declared type-params AND any extra carryover above them on the parent
stack. The current analyser covers scalar, vector, reference/GC, direct,
indirect, and `call_ref` producers as well as multi-value structured-control
parameters and results. Scalar/vector spill locals join the linked payload;
reference spills join the landing's process recipe vector.

**Multi-value-params bodies (sub-commit 2.6c).** When a SubRegion is a
multi-value `Block`/`Loop`/`TryTable` whose body uses its declared input
params, the cascading POST_K blocks can't expose those params to inner
chunks (POST_K is `Simple(None)`, so the wasm validator forbids reading
from outside its scope). The fix: at body entry, pre-spill the params to
fresh function-local locals; in POST_0's body (just before chunks[0]
runs), reload them via prepended `local.get`s. On NORMAL flow the body
params are saved and reloaded; on REWIND the dispatch br_tables past
chunks[0], so the LocalGets are skipped — exactly the cases where the
params would otherwise be needed.

### 4. Pure scalar materialization

Before allocating call-argument or sub-region carryover locals, the transform
checks whether the values at the landing are produced by a suffix that can be
replayed from an empty stack. The whitelist is deliberately small:

- scalar constants and scalar `local.get`;
- non-trapping i32/i64 unary ops such as `eqz`, `clz`, `ctz`, `popcnt`, and
  integer extends;
- non-trapping i32/i64 binary arithmetic, bit operations, shifts, rotates, and
  integer comparisons.

The materialization whitelist excludes calls, memory/table operations, globals,
reference operations, integer div/rem, floating-point operators,
`local.set`/`local.tee`, and any instruction that needs stack input from before
the suffix. A suffix outside that replay-safe optimization is still supported:
the typed spill/recipe path preserves it instead. This keeps REWIND behavior
tied to the same post-call/post-landing sequence while avoiding frame locals
for common compiler shapes like recursive `walk(depth - 1)` arguments and
`eqz(depth)` branch conditions.

**Function-level analyser invariant.** `walk_seq_for_carryovers`,
`compute_carryover_types`, and `compute_nested_carryover_types` must determine
the exact pushed types for every valid producer that reaches a fork landing.
An unknown slot consumed earlier is irrelevant; an unknown live carryover is an
instrumenter typing defect to fix, not an accepted source-program limitation.
There is no guard-dispatch fallback after the mega-PR cleanup.

## Reference and table-state ownership

ABI 43 retires `_wpk_fork_funcref_stash`,
`_wpk_fork_externref_stash`, and `_wpk_fork_exnref_stash`. The tool never
emits them. Static slots were unsafe twice over: recursive/reentrant
activations could alias, and every fork child starts from a fresh module
instance whose tables are empty. JavaScript cannot generically transfer
`funcref`/`externref` across workers or Stores, and the Table API cannot copy
`exnref`.

Closure and liveness analysis runs before rewriting so functions wholly outside
the fork closure remain untouched. Within a live activation, the generated
representation is selected by value class:

- scalar locals, parameters, arguments, and carryovers use the linked frame;
- `funcref` values use an activation-scoped immutable function catalog;
- static references use the fresh instance's static-root catalog;
- concrete and abstract GC references use versioned typed struct/array/i31
  recipes with graph identity established before recursive fields, preserving
  cycles and aliases;
- externalized GC values pass through Wasm's `any.convert_extern` /
  `extern.convert_any` bridge so their typed identity is not mistaken for an
  opaque host object;
- opaque `externref` values use a process-image owner handle. Each Worker has a
  generation-branded canonical token; imports resolve the token at the owner
  boundary rather than transferring the JavaScript object;
- complete Wasm/JSTag exceptions use an exception recipe whose payload
  references the same process graph.

Reference-bearing function signatures, `call_ref`/`return_call_ref`, nullable
and non-null concrete types, reference arguments/results, and reference
operand-stack carryovers all use those same recipes. A fresh child materializes
providers first, restores module state second, then consumes continuation
frames. Capture, successful replay, abort replay, process-image replacement,
and worker teardown clear transaction-local tables and leases so
instrumentation does not retain stale GC roots.

Constructor provenance is recreated as part of typed GC materialization.
Immutable arrays and mutable aggregates with non-defaultable reference seeds
cannot always be allocated from their final field snapshot alone, so the
recipe records the exact constructor layout, up to sixteen scalar operand
bytes, and typed seed edges. The generated allocate helper registers that same
weak provenance for the fresh child object before releasing its staging
record. Consequently a child can fork again and reconstruct an equivalent
grandchild; it never needs a weak-map entry keyed by the parent's Store-local
object. Nullable constructor seeds, including the unobservable seed of a
zero-length array, remain canonical recipe zero.

Mutable reference globals and tables are module-state, not activation-frame
fields. Generated KFMS helpers save mutable globals, table length, sparse dirty
pages, element/data segment lifetime, and typed entries. Static initialization
is recreated by instantiation; runtime `table.set`, `table.fill`, `table.copy`,
`table.init`, and `table.grow` effects are restored from the process-owned
state. A generation-published table journal brings pthread replicas to the
same state before indirect/table-reference use. The dynamic-link archive first
recreates side modules at their exact memory/table bases and registers their
function catalogs; table-state replay then resolves entries against those
fresh functions. Publication writes records before the generation fence, so a
reader can never treat a partially initialized recipe as current.

## Catch-handler resume

Catch-handler resume saves a reconstruction recipe, never a parent-instance
exception reference. Normal handler entry records one function-wide exact
region/arm selector. A statically tagged scalar arm stores its tag payload in a
typed scratch union that overlays the maximum active tuple in the linked frame.
Rewind dispatches inside the same `try_table` body, restores the selected tuple,
and executes the selected arm's `throw $tag`. Normal Wasm exception dispatch
reaches the original clause; `CatchRef` receives a new exnref owned by the child
instance.

Reference-bearing tag payloads, vector payloads, `CatchAll`, `CatchAllRef`, and
legacy-EH cleanup handlers use the complete-exception codec. The codec retains
the caught value only for the activation lifetime needed to encode its recipe,
then reconstructs and throws it inside Wasm during replay. It never asks
JavaScript to return an `exnref`.

```
┌────────────────────────────────────────────────────────────────────┐
│ Parent execution (before fork)                                     │
│                                                                    │
│   try_table (catch_ref $tag $handler):                             │
│     callee_that_throws()                   ← throws tag X          │
│   → $handler                                                       │
│     handler_code                                                   │
│       fork()                               ← unwind begins here    │
│       more_handler_code                                            │
└────────────────────────────────────────────────────────────────────┘
                        │
                        │  unwind: save region K, arm A,
                        │          and scalar tag payload in this frame,
                        │          drain frames to top.
                        ▼
┌────────────────────────────────────────────────────────────────────┐
│ Child instance created, memory copied, rewind begins               │
│                                                                    │
│   main() preamble:                                                 │
│     state == REWINDING, load our frame                             │
│                                                                    │
│   try_table body rewind-throw stub:                                │
│     state == REWINDING && catch_selector == (K, A) →               │
│       validate arm A; push saved scalar payload; throw $tag_A      │
│     ← caught by the original Catch/CatchRef clause; CatchRef       │
│       creates a fresh child-instance exnref.                       │
│                                                                    │
│   handler-level preamble (state still REWINDING):                  │
│     resume at the fork() call site with return value = child pid 0 │
│                                                                    │
│   state := NORMAL, execution continues                             │
└────────────────────────────────────────────────────────────────────┘
```

Mixed `Catch`/`CatchRef` lists, multiple arms, distinct target labels,
`CatchAll`/`CatchAllRef`, reference-bearing payloads, recursion, loop re-entry,
and catches followed by an ordinary merged fork all use the same exact
activation selector and process recipe graph. An unknown selector, malformed
recipe, stale process generation, or catalog mismatch traps before child code
can consume partial state; replay cannot fall back to old instance state. See
[Fork from a tagged catch](#fork-from-a-tagged-catch) under "Maintainer notes"
for the implementation.

## Call-graph discovery

Instrumentation only rewrites functions that can transitively reach the
designated async import (default: `kernel.kernel_fork`). The discovery
algorithm in `crates/fork-instrument/src/call_graph.rs`:

1. Seed set `S` = { the imported `kernel.kernel_fork` function }.
2. **Direct reverse closure.** For every newly discovered callee `g`, add
   every local function that directly calls `g`.
3. **Indirect reverse closure.** If `g` can be dispatched from a function
   table, add every local function that performs `call_indirect` or
   `return_call_indirect` against the same table with a structurally matching
   function type.
4. Repeat steps 2–3 until the worklist is empty.

The output is a function-set `S` that gets instrumented. All other functions
pass through unmodified.

The host-parsed marker exports `__abi_version`,
`__wasm_posix_thread_slots`, and `__get_channel_base_addr` also remain
unmodified even if call-graph discovery includes them in `S`. The host reads
their wasm-ld wrapper bodies directly and does not use them as fork
continuation roots.

The indirect-call step is a may-analysis, but it is slot-sensitive when the
Wasm proves enough facts. Active element segments with constant offsets
populate known table slots. A `call_indirect` whose table index is a literal
`i32.const` or a folded constant `i32.add`/`i32.sub` expression can dispatch
only to that slot, so a same-signature fork-path target in a different slot
does not pull in the caller. Dynamic indexes remain conservative: if the table
contains a matching fork-path target anywhere, the caller stays in `S`.

Unknown table state also remains conservative. Passive segments count only for
tables that can receive them via `table.init`; because the destination range is
not modeled, their functions are table-wide. Declared segments do not populate
a table. Dynamic table writes (`table.set`, `table.fill`, `table.grow`) make
the table unknown, so any matching-signature fork-path target may be reachable.
`table.copy` propagates known and unknown source-table state to the
destination.

This is enough for registered callback paths such as signal handlers, pthread
cleanup handlers, `atexit` handlers, and qsort-style comparators in the current
libc output. The broader "instrument every address-taken function" rule from
the original C3 plan was not needed for this PR and was not added; K-01, K-02,
K-04, and K-07 cover the current behavior.

## Fork sinks and compiler facts

The closure above is the conservative fork path. By default the instrumenter
then reduces it with a sink analysis (`crates/fork-instrument/src/sink.rs`):
a function whose fork child can never return to its caller (it calls `_exit`
or `exec*`) is a boundary; the parent's unwind stops there and the callers
above it stay uninstrumented. `--no-sinks` keeps the full closure. The
design and its measurements are in
[`plans/2026-10-02-fork-sinks.md`](plans/2026-10-02-fork-sinks.md).

The analysis resolves each `call_indirect` in one of two ways.

- **With compiler facts.** The SDK's KandeloCallTypes clang plugin writes,
  per object, a text description of the object's functions and call sites
  (CFI type ids, virtual-call slots, function-pointer conversions, untyped
  pointer flow per slot, `pthread_cleanup_push` pairs, `jmp_buf` identity,
  each unit's aliasing mode) into a custom section named `kandelo.calltypes`.
  wasm-ld concatenates those sections in input order, so the linked module
  carries one section made of per-object chunks. Large chunks use lossless
  zlib frames; the reader decodes one chunk at a time before parsing the
  same format-5 records. Plain and framed objects may be linked together.
  The framing and expansion limits are specified in
  [the SDK guide](sdk-guide.md#compiler-facts-for-fork-instrumentation).
  The link also records
  `kandelo.calltypes.code-sha256`, the SHA-256 of the code section payload
  (from the function count to the section end). The instrumenter uses the
  facts only when that hash matches the code it receives; a tool that
  rewrites code after linking (a `wasm-opt` run in a package build, for
  example) keeps unknown custom sections but changes the code, and the facts
  would then describe the wrong functions. A mismatch or a missing hash
  prints one line and falls back to the analysis without facts.
- **Without facts**, call sites match by Wasm signature (plus the musl
  registry, parameter and constant-slot refinements).

Facts are bound to functions without a linker map. Objects keep their order
on both sides, so each module function is matched, in index order, to a
same-named definition in the current or a later chunk; inside one chunk
functions match by name, because clang does not emit a file's functions in
the order the plugin lists them. Names that are unique on both sides anchor
the alignment. The name section holds demangled names only, so one name can
stand for several definitions: a C++ constructor's or destructor's complete-
and base-object variants in one object, or same-named file-local functions
(including linkonce copies) in several objects between two anchors. Such a
function is bound to all of them and the analysis uses the union of their
facts (call sites of every variant whose indirect-call signatures match the
body, every variant's type ids, no registry-hub rule), never a guess by
order. A pair whose Wasm parameters cannot be the wasm32 lowering of the IR
parameters (equal count, or extra `i32` for a variadic tail or a 128-bit
result pointer and `i64` pairs for 128-bit values) is not bound.
Definitions the link removed are skipped. Functions with no binding
(linker-synthesized code, objects built without the plugin) are analysed
without facts: their own indirect calls and their use as targets match by
Wasm signature.

Known gap: a function-pointer conversion made inside an object without facts
is invisible to the type rules. If such an object takes the address of a
function defined in an object with facts and calls it through another C
type from a site that has facts, that edge is missed. The research results
were measured with this same per-function fallback; falling back for the
whole module whenever any object lacks facts would close the gap at the cost
of the precision. Which objects lack facts is reported by `--sink-report`
(`bound` against `defined`).

The rules applied with facts: exact CFI type matching except for functions
the source converts, puns or passes through untyped pointers to another
function type; C's effective-type rule in units compiled with strict
aliasing; the musl and libc++ callback registries; `pthread_cleanup_pop`
running only its own scope's handlers; calls through a `sigaction()`
old-action global dispatching only registered handlers; and per-buffer
`longjmp` targets.

Which analysis runs:

| Module | Analysis |
|---|---|
| wasm32 main module, `kernel.kernel_fork` entry, facts with a matching hash | with facts |
| main module that cannot dlopen, facts absent, unreadable, unhashed or stale, or wasm64 | without facts |
| main module that can dlopen, no usable facts | none (full closure) |
| side module (`dylink.0` or `--entry env.fork`) | none (full closure) |

A module that can dlopen is analysed with facts too. What it may assume
about side modules is chosen with `--side-modules`:

- `traced-entries` (the default). The analysis treats a side module as
  entering the main program only through its imports (an `env` function or
  a `GOT.func` slot). A function whose fork child can return to a caller is
  *fork-returning*; it stays instrumented in the callers' frames. The
  instrumenter records the main module's side of that assumption in a
  `kandelo.wpk_fork.dlopen_contract` custom section: the exported
  fork-returning functions, and whether any fork-returning function is in
  the indirect-call table (`address-taken`). At `dlopen` both hosts read the
  section (`host/src/fork-side-module-contract.ts`) and refuse, with a
  `dlerror()` message naming the import, a side module that imports a
  fork-returning function, or any side module at all when a fork-returning
  function's address is taken (a side module could then reach it through a
  function pointer the analysis never saw). The refusal is the real
  boundary: the main program was compiled to fork correctly only from the
  calls it could see. Refusing every side module would take `dlopen` away
  from a program that has it, so when the analysis finds an address-taken
  fork-returning function the instrumenter prints one line and plans that
  module for `assume-all-entries-fork-returning` instead.
- `assume-all-entries-fork-returning`. Any indirect call may enter a side
  module whose fork child returns anything, so every function whose fork
  path can pass through a side module stays instrumented and is never a
  boundary. The contract section says so and the hosts impose no
  restriction. Use it for a program that must load arbitrary plugins.

Facts that cannot be read, or an
internal error in the facts analysis, fall back to the analysis without
facts with a one-line message, never to anything less conservative. The
`kandelo.calltypes` and `kandelo.calltypes.code-sha256` sections are removed
from every output, including a module the instrumenter otherwise returns
unchanged.

Flags:

- `--no-facts` ignores the facts (diagnosis).
- `--no-effective-types` applies C's effective-type rule nowhere.
- `--side-modules=traced-entries|assume-all-entries-fork-returning` (above).
- `--sink-report` (hidden) prints which analysis decided (`source\t<closure|builtin|facts>`),
  the facts' coverage, and the instrumented set and boundaries as
  `A\t<name>`/`B\t<name>` rows.

When the analysis moved into this crate (#1471) it was checked against the
research tools it replaced, on their research links, with the per-object
facts concatenated in link order into the section. The tools and that
comparison harness were removed afterwards; they remain in git history at
a3f0eb448 (`tools/fork-sink-research`,
`crates/fork-instrument/examples/facts_equivalence.rs`). For
foot, git and bash every function's binding is, or (for 141, 51 and 1
functions bound to a union) contains, the research tools' map-based binding,
the exported indirect-call targets, cleanup and `jmp_buf` facts are
byte-identical to theirs, and the instrumented sets and boundaries equal the
research results (4, 25 and 1,912 distinct names). Those research results
assume the dlopen contract (`--side-modules=traced-entries`), which only
bash needs (it can dlopen); with `assume-all-entries-fork-returning` bash
keeps 1,927 of 1,929 functions. Instrumented binaries
built through the SDK with embedded facts have not been run yet.

## Guarantees and non-guarantees

### Guaranteed

- **Call stack.** Every fork-path function's call stack position is
  serialized as a frame (func_index + call_index) and reconstructed during
  rewind. The child resumes at the exact call site from which the parent
  invoked `fork()`.
- **Scalar user locals.** All i32, i64, f32, f64, and v128 locals on the
  fork-path are saved to linear memory at unwind and restored at rewind.
- **Fresh-instance ownership.** Every accepted replay value is either scalar
  activation state in the linked continuation or state rebuilt by an explicit,
  versioned reconstruction owner. Instrumented modules carry
  `FORK_CAP_ACTIVATION_STATE_SAFE`; ABI 43 hosts and artifact guards reject a
  fork-shaped artifact without that capability before execution.
- **Byte-reproducible instrumentation.** Given the same input bytes, CLI
  options, and built tool, separate processes emit byte-identical Wasm.
  Synthetic locals and nested regions are assigned in canonical sequence-ID
  order rather than randomized hash-map iteration order.
- **Mutable scalar globals.** Snapshotted in
  `wpk_fork_unwind_begin` and restored in `wpk_fork_rewind_begin`.
  Includes `__stack_pointer`, `__tls_base`, and any program-declared
  mutable globals.
- **Reference activation state.** Live reference locals, parameters,
  reference call arguments/results, call-ref callees, and operand-stack
  carryovers are represented by typed process recipes and decoded into the
  fresh activation. Definitely-null references consume no recipe entry.
- **Mutable reference globals and tables.** KFMS module-state helpers restore
  reference globals, sparse table contents and length, and passive-segment
  lifetime before frame replay. Process generation fencing keeps pthread
  replicas and late dynamic-link consumers coherent.
- **Exception context.** Frames captured inside a catch handler carry the
  exact dynamic region/arm selector. Scalar tagged payloads occupy an overlaid
  maximum-size tuple; reference/vector payloads and untagged catches use a
  complete-exception recipe. Replay throws inside Wasm so `CatchRef` and
  `CatchAllRef` receive fresh child-instance exnrefs.
- **No stale replay roots.** The instrumenter emits none of the historical
  `_wpk_fork_*ref_stash` tables. Temporary codec slots, retained caught
  exceptions, anyref transit entries, and externref handle leases are cleared
  on normal completion, successful replay, abort, process-image replacement,
  and worker teardown.
- **Frame-pressure bounds.** Ordinary reference recipes add no source-function
  local and no bytes beyond the existing 16-byte linked-frame header:
  catch selector and vector ordinal reuse `+8` and `+12`. Catch operand storage
  is colored by maximum simultaneously live type tuple rather than static arm
  count. Generated helper-function locals and the process recipe arena are
  outside every ordinary native activation.
- **Kernel-side-effect calls don't re-fire during REWIND.** Switch-dispatch
  (the only live scheme post-commit-4) skips the body chunks before the
  matching `POST_K` entirely on REWIND, so non-fork-path direct calls
  (`setpgid`, `dup3`, `kill`, `open`, `pipe`, …) and all observable
  side-effect ops in those chunks run exactly once, on the parent's NORMAL
  pass. No per-call or per-op gating is needed.

### Boundaries outside activation replay

- **`makecontext` / `swapcontext` / `getcontext` / `setcontext`.** Userspace
  stack-switching primitives are unsupported and not on any roadmap. See
  [posix-status.md](posix-status.md) for rationale.
- **Host engine proposal support.** The input must be a valid module for both
  the transform's parser and the target Node/browser engine. The ABI does not
  emulate a WebAssembly proposal that the selected engine itself cannot
  instantiate.
- **Stale or incomplete artifacts.** ABI 42 fork artifacts, copied capability
  bytes, malformed recipe metadata, and mixed-version host/module contracts
  fail before execution. They are rebuild inputs, not compatibility modes.

#### Closed since the mega-PR's 2.5/2.6 sub-commits

These were "Not guaranteed" pre-2.5/2.6 but are now absorbed by switch-
dispatch (top-level or nested):

- ~~**Operand-stack carryovers at DirectCall landings**~~ — sub-commit 2.5c
  added per-call carryover spilling at direct fork-path call landings.
- ~~**Multi-value-params Block/Loop/TryTable bodies containing fork-path
  calls**~~ — sub-commit 2.6c added body-input-param prespill so the
  cascading POST_K blocks can re-expose params to inner chunks.
- ~~**Wider carryover shapes at sub-region landings (multi-typed, multi-
  value)**~~ — sub-commit 2.6a's `CarryoverPlan::spill_locals` Vec
  generalised the single-i32 MVP to any number of typed slots.
- ~~**Top-level carryovers with unknown-type producers consumed before the
  fork call**~~ — sub-commit 9-followup generalised the top-level
  analyser to `Vec<Option<ValType>>`, mirroring 2.5c's nested policy.

### Side effects during REWIND — no gating needed

Post-commit-4 (2026-05-14), switch-dispatch is the only live dispatch
scheme. By construction, the body chunks before the chosen `POST_K`
**never re-execute on REWIND** — the function-level `br_table` jumps
directly to the matching post-call block, bypassing every preceding
instruction. This means:

- **Non-fork-path direct calls** in those chunks (libc wrappers for
  `setpgid` / `dup3` / `open` / `kill` / `pipe`, etc.) never re-fire.
  Their kernel side effects happen exactly once, on the parent's
  NORMAL pass. The pre-2.5/2.6 guard-dispatch's `state == NORMAL`
  gate + frame-saved result locals are no longer needed.
- **Observable side-effect ops** (`local.set`, `local.tee`,
  `global.set`, `store` of all widths, `memory.grow` / `memory.fill`
  / `memory.copy` / `memory.init`, `data.drop` / `elem.drop`,
  `table.set` / `table.grow` / `table.fill` / `table.init` /
  `table.copy`, atomic RMW, `atomic.notify`, `throw` / `throw_ref`)
  in those chunks similarly run only on NORMAL.

The pre-2.5/2.6 Phase 4g side-effect-gating machinery
(`emit_gated_side_effect`, `side_effect_shape`,
`emit_gated_non_fork_call`) was deleted alongside guard-dispatch in
commit 4. The historical context — including the
`local.tee` identity-passthrough bug from the popen-class divergence
investigation — is preserved in
`memory/fork-instrument-O2-bug-investigation.md` (external memory).

## Performance envelope

Linked continuations add three imported host calls per saved activation over a
complete fork cycle: reserve and commit while unwinding, then next while
replaying. Each saved activation also carries a 24-byte node header on wasm32
or a 32-byte node header on wasm64, rounded together with the payload to an
8-byte boundary. Each active module continuation uses at least one 64 KiB
page-rounded anonymous mapping; another mapping is added only when the current
chunk cannot hold the next complete node. An individual frame larger than a
Wasm page is allocated in a correspondingly larger page-rounded chunk.

ABORT_UNWINDING adds one i32 local and a result-typed restart-loop guard to each
transformed function, a zero-reservation branch at each fork-path call site,
two control exports, and a 16-byte root-prefix selector. This code executes
only on replay checks or allocation failure; ordinary execution adds the local
and loop structure but does not allocate continuation memory.

The module-format fixed cost is three imports, two abort exports, plus the
24-byte `kandelo.wpk_fork.linked_frames` descriptor and normal Wasm section/name
encoding. The fixed 60 KiB host-reserved control-region geometry remains in
place from ABI 42, but it is no longer continuation capacity: only its anchor
word is used to find the dynamically allocated root chunk.

The ABI 43 deferred-signal request flag occupies the channel header, and the
post-import checkpoint is an ordinary syscall. Neither adds bytes to the
linked continuation, its 16-byte frame header, or an activation payload.

A function with tagged catches uses one function-wide exact-arm selector and
one typed scalar operand union colored to the maximum simultaneously live
payload. The fixed frame header remains 16 bytes, references add no frame
bytes, and additional catch arms do not each allocate a tuple. A scalar catch
payload can still enlarge that function's frame by the maximum live tuple;
activation-owned storage is required for recursion and reentrancy correctness
and replaces the unsafe module-global tuple.

As a narrow size check, instrumenting the P-10 deep-recursion fixture from the
same 27,886-byte raw Wasm produced 50,873 bytes with the ABI 41 instrumenter
and 52,330 bytes with the ABI 42 linked-frame instrumenter: 1,457 additional
bytes (2.86%). This is one small fixture, not a general application-size
claim; the fixed import/metadata cost and the number of transformed call sites
change the percentage substantially between programs.

Using the same dev-shell compiler invocation on 2026-07-21, the current P-10
source produced a 27,608-byte raw module. Commit `a4789e2c6` (linked frames
before abort recovery) instrumented it to 52,052 bytes; ABORT_UNWINDING
instrumented the identical raw input to 58,370 bytes. The recovery state
machine therefore added 6,318 bytes (12.14%) to this instrumented fixture.
P-10 deliberately creates a very large conservative fork-path closure, so this
is a stress-fixture result rather than a general package-size estimate.

Performance comparisons must use the fork-heavy benchmark suites with
`npx tsx benchmarks/run.ts --rounds=3` on both the Node.js and browser hosts.
The suites that exercise fork meaningfully are `wordpress`, `erlang-ring`,
and `process-lifecycle`. Do not infer a regression percentage from the
structural costs above.

For the concrete numbers landed by the Phase 7 rollout PR, see Task 15 of
`docs/plans/2026-04-21-fork-instrument-phase-7-rollout-plan.md`. Binary size
for fork-heavy programs is expected to be equal or smaller than under the
prior full-module fork-continuation carve-out (most notably git), since the tool instruments
a tighter reachable set.

## Maintainer notes

### Reasoning about which scheme a function uses

When a real-world program misbehaves during fork, the first triage step is
to identify which switch-dispatch shape the offending function uses:

```bash
wasm-tools print "$BIN" | awk '/^\s+\(func [^;]*main/{found=1} found{print}' | head -200
```

A replay preamble `if (state >= REWINDING) ... end` followed by a `loop`
whose body opens the function's landing blocks means switch-dispatch is
active. A dispatch with several landings is
`block (state < REWINDING; br_if 0) (global.get $_wpk_fork_call_index) br_table`;
a region with one landing instead begins its landing block with
`state >= REWINDING; br_if <landing>`, and a region whose landing has nothing
before it needs no dispatch at all. A historical
`block $unwind_save` followed by per-call `(state == NORMAL || (REWINDING &&
call_idx == K))` if-elses means an old guard-dispatch binary is being
inspected, not current PR output.

To distinguish top-level switch-dispatch from nested switch-dispatch,
look inside the enclosing instructions: nested switch-dispatch emits the
same dispatch shapes inside any
fork-bearing `block` / `loop` / `if` / `try_table`, plus a `select`
rewriting any fork-bearing IfElse's condition afterwards. Impure IfElse
conditions also show a `local.set $cond_swap_local` at the end of the
preceding chunk; pure condition suffixes are replayed at the post-landing
instead. Top-level switch-dispatch has only the function-level dispatch and
never touches a sub-region's body.

Carryover-spilling at a SubRegion landing shows up as a pair of fresh
i32 locals (recorded in the function's frame): the chunk inside `POST_K`
ends with `local.set $spill_local`, and after the enclosing instruction
the post-landing sequence emits `local.get $spill_local` (and, when the
enclosing instr returns an i32, a brief juggle through `tmp_result_local`).

Nested switch-dispatch coverage lives in
`tests/switch_dispatch.rs::nested_fork_call_uses_per_block_switch_dispatch`
and the carryover-spilling / pure-materialization fixtures alongside it. Add
new regressions there or in `host/test/fork-instrument-coverage.test.ts`
depending on whether the bug is a tool-level transform issue or an end-to-end
host/runtime issue.

### Running tests

Unit tests live in `crates/fork-instrument/tests/`. The default cargo target
in this workspace is `wasm64-unknown-unknown` (from `.cargo/config.toml`),
which cannot build host tests — always pass the explicit host target:

```bash
HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
cargo test -p fork-instrument --target "$HOST_TARGET"
```

### Running the fuzz gate

Phase 6 catch-handler resume was validated with a random-WAT fuzzer that
generates try_table programs on a fork path and asserts both walrus and
wasmparser accept the instrumented output.

```bash
scripts/run-fork-instrument-fuzz.sh                 # default 10 000 iters
FUZZ_RUNS=50000 scripts/run-fork-instrument-fuzz.sh # longer run
```

The script passes `--sanitizer=none` to `cargo fuzz`. On macOS arm64,
cargo-fuzz's default AddressSanitizer deadlocks during init (the malloc
interceptor recurses into ASAN init which holds a spin mutex). The fuzzer
targets validator/semantic divergence rather than memory-safety, so ASAN is
not load-bearing.

### Supporting additional reference state

Do not add a module-static reference stash. A fresh fork child has a new Wasm
instance, table, Store, and exception-tag identity, so a slot number is not a
transferable value even if it happens to fix same-instance recursion.

Support for a new reference shape extends one of two complete designs:

1. Encode every value needed by replay as versioned activation-owned bytes in
   the linked continuation, then reconstruct the reference deterministically
   in the child.
2. Name an explicit host reconstruction owner, version its recipe, and prove
   Node, browser, pthread, and side-module parity.

Add a positive fresh-instance replay test that would fail if the parent
module's globals or tables were consulted, plus malformed/version-mismatch
tests for the ownership contract. A valid source shape is not converted into
an instrumentation rejection merely because its reconstruction provider is
new work. Update the capability contract and bump the ABI if the accepted
artifact surface or reconstruction format changes.

### Extending side-effect coverage

There is no live side-effect gating path after guard-dispatch removal. If a
new wasm opcode can appear before a fork-path call, add coverage that proves
the containing switch-dispatch shape skips that opcode on REWIND. Existing
examples are the S-01..S-08 host fixtures plus the WAT-level table-operation
tests in `crates/fork-instrument/tests/coverage_wat.rs`.

### Fork from a tagged catch

`Catch` arms unwrap the thrown exception's operand tuple at handler entry.
`CatchRef` arms additionally push an instance-local exnref. Neither reference
identity nor module scratch is available in a fresh child, so both forms replay
from activation-owned selectors and typed recipes.

The implementation adds that path without accessing continuation memory during
ordinary catch execution:

1. **Static discovery (`plan_plain_catches`).** Walk each fork-path function
   and collect every `Catch`, `CatchRef`, `CatchAll`, and `CatchAllRef` arm's
   tag when present, target label, exact catch-list index, kind, and operand
   types. Legacy `try` handlers are normalized to the same modern-EH control
   representation. This plan has no runtime addresses or activation state.
2. **Activation allocation.** Allocate one function-wide exact-arm selector
   and a typed operand-scratch union sized by maximum simultaneous use.
   Scalar `CatchRef` forwarding uses one short-lived nullable exnref scratch;
   complete-exception arms retain only the liveness-colored recipe roots
   required at a fork landing.
3. **Frame ownership.** Header word `+8` stores the selector. Scalar payload
   types overlay one maximum-size frame range; reference/vector payloads are
   edges in the process recipe graph. Each recursive or reentrant activation
   therefore owns a distinct recipe without cost proportional to static arm
   count.
4. **Capture.** A generated block records the incoming tuple or complete
   exception and exact selector, then restores the original handler stack.
   Short-lived forwarding scratch is cleared before user code; retained recipe
   roots are cleared by transaction completion or abort.
5. **Replay.** `inject_rewind_throw_stubs` dispatches on the restored selector.
   Scalar arms push their tuple and execute `throw` with the original tag.
   Complete-exception arms materialize and throw inside Wasm. The original
   clause then reconstructs its payload and, for reference clauses, a fresh
   child-local exnref. An unknown selector traps instead of consulting old
   instance state.

The lifetime boundary is load-bearing: a catch can run before any fork or
after a prior continuation has been released. Its normal capture path must
therefore never dereference `_wpk_fork_buf`.

C-08/C-09 verify the transformed funcref/externref catch shapes. The Node
`catch-ref-fresh-worker` test and Chromium continuation gate additionally
execute non-null funcref and nullable externref payloads through `CatchRef` in
new process Workers; the child calls the reconstructed funcref and receives a
fresh child-local exnref. The module-exception, GC-codec, process-owner, and
mailbox suites separately cover vector payloads and non-null opaque externref
ownership. Together these gates prove that catch operands use typed recipes
rather than being misclassified as scalars or placed in a module-static table.

## See also

- [architecture.md](architecture.md) — overall kernel / host / user-program
  separation.
- [abi-versioning.md](abi-versioning.md) — why the `wpk_fork_*` export names
  and save-buffer layout are covered by `ABI_VERSION`.
- [posix-status.md](posix-status.md) — per-syscall support, including the
  `ucontext` family's unsupported status.
- [porting-guide.md](porting-guide.md) — how to compile programs against the
  SDK; `wasm-fork-instrument` is invoked automatically by build scripts.
- [`plans/2026-04-20-fork-instrumentation-design.md`](plans/2026-04-20-fork-instrumentation-design.md)
  — the originating design discussion, including alternatives considered.
