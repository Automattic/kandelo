# Memory-bounded fork instrumentation

The existing Walrus transform remains the correctness oracle during this
migration. Reading operators with a streaming parser and then constructing
the full Walrus module does not bound instruction memory.

## Existing pass dependencies

| Pass | Reads | Produces / ordering requirement |
| --- | --- | --- |
| Artifact checks | Original imports, exports, custom sections | Reject restamping and reserved runtime hooks |
| Compiler-fact binding | Exact original code hash, linker function order, names, parameter types, object chunks | Definition bindings and facts-derived dispatch targets; no optimizer may run before binding |
| Legacy dlopen lowering | Import signatures, memory/table geometry | Driver function and replacement imports; introduces indirect dispatch |
| Initial call closure | Calls, tail calls, lexical dispatch proofs, type subtyping, element contents, all source table writes/copies/initializations | Activation and semantic control sets |
| Legacy exception normalization | Initial activation set, nested legacy handlers | New lexical control coordinates; requires a second closure pass |
| Sink analysis | Per-function abstract execution, call/throw/return fixed points, compiler-fact targets, callback registries, longjmp identities | Boundaries, reduced activation/control sets, dlopen contract |
| Activation validation | Types, locals, calls, catches and reference liveness | Replay ownership validation |
| Catch and resume planning | Source entry points, exact catch arms, function-local control structure | Catch selectors, resume thunks/catalog and unwind transport helper keys |
| Static reference planning | Original globals, table initializers, element expressions | Static identity catalog; precedes segment conversion |
| Module-state planning | Original globals, tables, segments, start, writes in **all** functions | Ownership ordinals, segment lifetimes, table baselines and synchronization policy |
| Runtime declaration | Pointer width, global snapshot layout, codec shapes | Private imports, types, globals, runtime helpers |
| Continuation rewrite | Frozen reaching/sink decisions, catch plan, reference analysis, runtime declarations | Per-function switch dispatch, frame codecs, thunks; currently also declares helpers during rewriting |
| Module-state rewrite | Original state plan and runtime declarations | Table read/write barriers and segment-drop tracking in **all** source functions, bootstrap helpers |
| Emission | Every index space, final helper declarations, metadata | Remapped code, expressions and sections; feature declarations and leading dylink placement |

The existing `facts::Side` retains expanded string graphs for the whole link.
Moving instruction bodies out of memory alone does not bound that structure.
The sink interpreter also revisits callees for specialization, so replacing
its `Module` argument with a one-shot iterator is insufficient.

## Pipeline ownership

1. Scan the immutable original binary. Retain byte ranges, types, compact
   function summaries, original operator offsets, and fact-section ranges.
   Validate bodies serially, reusing validator allocations. Discard each
   decoded operator immediately. Never retain names or bytes by instruction.
2. Bind facts against that exact binary. Reduce object chunks into interned
   relations, with external storage for relations too large for the memory
   budget. Resolve call/sink fixed points before helper declaration.
3. Freeze helper declarations and mappings for functions, types, tables,
   memories, globals, tags, data and elements. Original program points are
   `(original function index, original operator byte offset)`, not Walrus
   arena IDs or emitted offsets. Normalization must explicitly retain this
   provenance.
4. Decode, rewrite and emit one source body at a time. A function outside
   the activation set still passes through index and module-state rewriting.
   Use serial execution initially: the concurrency bound is one, independent
   of Rayon or host CPU count. Spool variable-length sections to private
   temporary files and copy with fixed-size buffers after their lengths are
   known. A `Vec<u8>` convenience API cannot make an output-memory bound;
   production emission must accept a writer.

Do not silently fall back from a requested bounded transform to whole-module
Walrus parsing. Do not emit fork capability metadata from a partial transform.
Existing `instrument`, `analyze` and `sink_report` remain the oracle until the
replacement passes have semantic/runtime equivalence coverage.

## Validation and rollout

Compare conservative closures against the existing implementation, including
tail calls, duplicate signatures, typed references, imported/dynamically
written tables, passive segments, and legacy/modern exceptions. Compare
original operator coordinates against the exact input, including unreachable
operators. Exercise remapping in code and module expressions, fresh-instance
fork replay, deterministic separate-process output and malformed inputs.

Measure scans and transforms separately. Small synthetic modules can establish
retention behavior; they cannot establish Codex instrumentation capacity.
Large Codex runs require coordination and the 16 GiB physical-footprint guard.
The supplied historical 16.02 GiB sample was stopped during sink planning,
before rewriting/emission, and is not a measured peak for the complete tool.

## Implementation milestones

1. **Establish scan and emission correctness.** Finish the compact scanner,
   conservative closure resolver and writer-based emitter. Differentially test
   closure results against Walrus. Check unreachable code, lexical constant
   proofs, type subtyping, passive segments, table copies and exception
   regions. Verify all index spaces in bodies, expressions, exports, start
   and names. Exercise section/function budget failures and output I/O errors.
   Preserve original operator provenance through all later normalization.
2. **Move facts and sink analysis off whole-module IR.** Bind exact original
   functions before lowering or optimizing. Process facts one object at a
   time, intern shared strings and externally store large relations. Refactor
   sink execution to load/discard bodies on demand, retaining only compact
   return/throw/continuation summaries across fixed-point iterations. Bound
   specialization caches. Compare decisions, facts coverage, boundaries and
   dlopen contracts with the oracle, including conservative fallback cases.
