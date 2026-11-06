# Node 26 core implementation outline

The normal targeted engine149 build failed an actual Mozilla sorted-list gate.
Source150 fixes three build lists; the unchanged upstream validator accepts
41checked lists and14package-source checks pass. No current engine/runtime
acceptance follows. See [build ordering scope](engine-build-order-integration.md).


Source checkpoint149 integrates actual native execution ownership and outer
callback recovery, preserving catchable nested errors and clear epochs.
Four native helper compilations, six bounded component processes and36affected
checks pass with explicit dependencies. Current SpiderMonkey/guest/four-host
validation and documented fatal/main/Promise gaps remain open. See the
[recovery scope](callback-recovery-integration.md).


Source checkpoint148 adds actual runtime-owned default-locale source and
private bootstrap capture. Header compilation against real Mozilla ICU77 and
21affected frontend/package checks pass; guest engine/ICU runtime and four-host
conformance remain unvalidated. CPU APIs remain unsupported implementation gaps.
See [locale scope](default-locale-integration.md).


Source checkpoint147 integrates pinned recursive cp algorithms and actual native
worker/resource ownership. Existing evidence retains16matching groups and one
handled-callback after-hook nonpass. The combined engine and four-host runtime
remain unvalidated; all19families stay partial. See the
[recursive copy scope](copy-directory-integration.md).


Source checkpoint146 routes original allocation spans through queued FS/codec
consumers and makes USER_OWNED deallocation a committed native transaction.
One actual component control and36 affected frontend/package checks pass with
explicit dependencies. The combined engine and four-host runtime remain
unvalidated; FS-011 and all19families stay open. See the
[allocation integration scope](original-backing-consumers-integration.md).


Source145 adds actual watchFile/StatWatcher polling,timer/close/resource owners
and shared cached-clock integration over144. Eight bounded native/component
processes and affected source checks pass;production JSAPI/four-host validation,
notifications and shared callback recovery remain open. See
[watcher integration](stat-watcher-integration.md).


Source144 routes Worker lazy locks/private module identity through the actual
production native adapter.27differential traces,four existing Locks processes
and affected source checks pass with real V8/portable dependencies;SMprimitive
and current four-host conformance remain unvalidated. See
[Worker lazy scope](worker-lazy-integration.md).


Source143 integrates real engine lazy DATA shapes,traced cells and native
binding over current142TLS/ELD/VM/backing source. Source/staging and14package
checks pass;no C++/guest/public-consumer conformance is established. See the
[native lazy prerequisite scope](native-lazy-data-integration.md).


The separate SDK recovery slice keeps recipe142 and fixes diagnosed invalid
initializer handling in Kandelo's compiler-facts collector. Thirteen native
component controls pass;normal SDK/musl/package freshness must refresh before
the next engine build. See [SDK recovery scope](sdk-recovery-integration.md).


Source142 adds actual eager TLS trust-context ownership, completion-time
verification and Promise-realm admission over current141. Focused OpenSSL/TCP
and affected source controls pass; production JSAPI and current four-host
conformance remain open. See [TLS integration](tls-context-integration.md).


Source checkpoint141 fixes the shared own-property helper's stored-value
return. First-read Number/BigInt Stats dates and37 affected/package checks pass
with native dependencies. Guest metadata and four-host conformance remain open.
See the [helper scope](own-property-return-integration.md).


Source checkpoint140 adds actual retained-backing engine/native capabilities
and correct known-owner controller accounting. Portable ownership controls and14
package checks pass; production byte-consumer routing, VM/GC/transport and all
four hosts remain unvalidated. See the
[backing-store scope](backing-store-integration.md).


Source checkpoint139 adds native event-loop-delay samplers and deferred-close
ownership beneath the pinned public wrapper. Portable/native-host controls and39
affected/package checks pass; actual Kandelo phase/GC/clone/realm/four-host
behavior remains uncompiled/unvalidated. See the
[ELD integration scope](event-loop-delay-integration.md).


Source checkpoint138 integrates the complete pinned OutgoingMessage and actual
request framing/socket completion paths. Twenty focused dependency-runner groups
and20 source-only header/package checks pass; these are not guest/four-host
conformance. Client/Agent/server/TLS gaps remain open. See the
[HTTP integration scope](http-outgoing-integration.md).


