# Promotion, Atomic Pages, and Legacy Retirement Implementation Plan

> **Junior-review edition:** The complete command-level version is preserved
> in docs-only commit `0153a8863`. This edition explains the same interfaces,
> tests, trust boundaries, and commit sequence in plainer language. During
> implementation, use the preserved task details together with any review
> changes approved against this edition.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve protected prior-ABI tap history, admit eligible merged
candidates without changing bottle-layer bytes, rebuild canonical VFS products,
publish one complete Pages site, prove the hosted successor transition, and
remove only legacy entries whose individual evidence is complete.

**Architecture:** GitHub's exact merged-PR fact triggers protected tap
promotion. Before any successor activation, a separate protected workflow
creates and verifies `abi/N`. Each Formula promotes independently through an
unchanged bottle layer, narrow metadata compare-and-swap, and immutable
admission. Kandelo rebuilds Pages products with canonical references and hands
one inert complete site to a separately permissioned deploy job. Retention and
retirement are derived from evidence, never from a success label.

**Tech Stack:** Tap Python modules/OCI transport, GitHub REST and `gh`, Git
branches, TypeScript VFS builders, Node/Vitest, Playwright, native GitHub Pages
actions pinned to full SHAs, Rust readiness/retirement models, Python hosted
acceptance, Ruby workflow tests, and `scripts/dev-shell.sh`.

## Global Constraints

- Keep Plans 1–4 interfaces unchanged. Checks/status/runs/tags/timestamps/
  mutable branches are not candidate or admission authority.
- Generic code derives `N`, `N + 1`, namespaces, and `abi/N`; concrete values
  appear only in `abi/staging/acceptance/successor-batch.toml`.
- Promotion requires GitHub's merged fact for the exact request PR. Do not infer
  merge from Kandelo main scans or ancestry.
- Before any successor canonical object or current-ABI metadata change,
  `abi/N` must exist at the exact preactivation tap commit, be protected by an
  external rule, and pass public metadata/readback checks.
- Workflows verify protection but have no repository-administration permission.
- Promotion reuses exact candidate bottle digest/bytes. Candidate and canonical
  manifest digests may differ. Original production and later admission
  provenance remain distinct.
- Canonical consumers require a valid `AdmissionRecordV1`.
- Formulae promote independently. Failure/drift blocks only the Formula,
  reverse dependants, and affected products.
- Tap source comparison ignores only reviewed generated bottle/current-ABI
  metadata. Other drift requires replanning/rebuild as the contract dictates.
- Tap-main writes use exact compare-and-swap and may touch only generated paths
  named in `FormulaMetadataUpdateV1`.
- Main never presents prior-ABI bottles as successor-current. Unpromoted
  Formulae are explicitly pending/unavailable.
- The old ABI sweep may drain in the background; it does not gate successor
  work. It becomes retired only when every scheduled old-ABI subject is
  terminal.
- Historical repair/security rebuild uses protected `abi/N` and the normal
  uncredentialed/protected pipeline. It is maintenance, not override.
- Pages selection comes only from the Pages registry.
- Pages consumes admitted canonical bottles and exact current-main inputs,
  rebuilds final VFSs with canonical references, and reruns required evidence.
- MVP Pages is atomic. Any missing/failed/timed-out input or site check prevents
  deployment and keeps the last complete site.
- Coordinators record blockers and return; they do not hold sleeping runners.
- Ordinary candidate/source deletion requires no pins and a full 30-day grace
  after unmerged close. Canonical/admission/shared custody is never deleted.
- Immediate purge is protected and exact for malicious/legal/pathologically
  large unendorsed objects; admitted/shared content remains forbidden.
- Legacy removal requires every checked predicate and consumer audit. Deferred
  complete external custody is expected to block broad cleanup.
- Non-Homebrew package archive/staging infrastructure remains out of scope.
- Semantic ABI modeling, complete external custody, and man pages remain
  future work.
- Pin actions, preserve unrelated state, and run local commands through the
  dev shell.

---

## Plain-language data flow

```text
exact request PR is merged
          |
          v
create + externally verify protected abi/N
          |
          v
eligible candidate bottle layer
          |
          +--> canonical OCI manifest around unchanged layer
          |
          +--> narrow tap metadata CAS
          |
          +--> immutable admission record
          |
          v
canonical VFS recomposition + Node/browser evidence
          |
          v
complete Pages readiness record + site manifest
          |
          v
one inert Pages artifact --> separately permissioned deploy
```