3. **Freeze declarations and module-wide plans.** Separate discovery from
   code generation for catch recipes, frame codecs, unwind transport helpers,
   resume thunks and module-state helpers. Assign deterministic indices for
   every index space before any body is emitted. Plan static reference
   identities before segment conversion. Account for legacy dlopen/EH
   lowering without losing original coordinates.
4. **Port the complete function transform.** Reuse the existing continuation
   algorithms with function-local IR. Decode one body, normalize, validate
   replay ownership, rewrite continuation and module-state operations, emit,
   then release the body and all function-local scratch. Rewrite non-closure
   functions for state tracking and index changes too. Start with concurrency
   one and enforce configured resource limits. Keep Walrus as an explicitly
   selectable oracle, with no automatic unbounded fallback.
5. **Integrate bounded production I/O.** Add an atomic file/writer entry point
   and CLI backend selection. Freeze declarations before writing sections;
   use temporary-file spooling wherever a section size is not known. Eliminate
   module-sized output vectors and boundedness loopholes in metadata, helper
   code and final feature declaration. Keep existing build invocation and ABI
   behavior; document any integration changes for the package/SDK agent.
6. **Validate before changing the default.** Run the relevant Rust and
   existing Node/browser fork-replay suites, ABI snapshot gate and independent
   Wasm validation. Include fresh-instance references, exceptions, module
   state, tail calls, sinks, dynamic linking and separate-process determinism.
   Measure scan, facts/sink, rewrite and emission peaks independently on
   synthetic scaling fixtures. Coordinate a guarded Codex run only after
   those gates; retain the 16 GiB physical-footprint guard and bounded jobs.
   Report transform memory separately from application runtime performance.

As of the pause on 2026-10-22, only the initial scan/emission/closure building
blocks have been drafted. The existing production transform is unchanged.
The scanner and emitter passed a Cargo check before the closure resolver was
added; the final draft has not been checked or semantically tested. No large
input was run and no memory improvement is claimed.

## 2026-10-23 progress

### Initial scan/emission checkpoint

Work resumed with focused host-target instrumenter builds and fixtures,
without rebuilding the kernel, SDK, packages or browser products.

- The scanner now interleaves validation and summary collection. Detached
  unreachable suffixes do not contribute call edges, but emission still visits
  their exact original operators. Nested control attachment and no-op lexical
  provenance are covered by fixtures.
- The compact closure resolver is compared against Walrus across the existing
  call-graph fixtures, for both local and external dynamic dispatch policies.
  Comparisons include activation/control sets and exact original tail offsets.
- Definition-only facts binding verifies the original code hash and uses the
  existing linker-order binder. It decodes one object at a time and retains
  only definition names and parameter counts. Full target/flow/sink analysis
  remains on the oracle path; split chunks spanning separate custom sections
  are not yet supported by the new definition reader.
- The writer emitter spools code and data sections, consumes one function
  encoder at a time, and preserves leading dylink placement. Metadata buffers
  and functions have explicit emission limits. Source input, compact summaries,
  validator state and caller-supplied transform scratch remain separate memory
  costs; these limits are not a physical-footprint guard.
- Tests execute remapped modules in Node with added private imports shifting
  function/type/memory/table/global/tag indices, and check active segments,
  starts, indirect calls and exception payloads. Other fixtures cover modern
  and legacy exception regions, deterministic diagnostic CLI output, budget
  failures, writer failures, and total code larger than one function budget.
- `--streaming-scan` exposes scan statistics and definition binding only. It
  cannot emit a fork artifact. Production instrumentation and its ABI remain
  on the original implementation; no default backend was switched.

The next substantive milestone is a bounded provider for sink execution and
facts relations, followed by frozen helper declarations and function-local
continuation/module-state rewriting. In particular, the current transform's
`reference_analyses` map retains liveness/nullability for every target at once;
the replacement must compute and discard that information per source body,
before introducing that body's synthetic dispatch locals.

At this initial checkpoint, no Codex input was copied or executed and no
physical-memory comparison had been run. The later bounded front-end
measurements are recorded below; a complete bounded fork transform is still
unfinished.

Validation: `scripts/dev-shell.sh` with the explicit host target, two Cargo
jobs and two test threads ran the complete fork-instrument crate suite:
401 passed, none failed or ignored. After adding the final segment-remapping
fixture, all 13 streaming tests passed in a focused rerun. The suite includes
the existing Node replay/codec/state fixtures and production CLI determinism
tests; it is not browser or conformance evidence for the experimental path.
Logs are `.context/fork-instrument-tests-final.log` and
`.context/streaming-tests-final.log`. `git diff --check` passed.

No whole-workspace, browser, conformance or ABI snapshot gate was run. The ABI
script unconditionally builds the kernel, so it was left for the later
integration gate under the user's request to avoid a full rebuild. Shared ABI
sources and snapshots were not changed. No package/SDK integration change is
required for this diagnostic stage.

### Native IR and function-local analysis/rewrite slice

The user chose wasmparser/wasm-encoder with a Kandelo-owned function-local
IR, keeping registry Walrus unchanged as the production implementation and
correctness oracle. No Walrus fork, vendor copy or registry-source patch is
part of the change. Walrus originally supplied typed structured control,
validation and index-safe emission; the replacement still needs those
capabilities. wasmparser supplies operator definitions and validation, and
wasm-encoder supplies binary encoding. Kandelo's IR owns source coordinates,
symbolic control-region identities, exact exception-arm ordering, transfers,
locals and typed pre-call operand stacks. It is not a new Wasm instruction
set or a second type validator.

Implemented after the initial checkpoint:

- `streaming/ir.rs` validates/decodes one body with reusable validator scratch.
  Explicit limits apply before expanding locals, instructions, branch tables
  and landing stacks. Raw source operators, including detached unreachable
  instructions, remain available for remapping and output.
- `streaming/reference.rs` ports reference-local liveness and conservative
  definitely-null data flow to this IR. Separate normal/exception successors
  cover loops, branches, modern catch arms and legacy handlers/rethrows.
  Reference state uses bounded bitset matrices; work, edges and retained
  landing values have rejection limits. This result belongs to one function
  and must be released before processing another. It does not recreate the
  production all-target `reference_analyses` map.
- `streaming/types.rs` maps validator-canonical heap identities to source
  module type indices before final output remapping. Duplicate type interning
  makes those identities different from binary indices; typed-table and GC
  carryover fixtures exercise that distinction.
- `FrozenDeclarations` fixes helper signatures before emission. The emitter
  snapshots them, inserts missing type/function/code sections in canonical
  order, and spools generated helper bodies serially. Leading dylink and all
  original functions remain covered. This currently freezes function types
  and function declarations, not the entire runtime's other index spaces.
- `streaming/state.rs` ports source table mutation/consumer helpers and
  segment-drop bit tracking. Discovery visits every original function; there
  is no fork-activation filter. It consumes final runtime-hook/marker/global
  indices. Node fixtures check exact dirty ranges, failed growth, tail
  dispatch, guard-before-read ordering, no dirty mark after a trapping write,
  and idempotent drop bits. Mixed-width and typed tables validate independently.
  Snapshot ownership/catalogs, runtime hook generation, bootstrap and generated
  call-transport handling remain to migrate.
- `facts::call_facts_from_scan` builds the existing call-facts solver's inputs
  from serial source-body summaries instead of a Walrus module. It preserves
  oracle definition binding, signature agreement and fallback, including the
  oracle parser's retained suffixes after tail calls. Full relations still
  use expanded `Side`; this adapter does not solve bounded facts storage.

The diagnostic CLI and production backend selection are unchanged by this
slice. These library primitives cannot certify an artifact as fork-capable.
The next major work is bounded full facts/sink fixed points, complete frozen
runtime/catch/frame planning, and the continuation rewrite. Complete module
state snapshot/bootstrap integration and atomic production I/O also remain.

The [memory report](../measurements/2026-10-23-streaming-instrumenter-front-end.md)
records 72 fresh-process measurements on six controlled examples, with a
1 GiB guard and three alternating-order repetitions. Median physical peaks
for front end plus round-trip serialization include 277.67 → 6.59 MiB for
wide arithmetic, 140.31 → 36.36 MiB for 50,000 tiny functions, and
73.77 → 55.48 MiB for one large function. This measured binary predates the
reference/state/helper additions and excludes full facts/sink/continuation
work. No Codex input or application was executed and no complete-transform
capacity claim follows from these numbers.

Final validation for this slice: the complete native fork-instrument crate
suite passed **424 tests**, with none failed or ignored, under
`scripts/dev-shell.sh`, the explicit host target, two Cargo jobs and two test
threads. This includes existing production replay/codec/EH/module-state and
determinism tests, plus native IR/reference/helper/state fixtures and Node
execution. Log: `.context/native-migration-full-tests-final.log`.
`git diff --check` passed. The release memory example built separately;
the profiling script's syntax and all 72 successful evidence rows were checked,
and the preserved measured binary matches its recorded SHA-256.

No whole-workspace, browser, conformance or ABI snapshot gate was run for the
new experimental path. Shared ABI sources/snapshots and normal production
instrumentation algorithms remain unchanged. Kernel, SDK and package rebuilds
were not started. The remaining full-transform integration gates in milestone
6 are still required before changing the production default.

### Active goal: external facts planning and on-demand bodies

The user explicitly created an ongoing goal to complete the native pipeline.
This stage moves the full compiler-facts relation solver off expanded `Side`;
the original production `facts::call_facts` remains the unchanged oracle.

- `facts/stream.rs` reads bounded UTF-8 lines, including plain/compressed
  objects split at arbitrary custom-section boundaries. The inflater checks
  exact encoded/decoded lengths and the zlib end marker without allocating a
  complete decoded object. Default line/object/total budgets are
  1 MiB / 512 MiB / 16 GiB. The definition reader now uses this path too.
- `facts/storage.rs` and `storage.sql` intern names and store sparse sites and
  relations in a private disposable SQLite database. Duplicate slot strings
  and attacker-sized site ordinals do not create Rust string graphs or resized
  site vectors. Bundled SQLite avoids relying on an undeclared host library.
  Cache, row, work and main-file disk budgets are explicit; query temporaries
  use files, and SQLite builds forcing memory-only temporaries are rejected.
  The page-cache setting is a target, not a physical-memory guard.
- `facts/flow.rs` ports direct-call return/parameter summaries, nested-record
  closure, conversion reach, shared joins for identical reach sets and slot
  origin propagation to indexed disk relations. It preserves the oracle's
  four type/slot feedback rounds and strict/relaxed aliasing policy, including
  late `AL` declarations. Differential fixtures cover 60 configurations.
- `facts/calls.rs` ports linker-order binding and parameter-lowering guards,
  signature agreement, ambiguous definition unions, synthesized destructors,
  callback hubs, old-action signal dispatch, cleanup pairs and indirect target
  projection. Binding unions and target matrices stay on disk. The bounded
  `targets_for` API distinguishes no facts from a proved empty target set.
  Compatibility collection has its own resident budget and explicitly fails
  for a matrix that exceeds it. Eleven binder configurations compare against
  the original binder; integrated facts fixtures compare target lists and
  coverage reports against the Walrus-backed solver.