Source checkpoint137 selects the explicit Kandelo/Unix SpiderMonkey target
without Linux identity, preserving actual Wasm/musl owners and generic Rust
identity. Exact source/configure controls and14 package checks pass; complete
configure, engine and four-host behavior remain unvalidated. See the
[target configuration scope](target-config-integration.md).


Source checkpoint 136 adds real source/synthetic module records, graph linking,
live namespaces and evaluation ownership beneath the pinned public VM classes.
The real CLI now owns the experimental flag instead of leaving the JS gate
unreachable. Eleven dependency scenarios, 14 extracted-parser/native comparisons,
and 24 affected VM/package checks pass. These are not candidate engine results.
Cache, phases, attributes, offsets and deadline gaps remain open; combined
engine and four-host validation are pending. Overall suites and full product
rebuilds stay deferred. See [VM module scope](vm-module-record-integration.md).


Source checkpoint 135 fixes Worker argv coercion and option-getter order,
captures eval once, and supplies the classic eval argument through the real
startup configuration. All 32 source/native comparisons and two main-startup
controls pass, along with 11 affected port groups and 14 package checks.
Native lazy-property and Navigator observations remain prerequisites, not
candidate passes. Combined engine and four-host validation remain pending.
All 19 families remain partial; overall suites and full rebuilds are deferred.
See [Worker startup scope](worker-startup-integration.md).


Source134 adds real HDR/statistics/sliding-window histogram owners, unchanged
pinned public wrappers, native queued QRDE completion and packet-owned clone
material, together with process-owned retained-memory accounting. It preserves
one physical allocation across aliases,queues,cache/work and context retirement.
Root403portable rows+27imports and403NAPI public rows+75edges pass,as do48affected
frontend and14package checks. Four focused components compile through the SDK.
Actual engine JSAPI,clone/GC/VM behavior and four-host conformance remain open;
ELD is a separate pending source integration. All19families remain partial.
See [histogram integration and limits](histogram-retained-memory-integration.md).


Source133 adds a native per-context default-trigger owner, separate from
captured frames and execution IDs, and routes AsyncResource, ticks and existing
FS/DNS/codec constructors through it. Production adapter forwarders are covered
by one new control;21 affected async groups and12 package checks also pass.
Actual native numeric-owner/RAII/dependency controls pass;the retained native
callback fixture ID difference is not counted as execution-ID compatibility.
Combined117–133engine/JSAPI and four-host conformance remain unvalidated.
All19families partial;overall suites/full product rebuild remain deferred.
See [default-trigger integration](async-default-trigger-integration.md).


Source132 shares native string-byte primitives across JWK and hash/HMAC/cipher
updates. Original strings/encodings now reach native owned conversion;public
Buffer allocation cannot supply private native input.31root groups(including
96boundary cases inside one new group) and12package checks pass;the standalone
codec compiles to Wasm through the SDK. Private24,736byte/12,308affected-JWK/
226material results were identity-verified,not rerun. Actual native JSAPI and
combined117–132engine remain uncompiled;all19families partial. Overall suites/
full product rebuild stay deferred. See [private native bytes](private-byte-implementation-dependencies.md).


Source131 fixes receiver victim-root insertion with genuine own properties,
so inherited indexed setters cannot leak/drop roots or reenter before commit.
The NAPI packet fixture now mirrors production own-element definitions.
Original17matched public groups,2existing failure groups,4native/7candidate
prototype groups and12package checks pass;old receiver and old fixture fail
the new assertions as expected. Production JSAPI/combined117–131engine remains
uncompiled;all19families partial. Overall suites/full rebuild stay deferred.
See [indexed receiver ownership](worker-locks-prototype-fix.md).


Source130 removes public Buffer allocation/JavaScript callbacks from native
JWK byte ownership,preserves OOM/control failures,and roots material across
reentrant getters and foreign-handle realm access.20root key checks(including
one new callback-forbidding group) and12package checks pass. Source-identical
private evidence contains12,308codec and226material passes;those were verified
by source/dependency/binary identities,not rerun. Four unchanged files retain
6passes/2consumer nonpasses. Combined117–130engine/JSAPI remains uncompiled;
all19families partial. Overall suites/full product rebuild remain deferred.
See [JWK review fixes](jwk-review-fixes.md).