## Exact interfaces

### Promotion policy and ABI state

`PromotionPolicyV1` fixes repository identities, `abi/` history prefix,
required protection/readback, canonical repository prefix, independent Formula
promotion, and prohibition of a global completion gate.

Promotion activation is `disabled`, `observe`, or `active`. Observe computes
plans without writing packages or Git refs.

`AbiStateV1` contains current ABI/snapshot plus an optional activation object
binding request, merged PR/commit, prior ABI/branch, and exact history record.
It contains no Formula list, completion percentage, or candidate selector.

### Protected history

`AbiHistoryPlanV1` binds source/successor ABI, exact preactivation commit/tree,
branch `abi/<source-abi>`, metadata digest, and protection requirement digest.
`AbiHistoryRecordV1` binds the created ref object, protection evidence,
metadata verification, public readback, and run.

The workflow verifies the external rule before creating a ref without force.
An existing branch must already point to the exact object. It rechecks public
ref/tree/protection/ABI/Formula/bottle data afterward. Promotion requires the
record locator and revalidates it; a Boolean “ready” is insufficient.

### Promotion and admission

`PromotionDecisionV1` binds exact merged PR, request, Formula subject, tap plan,
candidate/layer/custody, qualifying receipts/overrides, tap-source state, and
eligibility.

`FormulaMetadataUpdateV1` binds Formula/architecture, expected main commit and
normalized metadata, exact allowed paths, canonical manifest/layer, and target
ABI. Per-Formula writes cannot touch another Formula or ABI state.

Promotion order is fixed: validate everything; recheck drift; create canonical
manifest around the existing layer; anonymous readback; build narrow metadata
patch; compare-and-swap commit; reread main/canonical bytes; publish admission.
Canonical bytes without a valid landed metadata write and admission are not
selectable.

The first activation commit changes global ABI state, removes prior-ABI
current selections, and marks every successor subject pending/unavailable.
Independent promotions fill them in later; activation does not wait for the
complete tap.

### Historical maintenance and epoch state

`HistoricalMaintenanceAuthorizationV1` binds protected `abi/N`, exact Formula/
architecture, allowed repair reason, maintainer permission, and policy. The
normal pipeline creates new attempt/candidate/verification/admission records on
that branch.

`AbiEpochStatusV1` derives `active`, `retiring`, or `retired` from every
scheduled subject's terminal outcome plus repair links. It cannot rewrite a
failure as success or delete history.

### Retention

`RetentionAssessmentV1` lists exact target/class, all pins, unreferenced start,
grace completion, eligibility, and reason. Pins cover open work, verification,
products, repair, reuse, admission, canonical layers, and shared custody.

After eligible deletion, protected code confirms anonymous absence and emits a
`DeletionRecordV1`. If tombstone publication fails after deletion, retry
reconstructs it from the immutable original record plus confirmed absence.

### Canonical Pages readiness

`PagesReadinessRecordV1` binds exact current-main source, ABI/snapshot, Pages
registry/products, site metadata, and for each product: load mode, manifest,
admissions, resolved inputs, final VFS/report, runtime evidence, and host
receipts. `ready` is true only with no blockers.

Every envelope has `reference_class = "canonical"`. Bottle entries bind exact
admissions and unchanged layers. Candidate references fail. Final VFS/report/
evidence identities are new and never claim candidate VFS byte reuse.

`PagesSiteManifestV1` lives at
`apps/browser-demos/dist/.well-known/kandelo/pages-deployment.json` and binds
the complete site revision. It has no credential or mutable latest pointer.

| Pages job | Exact permission | Executes source/product code? |
|---|---|---|
| `build-complete-site` | `actions: read`, `contents: read` | Yes, protected main |
| `deploy-complete-site` | `pages: write`, `id-token: write` | No, inert artifact only |

Workflow permissions are `{}`. Any failure before deploy leaves the public
site unchanged.

### Hosted acceptance and retirement

`abi/staging/acceptance/successor-batch.toml` is the only concrete hosted
fixture. Generic commands accept any valid fixture and contain none of its
branch/ABI values.

The first fixture names
`integration/abi43-batch-linear-20260801`. That branch is acceptance data,
not a special case: its name and concrete ABI values may appear only in the
fixture, generated acceptance evidence, and tests that assert generic code has
not copied them.