- `call_facts_from_scan` now uses this file-backed solver. The earlier expanded
  native adapter was removed. This is experimental library integration; normal
  CLI instrumentation still uses the oracle and does not silently fall back
  from a requested bounded backend.
- The scanner retains shared `wasmparser::ValidatorResources` for a direct
  `BodyProvider`. It reuses validator allocations and can load/revisit any
  original body without traversing earlier functions or retaining decoded IR.
  The typed emitter now uses it. Tests cover loading a later small body when
  an earlier body exceeds the configured decode limit, reuse after failed
  decoding, forward functions, concrete references, EH and data counts.

The native sink interpreter still needs to consume these APIs; it must avoid
collecting the compatibility target matrix or caching every body's IR. Port
whole-program return/throw summaries and child continuations next, keeping
specialization depth/cache and recorded call states bounded. Complete runtime,
continuation, snapshot/bootstrap and production I/O integration are still
pending. No new full-transform memory or Codex capacity claim is made.

### Native sink interpreter and disk-backed module metadata

The next goal increment adds `streaming/sink/{evaluate,program}.rs`.
`evaluate` ports the function-local abstract machine to wasmparser operators,
including structured blocks/loops, ordinary and tail calls, child resumption
from original normal-mode post-call states, ordered modern catch clauses,
the oracle's conservative legacy-handler model, scalar folds, reference
branches and shadow-stack slot tracking. Call summaries/target policies are
supplied through an environment so one function can be discarded between
whole-program evaluations. A frame-escape result instructs the planner to
repeat without slot tracking, matching the oracle's two-pass policy.

IR now captures original validator operand heights and arities. The evaluator
checks control depth and reserves a conservative bound on live state values
before making structured-control clones. Frame slots, work and per-body target
memberships have separate explicit limits. Child-injection state shape and
original source ownership are checked. Unsupported GC/proposal instructions
remain explicit; their result cannot prove a sink.

`program` freezes compact function/signature/global metadata while direct and
signature caller dependencies, table memberships and literal slots live in
indexed disk relations. It borrows the store exclusively during construction
so planning tables cannot be replaced while the returned program uses them.
Body operators are visited serially with the original parser's lexical
retention policy. Reference calls also have summary dependencies; a callee
summary change must revisit callers using `call_ref`. Null-containing element
expressions conservatively disable literal-slot narrowing to avoid shifting
later functions into null positions. This refinement is intentionally safer
than copying the old filtered-expression slot numbering.

Differential fixtures cover normal/child results, exception masks, original
call targets, post-call stack/local values, table/reference target sets,
caller lists, globals and function flags. Cases include modern/legacy EH,
tail/indirect/reference calls, loops, atomic loads/stores, SIMD memory operands,
partial overwrites and frame-address escape. Separate tests exercise budget
failures, catch probes, malformed injection states, unsupported operators and
disk-backed table matrices. Whole-program summary/parameter/registry and
child-continuation fixed points still need integration before this is a full
native sink planner. Production remains the unchanged oracle backend.

The subsequent increment adds a generic normal-summary workqueue in
`streaming/sink/summaries.rs`. It borrows the current summary array, decodes
and discards each body before querying dependency groups, re-evaluates escaping
frames, carries exception-local masks, applies named contracts and marks
unsupported bodies conservatively. Resident summaries, total evaluations and
reported evaluator work have explicit limits. The complete policy environment
and child-continuation fixed point are still pending. Unit fixtures compare
this driver with a round-robin fixed point using the unchanged oracle
interpreter, in addition to comparing local normal/child states. Integer folds
cover 329 boundary combinations.

Typed-reference checks additionally retain declared function supertypes in a
disk-backed compatibility relation and requeue callers accepting those types.
Concrete table/global initializer references are escaping functions. Unknown
reference imports and active element expressions preserve an external-call
possibility, so future fork closure must seed an external vertex independently
of the dlopen-import flag. These conservative cases have dedicated fixtures;
the older sink signature-only bookkeeping is not a reason to drop a valid
reference target during migration.

Before adding module metadata, the complete native instrumenter suite passed
452 tests under `scripts/dev-shell.sh`, explicit host target, two Cargo jobs
and two test threads (`.context/native-sink-full-tests.log`). The new metadata
stage is receiving focused validation next. No full rebuild or large Codex
run was started, and no new end-to-end memory result is claimed.


The subsequent policy integration records direct arguments in private disk
relations and resolves parameter forwarding without recursively retaining
caller bodies. Checked callback registries, cancellation cuts, original-caller
cleanup groups, sparse longjmp buffer masks and signal gate requirements now
feed a bounded local interpreter. Small-callee specialization is depth-limited
and its FIFO cache is discarded at each root evaluation to avoid stale summary
revisions. Native normal summaries no longer require an injected test policy.

A native `plan_sinks` now keeps call sites and resolved targets on disk,
computes reverse closure, identifies vfork wrappers, probes modern catcher
landings and solves child return/throw fixed points. Compact masks propagate
catcher ancestry; one function's injections and saved normal states are loaded
at a time. Child results never reinterpret another function's symbolic
parameter or frame address in the caller. Unknown external dispatch is seeded
independently of dlopen imports and never yields a boundary across instances.
Signal gate requirements remain explicit obligations for runtime generation.