Source129 adds a real shared worker-lock manager,receiver-local waiting and
released Promises,transactional grant/steal delivery and fair native-provider
dispatch.17public groups match exact native26;2fixture failure groups,
38affected controls and12package checks pass. One unchanged upstream
lock-diagnostics file passes both dependency-fixture modes. Portable owners
also compile through the actual SDK. These are scoped source/native controls;
production JSAPI/guest/four-host behavior is unvalidated. Lazy native-data
properties,global Navigator routing and earlier compatibility gaps remain open.
All19families remain partial;overall suites/full rebuild remain deferred.
See [lock integration and limits](worker-locks-integration.md).


Source128 selects the copy owner’s reflink header by actual availability.
Targeted engine127failed on an absent linux/fs.h selected by the existing
package macro;it also recorded an unresolved SDK calltypes-plugin crash.
Both failures remain saved. The corrected header compiles through the actual
SDK in normal and legacy-macro control modes.20zero-directory controls and
12package checks pass;the43-case portable matrix retains1errno mismatch.
Accepted engine116remains stale;source117–128is uncompiled as a full engine.
All19families remain partial;overall suites/full product rebuild stay deferred.
See [copy ownership](copy-file-implementation-dependencies.md).


Source127 routes filesystem copyFile sync/callback/promise wrappers through a
bounded descriptor owner and the existing real FSReq queue. Actual O_EXCL,
inode checks before truncation,metadata/cleanup and S_IFDIR rejection replace
the whole-buffer copy.35frontend and12package checks pass;two unchanged
upstream files pass in both native-dependency modes. The portable owner passes
20zero-directory controls;its43-case matrix retains1directory errno mismatch.
Guest117–127source is uncompiled;accepted116is stale. All19families remain
partial;overall suites/full rebuild remain deferred. See
[copy ownership and open differences](copy-file-implementation-dependencies.md).


Source126 adds real asymmetric JWK import/export over ncrypto/OpenSSL owners,
including RSA multi-prime,EC,OKP/AKP,private/public relation checks and native
own-property definitions. Eight new and61affected frontend controls and12package
checks pass. The reviewed portable owner has226passing native comparisons with
matching source/dependency identities. Four unchanged files in two modes retain
6pass/2candidate consumer nonpasses. Guest117–126source remains uncompiled;
accepted116is stale. All19families remain partial;overall suites/full rebuild
remain deferred. See [JWK ownership](jwk-implementation-dependencies.md).

Source125 installs the pinned public AsyncHook class with actual symbol/count
registry semantics,ordinary public functions and a stable ordinary root resource.
Eleven new and23 affected frontend controls,12 package checks and four runs of
two unchanged upstream files pass in explicit native-dependency scopes. The
initial regression exposed a fixture floating-point grouping error; its failure
and preimage remain retained. Guest117–125source remains uncompiled;accepted116
is stale. All19families remain partial;overall suites/full rebuild remain deferred.
See [AsyncHook ownership](async-hook-registration-implementation-dependencies.md).

Source124 adds actual per-context loop-start/idle measurements and the full
pinned event-loop-utilization calculation. Six new and seven existing frontend
controls, six portable clock-owner checks and12 package checks pass in their
recorded scopes. The complete unchanged upstream ELU file passes natively and
fails against the candidate at missing NodeTiming milestones; that failure is
retained. Selected shell-file patch composition is checked from the canonical
Mozilla archive. Guest source117–124 remains uncompiled; accepted116 is not
current. All19 families remain partial; overall suites/full product rebuild
remain deferred. See [loop measurements](loop-metrics-implementation-dependencies.md).

Source123 adds actual EC/OKP/PQC raw-key imports, exact algorithm spelling,
point/scalar/seed validation, public-role projection and pinned provider
encoding initialization. Four new frontend comparisons and23 affected controls
pass, alongside92 portable byte/error comparisons,18 affected material-owner
comparisons and two runs of one unchanged upstream file. The614-input source
guard and12 package checks pass. These are separate evidence scopes, not API
closure. Guest source117–123 is uncompiled; accepted116 is not current. All19
families remain partial; overall suites/full product rebuild remain deferred.
See [raw key ownership and evidence](raw-key-implementation-dependencies.md).

Source122 adds pinned logical/native realpath, readlink and full glob traversal
using real POSIX byte results/queued requests and shared Dirent/stat owners.
The private URL-or-path converter now serves filesystem consumers. Sixteen new
and37 affected controls,16 portable byte/error comparisons and eight unchanged-
file runs pass in their explicit native-boundary scopes. Guest source117–122
is uncompiled; accepted116 is not current. All19 families remain partial;
overall suites/full product rebuild remain deferred. See
[path/traversal ownership](filesystem-traversal-implementation-dependencies.md).


