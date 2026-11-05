# Public Buffer construction and actual pooled storage

This partial values/shared-storage slice follows V-030/V-031 and related
Buffer constructor/species/warning/byte/transfer obligations. It does not
close the values family or an individual API observation. The audited Node
26.13.0/source/native pins, original audit and Claude/npm/Bun remainder remain
unchanged.

## Source implementation and owning boundaries

* Public Buffer is the pinned callable function over a distinct internal
  FastBuffer typed-array constructor. Both call and construct forms, numeric
  versus conversion branches, native public errors, species, inheritance and
  constructor identity consume real existing byte/codec/error owners.
  Internal allocation never calls the deprecated public constructor.
* The pinned DEP0005 state, origin/options selection, counter limit and warning
  algorithm run over the actual process warning owner and existing saved-frame
  origin binding. NODE_PENDING_DEPRECATION supplies the existing admitted
  environment mode; complete pending/no/throw/trace/CLI/worker/warning-stack
  activation remains a separate process/origin requirement.
* The pinned aligned pool initialization, alignment/rollover and allocation
  algorithms share one real backing owner with string encoding, array-like
  conversion, concatenation and copyBytesFrom. Ordinary alloc remains zeroed
  and unpooled; allocUnsafeSlow retains independent native allocation/alignment.
  Public poolSize and target thresholds/offsets are live state. There is no
  fabricated alignment address or independent codec-side pool.
* A real permanent NON_DETACHABLE ArrayBuffer storage flag participates in the
  engine's existing defined-detach-key checks. The internal pool registration
  marks that actual ArrayBuffer. Direct transfer, transferToFixedLength and
  JSAPI detach/steal routes use the engine restriction. Structured-clone
  preflight rejects a marked pool before graph traversal or any transfer;
  its transfer writer checks again after graph getters. The flag is not a
  public-property approximation, inherited mark or serializer-only blacklist.
* The actual Node option parser admits --zero-fill-buffers and its negative/
  underscore/boolean-presence forms through both command line and NODE_OPTIONS.
  Private process option state controls native backing-store memset; mutable
  JavaScript CLI metadata cannot enable/disable that allocator policy.
* Startup here is the ordinary guest startup. V8 snapshot admission/format is
  not implemented, so the target snapshot-deserialize callback is unselected
  explicitly. No isBuildingSnapshot successful stub was introduced.

The storage restriction is an embedding capability added to the owning
engine, not an outside-runtime defect or a replacement for a fixable kernel
operation. No new host import, syscall, wire layout or ABI change is added.
The package recipe changes because its source output changes; no platform
identity flag was added and the build script itself is unchanged.

## Focused evidence and retained failures

Eight focused public/shared-source scenarios cover constructor overloads/
errors/subclasses/warnings, public/FastBuffer metadata, actual shared pools,
string/raw/foreign view copies, rollover, physical native alignment, direct
and structured transfer rejection/copying, and warning selection/retry.
The final report is .context/node26-buffer-pool-controls-r4/report.json.
Its explicit boundary is the exact native Node backing allocator, alignment,
mark/detach/serializer, errors and warning dependencies; it does not execute
this new SpiderMonkey flag or guest native zero-fill implementation.

Eight independent portable CLI comparisons compile the unchanged actual
candidate tokenizer/boolean/argument parser. They compare native Node's real
option values/execArgs for ordinary, negated, underscore/equal-suffix,
NODE_OPTIONS quoting and command-line override cases. The report is
.context/node26-buffer-pool-cli/report.json. Native process parsing is not
compiled guest CLI/allocator runtime conformance.

Four unchanged upstream files execute separately as candidate and native:
parent-property, pool-untransferable, alloc-alignment and no-negative-
allocation. .context/node26-buffer-pool-upstream-r1/report.json records all
eight process outcomes and file identities. Candidate globals/module exports
select this actual Buffer source; native ports/serializer/internal bindings/
process/assert/common and other buffer exports are explicit dependencies.
Twenty-three affected byte/codec/header controls also pass. Their fixtures
now use the actual public constructor/pool over native dependencies instead
of continuing to treat the internal FastBuffer class as public Buffer.
The existing target-version guards are retained; no skip counts as a pass.

The first focused run retained six passes and two failures: an explicit
FastBuffer constructor gave the wrong length, and a rollover fixture assumed
an obsolete padding size. The first source mismatch was fixed by restoring
the pinned empty/default FastBuffer constructor; rollover now compares a
separate actual native result. A second run retained seven passes and the
missing public constructor Uint8Array ancestry. Actual source inheritance
was corrected; no assertion was weakened. Reports, prior inputs and scripts
remain retained. Two staging scripts also stopped on reviewed-input guards
after partial staging; follow-up scripts completed those mutations without
rerunning them. Initial unused-import cleanup does not change assertions.

Source checks retain section/full-file pin checks, exact four-file engine
patch forward/reverse with zero fuzz, generated bundle/bootstrap/native unity,
unchanged Mozilla include checks, original audit/target identity, declarations
and unchanged Bun dispatch. Package acceptance and runtime evidence remain
separate gates.

## Remaining requirements

* Compile the identified guest candidate, then validate real zero-fill,
  permanent detach/clone/direct transfer/GC/realm/worker behavior on all four
  hosts; focused native controls do not execute the guest binding.
* Complete general worker markAsUntransferable/isMarkedAsUntransferable for
  arbitrary objects and proxy/private semantics. This slice registers actual
  internal pool ArrayBuffers only; it does not expose a partial public facade.
* Shared/resizable/detached/out-of-bounds backing-store leases and races,
  allocator failure/accounting, context/worker shutdown and memory gates;
  actual origin/CLI/environment/warning activation and stacks.
* Remaining Buffer module exports, errors/brands/descriptors/inherited or
  user-modified constructor/realm edge behavior, private native diagnostics
  and public view/encoding/transfer integration. No blanket engine exclusion
  is accepted. V8 snapshot-format admission requires its own explicit owner.
* Reconcile each original observation against combined source before overall
  suites. Later validation includes unchanged upstream and native controls
  plus relevant guest lifecycle/memory checks within the full-rebuild deferral.

Continue independent shared, protocol, worker, loader, terminal and tooling
owners breadth first. No overall suite or full product rebuild ran.

The normal targeted wasm32 engine70 build subsequently succeeded in
244.5 seconds, with all 596 frozen selected source identities unchanged.
Unchanged Mozilla checks, optimization and fork instrumentation passed.
The retained artifacts/report are in .context/node26-engine-r70-accepted.
This compiles the actual binding and engine change; guest zero-fill/transfer/
GC/realm and four-host runtime validation remain pending. No overall suite
or full product rebuild ran.