Focused tests compare all four sink-plan sets with the unchanged oracle for
ordinary/vfork returns, exits, loops, throwing/catching/rethrowing, frame
escapes, transparent tails, direct/indirect/reference calls and signal policy.
Additional tests exercise external dispatch, declined normalization and
resource failure followed by a successful retry. A full native artifact is
still unavailable: legacy normalization, complete frozen runtime/index plans,
continuation and module-state generation, production atomic I/O and final
runtime/ABI gates remain required. The previous front-end memory results do
not measure these new passes; a separately guarded sink-phase measurement is
being prepared.


The first runtime-planning increment freezes appended imports and the index
shifts they cause in every entity space. `FrozenImports` retains original
import prefixes and shifts source definitions across functions, tables,
memories, globals and tags; source type/data/element indices do not shift.
Plans are fingerprinted to their original bytes. The serial writer inserts
an absent import section alongside absent frozen helper declarations in
canonical order, preserving leading custom metadata. Five dedicated fixtures
check remapped source operations, EH, names, start, exports, initializers and
segments; Node execution checks existing start/export behavior. The complete
native crate gate now passes 499 tests with two build jobs/test threads. This
is not the full runtime catalog: local globals/tables/tags/exports, transport
and continuation helpers, normalization and production integration remain.

The separately preserved facts/sink measurement now covers seven controlled
examples and 42 fresh guarded processes; see the dated sink measurement
report. It exposed and corrected allocator retention from repeated geometric
IR-vector growth by reserving the scan's exact operator count. Tiny fixtures
still use more native physical memory because of SQLite setup; full artifact
and Codex measurements remain unperformed. Later frozen-import source changes
are not included in that preserved measurement executable.


The next native increment freezes local declarations as well as imports.
A bounded builder assigns output indices for tables, memories, tags, globals
and elements, rejects duplicate exports, and binds its catalog to the exact
original input and frozen import layout. The writer appends or inserts each
section in Wasm order. Planning can extend a previous local catalog and
concatenate helper catalogs whose identities have already been assigned.
No declarations are added while emitting functions.

`streaming/runtime.rs` now plans the linked runtime's four private globals,
frame/resume/reference imports and seven control exports. It emits scalar
snapshot/restore and state-transition bodies serially, preserving the original
primary pointer width, declaration-order scalar prefix, child channel binding,
reference-global exclusion, cleanup ordering and final buffer release. Other
passes can supply their import/type prefix and final-index codec overrides.
Native tests compare the scalar layout and import ABI against unchanged
Walrus, execute wasm32 and wasm64 capture/rewind/abort on Node, and compare
snapshot bytes and transition outputs. Another fixture composes this runtime
with the existing native table/drop rewrite helpers, including source calls
outside any fork closure.

This remains a component of the unfinished native pipeline. No continuation
frames, transport/resume helpers, full reference/module snapshot bootstrap or
production backend selection are supplied by these controls alone. No fork
capability section is emitted. The preserved facts/sink measurements predate
this code and must not be presented as its end-to-end memory profile.


The next continuation increment adds per-function frame layouts and shared
scalar frame codecs. Source IR now records each region's parent input stack
and each call's control-frame operand floor; inner calls must not spill the
parent's values. The existing compiler-fact lexical retention rule is shared
with IR decoding so original local ordering retains tail-call suffixes without
mistaking them for executable replay landings.

FrameBuilder preserves parameter/first-use local order and wide-first scalar
packing, including the existing 256-byte scratch threshold and export/name
stack-pointer precedence. Virtual scalar spills occupy a contiguous tail in
the frame and a 16-byte-aligned shadow-stack reservation. Only the scratch
base/type temporaries remain physical locals. Native reserve/release/reseed
and bulk-copy operations execute on wasm32 and wasm64; automatic installation
on rewritten control-flow exits and catch landings is still pending. Scalar
catch payload arms overlay their maximum size, and reference vectors retain
universal-prefix ordering and recipe-free null restoration.

FrameCodecCatalog interns immutable scalar helper recipes and emits them
serially. The source helper bodies match unchanged Walrus byte-for-byte in
48 comparisons across pointer width, selector, commit and scalar-shape cases.
Native Node execution checks mixed scalar values, saved headers, commit order,
frame consumption and the one-result restore cursor. Separate differential
fixtures cover original-local ordering, scratch layouts, codec policy and
reference slots/null restores. The complete focused instrumenter crate gate
passes 518 tests; no ABI snapshot, whole workspace, browser or conformance gate
has been substituted by these checks.

The native function rewrite remains unfinished: call/region materialization,
reference helper emission, catch/transport/resume dispatch and scratch exit
installation must use these plans, alongside legacy normalization and full
module-state capture/bootstrap. Production remains the unchanged Walrus path;
these components emit no fork safety marker. Existing memory evidence predates
this increment and is not an end-to-end result for the new frame machinery.


## Native continuation landing planner — latest authoritative increment

Previous goal turn answered the user's status question and checked the current
worktree; it was status/no new implementation. Revalidated and took the next
safe action this turn. Goal remains active; full scope is unchanged.

Implemented streaming/continuation.rs and continuation/materialize.rs, exported
by streaming/mod.rs. This is a function-local plan, not production integration
or complete fork replay. Source instruction spans are retained by indices, no
cloned instruction vectors. Distinct SequenceIds represent each if/legacy handler
arm; iterative binary-order discovery and reverse region-ID propagation preserve
contiguous half-open call ranges, without descendant-call matrices or recursion.
Only ordinary source calls accepted by existing reachable reference analysis
are landings; tail transfers and exception ownership/normalization remain work.
Root sequence is sequences[0]. Each sequence has source span, call range,
entry temporary parameters, chunks (trimmed for replay suffixes) and landings.
A region landing retains its complete enclosing source span, child region ID,
arm IDs, call range and operand materialization. Non-fork child spans remain in
normal chunks. CallContinuation retains original point/kind, final signature ID,
argument plan and current-control-frame-only carryover LocalKeys.