Source121 installs the pinned shared warning owner and actual CLI option
source for filtering, trace/deprecation policy and redirect-file lifecycle.
Sixteen new frontend and47 affected controls pass; one known environment-clone
fixture nonpass remains. Four unchanged-file runs and14 portable parser
comparisons pass in their explicit native-boundary scopes. Guest source117–121
is uncompiled; accepted116 is not current. All19 families remain partial;
overall suites/full product rebuild remain deferred. See
[warning ownership and evidence](warning-implementation-dependencies.md).


The shared [build-input guard](build-input-closure.md) now covers614 source
and verification files, including the initial309 added inputs. Twelve focused
package-contract checks pass. Runtime source remains120/uncompiled; this
source-only prerequisite changes no runtime conformance claim.

Source120 adds real borrowed-stdin terminal mode leases, pinned mode/error
policy, actual window queries and transport/context/GC cleanup. Five native-
boundary frontend comparisons, four affected stream controls and one portable
PTY/native comparison pass in their recorded scopes. The guest binding and
117–119 source remain uncompiled; accepted116 is not current. Public TTY classes,
signals/drain and four-host conformance remain open. All 19 families are partial;
overall suites/full product rebuild remain deferred. See
[terminal ownership and evidence](terminal-mode-implementation-dependencies.md).

Earlier revision checkpoints below retain their historical scope.

Source revision119 adds pinned Module.wrap/wrapper owners and actual patched
script compilation, preserving the ordinary function compiler. The shared
invocation now snapshots exports once for receiver/argument identity. Eight
new and fourteen affected frontend controls pass; two unchanged upstream
fixtures pass in candidate/native modes. Guest compilation and four-host
conformance remain pending; accepted116 is not current for source117–119.
Earlier guest failures and all 19 incomplete families remain open. Overall
suites/full product rebuild remain deferred. See
[wrapper ownership and evidence](module-wrapper-implementation-dependencies.md).

Earlier revision checkpoints below retain their historical scope.

Source revision 118 adds pinned hard-link sync/callback/promise APIs over
actual libc operations, owned queued source/destination paths and shared
destination-error completion. Twelve frontend controls and one portable-owner
comparison pass within explicit native dependency boundaries. The new C++ and
source117 empty-input fix remain guest-uncompiled; accepted engine116 is not
current. Its earlier cipher failures remain open, with a bounded native-tag
investigation recorded separately. All 19 families remain incomplete; overall
suites and a full product rebuild remain deferred. See
[hard-link ownership and evidence](hardlink-implementation-dependencies.md).

Earlier revision checkpoints below retain their historical scope.

Source revision 117 supplies pinned Cipheriv/Decipheriv algorithms over actual
native ncrypto/OpenSSL contexts and fixes the empty-data versus null-control
boundary. The accepted targeted engine 116 compiles the preceding source and
passes artifact admission. Five Node-host guest comparisons record one pass
and four failures with escaping Wasm exceptions; these failures remain open.
The empty-input fix has portable-owner evidence but is guest-uncompiled.
All 19 families remain incomplete. Overall suites and a full product rebuild
remain deferred. See [cipher ownership, evidence and gaps](cipher-implementation-dependencies.md).

Earlier revision checkpoints below retain their historical scope.

Revision 115 compiles real named broadcast groups and owned shared engine
message storage, including revision 114 temporary-directory owners. Normal
artifact admission succeeds; four same-source exact-native/Node-host guest
controls pass, including a real worker exchange and temporary-dir disposal.
Four-host and whole-family conformance remain unestablished; all 19 families
are incomplete and overall suites/full product rebuild remain deferred. See
[broadcast ownership and scoped evidence](broadcast-implementation-dependencies.md).


Earlier source revision 114 adds pinned temporary-directory and disposal APIs over
real libc creation, native FS requests and existing removal owners. Seven
new frontend controls, twelve affected controls, nine portable native-owner
scenarios and four unchanged upstream files pass within their documented
control boundaries. The changed guest source is uncompiled; accepted engine
113 is not current for this candidate. All 19 families remain incomplete,
and overall suites/full product rebuild remain deferred. See
[temporary-directory ownership and evidence](tempdir-implementation-dependencies.md).