`HostedAcceptanceEvidenceV1` maps every approved criterion to exact validated
request/record/OCI/Check/workflow/Pages/ref/protection evidence. A URL without
read-only revalidation is not evidence.

`LegacyRetirementAssessmentV1` evaluates each exact repository/path,
consumers, replacement, required/verified evidence, source-retention role,
consumer audit, removal conditions, `removable`, and blockers. No blanket
force exists. Deferred external custody means the expected first assessment
does not permit broad deletion.

## File map

### Tap

- Create ABI state, promotion policy/activation, and history/promotion/
  admission/retention fixtures under `Kandelo/`.
- Create Python modules `abi_history`, `promotion`, `tap_metadata`,
  `historical_maintenance`, and `cleanup`, plus tests.
- Modify records/reconciler/CLI and existing staging workflows/checkers.
- Create ABI-history and candidate-cleanup workflows.

### Kandelo

- Create Rust `pages_readiness.rs` and `retirement.rs`; modify record routing.
- Create Pages activation, sole acceptance fixture, and generated evidence.
- Create Pages readiness/atomic tests and hosted acceptance scripts/tests.
- Create Pages canary; modify production Pages workflow and freshness/
  deployment checks.
- Extend retirement ledger/test.

### Legacy markers and documentation

- Mark audited Kandelo/tap legacy Homebrew workflows/scripts for evidence-based
  retirement without deleting them automatically.
- Update ABI, browser, Homebrew, binary-release, repository, future-work, and
  tap documentation.

---

### Task 1: Define promotion policy, ABI state, and durable records

**Files:** Create tap promotion policy/activation/ABI state/fixtures and
promotion record models/tests; update Kandelo record variants.

**Interfaces:** Produces `PromotionPolicyV1`, `AbiStateV1`,
`AbiHistoryRecordV1`, `PromotionDecisionV1`, `FormulaMetadataUpdateV1`, and
the new maintenance/readiness/retirement record variants.

- [ ] Write failing strict-schema/state/invariant/cross-language fixture tests.
- [ ] Prove activation begins disabled and current behavior is unchanged.
- [ ] Run Rust and tap tests; confirm red.
- [ ] Implement only pure policy/record parsing and canonical fixtures.
- [ ] Rerun tests; expect PASS.
- [ ] Commit matching Kandelo/tap changes separately.

---

### Task 2: Create and verify protected prior-ABI history

**Files:** Create `abi_history.py`, tests, and
`.github/workflows/abi-staging-abi-history.yml`; extend workflow checkers.

**Interfaces:** Produces `AbiHistoryPlanV1`, `AbiHistoryRecordV1`, and protected
history create/verify commands.

- [ ] Write failing cases for missing/wrong protection, wrong ref/object/tree,
  force attempt, mismatched metadata/readback, existing exact idempotence, and
  successor action before history.
- [ ] Write failing workflow permission/mutation tests; workflow may verify
  rules and create exact ref but has no admin or force path.
- [ ] Run unit/workflow tests; confirm red.
- [ ] Implement plan/verification and protected no-force workflow.
- [ ] Rerun tests and actionlint; expect PASS in disabled/observe mode.
- [ ] Commit in the tap.

---

### Task 3: Promote exact bottle layers and publish admissions

**Files:** Create `promotion.py`, tests; extend OCI/records/fixtures.

**Interfaces:** Produces exact `PromotionDecisionV1`, canonical OCI manifest,
anonymous readback, and `AdmissionRecordV1` after metadata landing.

- [ ] Write failing tests for exact merge, history, candidate/custody/receipts,
  unchanged layer, candidate/canonical namespace separation, source drift,
  failed readback, idempotence, and original producer preservation.
- [ ] Run focused tests; confirm red.
- [ ] Implement pure eligibility and protected canonical publication. Do not
  publish admission yet when metadata has not landed.
- [ ] Rerun tests; expect PASS for OCI phase and refusal of premature admission.
- [ ] Commit in the tap.

---

### Task 4: Activate successor metadata and perform narrow Formula CAS writes

**Files:** Create `tap_metadata.py`, tests; finalize promotion/admission fixture
and ABI state.

**Interfaces:** Produces one-time activation and per-Formula
`FormulaMetadataUpdateV1` compare-and-swap operations.

- [ ] Write failing tests for missing history, prior-ABI leakage, unpromoted
  pending state, wrong main/normalized metadata, unexpected paths, concurrent
  change, non-fast-forward, and another Formula/ABI-state mutation.