All call argument spills allocate before all call carryovers, then region input
spills, matching the scalar scratch-tail grouping. Safe suffix replay uses the
oracle's exact whitelist (numeric constants except v128, local.get, safe integer
unary/binary ops), a backwards typed expression walk instead of repeated forward
suffix simulations, and a source Range rather than copied operators. Empty
arguments use Empty; other operands use frame-backed Spill keys. Generic funcref
call_ref callee storage follows the old plan: complete call emission must cast
that callee to the final typed call_ref signature. table64 selectors use I64.
OperandMaterialization supplies capture (reverse pop) and restore (ordered get
or replay via mapped original ops with compacted source local indices), enforcing
output limits. Scratch primitives are reused; automatic exit/reseed installation
and dispatch are still unfinished.

References combine call argument and carryover refs, ancestor region refs (also
pure replay local reads), every ref parameter needed by a zero-arg resume thunk,
normal/exception-successor liveness and nullable direct null restoration. A pure
parent-region local.get is activation-owned even if original CFG says dead at
inner call. Catch payload/owned-exception recipes still must be incorporated
by the complete EH planning pass. Existing reference analysis validates original
source and point/kind/count alignment. FrameLayout.reference_plan freezes union,
universal prefix, landing slots and null restores. No new reference codecs.

Budgets: continuation metadata64MiB, values1m (includes bounded scratch work),
work100Mi units, plus independent existing FrameLimits/ReferenceLimits/IR limits.
Empty ancestor ref sets skip descendant loops; nonempty memberships consume work
and value budgets. No OS-memory/performance claim inferred from these budgets.

Tests: tests/streaming_continuations.rs has8 tests covering nested ownership and
body params, if-arm call ranges/nonfork chunk preservation, normal/EH refs,
legacy catch inputs, indirect/call_ref/load barriers, explicit resource errors,
1024 nested regions without recursion, and dead-at-inner-call ancestor replay
refs. Native-only capture/reload fixture composes the plan with bounded emitter,
executes source vs transformed wasm32/64 in Node with2/40 calls, preserving
externref identity, exact call arguments/results, mutable global changes and SP.
40 calls trigger virtual scratch; unused source locals are compacted. This is
not a fork execution. New private instrument/native_frame_tests tests compare
70 argument suffix cases and4 nested carryover/region-range cases to unchanged
Walrus production algorithms. No production algorithm/Walrus dependency edits.

Latest full focused gate:528 passed,0failed/ignored,45 result groups, canonical
dev shell, host aarch64-apple-darwin, Cargo-j2, testthreads2.
Log .context/native-continuation-full-tests.log; all build sessions terminal.
Focused logs: native-continuation-plan-check.log (check),
native-continuation-plan-tests.log (7 tests before the eighth regression was
added; latest full gate includes all8), native-continuation-oracle-tests.log
(70 cases), native-continuation-nested-oracle-tests.log (4 cases).
First test attempt lacked memory in a load fixture, fixed before passing gate.
rustfmt applied only the new continuation files/test and existing private
native_frame_tests.rs; git diff --check passed. Authoritative fork doc updated.
No full rebuild, new memory benchmarks, browser/ABI/workspace/conformance gates,
Codex run, commits/PRs, branch rename, other-worktree edits or subagents.

Next: install full continuation dispatch on this plan, including source branch
label translation through synthetic blocks, per-sequence input parameter bridge,
replay arm forcing and bounded recursive-bucket topology (iterative generation),
frame capture/replay postamble and whole-function private unwind handler, typed
call_ref callee casts, scratch release/reseed at all source/synthetic exits.
Complete scalar/reference/catch frame IO and zero-argument resume thunks need
frozen helper recipes before emit. Remaining global work: normalization/import
replacement, typed GC/exn reference providers/codecs, full module-state snapshot/
segments/bootstrap ownership, production atomic I/O/backend/artifact certification,
full validation and guarded end-to-end memory. Do not mistake primitive/helper
or storage-only fixture success for completion. Production still unchanged Walrus.


## Native continuation dispatch emitter — latest authoritative increment

Previous goal turn made progress: bounded landing planner and528 tests. This
turn makes further concrete progress; goal remains active with full scope.

Added streaming/continuation/dispatch.rs, exported from continuation.rs. New
emit_continuation_dispatch emits function contents excluding finalEnd, into an
already-declared Function with final mapped indices. No declarations occur here.
An explicit LIFO task stack handles original source nesting and32-way balanced
bucket nodes without Rust recursion. Each synthetic child label ends BEFORE
its body; last child can yield source region results outside all bucket labels.
Boundary chunks consume previous call results and capture the next landing
before closing the enclosing empty bucket. Per-sequence temporary entry params
bridge source typed block/if inputs across empty synthetic dispatch blocks.

Replay guards use final state_global and call_index_global, state>=REWINDING
(also syntactically abort3), reject out-of-range coordinates and choose child
labels via bounded tables. Single-target nodes use a direct branch. NORMAL
executes initial chunk; replay skips earlier chunks. Calls reload carryovers
and arguments and invoke ContinuationHooks. Region landings reload parent
inputs, force then/else from the saved call range and enter independently
planned arms. continuation.rs now reserves one optional I32 condition temporary
in FrameLayout when fork-bearing if landings exist; it is not saved scalarstate.