Earlier source113 supplies real SQLite scalar and aggregate/window registrations,
traced callback/accumulator ownership and parent-handle retention. The targeted
engine compiles and passes normal artifact admission. Nine focused comparisons
record3pass/6fail: return conversions, groups and windows match; other cases
retain integration failures and one failing native-reference expectation.
No whole SQLite, overall-suite or four-host conformance follows. See
[SQLite callback owners and remaining work](sqlite-callback-implementation-dependencies.md).


Earlier source112 compiles the shared codec/work storage changes and the
earlier111URL/path bundle. Normal admission accepts the stamped artifact.
Seven focused Node-host comparisons record3pass/4fail; all public assertions
complete, and the four raw-byte mismatches are traced to gzip OS metadata
(native macOS19versus guest Unix-default3). Original failures are preserved.
Ordinary async resizable leases, complete lifecycle and four-host conformance
remain open. No overall suite or full product rebuild ran. See
[compression storage and evidence](compression-storage-implementation-dependencies.md).

Earlier recipe-stage statements retain their historical scope.

Historical source111 adds pinned URL/file-path/HTTP-option conversion algorithms
over the actual shared parser, Buffer/path and error owners. Focused frontend
controls record15pass; unchanged upstream files record6pass/2macOS skips
across candidate/native modes. The changed guest bundle is uncompiled;
accepted engine110does not validate these bytes. See
[URL/path owners and limitations](url-path-implementation-dependencies.md).

The last accepted artifact checkpoint follows.

Historical integration checkpoint: canonical targeted engine110 compiles the
shared native Error location-extension policy. Eight actual Node-host guest
controls record7pass/1fail; earlier assertion diagnostics and root/VM/clone/
native-error/worker location checks pass. Full generic Error layout remains
failed at the own lazy stack accessor/prototype contract. A separate standalone
shell control passes; it is not Node conformance. Exact pins, the frozen audit,
the earlier native fixture failure and all108/109nonpasses remain intact.
See [Error owners/evidence](error-location-implementation-dependencies.md),
[assertion algorithms](assertion-error-implementation-dependencies.md) and
[kernel admission](kernel-admission-integration.md). All19families remain
partial; overall suites and the full product rebuild remain deferred.

The [source audit](../audit/audit-report.md) is complete as a historical
review of its recorded source identities. The user subsequently authorized
the active [breadth-first implementation pass](breadth-first-implementation.md)
before overall suites. Its machine-readable implementation-state.json
records current source progress and scoped evidence separately from runtime
conformance. Focused controls and targeted builds are allowed; full product
rebuilds remain deferred. The original outline below is historical planning
context, not current implementation or compatibility evidence.

The [current capability reconciliation](current-capability-reconciliation.md)
routes all 19 families and original deprecation requirements to current
owners and remaining dependencies. Source audit, implementation and
runtime conformance remain independent dimensions; no family is complete.

The latest [process lifetime source slice](process-lifetime-implementation-dependencies.md)
is recipe89 source only. The last accepted engine88 remains independently
identified; it does not contain that slice. Focused native-dependency
controls are separate from guest and four-host conformance.

The subsequent [password-KDF source slice](kdf-implementation-dependencies.md)
is recipe90, with a verified shared OpenSSL3.5.9 source prerequisite. Its
native controls are separate from the uncompiled guest dependency/binding.

Recent source slices include [random-job and OpenSSL thread ownership](random-implementation-dependencies.md),
[StringDecoder byte-state ownership](string-decoder-implementation-dependencies.md),
[incremental Hash/Hmac ownership](incremental-crypto-implementation-dependencies.md),
and [persistent Dir ownership](dir-implementation-dependencies.md).
Their focused evidence and explicit remaining dependencies do not certify
the combined current candidate on any guest host.

This is a work inventory, not a compatibility report. The target remains
Node 26.13.0, source commit
`18b32a3b1552e199a01f1a8d9fd64aa756d3b75b`. The most recent official
release/checksum check was recorded on November 1, 2026, before this
outline. This pass does not make a new release-availability claim.

[The implementation plan](../core-plan.json) assigns all 74 discovered
builtin names and all 71 API documents to 19 module families. It orders
13 shared prerequisites before their dependents. No module family is
complete. Names beginning with an underscore remain visible for a public
applicability review; their discovery does not make private interfaces a
public compatibility requirement.

