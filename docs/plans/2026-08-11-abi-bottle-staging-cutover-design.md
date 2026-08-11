# ABI Bottle Staging Activation And Legacy Cutover

## Status

Approved direction, recorded before implementation on 2026-08-11.

This design activates the exact-candidate bottle system implemented by pull
request 1247 and makes it the staging authority for applicable Application
Binary Interface (ABI) pull requests. It does not activate promotion, delete
artifacts, or change production Formula metadata.

## Problem

Kandelo ABI pull requests still run the legacy package-release staging matrix
in `Automattic/kandelo`. That matrix rebuilds nearly the entire Kandelo package
registry into a temporary GitHub Release, even though the replacement system
builds Formula candidates in `Kandelo-dev/homebrew-tap-core`, verifies their
public bottles, and composes the exact VFS products that users consume.

The duplication is especially costly during an ABI transition. A new ABI
invalidates every legacy package cache key, so the old matrix rebuilds all
selected packages even when their replacement bottles will be built again by
the tap. Pull request 1247 currently demonstrates this bootstrap cost: its
staging run contains 64 unique package build identities while the protected
candidate system is not yet active.

The replacement cannot safely self-host pull request 1247. Its request feed
and required-check workflows use `pull_request_target` or protected manual
dispatch, so GitHub executes the versions on protected `main`. Until the
infrastructure lands, protected `main` has neither its implementation nor its
active policy. Pull request 1247 therefore needs one final legacy staging run
before later ABI pull requests can use the new path.

## Current Bootstrap Failures

Four jobs in the pull request 1247 staging run currently fail for three
isolated package-output integration defects:

1. Tcl successfully builds its interpreter into the resolver-owned work root,
   then its diagnostic checks the obsolete checkout-local
   `packages/registry/tcl/bin/tclsh.wasm` path.
2. MariaDB successfully compiles both wasm32 and wasm64 builds to the final
   link, but each CMake toolchain reconstructs checkout-local glue-object
   paths instead of consuming the resolver-owned glue directory prepared by
   the build script.
3. PHP successfully builds and fork-instruments the CLI and FPM artifacts,
   then sealed installation rejects the outputs because the build script does
   not pass the required explicit fork-instrumentation policy.

These failures are regressions in the new isolated-output contract. They are
not evidence that Tcl, MariaDB, or PHP no longer compile for Kandelo. They must
be repaired through the normal package build contract before pull request 1247
can merge.

## Goals

- Make exact staged bottles and exact product evidence authoritative for
  same-repository ABI pull requests.
- Stop rebuilding the legacy Kandelo package-release matrix for those pull
  requests.
- Keep normal kernel, host, structural ABI, and non-package validation.
- Publish candidate bottles, receipts, and product records only from
  `Kandelo-dev/homebrew-tap-core` into the Kandelo-dev GHCR namespace.
- Permit `Automattic/kandelo` to publish only the bounded public request asset
  as a GitHub Release asset.
- Fail closed when a request, candidate, verification receipt, product, or
  evidence result is absent or stale.
- Keep Formula promotion and production metadata mutation disabled.
- Preserve the legacy staging path for non-applicable package-only pull
  requests during the first rollout.

## Non-Goals

- Do not project candidate bottles back into the legacy `binaries/` directory
  or `index.toml` format.
- Do not publish any GHCR package under the Automattic organization.
- Do not activate Formula promotion, tap-main writes, ABI-history mutation,
  candidate deletion, or cleanup deletion.
- Do not retire every Kandelo package recipe in this change.
- Do not make the old package matrix a fallback for an applicable ABI request.
  A fallback would restore the expensive duplicate work and could let the two
  systems disagree about which bytes were tested.
- Do not change ABI 42 artifacts or claim that pull request 1247 was staged by
  the replacement system.

## Relationship To The Original Roadmap

This design inserts a time-critical activation tranche into
`2026-08-08-abi-staging-promotion-pages-and-retirement.md`. It does not replace
that plan or mark its remaining work complete.

The tranche advances the candidate/product portion of original Task 12 and
uses the hosted canary boundary shared with original Tasks 10 and 11. The
separate final admitted-product Pages plan has completed its local Tasks 1–5,
so its sealed site and Chromium gates are available to the hosted canary. That
local completion is not a production deployment claim.

After this cutover, the original roadmap still owns:

- Task 6: the full historical-repair and epoch-retirement lane;
- Task 7: active deletion tombstones and deletion execution, which remain
  observe-only or disabled;
- Task 10: the inactive production Pages switch and later separately reviewed
  deployment;
- Task 11: generic hosted acceptance orchestration and retained evidence;
- the promotion, ABI-history, retry, and override portions of Task 12;
- Tasks 13 and 14: evidence-based retirement assessment without premature
  legacy deletion;
- Task 15: final operational documentation and explicit limitations;
- Task 16: whole-roadmap verification and hosted evidence audit; and
- the deferred shared CandidateRecord fixture and sealed-file no-follow review
  items already recorded in the ledgers.

The original global prohibitions continue to apply during this tranche: no
production Pages deployment, artifact deletion or purge, legacy-infrastructure
removal, or Formula promotion. The cutover may generate candidate artifacts
and verification evidence only under the authorities defined below.

## Authority And Artifact Flow

### Kandelo request authority

Protected `Automattic/kandelo` code classifies the exact same-repository pull
request head. When the change is ABI-staging applicable, it derives one
canonical request bound to:

- the exact pull request head commit and tree;
- the target ABI version and snapshot;
- protected request policy and guard registries;
- the selected Formula and VFS product requirements; and
- the protected workflow revision that issued the request.

Active request publication writes only that canonical request to a bounded
GitHub Release asset in `Automattic/kandelo`. It does not publish a package,
bottle, VFS, receipt, or other object to Automattic GHCR.

### Tap candidate authority

Protected `Kandelo-dev/homebrew-tap-core` code consumes the request without
credentials during discovery and planning. Candidate build jobs run the exact
Kandelo pull request source as untrusted build input, while protected tap code
owns reconstruction, publication, and verification.

All OCI repositories used by this lane must have a validated prefix under:

```text
ghcr.io/kandelo-dev/homebrew-tap-core-abi-<N>/
```

The workflow must reject an Automattic GHCR repository before any write.

### Product authority

The tap workflow composes only the selected product graph. Formula-owned
inputs come from the exact candidate bottle layers. Non-Homebrew package,
archive, repository, and toolchain inputs are rebuilt or recaptured inside the
bounded uncredentialed product job from the exact Kandelo source and protected
runtime authority. Candidate VFS images are not trusted as inputs.

Protected Node.js and Chromium evidence runs prove the selected product
outcomes. This product path replaces the legacy test gate's consumption of a
synthetic full-registry `binaries/` overlay for applicable ABI requests.

## Rollout

### Phase 0: Bootstrap pull request 1247

Repair the three isolated-output defects with focused regressions:

- Tcl diagnostics and publication must use the resolver-owned artifact and
  must not require or mutate a checkout-local `bin/` path.
- MariaDB CMake toolchains must receive one explicit, absolute glue-object
  directory prepared by the build script for each architecture. The
  toolchains must not infer mutable build state beside themselves.
- PHP sealed installs must declare the normal `auto` fork policy so the helper
  validates already-instrumented executables and safely handles outputs that
  do not import `kernel_fork`.

Run the affected package build-contract tests and the normal staged archive
path. Merge pull request 1247 only after its required CI completes.

### Phase 1: Repair and canary hosted discovery

The tap's scheduled discovery currently performs a broad Automattic Release
listing whose response exceeds the protected 4 MiB bound. Do not raise that
bound. Change discovery so an explicit canary dispatch consumes one exact
request asset URL and scheduled discovery enumerates only the bounded request
namespace or a protected compact index.

Before activation, add mutations proving that discovery rejects:

- a foreign repository or asset namespace;
- an unbounded or paginated response outside policy;
- a mutable or noncanonical request locator;
- a request whose digest, head, policy, or ABI identity differs; and
- ambient credentials during anonymous request readback.

Run one explicit hosted canary while promotion remains disabled. The canary
must prove:

- request publication is a GitHub Release write in Automattic only;
- every OCI write targets the Kandelo-dev namespace;
- every selected Formula has its required candidate and verification receipt;
- every selected product has the required Node.js and browser evidence; and
- no production Formula metadata, tap branch, ABI history, or Pages site is
  mutated.

### Phase 2: Activate candidate production without promotion

After the canary succeeds, change these controls through reviewed pull
requests:

- Kandelo request feed: `observe` to `active`.
- Tap reconciliation: `observe` to `active`.
- Tap candidate publication: `observe` to `active`.
- Tap product evidence: `observe` to `active`.

Keep tap promotion `disabled`. Keep cleanup deletion observe-only or disabled.
Re-run an exact request after every activation change so the public records
bind the current protected policy revisions.

### Phase 3: Enforce evidence and suppress legacy ABI staging

Put the exact-head Kandelo PR Check into enforce mode only after Phase 2 has
produced a complete public result. The protected prepare-merge gate must reject
an applicable pull request unless that Check proves the current head, request,
tap policy, candidate receipts, product evidence, and terminal success.

Then extend the change-scope route with an explicit state for exact ABI staging
applicability. For that state:

- emit an empty legacy library and program package matrix;
- do not create or reuse a PR `binaries-abi-v<N>` staging Release;
- do not materialize a legacy PR package overlay for tests;
- continue the normal kernel, host, structural ABI, and non-package tests; and
- make the enforced exact-head Check the package/product merge authority.

The route must be derived from protected classification, not a label, Formula
name list, or changed-path approximation. If the exact request or public
evidence is delayed, missing, conflicting, or failed, the Check fails and the
pull request remains unmergeable. The workflow must not reactivate the old
matrix as a fallback.

Non-applicable package-only pull requests retain their current legacy staging
behavior during this rollout. A later design may move those builds to the tap
and retire the remaining package-release machinery.

## Why No Compatibility Projection

Materializing candidate bottles into legacy `binaries/` paths would let old
tests run unchanged, but it would create another translation authority between
the exact OCI bottle and the tested file. It would also preserve the full
registry overlay and tempt future workflows to treat a bottle and a Kandelo
package archive as interchangeable.

The replacement system already provides stronger evidence at the correct
layers:

- bottle structure and public candidate verification for each selected
  Formula;
- exact product composition from those bottle layers; and
- protected Node.js and Chromium product outcomes.

The cutover therefore routes applicable ABI pull requests to that evidence
instead of translating the evidence back into the legacy system.

## Failure And Retry Semantics

- A failed package bootstrap job in pull request 1247 remains an ordinary CI
  failure and must be fixed before merge.
- A missing request in active mode is a terminal staging failure after the
  bounded discovery grace period.
- A failed candidate, receipt, product, or evidence job remains visible in the
  exact-head Check; sibling success cannot hide it.
- Reruns preserve exact request and attempt identities. A later attempt cannot
  reuse a conflicting candidate or receipt from another head, ABI, policy, or
  Formula layer.
- Promotion remains disabled even when all candidate evidence succeeds.
- Rollback before the legacy cutover means returning activation to observe and
  leaving the old matrix unchanged.
- Rollback after the legacy cutover requires a reviewed routing change. An
  operator label or ad hoc fallback cannot silently restore legacy authority.

## Verification

Implementation must use test-driven development and include:

1. Focused package regressions for Tcl, MariaDB wasm32/wasm64, and PHP sealed
   outputs.
2. Tap discovery tests for one exact request, bounded scheduled enumeration,
   foreign locators, response limits, and anonymous readback.
3. Workflow mutation tests proving activation cannot write outside its exact
   repository and namespace.
4. A hosted canary that publishes candidates and evidence but cannot promote,
   delete, deploy Pages, or write Automattic GHCR.
5. Change-scope tests for applicable ABI, non-applicable package-only, mixed,
   stale-policy, missing-request, and failed-evidence cases.
6. Prepare-merge tests proving the enforced Check is bound to the current pull
   request head and protected policy.
7. A workflow test proving an applicable ABI request schedules zero legacy
   package matrix rows while retaining normal non-package validation.
8. Fresh action pin, generated policy, workflow contract, and diff checks in
   both repositories.

## Acceptance Criteria

The cutover is ready for the ABI 43 pull request when:

- pull request 1247 is merged with its bootstrap package failures repaired;
- one exact hosted canary completes through candidate and product evidence;
- no workflow publishes a GHCR object under Automattic;
- Formula promotion and deletion remain disabled;
- the exact-head Kandelo PR Check is enforced for applicable ABI changes;
- an applicable ABI fixture schedules no legacy package archive builds;
- a non-applicable package-only fixture still follows the legacy route; and
- a missing or failed public fact blocks merge without starting the legacy
  package matrix.