Symbolic original branch IDs map through inserted labels: br/br_if/br_table,
br_on_null/nonnull/cast/castfail, modern try_table catch label clauses, legacy
rethrow and delegate. Generic call_ref callee storage is narrowed using the
mapped final signature before source invocation. Local access uses compacted
FrameLayout get/set/tee, including virtual scratch. Detached source regions
are skipped; structural ends/arms still emit; return_call-retained suffixes
remain emitted where the oracle retains them. Source global/module/etc indices
flow through hook Reencode; points remain exact original ProgramPoints.

DispatchEnvironment includes enclosing_blocks (labels installed by a wrapper)
and optional function_exit_block (outside-to-inside index) to bind original
function label/Return to a typed common exit. This permits normal return and
conditional function-branch cleanup at one epilogue. It does not yet install
escaping-exception/scratch reseeding/tail release or abort restart policy.
ContinuationHooks must balance added controls except the source encoded opener;
default call hook preserves lexical invocation only. Complete frozen transport/
resume routing still must be installed. Source hook receives translated branch
depths and exact original point for state/exit rewriting. No capability marker.

DispatchLimits: output32MiB, emitter metadata64MiB, work100Mi units. Queued task
metadata includes gate payloads; labels/tasks/sequence catalogs are accounted.
Replay table output/metadata/work preflight and source branch-table metadata
preflight prevent unbounded temporary vectors. Limits are logical estimates,
not measured OS ceilings. Full emitter still has no module-wide instruction IR.

New tests/streaming_dispatch.rs10tests. A test-only private exception captures
scalar user+spill fields in linear memory, releases scratch and discards Wasm
activation locals. Reentry reserves scratch/restores fields then invokes the
real native dispatcher, comparing result, call trace, mutable counter andSP to
the uninstrumented source. These are real function-local capture/replay tests,
NOT production fork/module-state execution. Ten control-shape fixtures on both
wasm32/64 cover if inputs/changed locals forcing botharms, block params,parent
carryovers, loops, br_table, typed modern catch and opaque nonfork chunks.
40-call virtual-spill fixtures capture/replay at0/31/32/39 on both widths;
typed common exits cover Return and conditional root-label branches withSP
cleanup. 4097-call fixture asserts max emitted nesting<128, compares replay at
0/31/32/1023/1024/4096. 1024 source regions emit/replay without native recursion.
Reference branches and typed call_ref/indirect calls compare normal execution
only; legacy rethrow/delegate depth cases likewise compare normal only, not
owned-exception replay. Detached local compaction/tail suffixes, deterministic
bytes, malformed replay ordinal and explicit output/work/metadata errors pass.

Full focused crate gate: **538 passed,0failed/ignored,46 groups**, canonical dev
shell/aarch64-apple-darwin/Cargo-j2/testthreads2. Latest log:
.context/native-dispatch-final-full-tests.log. Earlier full gate537 in
native-dispatch-full-tests.log preceded added legacy test. Other logs:
native-dispatch-check.log, native-dispatch-tests.log (9 tests before legacy),
native-dispatch-legacy-tests.log (last legacy test). First test compile needed
usize depth annotation; an initial tail-only test asserted replay validation
with no call landing, fixture corrected to include a preceding ordinary call.
All build sessions now terminal. rustfmt/newdocs and git diff --check pass.
No full rebuild/kernel/SDK/packages, memory measurements, Codex access, browser/
ABI/conformance/workspace gates, commits/PRs, branch rename, subagents, registry
or other-worktree edits. Walrus production code/dependency remain unchanged.

NEXT IMPLEMENTATION: connect production linked-frame capture wrapper, scalar
save/restore helpers, per-call selector and zero-argument resume transport.
Important design needs: plan_continuations currently finishes FrameBuilder;
wrapper-specific control locals (I32 call selector when nCalls>1, catch selector,
frame temps) must be reserved BEFORE finish, e.g. a planning-extension callback
or integrated CapturePlan. Call hook currently receives args already on stack;
frozen routed-call If/TryTable signatures must consume all args, including
indirect index/generic ref callee extras, to expose them above the new control
floor; carryovers remain below. A typed common exit is now supported. Preserve
source safety gates/private-tag bypass and complete exception ownership; normal
legacy/catch-all execution tests are not private-unwind replay proof.
Useful old sources: emit_unwind_frame_select_helper893, AbortDispatch1219+
wholefunction capture1293+, scalar preamble/inline frame restore4790-4990,
postamble4990+, emit_replay_routed_call5330, zeroarg resume thunk5480+.
Native runtime has7control helpers; scalar FrameCodecCatalog already exists.
Remaining full objective: typed ref codecs/providers, GC/exn/legacy normalize,
full module-state/segment/bootstrap snapshots, complete frozen catalogs and
atomic production I/O/backend/artifact verification, full Node/browser/ABI/
conformance/determinism gates, guarded synthetic end-to-end and coordinated
Codex16GiB run. Do not mark complete at this or another component milestone.


## Linked scalar activation wrapper — latest in-progress increment

Previous goal turn made progress (native dispatch emitter,538 full focused
crate tests). This turn also makes substantive progress. Goal remains active,
unbudgeted, full objective intact. User steered with status question; answered
briefly in commentary; not a pause or cancellation.