[The manifest](manifest.json) records document hashes, builtin exposure
policies, the saved native capture identity and all 39 upstream test
categories. [The review rows](review-rows.jsonl) retain all 5,771 document
sections and 5,428 captured descriptor records. These 11,199 rows are
review obligations, not unique public APIs. Narrative sections, duplicate
exports, aliases and overlapping documentation remain visible. Every
per-host row starts as `unreviewed`, including APIs with narrower existing
behavioral evidence in [coverage checkpoints](../coverage/).

[The implementation ledger](implementation-review.md) records source changes
and pending validation during the broad pass.

[Deferred event verification obligations](event-verification-obligations.json)
keep candidate source identities, activation flags and pending results
separate from the unchanged historical reports. No candidate has been run
as part of this broad pass.

[The stream dependency graph](stream-dependencies.json) records concrete
pinned imports and the shared prerequisites needed before replacing the
minimal stream implementation.

## Implementation order

Start with captured intrinsics, validation, brands, descriptors and byte
semantics. Scheduling and process lifetime, inspection, events/abort and
streams then unblock many other families. Loader, descriptor and transport
work follow their actual prerequisites. Crypto/protocol/compression
backends, workers, engine APIs and integrated tooling need their real
underlying resources; adding facade exports does not implement them.

The plan is a dependency graph, not a claim that every module in one
family must wait for every API in another. Implement a coherent shared
foundation and its consumers together. Keep pending verification attached
to each change. During the outline and broad implementation pass, reuse
existing evidence and perform source review without new tests, runtime
probes or builds. Once that candidate is ready, run targeted builds and
batched unchanged-upstream/native comparisons on all four hosts. The
full product rebuild remains deferred.

Each module also has explicit review obligations for inherited APIs,
getter-returned objects, symbols, aliases, descriptors, overloads, legacy
constructors, CLI policies, platform branches and asynchronous resource
lifetime. The completed audit records those reviews and their implementation
gaps; that audit does not make this candidate conformant. The saved native capture is
from Darwin arm64, has a depth limit and did not inspect gated modules
under their enabling flags. Documentation and source policy keep those
surfaces in scope. Neither absent capture data nor a missing native
binding justifies an engine/platform exclusion.

## Regenerate without running code under test

Use an already prepared unchanged source tree from the pinned test runner:

```sh
scripts/dev-shell.sh python3 scripts/generate-nodejs-core-outline.py \
  --source .context/nodejs-lts-cache-v2/node-v26.13.0
```

This reads source and the checked-in saved discovery data, verifies their
identities and emits planning files. It executes no native/guest Node
code, downloads nothing and builds nothing. Re-running it deliberately
recreates an unreviewed discovery index; put behavioral reviews and
results in separate coverage/evidence files rather than editing generated
rows to assert support. For a deliberate replacement discovery capture,
pass `--reference-inventory <saved-reference.json>` using the same schema
as the existing capture. A changed target or discovery surface requires
explicit review of the plan before generation can proceed.

The category index counts only direct `test-*.js`/`test-*.mjs` candidates;
it does not claim official test selections or complete fixture coverage.
Review each category's configuration and nested suites before deciding
applicability. Native addon, embedding, WASI, pseudo-terminal, inspector,
network and Web Platform Tests need their actual fixture/launcher paths.
An unrun category stays pending, never passing or silently excluded.

## Completion

Reconcile documentation, saved exports and source policy into an audited
API matrix. Bind every behavior claim to current source/artifact
identities and relevant native and four-host results. Preserve failures,
upstream skips, unsupported cases, timeouts, harness errors and pending
work separately. Proposed platform boundaries need API-specific reasons
and concrete evidence. This outline supplies neither that final audit nor
passing compatibility.

The partial live TLS metadata source owner and its explicit remaining
requirements are tracked in [TLS state dependencies](tls-state-implementation-dependencies.md). No family or four-host conformance is established by that slice.

[Public Buffer/pool ownership](buffer-pool-implementation-dependencies.md)
subsequently reached targeted engine70 acceptance. Focused native dependency
controls and unchanged source assertions are separate from guest/four-host
conformance; no family is complete.

[Shared package policy](package-policy-implementation-dependencies.md) now connects actual exports/imports/maps/
conditions and public package-JSON discovery with filename/URL consumers.
Execution, hooks, source-syntax/type/addon and four-host requirements remain
explicitly incomplete; source policy is not full loader compatibility.