- [ ] Run tests; confirm red.
- [ ] Implement one activation CAS and independent per-Formula CAS with exact
  allowed path sets and reread verification.
- [ ] Publish admission only after successful metadata reread.
- [ ] Rerun tests; expect PASS.
- [ ] Commit in the tap.

---

### Task 5: Reconcile merge-triggered independent promotion

**Files:** Modify tap reconciler/workflow/CLI and workflow tests.

**Interfaces:** Adds merged-exact-request history barrier, independent eligible
Formula promotion, drift/rebuild decisions, and background continuation.

- [ ] Write failing lifecycle/scheduler tests for exact merge, nonmerge main
  commit, independent success/failure, drift, dependencies, retries,
  background, idempotence, and no global gate.
- [ ] Write failing workflow permission/mutation tests for separated OCI,
  contents CAS, and admission jobs.
- [ ] Run tests; confirm red.
- [ ] Implement observe mode and then active path behind promotion activation.
- [ ] Rerun unit/workflow/actionlint tests; expect PASS.
- [ ] Commit in the tap.

---

### Task 6: Support protected historical repair and epoch retirement

**Files:** Create `historical_maintenance.py`, tests; modify maintenance
workflow/checkers.

**Interfaces:** Produces `HistoricalMaintenanceAuthorizationV1` and
`AbiEpochStatusV1`.

- [ ] Write failing exact branch/ref/subject/reason/maintainer/policy tests and
  prove repair is not override or current-main mutation.
- [ ] Write failing epoch cases for active/retiring/retired with every source
  subject and repairs retained.
- [ ] Run tests; confirm red.
- [ ] Implement normal uncredentialed/protected pipeline targeting only
  protected `abi/N`, plus derived epoch status.
- [ ] Rerun workflow/actionlint/unit tests; expect PASS.
- [ ] Commit in the tap.

---

### Task 7: Enforce retention and deletion tombstones

**Files:** Create `cleanup.py`, tests, retention fixture, and candidate-cleanup
workflow; extend workflow checkers.

**Interfaces:** Produces `RetentionAssessmentV1`, protected exact deletion, and
`DeletionRecordV1`.

- [ ] Write failing pin/grace/shared/admitted/immediate-purge/tombstone tests.
- [ ] Write failing workflow tests for broad glob, unaudited delete,
  candidate-executed deletion, admitted/shared delete, hidden actor/reason, and
  missing anonymous absence check.
- [ ] Run tests; confirm red.
- [ ] Implement pure assessment and protected exact deletion/tombstone retry.
- [ ] Rerun tests/actionlint; expect PASS.
- [ ] Commit in the tap.

---

### Task 8: Recompose canonical products and calculate Pages readiness

**Files:** Create Rust Pages readiness, TypeScript runner/tests, atomic shell
test; extend records and foundation checks.

**Interfaces:** Produces `PagesReadinessRecordV1` and
`PagesSiteManifestV1` from admitted canonical inputs only.

- [ ] Write failing cases for missing/invalid admission, changed layer,
  candidate reference, incomplete product, failed Node/browser evidence,
  missing Pages product/site metadata, and registry/product mismatch.
- [ ] Write a failing canonical recomposition test proving new VFS identity,
  canonical lazy references, unchanged bottle layers, and complete report.
- [ ] Run Rust/TypeScript/shell tests; confirm red.
- [ ] Implement canonical resolution, builder execution, evidence rerun, and
  one complete site manifest/readiness record.
- [ ] Rerun tests; expect PASS only for the complete site.
- [ ] Commit.

---

### Task 9: Prove a native atomic Pages workflow in canary mode

**Files:** Create `.github/workflows/abi-staging-pages-canary.yml`; extend Pages
deployment/freshness scripts and tests.

**Interfaces:** Produces one inert complete-site artifact and a separate
no-source deploy job in canary mode.

- [ ] Write failing structural/mutation tests for workflow-level `{}`,
  build/deploy permission split, protected main source, exact artifact,
  readiness/site manifest, size/freshness checks, action pins, and rejection of
  partial upload/deploy-side source execution.
- [ ] Write a failing test where one product dependency is absent and verify no
  upload/deploy occurs while prior deployment identity remains.
- [ ] Run Pages contract/freshness/actionlint tests; confirm red.
- [ ] Implement canary workflow without production deployment.
- [ ] Rerun tests; expect PASS for complete site and deliberate hold for
  incomplete site.
