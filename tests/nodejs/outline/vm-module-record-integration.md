# VM module records and native admission

Checkpoint 136 implements real SpiderMonkey source and embedding-synthetic
module records behind the unchanged pinned Module, SourceTextModule and
SyntheticModule classes. CompileModule, ModuleLink, ModuleEvaluate and actual
namespace/environment objects own parsing, graph instantiation, live exports,
evaluation and top-level await. Status comes from those records. Evaluation
with pending TLA maps to Node's evaluated public status without resolving or
replacing the actual pending engine Promise.

Synthetic records have traced export/callback/owner/Promise/error state and real
aliased environments. They link without running user evaluation, execute the
bound callback once, ignore its return value and preserve actual thrown values.
The direct and recursive engine linking paths both publish linked state.
Existing JSON records keep their prior path. Source-only module private-value
APIs remain unchanged; synthetic ownership uses its separate traced fields.

Static resolution uses the actual request identity and explicitly supplied
same-context graph. Metadata and dynamic imports route through traced module
registries. Non-VM private values fall through to the original loader hooks.
Native reactions retain the original dynamic import Promise and actual referrer
owner. They forward the actual settled value after the pinned wrapper validates
the returned module. No temporary filesystem registry entry, proxy namespace,
rewritten syntax or synthetic evaluation status stands in for an actual module.

Independent review found that a callable namespace export named then can
assimilate the wrapper's return into a value such as 42. The extra C++ namespace
assertion after fulfillment would reject this valid result. It is removed while
the unchanged wrapper still rejects an invalid callback return with
ERR_VM_MODULE_NOT_MODULE. Both cases pass for native Node and the pinned
wrapper/native-dependency fixture; the actual SpiderMonkey reaction remains
uncompiled. A provisional synthetic evaluation-status concern was withdrawn
after a native control demonstrated that the candidate timing already matches.
The sealed review retains that disproof; status timing was not changed.

## Realm and native CLI correction

Operations enter the actual target realm, wrap every argument and marshal
results/catchable exceptions back. Private hook admission checks the record's
realm, not the realm where a public callback function was created. Foreign
callbacks are admitted through normal checked wrappers. Synthetic callbacks,
metadata values and dynamic arguments are similarly wrapped and GC-rooted.
These source properties still require actual engine execution and stress.

A further root review found that default globalThis is the actual shell
WindowProxy. CheckedUnwrapDynamic stops at WindowProxy by default, so the
new module constructor and the existing compileFunction would reject that
accessible default global. Both now pass stopAtWindowProxy=false while
retaining the wrapper security checks, then require the actual inner global.
This is an owning-layer source fix, not a new global or JS facade. The exact
SM140 Wrapper.h contract and NewGlobalObject/SetWindowProxy path support the
source diagnosis; default/foreign/denied-wrapper/GC/OOM runtime proof is pending.
Earlier dependency controls do not exercise this C++ path. Their pre-correction
CPP identity is preserved; only the unchanged static constant map was tested,
and the current map is independently verified equal to that observation.

Root review found the JS export gate read experimentalVmModules but the real
CLI had no state field, parser branch or bootstrap property for it. The actual
native boolean parser now owns that flag, preserving existing underscore
normalization, negation, order, suffix handling, NODE_OPTIONS allowance and
CLI-only execArgv retention. Publication uses the same real state field; no
JavaScript option fallback supplies a fabricated true value.

Fourteen comparisons compile the exact extracted CLI parser/state and compare
its actual values/execArgv with pinned Node. Source checks verify the corresponding
JSAPI publication and consuming gate. This is not execution of that JSAPI path.
Two frontend groups check actual export admission and the full production
prefix's native-operation forwarding.

## Scoped evidence

Four complete VM reference files plus the Node option source/header match the
exact audited source archive. The public module source is embedded unchanged;
getConstructorOf is an independently hashed exact selector. Frozen proposal
and exact Mozilla/recipe preimages remain verified. Final engine patch 0109
roundtrips to the declared postimages, including the root native CLI correction.
The existing Worker startup, retained-memory, default-trigger and lock sources
are preserved. Source closure covers 676 inputs; staging/bootstrap/unity checks
pass. No engine, package, kernel or full product build ran for this VM slice.

Eleven source/native-dependency scenarios pass over actual Node ModuleWrap,
contexts and registries: validation, live synthetic exports, request metadata,
direct/asynchronous cycles, TLA, repeated thrown identity, link/context errors,
dynamic imports, foreign callbacks and live context state. The production
constant mapping matches eight actual native values. Twenty-four affected
checks pass: ten VM groups (two new, eight existing) and fourteen package checks.
The CLI helper is the only root native compilation in this slice.

The dependency fixture's initial native-prototype recursion failure is preserved;
its corrected native owner construction does not alter product assertions.
Five positive native observations for attributes, source phases, negative offsets,
cache and timeout remain requirements, not candidate passes. Combined source
117–136 is not successfully compiled as an engine and has no four-host acceptance.

A separate HTTP private test invocation unintentionally entered global setup.
Its sealed report records a private historical SDK driver/musl/fork-instrumenter
build and seven ABI-55 fixtures, followed by failed/interrupted private index
generation. Session 2493 terminated with 130 and later had no live handle; no
HTTP tests ran in that attempt. It was not a full product rebuild. These artifacts
are excluded from VM/HTTP acceptance and source patches. Exact command/output
identities and the limit of its root before/after evidence are retained in the
finding ledger. Do not describe the entire parallel work as having no builds.

## Remaining implementation and validation

Arbitrary static attribute values, source/defer syntax and objects, negative
source offsets, persistent code cache and real timeout/signal scopes remain
implementation gaps. Explicit unimplemented responses are not compatibility,
accepted exclusions or unavoidable engine boundaries. Script/context caches,
ordinary sandbox properties, memory/inspector, loader/worker and warning/metadata
obligations also remain. All 19 families remain partially implemented.

Actual JSAPI compilation, graph/synthetic execution, dynamic namespace/thenable/
Promise/hook/rejection behavior, GC/OOM/termination, security/compartments,
context retirement and all four product hosts require current-artifact evidence.
Prior sign/WebCrypto/cipher/SQLite/stack/gzip and networking nonpasses retain
their original scopes. Overall suites and full product rebuilds remain deferred.

No audited target/source/native-reference pin, external program/kernel/host ABI,
wire schema, platform identity, memory ceiling or accepted engine artifact changed.
Internal module layouts and the recipe revision require a newly built engine;
using accepted artifact 116 would not validate this candidate. Exact identities
and evidence are in [the ledger](vm-module-finding-progress.json).
