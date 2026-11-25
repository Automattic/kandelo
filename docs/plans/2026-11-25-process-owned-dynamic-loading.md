# Process-owned dynamic loading

**Status.** Design for maintainer review. The prototype and measurements
follow approval. The starting point is `develop@08489499b`. Use the
[on-demand loader and executable export model from PR #1748](https://github.com/Automattic/kandelo/pull/1748)
as a prerequisite. Its open head at review time is `ac3dd7a9a`.

## Decision

Put the dynamic symbol index, loaded-object graph, handle and scope
management, and error state in the guest loader linked into libc. Give
symbols canonical addresses when the executable is linked or the side
module is mapped. `dlsym` reads those addresses from guest memory. It
performs no host call, compilation, or table mutation, including for a
handle returned by `dlopen(NULL, …)`.

The engine adapter still compiles and instantiates Wasm and materializes
function, tag, global, and table references in each worker's Store. The
kernel continues to own VFS and address-space authority, task identities,
and fork/clone/exec sequencing. Keep the portable loader in a guest
component linked by the SDK, initially using libc's C glue for the libdl
surface. Shared Rust declarations own the wire formats. Rust artifact
validation and kernel lifecycle code own admission and reconstruction
ordering. Node and browser workers use the same engine adapter, with
opaque records that a non-JavaScript engine can implement.
[Host runtime contract](../agent-guidance/host-runtime.md)

### Why change this boundary

`libc/glue/dlopen.c` reads the top-level module, but delegates scope,
handles, and lookup to `host/src/dylink.ts`. `DynamicLinker.symbolAddress`
scans the live table, and appends a function when its export has no slot.
Side-module GOT resolution can also introduce main-program targets.
The original element segments contain neither of those late insertions.

Prior experiments (`PLAN.md` and `dlsym-fork-experiment/e2e{2,3,4,5}.log`
in the retained platform-followups evidence) expose two failure modes.

- With facts disabled, a program importing just `__wasm_dlsym` forks and
  calls its pointer successfully with the old conservative role. The
  narrowed role loses coverage and table reconstruction. The ordinary
  address-taken control passes. Clearing capability 0x02 alone while
  retaining the conservative behavior passed those controls and leaves
  the instrumentation cost.
- With default facts, even the old role reproduced a child null-function
  or signature-mismatch trap, including through the public libc API. The
  evidence implicates omitted frames above an indirect call. Verify that
  diagnosis with a sink report and a prefix that would fail if replayed
  from the start. A side-only target can raise the same analysis question
  independently of missing executable targets.

The prior waybar audit reported +13.1% for #1748 using a same-compiler pair.
The gtk3_smoke spike reported roughly +10% attributable to the role in its
experimental comparison. The latter's facts conversion dominated wall
time and used roughly 4.1 GB of scratch SQLite. The retained
`evidence-2026-11-22/size-audit-compare.txt` lists five SDL2 artifacts
newly linked to the lookup/close/error imports, plus freeciv-sdl2 which
already had the dynamic role and lost its side-load imports in that pair.
Confirm that roster and each artifact's role on the new baseline.

### Alternatives

| Approach | What it fixes | What remains |
| --- | --- | --- |
| Pre-register exports with the instrumenter | Adding exports to its possible-target sets repairs a missing analysis input. Physically adding table entries before analysis also lets fresh instances reproduce those slots. | Analysis-only registration still needs table capture and host resolution. Physical registration in a fork-only tool misses ordinary and non-forking links, duplicates part of the SDK's job, and needs the same canonical slot and optimizer work. An export-set fix can land independently for current binaries. |
| More precise instrumenter analysis | Separate side calls that return or throw normally from calls that can return a fork child. Refine target sets by slot and compatible type where proven. Reuse load-time restrictions from the existing traced-entries contract. | Precision needs sound bounds for escaped pointers, host writes, future plugin targets, and cross-module callbacks. A role decision based on loader import spelling lost those bounds in the experiment. This work cannot by itself supply local lookup or eliminate replay of the loader's POSIX state. |
| Link-time executable slots and a guest loader | Makes lookup read-only, gives analysis real main-program targets, and makes handles and scopes ordinary copied process state. | Requires toolchain work, an engine mapping protocol, and careful fork/thread/unload synchronization. True side-loading programs still need a cross-module fork contract. Static placement may make additional fork-returning targets visible and can increase instrumentation in some programs. |

Develop advanced during design review to include #1778
(`17c353b59`). It models dynamic main exports as indirect targets and
keeps ordinary side-call returns visible to the facts planner. The
maintainer's merge record reports the three new SDK-built regression
cases passing with the fix. Use these tests on the prototype and keep
the fix in every timing arm. The earlier crash is regression evidence
from before the fix. [Fork facts fix](https://github.com/Automattic/kandelo/commit/17c353b59a0b74db11be8266812c463dee4c4c18)

## Executable symbol index

Preserve #1748's archive extraction and visibility rules. The loader comes
from lazy members ahead of libc, non-PIC code defaults to public visibility,
and PIC code retains its existing defaults. Split lookup and its TLS error
handling from the side-loading member so an executable using only lookup or
close over the main handle can link without any engine mapping imports. A general `dlopen` entry still
carries the ability to map side code even if a particular execution
only passes NULL. Use the observed final capability rather than
classifying a program by one benchmark's arguments.
Retain support for explicit `--export=<name>`, the supported
`--export-dynamic`/`-rdynamic` set, and explicit export aliases. Use the
final live public link symbols as inputs. Startup, instrumentation, and
other reserved adapter exports have separate purposes and stay out of the
libdl namespace. As in #1748, exporting the executable cannot pull in an
otherwise unreferenced libc archive member merely because a future plugin
might need it. [SDK dynamic-loading guide](../sdk-guide.md#with-dynamic-loading-dlopen)

Emit a versioned, read-only-in-use linear-memory index with bounded
bytewise-sorted name strings and rows containing a string offset, kind,
and canonical value. Use width-correct relocations. For functions the
value is the C function pointer (a table slot), for ordinary data it is
the linear-memory address, and for supported TLS it describes the defining
module and offset to apply to the calling thread's TLS base. Give the
prototype distinct success and address fields in the internal lookup.
The index can use binary search initially. Measure a hash index before
adding one, especially for batched binding against large executable
tables. The raw format and numeric limits become artifact ABI once
published.

Allocate a slot for each selected function with wasm-ld's usual
address-taking relocation. A preexisting `&f` relocation and aliases of
the same linked function must use that same slot. Slot zero stays null.
The slot must appear in an active element segment before fork planning.
Keep the minimum table length, slots, export names, and data addresses
valid through local-continuation lowering, fork instrumentation, wasm-opt,
and stripping. The host can bind a direct import using the exact provider
and export ordinal carried in the mapping plan. Preserve the Wasm exports
that embedding APIs and this binding path need. Verify the final artifact's
name-to-slot/export relationship and the facts plan's knowledge of the
targets. Raw writers of the process function table remain subject to the
instrumenter's dynamic-write rules and the fork table journal.

Implement single-pass support in wasm-ld from the first prototype.
Select the dynamic symbols after resolution and liveness, assign
canonical slots before layout, and emit the index using ordinary data
and table reservations. Use the same linker behavior in the hosted and
guest SDKs. Measure the new single-pass link against the baseline on
small and large inputs, including LTO where used.

A discovery link followed by a final link is an alternative for
experimenting with the current linker. It would extract export identities
from the first link and feed a generated relocation object into the
second. This would repeat link work and require matching aliases and
renamed exports across both passes. A post-link editor would need
to preserve storage layout, canonical slots, and code-bound compiler
facts. The selected single-pass prototype can use the linker's resolved
symbols directly.

An executable without lookup or plugin-host intent needs no index.
An executable with lookup and an empty export set uses an empty index.
Track the contribution of exported code and duplicate names separately
from index bytes. Trim private runtime exports and honor explicit export
lists. A build that asks for `-rdynamic` promises its selected public names
to arbitrary future plugins. A profile, or the import list of plugins
currently shipped in an image, cannot silently narrow that promise.

## Map a side module

Start with synchronous worker-local engine calls as in the current staged
loader. Copy bounded bytes or retain an immutable compiled token scoped to
the exact process image and request. Put a narrow versioned descriptor at
the guest boundary. This sketch defines the direction of the interface.
Wire offsets, limits, and status encodings are prototype outputs.

| Operation | Input from guest | Output from adapter |
| --- | --- | --- |
| Inspect | Exact module bytes obtained through guest VFS via an open fd | Prepared token and bounded metadata in Wasm ordinal order, including `dylink.0` memory/table requirements, dependency names, typed import/export declarations and initialization entries |
| Instantiate and install | Prepared token, guest-assigned module ID, exact memory/table reservations and a binding vector indexed by import ordinal | Status, an engine materialization record, and any engine-derived export values or initializer slots that require instantiation |
| Attach or release | Generation and exact mapping records or a retirement request | Local materialization or retirement result. The adapter never releases the guest's mappings on a worker-local failure. |

Libc opens and `fstat`s the exact fd it reads, derives identity from
the opened object, and keeps the canonical path for diagnostics and
requester-relative search. Preserve and test the existing needed-library
search policy. Absolute paths are explicit. For a relative needed name
the current adapter tries the requester's directory, the name relative
to the working directory, then `/lib`, `/usr/lib` and `/usr/local/lib`.
Keep kernel permission and mount checks on ordinary VFS operations.
The adapter receives bytes or a generation-bound token for those bytes.

Use a caller-owned bounded result buffer for inspect. If capacity is
insufficient, return the sizes and the same prepared token for one
metadata refill without recompilation. Keep names in a string pool and
use little-endian fixed-size binding entries for the map request. Range
checks must cover counts, products, offsets, and the table reservation,
with no borrowed guest view surviving an engine call that changes the
underlying memory. Reserve whole table ranges through the existing
process table-generation owner so a concurrent grow cannot claim the
same slots. Bound side-module bytes, records, and reserved ranges on
both hosts before allocation. Inspect may compile and validate at once.
The engine never runs a module start routine during instantiation. Reject
unlowered starts and replay-unsafe active data. Use explicit Wasm entries
for bootstrap, relocation, TLS initialization, constructors, and
destructors, invoked after the import returns. Keep the signal-delivery
checkpoint when crossing a host phase that defers signal delivery.

Resolve the dependency closure and symbol scopes in the guest before
publication. The inspect descriptor supplies names only once per module
generation. Libc consumes it and sends back one packed binding vector,
with records such as provider module ID plus export ordinal for functions
or tags, a numeric pointer-width value for a GOT entry, or a reserved
engine binding for memory, table, and platform tags. The adapter checks
types, indices, byte ranges, image generation, and resource ownership and
installs the planned imports in one pass. Undefined strong symbols fail
with the module and symbol name. Apply weak and self-binding rules from
the final artifact metadata, including the PIC C++ cases covered by
#1748. Exclude private infrastructure names from guest scopes while
validating their separately declared imports.

Allocate the side module's public function slots with the same
canonical-slot rule as the executable, using a linker-provided
module-relative symbol map and a guest-chosen table base. A side
module's own `&f`, a consumer's `GOT.func`, and `dlsym` use the same
canonical slot for the same resolved definition. An interposed binding
can appropriately identify a different definition. Establish GOT and
data addresses from planned bases before relocations. Acyclic direct
imports can bind to already materialized provider exports without
wrappers. Mutually importing Wasm instances need explicit treatment
because immutable function imports need a concrete target at construction.
Prototype an acyclic closure and reject a direct-import cycle before
publication. For full support, test type-correct Wasm table-dispatch
thunks for the cycle edges with the instrumenter and engine catalogs.
An engine callback into Wasm would break the fork activation path.
Data/GOT-only cycles can use preassigned addresses if every relocation
and initializer is staged. Do not count cyclic closure support until
those cases pass.

For ScummVM, measure individual closure depth and import counts, total
adapter transitions, bytes copied, allocations, metadata decode, guest
resolution and engine time. Start with one inspect and one map per
module, plus stage and generation publication. Per-symbol host calls are
excluded by design. Add vector batching across modules in a phase only
if measurements justify it. Reuse parsed/compiled metadata across
replicas where the engine allows it, and make each worker's direct
imports from its own engine references. Compare cold compile, warm
compiled-token attach, and already-open refcount paths separately.
Capacity failures, unsupported capabilities, and engine errors return
structured results translated to guest `dlerror` text. Staged failure
revokes the token, clears any provisional slots, and releases only
resources the transaction owns. A grown Wasm table can retain null gaps.

## Loader state, threads, and fork

The process registry is guest linear memory, with stable generation-tagged
module IDs, ordered dependencies and binding-provider edges, public
handles/refcounts, scope membership, initialization stage, retained
mapping recipes, and a TLS error record per pthread. Publish complete
generations with a release/acquire fence. Keep the shared registry root at
a link-declared location so launch and replay can locate the engine
records before entering guest code. Expose a bounded mapping view to the
adapter, containing exact module identities and immutable bytes or a
retained immutable backing, ranges, binding vectors, and initialization
status. The rest of the registry is libc-private. In particular, handle
allocations and refcounts have no host mirror.

For the prototype, retain the exact side-module bytes in guest
memory and measure their contribution to fork copy and retained memory.
A shipping alternative is a kernel-owned immutable backing retained
for the image lifetime and leased to child/peer reconstruction. Measure
it against copying bytes before changing ownership. A path or ordinary
fd alone permits changed contents after a write, rename, or unlink.
Verify that fork and late pthread startup reconstruct a mapped module
after its pathname disappears.

Use the existing process table-generation and activation checks at
indirect dispatch and thread entry to attach missing Store-local
references before use. Without these checks, local lookup could hand a
pthread an index for which its worker has no function. Reuse the
generation fast path and check newly created and preexisting threads,
including direct entry into a side function and a thread with live side
TLS. During unload, withdraw lookup visibility and retire worker leases
before reusing any storage still reachable by an instance, callback,
finalizer, or activation snapshot. Defer resource reclamation while a
thread's TLS destructor or the activation registry pins the module.
An unordered or trapping engine retirement cannot cause another
worker's live mapping to be freed.

Serialize registry edits with process-private synchronization and
stage definitions before allowing initializer code to use them. Drop
short-lived registry locks before executing guest callbacks. Track
transaction owner, nested opens and in-flight initializer stage
explicitly. A nested transaction can use its parent's staged dependency
scope when authorized by the owner. Other threads see complete
generations. Failure must leave preexisting refs and scopes intact,
including after a failed nested open. Test cancellation, a constructor
that opens another module, and simultaneous open/close/fork. The
prototype must expose any unresolved reentrancy or fork synchronization
gap before a shipping lock protocol is chosen.

Fork copies handles, refcounts, addresses, TLS and pending error state in
memory. The child still needs fresh engine references. Recreate the exact
mapping graph in the child from retained recipes and bytes, attach all
providers and catalogs, restore per-instance globals/table overlays
through KFMS, then replay activations. Recreate the caller's TLS bases
without re-running TLS initialization or constructors over copied bytes.
Do not re-open paths, redo symbol resolution or replay an open/close
event log. Dirty table slots created by ordinary guest code still need
the existing fork journal.

The snapshot must identify a coherent generation and preserve the
caller-owned in-flight loader stage when a constructor or finalizer
forks. Restore that transaction owner to the child continuation and
supply new engine-local tokens for captured stages. For a transaction in
another thread, capture a defined committed view and reconcile provisional
resources with the copied address space before user replay, or establish
quiescence at a safe point. A child cannot inherit a lock owned by a
vanished pthread. Waiting for a sibling's arbitrary constructor to
finish can deadlock if it waits for the forking thread. Resolve this
case in the prototype before expanding coverage. Preserve the borrowed
vfork path with child-private attach state and no loader registry or
mapping writes into the parent's memory. Exercise completed borrowed
replay and rejection at an unsafe in-flight boundary. Exec drops the old
generation and creates a new registry.

### Fork role

Under the successor ABI, capability 0x02 identifies a fork-instrumented
main that can map side code. Use the shared declared mapping capability
and artifact validation to derive and enforce it consistently across
streaming graph, facts planning, SDK and host admission. A main that only
has its static index and local lookup uses ordinary target discovery and
retains the activation-state-safe role. Changes made by unusual
Wasm table writers still require the existing checks. Never infer
immutability merely from the absence of a public C `dlopen` call.

True plugin hosts still permit references to future side code. Keep
the traced-entries admission contract or the fully conservative
fallback, and prove that non-fork-returning side calls still count as
returning and possibly throwing. Loader and initializer callbacks are
ordinary Wasm-to-Wasm paths after each import returns. Expect the most
direct benefit for lookup-only workloads. Measure waybar, gtk3_smoke,
ScummVM and CPython with the role each link actually requires.
[Fork replay for side modules](../fork-instrumentation.md#fork-from-a-dlopened-side-module)

## Observable semantics and parity tests

Use the same SDK-built C/C++ fixtures on Node and browser, with
architecture-matched wasm32 and memory64 artifacts. Pair success cases
with failing operations that prove scope, stage, and lifetime decisions.
POSIX covers the real handles and binding/scope flags.
`RTLD_DEFAULT` and `RTLD_NEXT` are extensions.
See [POSIX dlsym](https://ktiml.mff.cuni.cz/~kucerap/unix/susv4tc2/functions/dlsym.html),
[POSIX dlopen](https://ktiml.mff.cuni.cz/~kucerap/unix/susv4tc2/functions/dlopen.html),
and the [Wasm dynamic linking conventions](https://raw.githubusercontent.com/WebAssembly/tool-conventions/main/DynamicLinking.md).

| Surface | Proposed rule and test |
| --- | --- |
| `dlopen(NULL)` and `RTLD_DEFAULT` | Search the executable, startup objects if present, then global loads in load order. The real null-path handle is closable and sees subsequent global promotions. Verify precedence, repeated open/close, local exclusion, and zero mapping calls for pure main lookup. |
| Object handles and `dylink.0` needed entries | Search the named object then its transitive dependencies in breadth-first dependency order. Bind relocations in load order over the eligible set of startup objects, committed global objects and this load's closure. Add newly discovered objects to logical load order in dependency order, independent of engine instantiation order. Check a diamond, duplicate definitions, an unrelated local object, a missing dependency, a cycle, and rollback. The Wasm needed list serves the role of ELF `DT_NEEDED`. Startup linking against shared libraries remains outside this design. |
| `RTLD_NOW` and `RTLD_LAZY` | Bind eagerly for both. POSIX allows eager resolution for LAZY. Verify that both resolve data and functions before initialization and report missing strong imports at open. Validate invalid flag combinations and inventory existing extensions such as `RTLD_NOLOAD` before changing their behavior. |
| `RTLD_GLOBAL` and `RTLD_LOCAL` | Local is the default. Promote an already-open object and its eligible closure on a global open. Preserve earlier bindings and retain their defining objects while needed. Test order and lifetime with two roots sharing a provider and with a local-to-global reopen. |
| `RTLD_NEXT` | Preserve the existing unsupported status in the prototype and initial implementation. Return a specific unsupported diagnostic and test it. If a port needs the extension, use that case to investigate caller-module provenance, including indirect calls through the canonical `&dlsym`. |
| `dlclose` | Track explicit opens, needed edges and binding-provider edges. Invalidate the final closed handle, make it impossible for a reused handle to alias that stale value, and retire unreferenced objects including unreachable groups. Run registered destructors once in reverse initialization/dependency order outside the registry lock before reclamation, with C++ finalization and pending thread destructors accounted for. Test repeated opens, stale handles, destructor reentry, and reopen after final close. POSIX allows deferred unmapping. |
| `dlerror` | Keep the last unconsumed loader error in libc TLS. Consume it once, keep the returned string valid through the specified lifetime, and distinguish a zero-valued symbol from lookup failure. A successful call need not consume a prior error. Test two simultaneous distinct errors, a success between failure and read, and the calling pthread's inherited error after fork. |
| Address identity and nesting | Compare executable and side function results to `&f`, including aliases, address-taken and previously export-only functions, and a side consumer's GOT pointer. Check a data symbol and side TLS where admitted. Have a side module open another module and use its result. Verify constructor execution once, nested close and failed nested open. |
| Fork and replay | Fork after lookup, through an export-only pointer, after a side call, from a side initializer and a pthread, and fork again in the child. Check pointer equality, no re-run of a prefix or completed constructor, libc state inherited and then independently changed, reap status, and correct facts selection. For vfork, check permitted exec/_exit and that parent state survives. |

## ABI and migration

The base currently pairs program ABI 56 with host adapter 8. Use a
private prototype using an explicitly required versioned
`kandelo.*` program extension for experimental mapping imports. Derive
the new fork behavior only from that declared experiment contract.
Keep the ordinary ABI-56 path and checks active. Run the prototype with
its own matched artifacts and supplied capability. An extension can deliver a new interface while preserving the
ABI-56 base, but it cannot withdraw the old loader or reinterpret the old
fork role. Keeping both paths would retain the old host loader and its
replay policy for ABI-56 artifacts.

Recommend a coordinated successor program ABI for shipping the
replacement, with explicit maintainer approval of the supported-baseline
transition. Change `crates/program-abi/src/lib.rs::ABI_VERSION` for the
program manifest, required mapping imports, side artifact validation and
fork interpretation. Bump `HOST_ADAPTER_VERSION` in
`crates/shared/src/lib.rs` with the incompatible kernel/worker
reconstruction contract, including the new generation-bound mapping
handoff and old archive retirement. If these are the next bumps, the
numbers are 57 and 9. Assign them at integration. The existing
[scheduled next-ABI changes](../abi-versioning.md#required-changes-for-the-next-program-abi)
also require independent pthread TLS and removal of the single-step
`__wasm_dlopen` import and lowering. Coordinate that work before staging
a program ABI successor. If the maintainer keeps ABI 56 as the supported
baseline, retain the base gate and legacy behavior and stage only the
additive extension path until a successor is authorized.
[Program extensions](../program-extensions.md)
[Persistent-program baseline](../persistent-program-compatibility.md#what-a-narrow-program-contract-actually-contains)

Record the versioned program records and role in the Program snapshot
surface, and the separately versioned kernel/host records on the
KernelHost surface. Update `abi/snapshot.json` and generated bindings
with `scripts/check-abi-version.sh update`, check the digest and
classification, and rebuild and test the standalone resolver bundle.
Require the new loader format and architecture on the normal SDK
`-shared` path as well as mains where applicable. Today not every shared
library carries a full program digest. Give new modules an explicit
loader format and program ABI/digest declaration checked at map time.
Validate bindings and fork contracts before entering module code.
Validate non-SDK linked artifacts and all normal SDK entry points,
including in-guest links and ports with raw linker invocations.

Preserve the ABI-56 frozen fixture bytes and historical release artifacts.
Any supported-baseline transition explicitly creates a fresh cohort with
the normal SDK and gates. Under a new exclusive baseline, old user
programs remain intact and are rebuilt from source with the matching
SDK and instrumenter. Already-installed packaged programs and their
lazy references move to a verified, coherent SDK, libc, package/side
module and image generation through the normal ABI staging workflow.
Use the new ABI release namespace and cache identity. No automatic
restamping or binary conversion is part of this plan.

Test mismatched kernel/host pairs at startup, wrong executable stamps
and invalid manifest/role pairs before launch (including exec, spawn
and publication), and stale or wrong-width side modules at dlopen.
The diagnostic identifies the offending artifact and the expected
version or declaration and explains the rebuild requirement. An
incompatible module must never reach a constructor, or fail only when
a pointer is invoked in a fork child. Update the ABI, SDK,
fork-instrumentation and POSIX status references with the shipped
contract and any explicitly accepted gaps.

## Prototype and measurement review

The first milestone uses the single-pass linker and a versioned
mapping extension while preserving ABI 56. Start with a lookup-only
SDK fixture to prove pointer identity and static table targets. Complete
the milestone with one plugin that imports an executable symbol and
exports a function the executable finds through `dlsym`. On Node and
browser, fork after loading and call the plugin through the inherited
handle in the child. Also fork from within an active plugin call and
verify the child resumes inside the plugin and returns to the executable
without repeating the pre-fork prefix.

Validate a ScummVM engine next to exercise thousands of imports per
module and measure the batching path. Follow with a CPython extension,
a small dependency closure with side-originated loading, and an SDL2
lookup-only consumer. Keep port configurations and the compiler fixed.
The measurement cohort includes waybar, gtk3_smoke,
`sdl2.wasm`, `sdl2-dsp-test`, `playwave`, `ffplay`, `love`,
`freeciv-sdl2`, ScummVM plus representative engines, and CPython plus
an extension. The prior inventory lists six SDL2 outputs to inspect.
Identify which outputs are lookup-only and which newly acquired that
role in the paired builds. Time final executable
links at clang and rustc scale using their normal link inputs or retained
exact response files. Keep these large link tests distinct from claims
that clang and rustc need dynamic loading.

| Cost | Capture on each comparable arm |
| --- | --- |
| Link | Prerequisite compilation, single-pass final link including LTO where used, and post-link steps timed separately. Record wall time, peak RSS, and peak scratch usage. Measure a no-loader link and an export-heavy variant on clang/rustc-scale inputs. |
| Image and instrumentation | Raw/final Wasm and compressed bytes, function table and element entries, index/name bytes, exports, facts source and artifact size, capability byte, instrumented-function count, and per-phase instrumentation time. Attribute code retention separately. Keep a facts fallback or disk-full run visible and outside the comparable results. |
| Open and lookup | Time cold/warm/repeated opens, handle/global hits and misses, data/function lookup, local-to-global promotion, and close. Include reader/loader CPU, adapter calls and bytes, ScummVM engine import counts, and both first-use and steady-state latency. |
| Fork | Measure parent-to-child-ready and child-to-reap with zero side modules and after several loads. Include memory copy and attach/replay components, worker startup, and memory growth. State sparse/dense copy mode and use the same mode in each pair. |

Pin a fresh develop baseline with #1778. If #1748 remains outside
develop, compare that base, the same base with #1748 integrated, and
the prototype on that integration.
After #1748 merges, pin a fresh develop baseline containing it and
retain the earlier data for attribution. Record exact source, toolchain
and artifact digests, loader flags, facts selection, runtime and browser
engines, repetitions and dispersion. Run alternating pairs and an A/A
control on a quiet machine. Report invalid or missing pairs, and any
workload without an applicable timing path. Benchmarks use each arm's
matching kernel and artifacts. Compare ScummVM's large-import load
latency to the baseline's measured run-to-run variation. Treat a
repeatable increase as a mapping-path regression to investigate before
advancing. Follow the repository's Node/browser benchmark scope before
broad performance claims. [Performance contract](../agent-guidance/performance.md)

Use the worktree SDK and resolver for targeted builds in the dev shell
and `scripts/agent-job` for long runs. Keep scratch databases and build
logs in run-local scratch, disable automatic cache GC inside the build
environment, and budget for only one heavy link or instrumenter arm
at a time. Preserve measurements and raw logs needed for review.
Phase 2 stops for review with measured deltas, correctness results, and
remaining gaps. Use that evidence to review the proposed shipping ABI
transition and the plan for cyclic direct imports.

After that review, propose reviewable changes targeting develop.
Land any independent correctness regression coverage first, then
toolchain/artifact and guest-loader/adapter changes behind a coherent
admission boundary, then the approved compatible deployment or
successor-ABI cutover. Keep incompatible ABI declarations, generated
bindings and the matching runtime together. Release validation includes
normal SDK and guest build paths, the loader/fork host and browser
suites, Sortix dynamic-linking and applicable POSIX/libc suites, the
browser-memory gate, and the Node/browser performance suites. Report
each run or omission. Push and PR creation require separate approval.