- [ ] Commit.

---

### Task 10: Switch production Pages to atomic admitted products

**Files:** Modify `.github/workflows/browser-demos-pages.yml`, Pages deployment
and freshness tests, and `abi/staging/pages-activation.toml`.

**Interfaces:** Replaces legacy production assembly only after canary evidence;
deploy job receives one inert validated site artifact.

- [ ] Write failing production mutations for candidate reference, missing
  admission/product/evidence/site manifest, partial artifact, skipped newest-
  run check, source execution in deploy, and wrong permissions.
- [ ] Run existing/new Pages tests; confirm red before the switch.
- [ ] Reuse the canary build-complete-site path exactly; activate `legacy →
  canonical` only after canary/failure evidence is retained.
- [ ] Run Pages, browser asset, product evidence, docs, and actionlint suites;
  expect PASS.
- [ ] Run a deliberate hosted readiness failure and verify the previous public
  deployment remains live.
- [ ] Commit the narrow production activation.

---

### Task 11: Add generic hosted acceptance orchestration and one fixture

**Files:** Create the generic Python hosted-acceptance script/test, the sole
`successor-batch.toml` concrete fixture, and generated evidence target.

**Interfaces:** Produces `HostedAcceptanceEvidenceV1` by validating public
records/OCI/Check/workflow/Pages/ref/protection facts for all 21 criteria.

- [ ] Write failing parser tests for exact schema, full SHA/tree, source/
  successor relationship, criterion IDs, no duplicate/missing criterion, and
  concrete values outside the fixture.
- [ ] Write failing fake-client tests for each criterion, URL-only evidence,
  digest mismatch, wrong head, wrong protection, candidate/canonical layer
  mismatch, and stale Pages deployment.
- [ ] Run tests; confirm red.
- [ ] Implement generic read-only orchestration with injected GitHub/OCI/Pages
  clients and canonical evidence output.
- [ ] Rerun tests; expect PASS with no network for unit fixtures.
- [ ] Commit the fixture and generic tooling without claiming hosted success.

---

### Task 12: Execute the real generic successor transition

**Files:** Generate/update only
`abi/staging/acceptance/evidence.generated.json` after successful public
revalidation.

**Interfaces:** Consumes the sole concrete fixture and all protected hosted
systems; produces retained evidence for every supported acceptance criterion.

- [ ] Verify the exact fixture branch/head/tree exists publicly. The currently
  observed branch is local-only; if still absent, report the gate and stop.
- [ ] Verify `abi/*` external protection and all Release/Check/GHCR/Pages token
  permissions without granting broader workflow authority.
- [ ] Issue/reconcile the exact-head request; retain asset and decisions.
- [ ] Prove uncredentialed builds, custody, public candidates/readback, reuse,
  changed-input rebuilds, capture failure/override, separate verification,
  required product Node/browser evidence, and required-only Check behavior.
- [ ] Merge only after enforced current-head Check success.
- [ ] Create/verify prior `abi/N`, activate successor metadata, independently
  promote eligible Formulae, and prove unchanged bottle layers/no stale
  prior-ABI current metadata.
- [ ] Prove protected historical repair and post-merge background progress.
- [ ] Recompose all Pages products and deploy one complete site.
- [ ] Deliberately fail one readiness input and prove last complete site remains.
- [ ] Prove close/reopen/new-head history and allowed/forbidden overrides.
- [ ] Run the acceptance validator anonymously/read-only and generate evidence.
- [ ] Commit only fully validated evidence; otherwise retain no false success.

---

### Task 13: Audit retirement and mark only proven entries removable

**Files:** Create `retirement.rs`, retirement script/test; modify ledger and
legacy files only to add deprecation/evidence markers. Update tap legacy
markers/tests similarly.

**Interfaces:** Produces `LegacyRetirementAssessmentV1`; it does not delete.

- [ ] Write failing tests that require exact consumers/replacement/evidence/
  custody/audit/removal predicates for every ledger entry and reject blanket
  success.
- [ ] Run current consumer searches and focused legacy workflow tests in both
  repositories.
- [ ] Implement pure assessment from retained acceptance evidence and current
  repository consumers.
- [ ] Add truthful deprecation markers only where replacement exists; do not
  disable supported paths.
- [ ] Prove deferred external custody keeps every source-retention-dependent
  entry nonremovable.