Added streaming/activation.rs, activation/support.rs and capture.rs; exported
from streaming/mod.rs. Added plan_continuations_with planning extension; default
plan_continuations remains same API, extension receives open FrameBuilder,
call/sequence metadata, reserves temporaries BEFORE finish and returns extra
state. NativeActivationPlan uses it for one I32 call selector when calls>1,
keeps per-function continuation/results/environment and rejects zero landings.

ActivationSupportCatalog freezes final type/function IDs and compact recipes:
- frame select (I32 call,ptr size)->I32 success: publishes call-index global,
  reserves frame into*(buf), uses abort scratch buf+frames_start on reserve0,
  writes frame call word4, returns0/1. Source memory/SP indices already final.
- transport: direct/indirect/table64/ref call, extra selector/generic ref callee
  in helper params, typed ref narrowing, state>=2 resume_peek -> noarg result-
  typed call_indirect on process resume table, source lexical on slot0, converts
  STATE_UNWINDING normal callee return to private tag with results hidden in
  helper. Transport requests intern by final target and signature.
- scalar resume thunk: same old zero-constant vs frame_peek load cost policy;
  noarg->source result signature. Ref parameters explicitly rejected pending
  decoder. Result block types intern for multi-result wrappers.
Recipes never own FunctionIr/FrameLayout/instructions after freezing. Existing
FrameCodecCatalog separately freezes shared scalar I/O types/functions.

emit_native_activation composes actual linked runtime and dispatcher:
scratch reserve; replay preamble (frame_next/publish active buffer+frame/call
cursor/scalars+scratch restore); typed normal exit; outer catch_all_ref escaping
exception boundary; restart loop; selected postamble block; caught block; one
private-tag try_table around dispatch. Source returns/root branches target
normal exit. Private catch reseeds scratch, supplies static/local call selector,
invokes frozen frame_select; success->postamble, failure->live restart without
frame_next/preamble; loop entry reseeds after abort_begin SP restoration.
Postamble saves header/scalars/scratch, commits only once complete, throws
private or optional boundary import +consume own frame+live restart. Outer
escaping-exception cleanup releases scratch then throw_ref. Normal exit releases
scratch. CaptureHooks delegates mappings/source hooks and records call ordinal
before invoking caller's frozen transport/lexical route.
CURRENT explicit boundaries: wrapper rejects any source LegacyTry/TryTable,
any return_call*, and any reference slots/null-restore sets until proper EH,
tail and reference-frame passes are installed. No full fork capability marker.
Production still unchanged Walrus; these APIs are native experimental pieces,
not a completed replacement. Boundary branch generation exists but not yet
tested. Multi-result result-block code and float-peek resume path not yet tested.

New tests/streaming_activations.rs has ONE focused test spanning wasm32/64 x
inline/shared scalar codecs (4 configurations), deterministic artifact rebuilds.
It composes two actual native activations, NativeRuntime, support helpers,
frame codecs and a validating JS journal over normal runtime imports. Native
caller helper maps original fork import to transport and local child directly
to its activation wrapper. Tests check normal result/trace/SP; private unwind
through child+root, reserve/commit headers/order/call selectors; fresh noarg
root resume and frame_next order; failures at child and parent reservations,
live abort restart and consumption of committed child; injected root selector
routes its lexical fork transport through next child resume thunk and restores
carried value. Ref imports unused; no mock native instructions/IR.
Log .context/native-activation-tests.log:1 passed,0failed, terminal session67579.
Canonical dev shell/aarch64-apple-darwin/Cargo-j2/testthreads2.
Checks passed .context/native-activation-support-check.log and
native-activation-capture-check.log; sessions91812/65204 terminal. rustfmt applied
new files+continuation.rs and git diff --check passed. Authoritative doc updated.
LAST full focused crate gate remains538 from previous increment
.context/native-dispatch-final-full-tests.log. Full suite NOT rerun after this
increment. No new memory benchmarks/full rebuild/Codex/browser/ABI/workspace/
conformance gates/commits/PRs/subagents/branch renames/Walrus registry edits.

NEXT before closing increment: tighten support catalog metadata preflight before
cloning large result/transport/resume parameter vectors. Add raw helper oracle
comparisons to existing private instrument/native_frame_tests.rs:
minimal(memory32/64) NativeRuntime vs old inject_linked_runtime then
emit_unwind_frame_select_helper, emitted old named helper vs native support
helper0. Scalar resume thunk comparisons: source function f params I32/I64/
F32/F64/V128 with FrameBuilder scalar fields vs old collect_user_locals+
plan_frame_layout+emit_resume_thunk (func_ordinal7), output old helper named
__wpk_fork_resume_7 vs native support resume body. Include float-heavy params
that trigger frame_peek loads; old runtime imports/source final function mapping
must compare emitted final module bodies (Function IDs aren't output indices).
Add output/metadata/index preflight tests, unsupported reference/EH/tail plans,
optional boundary live restart, multi-results and actual scratch capture/replay
cases. Then run full focused suite once for updated tree.
Potential scratch measurement nuance: unwind_begin scalar prefix snapshots SP
at fork point, including active source/scratch stack reservations. Fresh replay
restores that prefix before creating new activations, whereas live abort reuses
still-live base. Preserve unchanged old ABI behavior; don't assume fresh replay
finishes at original host-entry SP in a synthetic function with no C prologue/
epilogue. Prior dispatcher tests used a private test frame store, not this prefix.
Do not change Walrus to accommodate tests. Reference/GC/exn providers/codecs,
full owned handler/tail normalization, module-state catalog/bootstrap/segments,
production atomic I/O/backend/artifact metadata and end-to-end guarded memory
remain required by goal. Large Codex only coordinated16GiB physical guard.
