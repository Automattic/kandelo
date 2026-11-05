# Node 26 core implementation outline

Current source113 supplies real SQLite scalar and aggregate/window registrations,
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