- [ ] Rerun retirement and legacy tests; expect a mixed/blocked exact result,
  not broad cleanup.
- [ ] Commit audit/markers.

---

### Task 14: Remove only individually proven legacy entries

**Files:** Delete only exact paths emitted as `removable = true`; update ledger
and affected focused validation/docs after each logical component.

**Interfaces:** Produces small per-component cleanup commits or a no-deletion
report when nothing qualifies.

- [ ] Generate the exact assessment to a task-specific `mktemp -d` path.
- [ ] If the exact removable set is empty, report named blockers and make no
  deletion commit.
- [ ] Before each qualifying removal, rerun consumer/custody/evidence checks,
  compare the exact path with the ledger, and reject directories/globs/shared
  non-Homebrew components.
- [ ] Remove one logical component with a reviewable version-control edit,
  rerun its focused and full retirement tests, and update the ledger.
- [ ] Commit each proven component separately. Never use a broad recursive
  deletion or blanket `--force`.

---

### Task 15: Document operational behavior and remaining limits

**Files:** Update Kandelo/tap ABI, browser, Homebrew, binary release,
repository, future-work, and README documentation.

**Interfaces:** Produces documentation that matches actual hosted activation,
retained evidence, and remaining legacy paths.

- [ ] Write failing documentation assertions for exact active stages,
  candidate nonendorsement, history/repair, background convergence, atomic
  Pages, retention, and the three deferred areas.
- [ ] Run docs assertions; confirm red.
- [ ] Update plain-language operational docs without claiming more than hosted
  evidence supports. Name any remaining legacy path and why it remains.
- [ ] Build docs and run doc tests; expect PASS.
- [ ] Commit docs separately in each repository.

---

### Task 16: Run the final whole-roadmap evidence audit

**Files:** Verify all five plans in both repositories; create no new behavior.

**Interfaces:** Produces fresh evidence for exactly the supported system and
its remaining hosted/retirement gates.

- [ ] Run all Kandelo foundation/request/build/product/Check/promotion/Pages/
  retirement/acceptance tests, browser evidence, ABI checks, workflow trust,
  actionlint, and docs build through `scripts/dev-shell.sh`.
- [ ] Run all tap Python, workflow mutation, actionlint, selection, build,
  maintenance, history, cleanup, and legacy tests through the same environment.
- [ ] Run the local miniature and cross-repository fixtures twice from clean
  temporary state.
- [ ] Revalidate every hosted acceptance link/digest anonymously/read-only;
  report absent evidence as a hard hosted gate.
- [ ] Audit exact layer reuse, admission, source/canonical namespaces, `abi/N`
  protection, tap metadata CAS, historical repair, background progress, and
  last-complete Pages.
- [ ] Audit all job capabilities and prove candidate/product/evidence execution
  lacks writes while protected writers execute only protected code.
- [ ] Search generic infrastructure for concrete acceptance values, synthetic
  staging merges, candidate references in canonical products, stale prior-ABI
  current metadata, sleeps, mutable latest state, unfinished tokens, and
  unauthorized deletion.
- [ ] Compare both commit histories/file scopes with the plan and report what
  was and was not activated or removed.

## Exit criteria

- Only exact merged requests trigger promotion.
- Protected verified `abi/N` exists at the exact preactivation tap state before
  any successor canonical/current-ABI change.
- Canonical manifests reuse exact candidate bottle layers, pass anonymous
  readback, and receive admission only after narrow metadata CAS.
- Tap main never serves prior-ABI bottles as successor current; unpromoted
  Formulae are explicit pending/unavailable subjects.
- Formulae and background work progress independently; protected history
  supports controlled repair/security rebuild.
- Retention honors pins, 30-day grace, immediate-purge boundaries, and
  immutable tombstones.
- Every Pages product is rebuilt from canonical admissions, retested, and
  included in one complete site manifest.
- Pages deploys one inert complete artifact and retains the old deployment on
  failure.
- The approved public successor fixture proves every supported criterion or
  reports exact external gates without substitution.
- Legacy removal is per proven ledger entry. Deferred external custody remains
  visible and is expected to prevent broad cleanup.
- Documentation matches actual operational evidence and retains explicit
  future work.

This completes the approved roadmap. It does not add semantic ABI proof,
complete external-source custody, man pages, arbitrary third-party tap
orchestration, or per-product Pages rollout.