Shared package policy and native conditions/map/symlink activation reached
targeted engine71 acceptance. Guest/four-host runtime behavior and full
module execution remain open; see package-policy-implementation-dependencies.md.

The partial DNS Resolver/channel/record source and external native completion
owner are documented in tests/nodejs/outline/dns-channel-implementation-dependencies.md.
Full pinned frontend/native-boundary controls are separate from guest/four-host
conformance; remaining configuration, permission, lifetime and host routes
are explicit gaps. No overall suite or full product rebuild ran.

The actual c-ares Resolver/channel/record and shared external completion
owners reached targeted engine72 acceptance, including its normal SDK-built
dependency. Native-boundary controls remain separate from guest/four-host
conformance. See dns-channel-implementation-dependencies.md; no family is complete.

Owned message packet and actual JS adapter integration source is recorded in
`tests/nodejs/outline/port-packets-implementation-dependencies.md`. Native engine
buffers replace rooted shell payloads; worker transport/lifecycle remains
partial and scoped controls do not establish guest/four-host conformance.

Owned engine message packets, close acknowledgement and actual adapter links
reached targeted engine75 acceptance, reusing the exact pinned dependencies. Native-boundary controls remain separate from guest/four-host
conformance. See port-packets-implementation-dependencies.md; no family is complete.

Process usage algorithms and actual nominal engine GC-budget reporting are
recorded in tests/nodejs/outline/resource-usage-implementation-dependencies.md.
Guest CPU/memory/resource/report/space providers remain explicit gaps; missing
measurements no longer return fabricated zeros/paths/spaces. No full API or
four-host conformance is established by those guards.

The subsequent resource-usage slice reached targeted engine76 acceptance.
Five previously tracked wrong-success numeric/report/space values are removed;
actual nominal GC budget is measured, while guest usage/report/space providers
remain implementation gaps. See resource-usage-implementation-dependencies.md
for original evidence, native/guest scope and remaining requirements. No
overall suite/full product rebuild or family closure is established.

The subsequent HTTP source slice uses the complete pinned IncomingMessage
module for actual response parsing, lazy/distinct headers/trailers and abort
state. Socket release now waits for consumed response EOF and completed request
writes. Recipe77 remains uncompiled; the last accepted engine76 predates it.
Focused native-boundary controls are separate from guest/four-host conformance.
Complete parser/Agent/server/HTTP2 and remaining lifecycle gaps stay open; see
`tests/nodejs/outline/http-incoming-implementation-dependencies.md`.

The VM ordinary-global source now owns a real isolated DONT_CONTEXTIFY
global and per-ShellContext chained/restored security callbacks (patch85,
recipe78). Ordinary sandbox live forwarding, imports/deadlines/microtasks and
full realm/worker behavior remain gaps. Native-boundary controls and the
retained complete-file dynamic-import failure do not establish guest or
four-host conformance. See
`tests/nodejs/outline/vm-plain-context-implementation-dependencies.md`.

The later normal targeted engine78 build compiles actual VM ordinary globals/
runtime security callback ownership and the preceding HTTP77 source. Narrow
Node-host guest VM outcomes are separately identified in the VM plain-context
dependency report; HTTP/worker/full API/four-host conformance remains open.
The complete unchanged VM plain-context upstream candidate file still fails
its missing dynamic-import requirement. No overall suite/full product rebuild.

The subsequent Worker source replaces minimal-prelude/JSON/shared-mailbox
launch with per-worker native context/thread/packet/endpoint ownership and
normal Node bootstrap/loader, ready/error/exit and independent stop/join/ref
state. Patches86–88 reached targeted engine83 acceptance; six identical
native/Node-host guest cases pass. Options/stdio/fd/transfer/resource/lifecycle,
ordinary stamped-consumer and four-host obligations remain open. Subsequent
recipe84 Test/Suite/harness source is uncompiled; native-boundary controls
are separate from guest execution. See worker-owner and testing dependency
records under `tests/nodejs/outline/` for exact evidence and retained failures.

The later targeted engine88 compiles actual SQLite iterator/column/limit/
session/change-set and native callback owners, with real SQLite activation and
process beforeExit idle/revival state. Exact focused native/Node-host guest
outcomes and retained nonpasses are in the SQLite dependency/finding records.
SQLite/testing/process and four-host conformance remain partial; no overall
suite or full product rebuild ran.
