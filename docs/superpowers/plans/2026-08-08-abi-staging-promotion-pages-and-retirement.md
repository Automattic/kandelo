# ABI Staging Promotion, Pages, and Retirement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admit merged exact-request candidates into ABI-qualified canonical
namespaces without changing bottle-layer bytes, preserve protected prior-ABI
tap history before activation, continue independent background convergence,
recompose and test canonical VFS products, publish one complete Pages site or
retain the last complete site, execute the approved real successor transition,
and assess exactly which legacy components have proven retirement evidence.
Production Pages deployment and legacy deletion remain unapplied during the
2026-08-09 autonomous execution.

**Architecture:** A protected tap reconciler treats GitHub's merged
pull-request fact as the trigger. Before the first successor promotion, a
separate protected history workflow creates `abi/N` at the exact preactivation
tap state and verifies both the ref and externally configured protection.
Eligible Formulae promote independently: protected OCI code creates a
canonical manifest around the unchanged candidate bottle layer and proves
anonymous readback; a distinct contents-only writer performs a compare-and-swap
generated metadata update; another protected publisher emits the immutable
admission. Kandelo Pages reads only admissions, recomposes product VFS images
with canonical references, reruns required Node/browser evidence, assembles one
site tree, and hands only that inert tree to the Pages deployer. Retention and
retirement are evidence-driven maintenance paths, never side effects of
success labels.

**Tech Stack:** Tap Python staging modules and OCI transport from Plans 2–4,
GitHub REST/`gh` for exact PR/ref/protection and compare-and-swap writes, Git
for protected ABI branches, existing TypeScript product builders for canonical
recomposition, Node/Vitest and Playwright for final evidence, native GitHub
Pages artifact/deployment actions with full-SHA pins, Rust `xtask` for strict
readiness/retirement records, Python hosted-acceptance orchestration, Ruby
workflow mutation tests, and all local commands through
`scripts/dev-shell.sh`.

## Global Constraints

- Consume Plans 1–4 exactly. Do not turn a Check, status summary, workflow run,
  tag, timestamp, or mutable branch into candidate/admission authority.
- Generic code derives source ABI `N`, successor `N + 1`, namespaces, and
  protected history branch from validated state. The named successor branch
  and its concrete ABI values appear only in
  `abi/staging/acceptance/successor-batch.toml`.
- Promotion begins only after GitHub reports the exact pull request associated
  with the request as merged. Kandelo main commit scanning or ancestry guesses
  are not substitutes.
- Before any `N + 1` canonical manifest, tap-main current-ABI mutation, or
  successor Formula metadata update, `abi/N` must exist at the exact
  preactivation tap commit, be covered by verified protection, and pass
  historical metadata/readback checks.
- Protection is an external repository rule. Workflow code verifies it but has
  no administration permission and never silently creates an unprotected
  branch.
- Promotion reuses the exact candidate bottle-layer digest and byte count.
  Candidate and canonical OCI manifest digests may differ; bottle bytes may
  not. Original producer/request/run remains producer provenance, while merge
  commit is admission provenance.
- Candidate and canonical repositories remain visibly distinct. Canonical
  consumers require an `AdmissionRecordV1`; a canonical object without a valid
  admission is not selectable.
- Each Formula promotes independently after dependencies qualify. A failed or
  drifting Formula blocks only itself, its reverse dependants, and affected
  products. There is no complete-core-set or tap-wide transaction.
- Tap source comparison excludes only reviewed generated bottle/current-ABI
  metadata. Any Formula recipe/support/source change produces
  `tap_source_drift`, replanning, and rebuild when its complete contract changes.
- Tap-main metadata writes are compare-and-swap against exact normalized source
  and expected current ref. They touch only the generated bottle/current-ABI
  paths named in `FormulaMetadataUpdateV1`; any unexpected path or non-fast-
  forward state fails.
- On ABI activation, main never serves prior-ABI bottle metadata as current.
  Unpromoted successor Formulae are explicitly pending/unavailable, not mapped
  to an `N` bottle. Formula names and platform tags remain ABI-neutral.
- The already scheduled source-ABI sweep may drain after successor activation.
  Retiring becomes retired only when every scheduled source-ABI subject is
  terminal; this does not gate successor work.
- Historical repair/security rebuilds use protected `abi/N` source/metadata and
  the same uncredentialed build/protected publisher separation. They are
  maintenance actions, not overrides.
- Pages product selection comes only from the Pages-owned registry. A product
  cannot place itself in the site, and test registries cannot silently add a
  Pages product.
- Pages consumes only admitted canonical bottle layers and exact current-main
  product/runtime inputs. Candidate VFS bytes are never relabeled. Final VFSs
  are recomposed with canonical references and required evidence reruns.
- MVP Pages deployment is atomic. Missing/failed/timed-out dependency,
  promotion, product build, evidence, gallery metadata, or site validation
  prevents upload/deploy and leaves the last complete deployment live.
- No coordinator waits on a runner for readiness; it records blockers and
  returns for later reconciliation.
- Candidate/source deletion follows explicit pin analysis and a 30-day
  unreferenced grace after unmerged close. Canonical/admission-pinned layers and
  shared custody are never deleted. A deletion receives an immutable tombstone.
- A malicious/legal/pathologically large unendorsed object may use the
  protected immediate-purge path with exact target/reason/actor; shared or
  admitted content remains forbidden.
- Legacy deletion is not automatic after one successful transition. Every
  checked-in retirement predicate must have immutable evidence and a consumer
  audit. Complete external-source custody is explicitly deferred, so any
  legacy component that still carries retained-source responsibility remains
  nonremovable in this plan unless that separate future work has actually
  landed and is evidenced.
- Non-Homebrew package archive/staging infrastructure remains out of scope even
  if an old Homebrew workflow shared it.
- Semantic ABI modeling, complete external-source custody, and man pages remain
  future work; do not claim or implement them as hidden cleanup prerequisites.
- During the 2026-08-09 autonomous execution, do not deploy production Pages,
  delete or purge artifacts, or delete legacy infrastructure. Implement and
  test inactive or observe-mode machinery and produce readiness or retirement
  assessments, but leave those external mutations unapplied.
- All action references are full 40-character SHA pins. Preserve unrelated
  dirty state and run local build/validation commands through
  `scripts/dev-shell.sh`.

---

## Interfaces

### Promotion and ABI epoch policy

Tap `Kandelo/staging/promotion-policy.toml` is `PromotionPolicyV1`:

```toml
schema = 1
kind = "kandelo-abi-staging-promotion-policy"
version = 1
tap_repository = "kandelo-dev/homebrew-tap-core"
kandelo_repository = "Automattic/kandelo"
historical_branch_prefix = "abi/"
require_branch_protection = true
canonical_repository_prefix = "homebrew-tap-core-abi-"
require_anonymous_readback = true
allow_independent_formula_promotion = true
allow_global_completion_gate = false
```

`Kandelo/staging/promotion-activation.toml` begins:

```toml
schema = 1
kind = "kandelo-abi-staging-promotion-activation"
mode = "disabled"
```

Allowed modes are `disabled`, `observe`, and `active`. Observe computes exact
history/promotion plans but writes neither canonical packages nor Git refs.

`Kandelo/abi-state.json` is `AbiStateV1` and is introduced without changing
the active ABI until activation:

```text
schema
kind = kandelo-homebrew-abi-state
current_abi
current_snapshot_sha256
activation = {
  request_digest,
  merged_pull_request,
  merge_commit,
  prior_abi,
  prior_branch,
  abi_history_record_digest
}
```

The activation object is nullable before the first managed transition.
`AbiStateV1` is global ABI selection only; it contains no Formula list,
completion percentage, or candidate selector.

### Protected ABI history

```python
@dataclass(frozen=True)
class AbiHistoryPlanV1:
    source_abi: int
    successor_abi: int
    preactivation_tap_commit: str
    preactivation_tap_tree: str
    branch: str
    expected_current_metadata_sha256: str
    protection_requirement_sha256: str

@dataclass(frozen=True)
class AbiHistoryRecordV1:
    schema: int
    kind: Literal["kandelo-abi-history-record"]
    plan: AbiHistoryPlanV1
    created_ref_object: str
    protection_evidence: Mapping[str, object]
    metadata_verification_sha256: str
    public_readback_sha256: str
    run: Mapping[str, object]
```

The branch is exactly `abi/<source-abi>`. The protected workflow first queries
rules/ref protection and fails if the intended branch is not covered. It then
creates the ref at the exact preactivation commit with no force. If the branch
already exists, its object must match exactly. After creation it re-queries the
public ref/tree, protection, ABI metadata, Formula bottle metadata, and public
bottles before publishing the history record.

No successor promotion/activation function accepts a Boolean “history ready.”
It requires the exact valid `AbiHistoryRecordV1` locator and independently
rechecks branch/ref/protection.

### Formula promotion and admission

```python
@dataclass(frozen=True)
class PromotionDecisionV1:
    request_digest: str
    merged_pull_request: Mapping[str, object]
    formula_subject: str
    tap_plan_digest: str
    candidate_record_digest: str
    candidate_binding_digest: str
    bottle_layer_sha256: str
    bottle_layer_bytes: int
    source_custody_digest: str
    qualifying_receipts: tuple[str, ...]
    override_receipts: tuple[str, ...]
    tap_source_state: Literal["exact", "drift", "rebuild-required"]
    eligibility: Literal["eligible", "ineligible", "rebuild-required"]

@dataclass(frozen=True)
class FormulaMetadataUpdateV1:
    formula: str
    architecture: str
    expected_main_commit: str
    expected_normalized_formula_sha256: str
    expected_generated_metadata_sha256: str
    allowed_paths: tuple[str, ...]
    link_manifest_path: str
    link_manifest_sha256: str
    canonical_manifest_digest: str
    bottle_layer_sha256: str
    bottle_layer_bytes: int
    target_abi: int

@dataclass(frozen=True)
class AdmissionPayloadV1:
    abi_history_record_sha256: str
    candidate_binding_sha256: str
    candidate_record_sha256: str
    promoted_layer: Mapping[str, object]
    qualifying_receipt_sha256s: tuple[str, ...]
    merged_pull_request: Mapping[str, object]
    preactivation_tap_source: Mapping[str, str]
    tap_source: Mapping[str, str]
    canonical: Mapping[str, object]
    canonical_public_readback_sha256: str
    formula_metadata_source: Mapping[str, str]
    formula_metadata_update: FormulaMetadataUpdateV1
    original_producer: Mapping[str, object]
```

`FormulaMetadataUpdateV1.allowed_paths` is exactly the Formula file, its one
sidecar, the top-level metadata index, and the one versioned link manifest
named by `link_manifest_path`. The separate one-time activation patch may also
touch ABI state. Per-Formula promotion cannot touch ABI state or another
Formula.

Repository discovery found one concrete contradiction with the original
three-path wording: the existing Homebrew VFS planner consumes
`Kandelo/link/<formula>-<pkg-version>-rebuild<rebuild>-<arch>.json`, and each
sidecar names that file. Promotion therefore writes that deterministic fourth
path. Protected code derives it only from the authenticated bottle archive and
the exact captured `homebrew/kandelo-guest-layout.json`; candidate metadata
does not own its file inventory, prefix, cellar, or links.
`link_manifest_sha256` is the digest of the exact sorted, indented JSON file
bytes (including its trailing line feed), matching the existing Homebrew
provenance contract rather than a second logical-object digest.

Implementation of merge-triggered promotion found a second concrete interface
contradiction. Plan 3 already permits a later exact request to reuse an earlier
candidate when the complete bottle contract is unchanged, but the original
`PromotionDecisionV1` had no field that could bind the required immutable
candidate-reuse record. It also implicitly treated the original producer as the
new merged head, which would make valid historical reuse unpromotable.
`candidate_binding_digest` closes that gap: for a candidate built by the current
request it equals `candidate_record_digest`; for cross-request reuse it is the
exact candidate-reuse record digest. `AdmissionRecordV1` carries the same value
as `candidate_binding_sha256`, records the current merged head as admission
provenance, and preserves the original candidate producer/source as the facts
that actually built the bottle. Protected planning and every separated writer
re-fetch and validate that binding. This is an interface correction for the
already approved reuse semantics, not a new reuse policy.

The three tap sources in `AdmissionPayloadV1` have distinct authority. The
`preactivation_tap_source` is epoch source A, pinned by
`abi_history_record_sha256`. `tap_source` is Formula compare-and-swap base B.
`formula_metadata_source` is the single-parent landed Formula commit C. The
admission validator requires A and B to differ, B and C to differ, all three to
name the protected tap, the Formula update to expect B, and the landed commit to
contain exactly the four authorized paths and bytes. One field cannot stand for
both the immutable preactivation epoch and mutable current-main Formula state.

Canonical publications may proceed independently, but Formula metadata commits
are serialized to one compare-and-swap owner per reconciliation wave. This is
required because every Formula patch is based on one exact current-main commit;
parallel commits would race the same base. A later wave replans the remaining
Formulae against the newly landed main. Every canonical, metadata, and admission
writer independently re-fetches the exact history record, `abi/N` ref/tree, and
fresh protection snapshot immediately before its mutation.

If metadata commit C lands but admission publication fails, the next protected
planner finds the unique first-parent commit that changed the exact four paths
and produced the authenticated link-manifest digest. It reconstructs the
original B-to-C patch from Git objects, validates C as an ancestor of current
main, revalidates the current four-path projection, and schedules admission
without rewriting metadata. An admission counts as durable progress only while
current main still retains that exact Formula/layer/link projection.

These fields correct the unpublished schema-1 admission interface while
promotion activation remains disabled. No production admission record using
the earlier incomplete shape may exist when this task is enabled; the protected
fixture and both Python and Rust readers enforce the final shape before rollout.

The promotion sequence is:

1. validate merged PR/request/candidate/custody/receipts/history/current policy;
2. re-evaluate exact current tap source and replan on drift;
3. create canonical OCI manifest around the exact existing bottle layer;
4. prove canonical manifest/layer anonymous readback;
5. create and validate the narrow metadata patch;
6. compare-and-swap commit/push the exact generated paths;
7. re-read tap main and canonical bytes;
8. publish `AdmissionRecordV1` binding all prior facts and metadata commit.

Canonical package bytes without step 8 remain unadmitted and cannot be
selected. A failed metadata CAS leaves an unselected canonical object that a
later idempotent reconciliation may reuse after revalidation; it never writes
an admission for a metadata update that did not land.

At initial successor activation, one protected generated commit first updates
`AbiStateV1`, removes prior-ABI bottle blocks/default sidecar selections from
tap main, and represents every successor subject as pending/unavailable. The
commit requires valid history evidence. Independent Formula promotions then
add successor bottle metadata. The activation commit does not wait for the
complete tap.

### Historical maintenance and epoch retirement

`HistoricalMaintenanceAuthorizationV1` binds protected `abi/N` ref/commit,
Formula/architecture, reason `failed-package-repair` or `security-rebuild`,
maintainer identity/permission, and policy digest. It is not an override and
does not accept candidate identity up front. The normal Plan 3 pipeline creates
new attempt/candidate/verification/admission records under ABI `N`, and the
metadata CAS targets only protected `abi/N`.

`AbiEpochStatusV1` is a derived record with `abi`, `scheduled_subjects`, terminal
outcomes, `state = active | retiring | retired`, and repair links. It cannot
delete history or make a failed Formula look successful.

### Candidate/source retention

```python
@dataclass(frozen=True)
class RetentionAssessmentV1:
    target_digest: str
    artifact_class: Literal["candidate", "source"]
    pins: tuple[Mapping[str, object], ...]
    unreferenced_since: str | None
    grace_complete: bool
    deletion_eligible: bool
    reason: str
```

Pins include open request, active promotion/verification/product/repair,
candidate reuse, admission, canonical layer, and shared-custody references.
Historical requests/attempts may retain compact identity without pinning large
bytes; pin fields are explicit. Ordinary cleanup deletes only after closed
unmerged lifecycle, no pins, and a full 30-day grace. It verifies deletion by
anonymous absence, then publishes `DeletionRecordV1`. If deletion succeeds but
record publication fails, a retry reconstructs the exact tombstone from the
candidate/source record and confirmed absence.

### Canonical product and Pages readiness

Kandelo `PagesReadinessRecordV1` is canonical JSON:

```text
schema
kind = kandelo-pages-readiness
source = { repository, commit, tree }
target_abi = { version, snapshot_sha256 }
pages_registry = { path, sha256, products }
site_metadata_sha256
products = [{
  id,
  load,
  manifest_sha256,
  admissions,
  resolved_inputs_sha256,
  vfs_sha256,
  vfs_bytes,
  builder_report_sha256,
  runtime_evidence_sha256,
  node_receipts,
  browser_receipts
}]
blockers
ready
```

Every product uses `ResolvedVfsProductInputsV1.reference_class = "canonical"`.
Homebrew bottle entries bind exact admissions and unchanged bottle layers.
Lazy references use canonical repositories; candidate references fail. Final
VFS/report/evidence bytes are new factual identities and never claim reuse of
candidate VFS bytes.

`PagesSiteManifestV1` is included at
`apps/browser-demos/dist/.well-known/kandelo/pages-deployment.json`. It binds
exact current-main source, ABI, Pages registry/site metadata, complete product
set, final VFS/report/evidence identities, documentation/API build identities,
and readiness-record digest. It contains no credential, mutable latest pointer,
or deployment-time authority.

The production workflow has separate jobs:

| Job | Permission | Executes source/product code |
|---|---|---|
| `build-complete-site` | `actions: read`, `contents: read` | Yes, exact protected main |
| `deploy-complete-site` | `pages: write`, `id-token: write` | No; deploys one inert Pages artifact |

Workflow-level permissions are `{}`. The deploy job receives only the named
Pages artifact after all readiness, product evidence, site tests, size checks,
and newest-run checks succeed. Failure before deploy leaves the prior GitHub
Pages deployment untouched.

### Hosted acceptance and retirement evidence

`abi/staging/acceptance/successor-batch.toml` is the sole concrete hosted
fixture. It records schema/kind, exact public repository, exact PR number, exact
full head SHA/tree, fixture branch
`integration/abi43-batch-linear-20260801`, source/target ABI values, and expected
acceptance criterion IDs. Generic commands accept any validated fixture and do
not contain these values.

`HostedAcceptanceEvidenceV1` binds each approved acceptance criterion ID to
exact request/record/OCI/Check/workflow/Pages/ref/protection URLs and digests.
Evidence is generated only after anonymous/read-only revalidation; a URL alone
is insufficient.

`LegacyRetirementAssessmentV1` evaluates each Plan 1 ledger entry:

```text
legacy path + repository
current consumers
replacement component
required evidence IDs
verified evidence locators/digests
source-retention role
consumer audit result
removal conditions
removable
blockers
```

No cleanup command accepts a blanket `--force`. It may remove only entries
whose assessment says `removable = true`, and its explicit path set must equal
those entries. Because complete external-source custody is deferred, the
expected first acceptance assessment leaves source-retention-dependent legacy
entries nonremovable and performs no broad deletion.

## File Map

### Tap promotion, history, retention, and maintenance

- Create: `Kandelo/abi-state.json`
- Create: `Kandelo/staging/promotion-policy.toml`
- Create: `Kandelo/staging/promotion-activation.toml`
- Create: `Kandelo/staging/fixtures/abi-history-record.json`
- Create: `Kandelo/staging/fixtures/promotion-decision.json`
- Create: `Kandelo/staging/fixtures/admission-record.json`
- Create: `Kandelo/staging/fixtures/retention-assessment.json`
- Modify: `scripts/abi_staging/records.py`
- Modify: `scripts/abi_staging/reconcile.py`
- Modify: `scripts/abi_staging/cli.py`
- Create: `scripts/abi_staging/abi_history.py`
- Create: `scripts/abi_staging/promotion.py`
- Create: `scripts/abi_staging/tap_metadata.py`
- Create: `scripts/abi_staging/historical_maintenance.py`
- Create: `scripts/abi_staging/cleanup.py`
- Create: `scripts/abi_staging/tests/test_abi_history.py`
- Create: `scripts/abi_staging/tests/test_promotion.py`
- Create: `scripts/abi_staging/tests/test_tap_metadata.py`
- Create: `scripts/abi_staging/tests/test_historical_maintenance.py`
- Create: `scripts/abi_staging/tests/test_cleanup.py`
- Create: `.github/workflows/abi-staging-abi-history.yml`
- Modify: `.github/workflows/abi-staging-reconcile.yml`
- Modify: `.github/workflows/abi-staging-maintenance.yml`
- Create: `.github/workflows/abi-staging-candidate-cleanup.yml`
- Modify: `scripts/check_abi_staging_workflows.rb`
- Modify: `scripts/test_check_abi_staging_workflows.rb`

### Kandelo canonical product, Pages, acceptance, and retirement

- Modify: `tools/xtask/src/abi_staging/mod.rs`
- Modify: `tools/xtask/src/abi_staging/records.rs`
- Create: `tools/xtask/src/abi_staging/pages_readiness.rs`
- Create: `tools/xtask/src/abi_staging/retirement.rs`
- Create: `abi/staging/pages-activation.toml`
- Create: `abi/staging/acceptance/successor-batch.toml`
- Create: `abi/staging/acceptance/evidence.generated.json`
- Create: `scripts/abi-staging-pages-readiness.ts`
- Create: `scripts/abi-staging-pages-readiness.test.ts`
- Create: `scripts/test-abi-staging-pages-atomic.sh`
- Create: `scripts/abi-staging-hosted-acceptance.py`
- Create: `scripts/test-abi-staging-hosted-acceptance.py`
- Create: `.github/workflows/abi-staging-pages-canary.yml`
- Modify: `.github/workflows/browser-demos-pages.yml`
- Modify: `scripts/ci-check-pages-deployment.sh`
- Modify: `scripts/test-pages-deployment-contract.sh`
- Modify: `scripts/check-pages-run-freshness.sh`
- Modify: `scripts/test-pages-run-freshness.sh`
- Modify: `abi/staging/legacy-retirement.toml`
- Create: `scripts/test-abi-staging-retirement.sh`

### Legacy deprecation markers; no unconditional removal

- Modify: `.github/workflows/reusable-homebrew-bottle-publish.yml`
- Modify: `.github/workflows/reusable-homebrew-bottle-maintenance.yml`
- Modify: `.github/workflows/reusable-homebrew-closed-selection-publish.yml`
- Modify: `.github/workflows/homebrew-main-shell-ci.yml`
- Modify: `.github/workflows/homebrew-experimental-vfs-publish.yml`
- Modify: `.github/workflows/reusable-homebrew-main-shell-mirror-publish.yml`
- Modify: `.github/workflows/homebrew-native-publisher-compatibility.yml`
- Modify: `scripts/deploy-gh-pages.sh`
- Modify: `scripts/abi42-rollout.py` in the tap repository
- Modify: `.github/workflows/selection-checks.yml` in the tap repository
- Modify: `.github/workflows/dry-run-bottles.yml` in the tap repository
- Modify: `.github/workflows/maintain-bottles.yml` in the tap repository
- Modify: `.github/workflows/publish-bottles.yml` in the tap repository
- Modify: `.github/workflows/publish-main-shell-mirror.yml` in the tap repository

### Documentation

- Modify: `docs/abi-versioning.md`
- Modify: `docs/browser-support.md`
- Modify: `docs/homebrew-publishing.md`
- Modify: `docs/binary-releases.md`
- Modify: `docs/repository-organization.md`
- Modify: `docs/future-improvements.md`
- Modify: `Kandelo/README.md` in the tap repository
- Modify: `README.md` in the tap repository

---

### Task 1: Define promotion policy, ABI state, and new durable records

**Repositories:** Kandelo and tap

**Files:**

- Create: `Kandelo/abi-state.json` in the tap
- Create: `Kandelo/staging/promotion-policy.toml` in the tap
- Create: `Kandelo/staging/promotion-activation.toml` in the tap
- Create: `scripts/abi_staging/tap_metadata.py` in the tap
- Create: `scripts/abi_staging/tests/test_tap_metadata.py` in the tap
- Modify: `scripts/abi_staging/records.py` in the tap
- Modify: `tools/xtask/src/abi_staging/records.rs` in Kandelo
- Modify: `tools/xtask/src/abi_staging/mod.rs` in Kandelo

**Interfaces:**

- Consumes: Plans 1–4 records/guards, exact current tap metadata/Formula blocks,
  and policy shapes above.
- Produces: `PromotionPolicyV1`, `AbiStateV1`, `AbiHistoryRecordV1`,
  `HistoricalMaintenanceAuthorizationV1`, `AbiEpochStatusV1`, and strict
  cross-language record vectors. Promotion begins disabled.

- [ ] **Step 1: Write failing policy/ABI-state tests**

  Reject ABI suffix in Formula/platform name, unqualified successor canonical
  namespace, global Formula completion gate, optional branch protection,
  unknown field, target not source-plus-one, current state inconsistent with
  metadata, and activation without exact history/request/merge identities.

- [ ] **Step 2: Write failing record-invariant tests**

  Cover history ref/tree mismatch, unprotected branch, admission layer drift,
  canonical readback mismatch, producer rewritten to merge commit, Formula
  metadata update absent/wrong, historical maintenance mislabeled override,
  epoch retired with nonterminal scheduled subjects, and unknown record kind.

- [ ] **Step 3: Freeze current metadata projections**

  Parse exact current `Formula/*.rb`, `Kandelo/formula/*.json`, and
  `Kandelo/metadata.json` into a generated in-memory projection. Assert
  `AbiStateV1.current_abi` matches without changing current behavior. Reject a
  Formula/sidecar silently serving a different ABI.

- [ ] **Step 4: Run Rust/Python tests and verify red**

  ```bash
  scripts/dev-shell.sh bash -c '
    host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
    cargo test -p xtask --target "$host_target" abi_staging::records
  '
  scripts/dev-shell.sh env PYTHONPATH="$KANDELO_TAP_ROOT" \
    python3 -m unittest \
      scripts.abi_staging.tests.test_tap_metadata \
      scripts.abi_staging.tests.test_records -v
  ```

  Expected: FAIL because policy/state/records are absent.

- [ ] **Step 5: Implement strict models without activation**

  Check in current observed ABI/snapshot state and a null managed activation.
  Parse/validate generated Formula bottle blocks separately from normalized
  recipe source. Do not rewrite any Formula or sidecar in this task.

- [ ] **Step 6: Run model/freshness tests**

  ```bash
  scripts/dev-shell.sh env PYTHONPATH="$KANDELO_TAP_ROOT" \
    python3 -m scripts.abi_staging.cli tap-metadata-check \
      --tap-root "$KANDELO_TAP_ROOT"
  scripts/dev-shell.sh env PYTHONPATH="$KANDELO_TAP_ROOT" \
    python3 -m unittest \
      scripts.abi_staging.tests.test_tap_metadata \
      scripts.abi_staging.tests.test_records -v
  scripts/dev-shell.sh bash -c '
    host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
    cargo test -p xtask --target "$host_target" abi_staging::records
  '
  ```

  Expected: PASS; promotion remains disabled.

- [ ] **Step 7: Commit each repository**

  ```bash
  git add tools/xtask/src/abi_staging/records.rs \
    tools/xtask/src/abi_staging/mod.rs
  git commit -m "[ABI] Define history and admission records"
  git -C "$KANDELO_TAP_ROOT" add Kandelo/abi-state.json \
    Kandelo/staging/promotion-policy.toml \
    Kandelo/staging/promotion-activation.toml \
    scripts/abi_staging/tap_metadata.py \
    scripts/abi_staging/records.py \
    scripts/abi_staging/tests/test_tap_metadata.py
  git -C "$KANDELO_TAP_ROOT" commit -m \
    "[ABI] Model protected tap ABI state"
  ```

---

### Task 2: Create and verify protected prior-ABI history

**Repository:** `kandelo-dev/homebrew-tap-core`

**Files:**

- Create: `scripts/abi_staging/abi_history.py`
- Create: `scripts/abi_staging/tests/test_abi_history.py`
- Create: `Kandelo/staging/fixtures/abi-history-record.json`
- Create: `.github/workflows/abi-staging-abi-history.yml`
- Modify: `scripts/check_abi_staging_workflows.rb`
- Modify: `scripts/test_check_abi_staging_workflows.rb`

**Interfaces:**

- Consumes: Task 1 promotion policy/state, exact preactivation main ref/tree,
  GitHub ref/protection facts, current Formula metadata, and public bottle
  readback.
- Produces: `AbiHistoryPlanV1`, immutable `AbiHistoryRecordV1`, and
  `plan-history`, `verify-history`, `publish-history-record` commands.
- Exact workflow jobs:

  | Job | Permissions |
  |---|---|
  | `plan-and-verify-policy` | `contents: read` |
  | `create-history-ref` | `contents: write` |
  | `verify-and-publish-history` | `contents: read`, `actions: read`, `packages: write` |

  No job has repository administration permission.

- [ ] **Step 1: Write failing local history tests**

  Use tiny Git repositories for absent branch, existing exact branch, existing
  wrong branch, source/target not adjacent, main moving before create, force
  attempt, missing Formula metadata, broken bottle readback, and idempotent
  rerun. Assert branch is exact `abi/N` and ref object equals preactivation SHA.

- [ ] **Step 2: Write failing protection tests**

  Model direct branch protection and wildcard ruleset coverage. Reject no
  coverage, disabled rule, bypass-only protection, response for another branch,
  stale protection snapshot, or workflow-provided Boolean. Re-query after ref
  creation.

- [ ] **Step 3: Write workflow mutation tests**

  Reject creation before protection preflight, admin permission, force update,
  branch from candidate/tap-plan SHA rather than exact preactivation main,
  successor promotion in this workflow, candidate execution in a writer,
  missing post-create public verification, or swallowed error.

- [ ] **Step 4: Run tests and verify red**

  ```bash
  scripts/dev-shell.sh env PYTHONPATH="$KANDELO_TAP_ROOT" \
    python3 -m unittest scripts.abi_staging.tests.test_abi_history -v
  scripts/dev-shell.sh env KANDELO_TAP_ROOT="$KANDELO_TAP_ROOT" \
    ruby "$KANDELO_TAP_ROOT/scripts/test_check_abi_staging_workflows.rb"
  ```

  Expected: FAIL because history implementation/workflow is absent.

- [ ] **Step 5: Implement fail-closed history creation**

  Capture main commit/tree once, derive source/successor ABI from validated
  request/state, verify configured protection, create with GitHub refs API only
  if absent, and require exact object on idempotent rerun. Validate historical
  Formula/sidecar metadata and public bottles before record publication.

- [ ] **Step 6: Run tests and actionlint**

  ```bash
  scripts/dev-shell.sh env PYTHONPATH="$KANDELO_TAP_ROOT" \
    python3 -m unittest scripts.abi_staging.tests.test_abi_history -v
  scripts/dev-shell.sh env KANDELO_TAP_ROOT="$KANDELO_TAP_ROOT" \
    ruby "$KANDELO_TAP_ROOT/scripts/test_check_abi_staging_workflows.rb"
  scripts/dev-shell.sh env KANDELO_TAP_ROOT="$KANDELO_TAP_ROOT" \
    actionlint \
      "$KANDELO_TAP_ROOT/.github/workflows/abi-staging-abi-history.yml"
  ```

  Expected: PASS in observe/dry-run until external protection exists.

- [ ] **Step 7: Commit in the tap repository**

  ```bash
  git -C "$KANDELO_TAP_ROOT" add \
    scripts/abi_staging/abi_history.py \
    scripts/abi_staging/tests/test_abi_history.py \
    Kandelo/staging/fixtures/abi-history-record.json \
    .github/workflows/abi-staging-abi-history.yml \
    scripts/check_abi_staging_workflows.rb \
    scripts/test_check_abi_staging_workflows.rb
  git -C "$KANDELO_TAP_ROOT" commit -m \
    "[ABI] Guard successor activation with protected history"
  ```

---

### Task 3: Promote exact bottle layers and publish admissions

**Repository:** `kandelo-dev/homebrew-tap-core`

**Files:**

- Create: `scripts/abi_staging/promotion.py`
- Create: `scripts/abi_staging/tests/test_promotion.py`
- Create: `Kandelo/staging/fixtures/promotion-decision.json`
- Create: `Kandelo/staging/fixtures/admission-record.json`
- Modify: `scripts/abi_staging/oci.py`
- Modify: `scripts/abi_staging/records.py`
- Modify: `scripts/abi_staging/cli.py`

**Interfaces:**

- Consumes: exact merged PR fact, eligible candidate/custody/receipts or exact
  override, valid Task 2 history record, current tap source, and canonical OCI
  namespace.
- Produces: `PromotionDecisionV1`, canonical manifest locator with unchanged
  bottle and bottle-metadata layers, and prepared `AdmissionRecordV1` awaiting
  exact metadata commit.

- [ ] **Step 1: Write failing eligibility tests**

  Reject open/closed-unmerged PR, request/PR mismatch, different merge PR,
  malformed merge fact, ineligible/failed verification, wrong override,
  candidate/custody/hash/readback mismatch, missing history, unprotected/moved
  history branch, target ABI mismatch, and unknown policy/guard version.

- [ ] **Step 2: Write exact-layer promotion tests**

  Fake registry must show candidate/canonical manifests differ while bottle
  descriptor digest/size/bytes are identical. The exact candidate bottle
  metadata blob is also copied unchanged so canonical product composition has
  an admitted descriptor locator. Reject download/rebuild output, changed
  layer, candidate repository used as canonical, mutable tag authority,
  private readback, and admission before readback/metadata.

- [ ] **Step 3: Write tap-source drift tests**

  Generated bottle metadata-only changes retain normalized source identity.
  Formula install/dependency/source/patch/support changes produce
  `tap_source_drift`, replan and compare contracts. If rebuilt dependency layer
  differs, invalidate reverse dependants; if identical, retain their eligible
  contract. Unrelated Formulae remain eligible.

- [ ] **Step 4: Run tests and verify red**

  ```bash
  scripts/dev-shell.sh env PYTHONPATH="$KANDELO_TAP_ROOT" \
    python3 -m unittest \
      scripts.abi_staging.tests.test_promotion \
      scripts.abi_staging.tests.test_oci -v
  ```

  Expected: FAIL because promotion is absent.

- [ ] **Step 5: Implement pure decision and exact OCI manifest creation**

  Fetch GitHub PR state directly, validate exact request relationship, recheck
  every immutable record, require valid history, compare current normalized tap
  source, and produce one Formula decision. Copy/mount the exact bottle and
  bottle-metadata blobs into the ABI-qualified canonical repository as needed,
  push the canonical manifest, and anonymously verify the manifest and both
  unchanged layers.

- [ ] **Step 6: Implement admission finalization contract**

  Do not publish admission until Task 4 supplies exact successful metadata
  commit/tree and post-write readback. Preserve original producer fields and
  add merged PR/commit strictly as admission provenance.

- [ ] **Step 7: Run promotion tests**

  ```bash
  scripts/dev-shell.sh env PYTHONPATH="$KANDELO_TAP_ROOT" \
    python3 -m unittest \
      scripts.abi_staging.tests.test_promotion \
      scripts.abi_staging.tests.test_oci \
      scripts.abi_staging.tests.test_records -v
  ```

  Expected: PASS.

- [ ] **Step 8: Commit in the tap repository**

  ```bash
  git -C "$KANDELO_TAP_ROOT" add \
    scripts/abi_staging/promotion.py \
    scripts/abi_staging/oci.py \
    scripts/abi_staging/records.py \
    scripts/abi_staging/cli.py \
    scripts/abi_staging/tests/test_promotion.py \
    Kandelo/staging/fixtures/promotion-decision.json \
    Kandelo/staging/fixtures/admission-record.json
  git -C "$KANDELO_TAP_ROOT" commit -m \
    "[Homebrew] Promote unchanged candidate bottle layers"
  ```

---

### Task 4: Activate successor metadata and apply narrow Formula CAS updates

**Repository:** `kandelo-dev/homebrew-tap-core`

**Files:**

- Modify: `Kandelo/staging/fixtures/admission-record.json`
- Modify: `Kandelo/staging/fixtures/formula-inventory.json`
- Modify: `Kandelo/staging/fixtures/tap-plan.json`
- Modify: `Kandelo/staging/formula-build-inputs.toml`
- Modify: `Kandelo/staging/generated/formula-build-inputs.json`
- Create: `scripts/abi_staging/bottle_link.py`
- Modify: `scripts/abi_staging/formula_inventory.py`
- Modify: `scripts/abi_staging/records.py`
- Modify: `scripts/abi_staging/tap_metadata.py`
- Create: `scripts/abi_staging/tests/test_tap_metadata.py` if not already
  present; extend the Task 1 file rather than creating another test module.
- Modify: `scripts/abi_staging/promotion.py`
- Modify: `scripts/abi_staging/tests/test_promotion.py`
- Modify: `scripts/abi_staging/tests/test_records.py`

**Cross-repository record parity in Kandelo:**

- Modify: `tools/xtask/src/abi_staging/records.rs`
- Modify: `tools/xtask/src/abi_staging/mini_lifecycle.rs`

**Interfaces:**

- Consumes: valid history, canonical readback, current tap main ref, normalized
  Formula identity, authenticated bottle-contract/archive bytes, the exact
  captured guest layout, and `FormulaMetadataUpdateV1`.
- Produces: one successor activation patch and independent per-Formula
  generated metadata patches, including one mechanical link manifest, each
  compare-and-swap and path-bounded.

- [ ] **Step 1: Write failing activation tests**

  Assert activation refuses missing/wrong/unprotected history, main moved,
  current ABI changed, target not successor, prior bottle blocks left current,
  unpromoted subject mapped to old bottle, unexpected file change, or activation
  waiting for complete tap. A valid patch marks all successor subjects pending
  and changes only generated ABI/bottle metadata.

- [ ] **Step 2: Write failing per-Formula update tests**

  Cover one architecture, dual architecture independent updates, exact
  canonical root/layer, sidecar/top-index consistency, current ABI binding,
  source CAS, generated metadata CAS, another Formula changed, unexpected path,
  non-fast-forward push, and idempotent already-landed update. Prove the
  normalized Formula digest comes from the authenticated bottle contract,
  revision/rebuild transitions cannot rewrite a successful sibling
  architecture, link inventory rejects archive traversal/escape links, and the
  link manifest uses only the captured guest prefix/cellar and promoted bytes.

- [ ] **Step 3: Run tests and verify red**

  ```bash
  scripts/dev-shell.sh env PYTHONPATH="$KANDELO_TAP_ROOT" \
    python3 -m unittest \
      scripts.abi_staging.tests.test_tap_metadata \
      scripts.abi_staging.tests.test_promotion -v
  ```

  Expected: FAIL because activation/CAS behavior is absent.

- [ ] **Step 4: Implement one-time activation patch**

  Generate patch bytes from exact current tree plus history/merge facts. Remove
  prior default bottle metadata from main, set current successor ABI/snapshot,
  and mark every supported subject pending/unavailable. Validate the entire
  resulting metadata tree before a contents-only writer commits/pushes.

- [ ] **Step 5: Implement independent Formula patching**

  Update only the exact Formula bottle block, generated sidecar/index row, and
  one versioned mechanical link manifest. Bind canonical manifest/layer,
  authenticated Formula source, bottle inventory, and captured guest layout.
  Re-read main immediately before push and use a normal non-force push; on
  conflict return `tap_source_drift` or CAS conflict for reconciliation.

- [ ] **Step 6: Run tests and current metadata regressions**

  ```bash
  scripts/dev-shell.sh env \
    PYTHONPATH="$KANDELO_TAP_ROOT" KANDELO_TAP_ROOT="$KANDELO_TAP_ROOT" \
    python3 -m unittest \
      scripts.abi_staging.tests.test_tap_metadata \
      scripts.abi_staging.tests.test_promotion -v
  scripts/dev-shell.sh env \
    PYTHONPATH="$KANDELO_TAP_ROOT" KANDELO_TAP_ROOT="$KANDELO_TAP_ROOT" \
    python3 -m scripts.abi_staging.cli tap-metadata-check \
      --tap-root "$KANDELO_TAP_ROOT"
  ```

  Expected: PASS against the unactivated current fixture.

- [ ] **Step 7: Commit in the tap repository**

  ```bash
  git -C "$KANDELO_TAP_ROOT" add \
    Kandelo/staging/fixtures/admission-record.json \
    Kandelo/staging/fixtures/formula-inventory.json \
    Kandelo/staging/fixtures/tap-plan.json \
    Kandelo/staging/formula-build-inputs.toml \
    Kandelo/staging/generated/formula-build-inputs.json \
    scripts/abi_staging/bottle_link.py \
    scripts/abi_staging/formula_inventory.py \
    scripts/abi_staging/records.py \
    scripts/abi_staging/tap_metadata.py \
    scripts/abi_staging/promotion.py \
    scripts/abi_staging/tests/test_tap_metadata.py \
    scripts/abi_staging/tests/test_promotion.py \
    scripts/abi_staging/tests/test_records.py
  git -C "$KANDELO_TAP_ROOT" commit -m \
    "[Homebrew] Apply ABI-safe Formula metadata updates"
  git add tools/xtask/src/abi_staging/records.rs \
    tools/xtask/src/abi_staging/mini_lifecycle.rs \
    docs/superpowers/plans/2026-08-08-abi-staging-promotion-pages-and-retirement.md
  git commit -m "[ABI] Bind admission records to bottle link metadata"
  ```

---

### Task 5: Reconcile merge-triggered independent promotion

**Repository:** `kandelo-dev/homebrew-tap-core`

**Files:**

- Modify: `.github/workflows/abi-staging-reconcile.yml`
- Modify: `scripts/abi_staging/cli.py`
- Modify: `scripts/abi_staging/reconcile.py`
- Modify: `scripts/abi_staging/promotion.py`
- Modify: `scripts/abi_staging/records.py`
- Modify: `scripts/abi_staging/tests/test_promotion.py`
- Modify: `scripts/abi_staging/tests/test_reconcile.py`
- Modify: `scripts/abi_staging/tests/test_tap_metadata.py`
- Modify: `scripts/check_abi_staging_workflows.rb`
- Modify: `scripts/test_check_abi_staging_workflows.rb`
- Modify: `Kandelo/staging/fixtures/promotion-decision.json`
- Modify: `Kandelo/staging/fixtures/admission-record.json`
- Modify in Kandelo: `tools/xtask/src/abi_staging/records.rs`
- Modify in Kandelo: `tools/xtask/src/abi_staging/mini_lifecycle.rs`

**Interfaces:**

- Consumes: Tasks 1–4, Plan 3 lifecycle/scheduler, and Plan 4 product records.
- Produces: separate `plan-promotion`, `publish-canonical`,
  `update-tap-metadata`, and `publish-admission` jobs.
- Exact permissions:

  | Job | Permissions |
  |---|---|
  | `plan-promotion` | `contents: read` |
  | `publish-canonical` | `contents: read`, `actions: read`, `packages: write` |
  | `update-tap-metadata` | `contents: write`, `actions: read` |
  | `publish-admission` | `contents: read`, `actions: read`, `packages: write` |

  No job has both `contents: write` and `packages: write`; none executes
  candidate code.

- [ ] **Step 1: Write failing workflow mutation tests**

  Reject open-PR promotion, main-commit scanning trigger, history Boolean,
  promotion before protected branch, changed layer, combined package/Git
  writer, candidate execution in writer, unbounded global matrix, all-Formula
  gate, metadata force push, admission before metadata/readback, or background
  failure stopping an independent sibling.

- [ ] **Step 2: Write failing convergence fixtures**

  Simulate required candidates immediately ready, background pending, one
  Formula drift/rebuild, one failed dependency, independent sibling, duplicate
  reconciliations, metadata CAS conflict, publisher retry, admission retry, and
  metadata success followed by admission failure and a later current-main
  commit. Assert exact idempotence, Git-object recovery, and independent
  progress.

- [ ] **Step 3: Run tests and verify red**

  ```bash
  scripts/dev-shell.sh env PYTHONPATH="$KANDELO_TAP_ROOT" \
    python3 -m unittest \
      scripts.abi_staging.tests.test_promotion \
      scripts.abi_staging.tests.test_reconcile -v
  scripts/dev-shell.sh env KANDELO_TAP_ROOT="$KANDELO_TAP_ROOT" \
    ruby "$KANDELO_TAP_ROOT/scripts/test_check_abi_staging_workflows.rb"
  ```

  Expected: FAIL because promotion jobs are absent.

- [ ] **Step 4: Implement disabled/observe/active flow**

  Disabled schedules nothing. Observe calculates exact history/activation/
  promotion plans without writes. Active first requires/rechecks history,
  applies one activation if needed, then schedules dependency-ready Formulae
  independently. Required subjects sort first; background continues after
  merge. Canonical publication may fan out, but exactly one Formula metadata
  CAS owner is selected per wave. A reused historical candidate is selected only through its exact
  current-request reuse record; original candidate, custody, and verification
  facts remain unchanged and separately bound.

- [ ] **Step 5: Wire exact artifacts between separated writers**

  Every job consumes a bounded artifact from an expected upstream job/run and
  revalidates it with protected code. The metadata writer accepts only a
  canonical readback locator; the admission publisher accepts only exact landed
  metadata commit/tree plus post-write readback.

- [ ] **Step 6: Run workflow tests and actionlint**

  ```bash
  scripts/dev-shell.sh env PYTHONPATH="$KANDELO_TAP_ROOT" \
    python3 -m unittest discover \
      -s "$KANDELO_TAP_ROOT/scripts/abi_staging/tests" -v
  scripts/dev-shell.sh env KANDELO_TAP_ROOT="$KANDELO_TAP_ROOT" \
    ruby "$KANDELO_TAP_ROOT/scripts/test_check_abi_staging_workflows.rb"
  scripts/dev-shell.sh env KANDELO_TAP_ROOT="$KANDELO_TAP_ROOT" \
    actionlint "$KANDELO_TAP_ROOT/.github/workflows/abi-staging-reconcile.yml"
  ```

  Expected: PASS while promotion remains disabled.

- [ ] **Step 7: Commit in the tap repository**

  ```bash
  git -C "$KANDELO_TAP_ROOT" add \
    .github/workflows/abi-staging-reconcile.yml \
    scripts/abi_staging/reconcile.py \
    scripts/abi_staging/cli.py \
    scripts/abi_staging/promotion.py \
    scripts/abi_staging/records.py \
    scripts/abi_staging/tests/test_promotion.py \
    scripts/abi_staging/tests/test_reconcile.py \
    scripts/abi_staging/tests/test_tap_metadata.py \
    Kandelo/staging/fixtures/promotion-decision.json \
    Kandelo/staging/fixtures/admission-record.json \
    scripts/check_abi_staging_workflows.rb \
    scripts/test_check_abi_staging_workflows.rb
  git -C "$KANDELO_TAP_ROOT" commit -m \
    "[ABI] Reconcile independent merged Formula promotion"
  git add tools/xtask/src/abi_staging/records.rs \
    tools/xtask/src/abi_staging/mini_lifecycle.rs \
    docs/superpowers/plans/2026-08-08-abi-staging-promotion-pages-and-retirement.md
  git commit -m "[ABI] Bind reused candidates through admission"
  ```

---

### Task 6: Support protected historical repair and epoch retirement

**Repository:** `kandelo-dev/homebrew-tap-core`

**Files:**

- Create: `scripts/abi_staging/historical_maintenance.py`
- Create: `scripts/abi_staging/tests/test_historical_maintenance.py`
- Modify: `.github/workflows/abi-staging-maintenance.yml`
- Modify: `scripts/abi_staging/reconcile.py`
- Modify: `scripts/check_abi_staging_workflows.rb`
- Modify: `scripts/test_check_abi_staging_workflows.rb`

**Interfaces:**

- Consumes: protected `abi/N`, history/admission records, normal Plan 3
  uncredentialed pipeline, maintainer permission, and epoch schedule records.
- Produces: historical maintenance authorization, new historical records, and
  derived retiring/retired status.

- [ ] **Step 1: Write failing retirement-state tests**

  Assert a source ABI becomes retiring after successor activation, stays so
  while any scheduled subject is nonterminal, becomes retired when all are
  terminal success/failure/timeout/canceled, and never gates successor. Reopen
  or repair does not erase terminal history or make the epoch active current.

- [ ] **Step 2: Write failing historical repair tests**

  Cover failed-package repair and security rebuild from exact protected branch,
  unauthorized actor, unprotected/moved branch, main instead of historical
  source, candidate namespace wrong ABI, metadata write to main, reuse from
  mismatched contract, and valid new attempt/candidate/receipt/admission.

- [ ] **Step 3: Extend workflow mutation tests**

  Reject historical build with write credentials, override receipt for repair,
  force push, arbitrary ref, missing history record, cross-ABI dependency, or
  deletion of failed prior records.

- [ ] **Step 4: Run tests and verify red**

  ```bash
  scripts/dev-shell.sh env PYTHONPATH="$KANDELO_TAP_ROOT" \
    python3 -m unittest \
      scripts.abi_staging.tests.test_historical_maintenance \
      scripts.abi_staging.tests.test_reconcile -v
  ```

  Expected: FAIL because historical maintenance is absent.

- [ ] **Step 5: Implement maintenance authorization and reuse of normal lane**

  Resolve exact `abi/N` source/metadata, validate protection, record actor and
  bounded reason, then feed a normal uncredentialed build/verify and separated
  publisher pipeline under that ABI. Target metadata CAS at the historical
  branch only. Do not change current main ABI state.

- [ ] **Step 6: Run tests and workflow checker**

  ```bash
  scripts/dev-shell.sh env PYTHONPATH="$KANDELO_TAP_ROOT" \
    python3 -m unittest \
      scripts.abi_staging.tests.test_historical_maintenance \
      scripts.abi_staging.tests.test_reconcile -v
  scripts/dev-shell.sh env KANDELO_TAP_ROOT="$KANDELO_TAP_ROOT" \
    ruby "$KANDELO_TAP_ROOT/scripts/test_check_abi_staging_workflows.rb"
  ```

  Expected: PASS.

- [ ] **Step 7: Commit in the tap repository**

  ```bash
  git -C "$KANDELO_TAP_ROOT" add \
    scripts/abi_staging/historical_maintenance.py \
    scripts/abi_staging/tests/test_historical_maintenance.py \
    scripts/abi_staging/reconcile.py \
    .github/workflows/abi-staging-maintenance.yml \
    scripts/check_abi_staging_workflows.rb \
    scripts/test_check_abi_staging_workflows.rb
  git -C "$KANDELO_TAP_ROOT" commit -m \
    "[ABI] Repair protected historical bottle epochs"
  ```

---

### Task 7: Enforce candidate/source retention and deletion tombstones

**Repository:** `kandelo-dev/homebrew-tap-core`

**Files:**

- Create: `scripts/abi_staging/cleanup.py`
- Create: `scripts/abi_staging/tests/test_cleanup.py`
- Create: `Kandelo/staging/fixtures/retention-assessment.json`
- Create: `.github/workflows/abi-staging-candidate-cleanup.yml`
- Modify: `scripts/check_abi_staging_workflows.rb`
- Modify: `scripts/test_check_abi_staging_workflows.rb`

**Interfaces:**

- Consumes: all request/lifecycle/reuse/candidate/custody/product/admission/
  repair records, 30-day policy, public registry facts, and protected actor for
  immediate purge.
- Produces: `RetentionAssessmentV1`, deletion operation, and immutable
  `DeletionRecordV1`.
- Ordinary cleanup job permissions are `contents: read`, `packages: write`;
  it executes no candidate content.

- [ ] **Step 1: Write failing pin/grace tests**

  Cover open request, merged admission, active verification/product/promotion/
  repair, reuse, shared custody, canonical layer, closed unmerged at 29/30
  days, reopened request, historical compact reference without pin, and
  multiple candidates sharing source. Only fully unreferenced elapsed targets
  become eligible.

- [ ] **Step 2: Write failing deletion tests**

  Reject canonical/admitted layer, shared/pinned custody, wrong package/version,
  mutable tag-only target, missing pre-delete recheck, unconfirmed deletion,
  tombstone mismatch, unknown record, and repeated deletion with conflicting
  reason. Idempotent retry after confirmed absence must publish/return the same
  factual target identity.

- [ ] **Step 3: Write immediate-purge and workflow mutation tests**

  Require exact unendorsed digest, allowed reason category, bounded human
  justification, maintainer authorization, pin analysis, and protected code.
  Reject broad package/repository delete, glob, candidate execution, sleep,
  personal token fallback, or deletion before reference recheck.

- [ ] **Step 4: Run tests and verify red**

  ```bash
  scripts/dev-shell.sh env PYTHONPATH="$KANDELO_TAP_ROOT" \
    python3 -m unittest scripts.abi_staging.tests.test_cleanup -v
  scripts/dev-shell.sh env KANDELO_TAP_ROOT="$KANDELO_TAP_ROOT" \
    ruby "$KANDELO_TAP_ROOT/scripts/test_check_abi_staging_workflows.rb"
  ```

  Expected: FAIL because cleanup is absent.

- [ ] **Step 5: Implement exact maintenance cleanup**

  Enumerate records first, compute pins, inject time for tests, re-fetch
  lifecycle/records immediately before delete, delete one exact registry
  manifest/version, prove anonymous absence without following unrelated
  redirects, and publish tombstone. Return after each bounded batch.

- [ ] **Step 6: Run tests and actionlint**

  ```bash
  scripts/dev-shell.sh env PYTHONPATH="$KANDELO_TAP_ROOT" \
    python3 -m unittest scripts.abi_staging.tests.test_cleanup -v
  scripts/dev-shell.sh env KANDELO_TAP_ROOT="$KANDELO_TAP_ROOT" \
    ruby "$KANDELO_TAP_ROOT/scripts/test_check_abi_staging_workflows.rb"
  scripts/dev-shell.sh env KANDELO_TAP_ROOT="$KANDELO_TAP_ROOT" \
    actionlint \
      "$KANDELO_TAP_ROOT/.github/workflows/abi-staging-candidate-cleanup.yml"
  ```

  Expected: PASS.

- [ ] **Step 7: Commit in the tap repository**

  ```bash
  git -C "$KANDELO_TAP_ROOT" add \
    scripts/abi_staging/cleanup.py \
    scripts/abi_staging/tests/test_cleanup.py \
    Kandelo/staging/fixtures/retention-assessment.json \
    .github/workflows/abi-staging-candidate-cleanup.yml \
    scripts/check_abi_staging_workflows.rb \
    scripts/test_check_abi_staging_workflows.rb
  git -C "$KANDELO_TAP_ROOT" commit -m \
    "[Homebrew] Retain and tombstone staging candidates safely"
  ```

---

### Task 8: Recompose canonical products and compute Pages readiness

**Files:**

- Modify: `tools/xtask/src/abi_staging/mod.rs`
- Modify: `tools/xtask/src/abi_staging/records.rs`
- Create: `tools/xtask/src/abi_staging/pages_readiness.rs`
- Create: `abi/staging/pages-activation.toml`
- Create: `scripts/abi-staging-pages-readiness.ts`
- Create: `scripts/abi-staging-pages-readiness.test.ts`
- Create: `scripts/test-abi-staging-pages-atomic.sh`

**Interfaces:**

- Consumes: Pages registry, exact current main, valid admissions, canonical
  public layers, Plan 4 builders/evidence definitions, and site/gallery
  metadata.
- Produces: canonical `ResolvedVfsProductInputsV1`, final VFS/report/host
  receipts, `PagesReadinessRecordV1`, and `PagesSiteManifestV1`.
- Pages activation begins `mode = "legacy"`; other modes are `observe` and
  `active`.

- [ ] **Step 1: Write failing readiness tests**

  Cover complete product set, missing admission, unpromoted dependency,
  candidate reference, wrong ABI/arch/layer, stale manifest/registry/runtime,
  final builder failure, Node/browser failure/timeout, missing gallery entry,
  extra product, informational non-Pages failure, and exact ready set.

- [ ] **Step 2: Prove candidate-to-canonical recomposition semantics**

  Use the miniature to assert each promoted bottle-layer digest/bytes remains
  identical, candidate and final VFS digests differ when locators change,
  final reports use canonical reference class, embedded/lazy placement remains
  identical, and no candidate namespace string exists in final VFS/report/site.

- [ ] **Step 3: Write failing atomic-site harness**

  Start with one prior complete site. Run readiness with every blocker class
  and assert output artifact/deploy intent is absent and prior site bytes remain
  unchanged. With a complete set, assemble into a new sibling directory,
  validate all files/manifest/size, atomically select it, and leave no partial
  output after injected failure.

- [ ] **Step 4: Run tests and verify red**

  ```bash
  scripts/dev-shell.sh npx tsx --test \
    scripts/abi-staging-pages-readiness.test.ts
  scripts/dev-shell.sh bash scripts/test-abi-staging-pages-atomic.sh
  scripts/dev-shell.sh bash -c '
    host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
    cargo test -p xtask --target "$host_target" \
      abi_staging::pages_readiness
  '
  ```

  Expected: FAIL because readiness/recomposition is absent.

- [ ] **Step 5: Implement exact canonical resolution and evidence**

  Select only Pages registry IDs, require admission per bottle layer, construct
  canonical input envelopes, run existing report-emitting builders, rerun
  protected Node/browser definitions against exact current-main runtime, and
  aggregate all terminal facts. Return blockers without waiting.

- [ ] **Step 6: Implement complete site manifest/assembly**

  Bind every final product and gallery entry plus docs/API identities. Build in
  a fresh directory and publish no deploy intent until complete validation and
  size checks. The site manifest uses content identity, not “latest.”

- [ ] **Step 7: Run readiness, VFS, browser, and atomic tests**

  ```bash
  scripts/dev-shell.sh npx tsx --test \
    scripts/abi-staging-pages-readiness.test.ts
  scripts/dev-shell.sh bash scripts/test-abi-staging-pages-atomic.sh
  scripts/dev-shell.sh bash -c '
    host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
    cargo test -p xtask --target "$host_target" \
      abi_staging::pages_readiness
    cd host
    npx vitest run \
      test/abi-staging-product-builders.test.ts \
      test/optional-demo-vfs.test.ts \
      test/lazy-vfs.test.ts \
      test/vfs-image.test.ts
  '
  ```

  Expected: PASS; Pages activation remains legacy.

- [ ] **Step 8: Commit**

  ```bash
  git add tools/xtask/src/abi_staging/mod.rs \
    tools/xtask/src/abi_staging/records.rs \
    tools/xtask/src/abi_staging/pages_readiness.rs \
    abi/staging/pages-activation.toml \
    scripts/abi-staging-pages-readiness.ts \
    scripts/abi-staging-pages-readiness.test.ts \
    scripts/test-abi-staging-pages-atomic.sh
  git commit -m "[Pages] Require complete admitted VFS products"
  ```

---

### Task 9: Prove a native atomic Pages workflow in canary mode

**Files:**

- Create: `.github/workflows/abi-staging-pages-canary.yml`
- Modify: `scripts/ci-check-pages-deployment.sh`
- Modify: `scripts/test-pages-deployment-contract.sh`
- Modify: `scripts/check-pages-run-freshness.sh`
- Modify: `scripts/test-pages-run-freshness.sh`

**Interfaces:**

- Consumes: Task 8 readiness/site build, existing full Pages tree assembly,
  exact current main, and GitHub Pages artifact actions.
- Produces: an observe-only workflow that builds/uploads a complete inert Pages
  artifact but does not deploy production.
- Permission map is workflow `{}` and job `{ actions: read, contents: read }`.

- [ ] **Step 1: Write failing canary structural tests**

  Require current protected main only, no PR deployment, no path filter, exact
  Pages registry, admissions before composition, canonical references, all
  product Node/browser evidence, docs/API/site metadata/size, newest-run check,
  one Pages artifact, no deploy action, no contents write, and no gh-pages
  branch mutation.

- [ ] **Step 2: Write canary mutations**

  Reject candidate VFS reuse, missing product, partial registry, skipped
  evidence, candidate reference, source fallback, swallowed failure, artifact
  upload before final checks, second site tree, mutable latest record, or any
  `pages: write`/`id-token: write` in canary.

- [ ] **Step 3: Run Pages checks and verify red**

  ```bash
  scripts/dev-shell.sh bash scripts/test-pages-deployment-contract.sh
  scripts/dev-shell.sh bash scripts/test-pages-run-freshness.sh
  scripts/dev-shell.sh bash scripts/ci-check-pages-deployment.sh
  ```

  Expected: FAIL because canary contract is absent.

- [ ] **Step 4: Implement complete canary build**

  Reuse existing docs/API/browser build steps only after Task 8 readiness. Use
  the exact registered product set and write `PagesSiteManifestV1` into the
  complete tree. Upload one Pages artifact with a full-SHA pinned action; do not
  call a deployment action.

- [ ] **Step 5: Run Pages checks and actionlint**

  ```bash
  scripts/dev-shell.sh bash scripts/test-pages-deployment-contract.sh
  scripts/dev-shell.sh bash scripts/test-pages-run-freshness.sh
  scripts/dev-shell.sh bash scripts/ci-check-pages-deployment.sh
  scripts/dev-shell.sh actionlint \
    .github/workflows/abi-staging-pages-canary.yml
  ```

  Expected: PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add .github/workflows/abi-staging-pages-canary.yml \
    scripts/ci-check-pages-deployment.sh \
    scripts/test-pages-deployment-contract.sh \
    scripts/check-pages-run-freshness.sh \
    scripts/test-pages-run-freshness.sh
  git commit -m "[Pages] Build complete canonical site canaries"
  ```

---

### Task 10: Prepare the atomic admitted-product Pages switch without deploying

**Files:**

- Modify: `.github/workflows/browser-demos-pages.yml`
- Modify: `abi/staging/pages-activation.toml`
- Modify: `scripts/ci-check-pages-deployment.sh`
- Modify: `scripts/test-pages-deployment-contract.sh`

**Interfaces:**

- Consumes: successful hosted Task 9 artifact/readiness canary and externally
  configured GitHub Actions Pages source.
- Produces: fully tested native two-job atomic deployment code using admitted
  canonical products, with last-complete site retention on failure, while the
  checked-in activation remains non-production for this execution.

- [ ] **Step 1: Run hosted canary before production edits**

  Retain exact workflow run/artifact/readiness/site-manifest digests and inspect
  every selected Pages product. Run a hold-only missing-product canary and
  confirm no deploy job/action occurs. If canary is unavailable or incomplete,
  stop before editing production workflow.

- [ ] **Step 2: Verify/switch repository Pages source externally**

  A maintainer with repository administration authority configures Pages to use
  GitHub Actions rather than the `gh-pages` branch. Record the settings/API
  evidence. Workflow code does not grant itself this authority.

- [ ] **Step 3: Write failing production workflow mutations**

  Require `build-complete-site` and `deploy-complete-site` permission split,
  native upload/deploy actions, no contents write/secrets/peaceiris action,
  deploy depending on successful complete artifact, stable concurrency, newest
  run, and no deploy on readiness/evidence/size failure. Reject partial site or
  candidate reference.

- [ ] **Step 4: Modify production workflow in observe mode**

  Change Pages activation to `observe`: build and validate the new admitted
  tree alongside the still-active legacy deploy, but do not add a second
  production writer. Compare exact expected complete site inventory and
  preserve current deployment behavior during the comparison run.

- [ ] **Step 5: Run one hosted observe comparison**

  Compare product/site manifests and user-visible browser evidence. Confirm the
  new tree is complete and any intentional locator differences are canonical
  recomposition, not missing content.

- [ ] **Step 6: Prove the single-writer activation mutation without applying it**

  Exercise a temporary fixture mutation that changes activation to `active`,
  removes the legacy `peaceiris` writer, and makes the native deploy job the
  sole production writer. Prove the build job uses contents read and the
  deploy job uses only Pages and identity-token writes without executing
  source. Do not apply that mutation to the checked-in production workflow.

- [ ] **Step 7: Run local workflow/security tests**

  ```bash
  scripts/dev-shell.sh bash scripts/test-pages-deployment-contract.sh
  scripts/dev-shell.sh bash scripts/ci-check-pages-deployment.sh
  scripts/dev-shell.sh bash scripts/test-pages-run-freshness.sh
  scripts/dev-shell.sh actionlint \
    .github/workflows/browser-demos-pages.yml
  ```

  Expected: PASS for the activation fixture. The checked-in production
  workflow remains in its pre-deployment state.

- [ ] **Step 8: Retain hosted canary evidence without production deployment**

  Retain the canary site manifest, then run the protected hold-only
  missing-product path. Confirm readiness records `pages_product_incomplete`
  and the deploy job is absent. Do not run a production replacement; record
  that proof as the remaining activation gate.

- [ ] **Step 9: Commit inactive production readiness**

  ```bash
  git add .github/workflows/browser-demos-pages.yml \
    abi/staging/pages-activation.toml \
    scripts/ci-check-pages-deployment.sh \
    scripts/test-pages-deployment-contract.sh
  git commit -m "[Pages] Prepare atomic admitted product deployment"
  ```

---

### Task 11: Add generic hosted acceptance orchestration and the sole fixture

**Files:**

- Create: `abi/staging/acceptance/successor-batch.toml`
- Create: `abi/staging/acceptance/evidence.generated.json`
- Create: `scripts/abi-staging-hosted-acceptance.py`
- Create: `scripts/test-abi-staging-hosted-acceptance.py`

**Interfaces:**

- Consumes: exact public fixture PR/head, all five-plan public records,
  repository/workflow/protection/Pages facts, and approved criterion IDs.
- Produces: strict `HostedAcceptanceEvidenceV1` and read-only verification
  report. The driver can trigger only explicitly named protected
  workflow-dispatch adapters when invoked with a separately authorized
  `--execute`; default mode is read-only verify.

- [ ] **Step 1: Write failing generic driver tests**

  Use fake GitHub/GHCR/Pages APIs for every approved acceptance criterion.
  Reject missing criterion, URL without digest validation, wrong head/tree,
  synthetic source, hardcoded fixture value in generic module, candidate with
  writes, missing custody/readback, layer drift, incomplete required product,
  background gate, missing history protection/repair, partial Pages deploy,
  override of integrity, and mutable evidence overwrite.

- [ ] **Step 2: Write fixture isolation tests**

  Scan all generic staging files and require the concrete branch/source/target
  values to appear only in `successor-batch.toml`, its generated evidence, and
  historical docs describing the fixture. The driver must pass equally with a
  temporary unrelated `N`/`N + 1` fixture.

- [ ] **Step 3: Run tests and verify red**

  ```bash
  scripts/dev-shell.sh python3 \
    scripts/test-abi-staging-hosted-acceptance.py -v
  ```

  Expected: FAIL because acceptance support is absent.

- [ ] **Step 4: Implement strict read-only evidence verification**

  Parse one fixture, verify exact remote PR head/tree/branch and current public
  state, fetch every referenced object anonymously/read-only, recompute digests,
  and emit canonical evidence only when every criterion is supported. Refuse
  timestamps/order as identity and refuse an older request for the current
  Check.

- [ ] **Step 5: Implement bounded explicit execution adapter**

  `--execute` accepts no arbitrary workflow, Formula, ref, or command. It may
  invoke only the protected request reconciliation, history, maintenance,
  Pages canary, and acceptance workflows fixed in reviewed policy, always with
  exact fixture/request identifiers. It never pushes a branch, creates a PR,
  changes protection, or supplies a personal token.

- [ ] **Step 6: Run tests with two generic fixtures**

  ```bash
  scripts/dev-shell.sh python3 \
    scripts/test-abi-staging-hosted-acceptance.py -v
  ```

  Expected: PASS.

- [ ] **Step 7: Commit without claiming hosted success**

  ```bash
  git add abi/staging/acceptance/successor-batch.toml \
    abi/staging/acceptance/evidence.generated.json \
    scripts/abi-staging-hosted-acceptance.py \
    scripts/test-abi-staging-hosted-acceptance.py
  git commit -m "[ABI] Define the successor staging acceptance fixture"
  ```

  The initial generated evidence is an explicit incomplete/not-run fixture
  accepted only by test mode; production retirement validation rejects it
  until hosted evidence is complete.

---

### Task 12: Execute the real generic successor transition

**Repositories:** Kandelo and tap

**Files:**

- Modify: `Kandelo/staging/promotion-activation.toml` in the tap
- Regenerate: `abi/staging/acceptance/evidence.generated.json` in Kandelo

**Interfaces:**

- Consumes: protected-main implementations, exact public acceptance fixture,
  active request/candidate/product/Check stages, verified `abi/*` protection,
  and explicit authority to run hosted workflows.
- Produces: one complete retained successor-transition evidence set.

- [ ] **Step 1: Verify the public fixture exists exactly**

  Query `Automattic/kandelo` and require the fixture branch/PR current head/tree
  equal `successor-batch.toml`. Current repository evidence found while writing
  this plan had the branch only locally. If it remains absent remotely, stop
  here, report the exact gate, and do not push it or substitute another branch.

- [ ] **Step 2: Verify protected history rule before promotion mode changes**

  Query tap rules/protection for the exact derived `abi/N` branch. If no rule
  covers it, request maintainer configuration and stop before history creation,
  current-ABI mutation, or canonical publication.

- [ ] **Step 3: Run exact-head request/candidate/product staging**

  Issue/reconcile the exact current request. Required Formulae/products must
  finish and `Kandelo PR Check` must pass under current policy. Retain request,
  tap-plan, contracts, candidates, custody, verification, candidate VFS,
  runtime, product evidence, and Check identities. Background may remain
  incomplete.

- [ ] **Step 4: Merge only through normal protected review**

  The agent does not merge merely because staging succeeded. The approved PR
  review/branch-protection path performs the merge. Record exact merged PR and
  merge commit. If the PR advances before merge, require a new current request
  and Check; old work remains historical/reusable.

- [ ] **Step 5: Run history workflow and inspect the activation barrier**

  Create/verify protected `abi/N` at exact preactivation tap main and retain
  history record/protection/readback. Do not enable active promotion until this
  passes.

- [ ] **Step 6: Move promotion from disabled to observe**

  Compute activation and all currently eligible Formula plans. Confirm prior
  metadata removal/pending successor representation, exact unchanged layer
  descriptors, source drift decisions, independent required/background order,
  and no writes.

- [ ] **Step 7: Activate promotion narrowly**

  Change only tap promotion activation to `active`, run the full local tap
  suite, commit/merge through protected review, and let reconciliation perform
  the one-time activation plus independent promotions.

  ```bash
  scripts/dev-shell.sh env PYTHONPATH="$KANDELO_TAP_ROOT" \
    python3 -m unittest discover \
      -s "$KANDELO_TAP_ROOT/scripts/abi_staging/tests" -v
  git -C "$KANDELO_TAP_ROOT" add \
    Kandelo/staging/promotion-activation.toml
  git -C "$KANDELO_TAP_ROOT" commit -m \
    "[ABI] Activate protected independent promotion"
  ```

- [ ] **Step 8: Verify required and background promotion behavior**

  Required Formulae should admit promptly and independently. Confirm each
  canonical bottle layer equals its candidate bytes and each metadata CAS/
  admission is exact. Leave a background failure visible and confirm unrelated
  background/required progress continues.

- [ ] **Step 9: Prove historical repair**

  Use a controlled failed-package or security-rebuild fixture on protected
  `abi/N`. Retain authorization, new uncredentialed attempt/candidate/receipt/
  admission, historical branch metadata commit, and public canonical readback.
  Confirm tap main remains successor ABI.

- [ ] **Step 10: Recompose and deploy the complete Pages site**

  Resolve every Pages registry product from admissions, build final canonical
  VFSs, rerun Node/browser evidence, deploy one complete site, exercise the
  hold-only incomplete run, and verify the last complete site remains live.

- [ ] **Step 11: Verify close/reopen/new-head and retry/override evidence**

  Retain hosted or exact protected fixture evidence for lifecycle preservation,
  three deterministic transient retries, exact allowed override, and rejection
  of an integrity override. Do not manufacture a successful outcome where the
  real fixture did not exercise one; incomplete criterion evidence blocks
  retirement.

- [ ] **Step 12: Generate and independently verify acceptance evidence**

  ```bash
  scripts/dev-shell.sh python3 scripts/abi-staging-hosted-acceptance.py \
    verify \
    --fixture abi/staging/acceptance/successor-batch.toml \
    --out abi/staging/acceptance/evidence.generated.json
  scripts/dev-shell.sh python3 scripts/abi-staging-hosted-acceptance.py \
    verify \
    --fixture abi/staging/acceptance/successor-batch.toml \
    --evidence abi/staging/acceptance/evidence.generated.json
  ```

  Expected: PASS only when every approved acceptance criterion has exact
  evidence.

- [ ] **Step 13: Commit retained evidence**

  ```bash
  git add abi/staging/acceptance/evidence.generated.json
  git commit -m "[ABI] Record the complete successor staging transition"
  ```

---

### Task 13: Audit retirement and mark only proven entries removable

**Files:**

- Create: `tools/xtask/src/abi_staging/retirement.rs`
- Modify: `tools/xtask/src/abi_staging/mod.rs`
- Modify: `abi/staging/legacy-retirement.toml`
- Create: `scripts/test-abi-staging-retirement.sh`
- Modify every legacy path listed under **Legacy deprecation markers**.

**Interfaces:**

- Consumes: complete hosted acceptance evidence, Plan 1 retirement ledger,
  repository consumer graph, custody coverage evidence, and failure/recovery
  evidence.
- Produces: `LegacyRetirementAssessmentV1`, deprecation comments, and exact
  per-entry `removable` decisions. It does not perform deletion.

- [ ] **Step 1: Write failing retirement validator tests**

  Require complete real transition, required product evidence, Pages evidence,
  independent promotion, protected history repair, consumer audit, complete
  retained-source custody, and failure/recovery evidence. Reject a URL without
  digest, stale/missing consumer, broad path, non-Homebrew shared component,
  incomplete acceptance, or manually toggled `removable`.

- [ ] **Step 2: Run the consumer audit**

  Build a machine-readable map of workflow calls, scripts, docs, package/build
  metadata, browser imports, `run.sh`, Homebrew selectors/locks, tap workflows,
  and source-retention roles. Compare it with every ledger entry. Any consumer
  absent from the ledger fails the assessment; do not silently broaden removal.

- [ ] **Step 3: Prove the deferred-custody barrier**

  Confirm Plan 3 preserves Git/submodule sources but not all external source
  bytes. Every legacy entry whose removal would discard an external retained-
  source role must remain `removable = false` with the exact
  `complete-external-source-custody` blocker. This is expected, not a failed
  staging implementation.

- [ ] **Step 4: Run tests and verify red**

  ```bash
  scripts/dev-shell.sh bash scripts/test-abi-staging-retirement.sh
  scripts/dev-shell.sh bash -c '
    host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
    cargo test -p xtask --target "$host_target" \
      abi_staging::retirement
  '
  ```

  Expected: FAIL until validator/audit/deprecation markers exist.

- [ ] **Step 5: Implement evidence-based assessment**

  Load exact immutable evidence and recompute every digest. Compare current
  consumers with ledger. Set `removable` only from proven predicates; reject an
  edited Boolean that disagrees. Emit exact blockers for every retained entry.

- [ ] **Step 6: Add concise deprecation markers without disabling paths**

  Point each listed legacy workflow/script at the approved design, replacement
  component, and retirement ledger. Keep behavior unchanged. The tap's
  ABI-specific rollout controller is marked as the first-fixture historical
  controller, never generalized by adding another hardcoded ABI.

- [ ] **Step 7: Run retirement and legacy regression tests**

  ```bash
  scripts/dev-shell.sh bash scripts/test-abi-staging-retirement.sh
  scripts/dev-shell.sh ruby scripts/check-homebrew-publish-workflow-trust.rb
  scripts/dev-shell.sh bash scripts/test-pages-deployment-contract.sh
  scripts/dev-shell.sh env KANDELO_TAP_ROOT="$KANDELO_TAP_ROOT" \
    python3 "$KANDELO_TAP_ROOT/scripts/test_abi42_rollout.py"
  ```

  Expected: PASS with all still-blocked legacy paths present and operational.

- [ ] **Step 8: Commit audit/markers**

  ```bash
  git add tools/xtask/src/abi_staging/retirement.rs \
    tools/xtask/src/abi_staging/mod.rs \
    abi/staging/legacy-retirement.toml \
    scripts/test-abi-staging-retirement.sh \
    .github/workflows/reusable-homebrew-bottle-publish.yml \
    .github/workflows/reusable-homebrew-bottle-maintenance.yml \
    .github/workflows/reusable-homebrew-closed-selection-publish.yml \
    .github/workflows/homebrew-main-shell-ci.yml \
    .github/workflows/homebrew-experimental-vfs-publish.yml \
    .github/workflows/reusable-homebrew-main-shell-mirror-publish.yml \
    .github/workflows/homebrew-native-publisher-compatibility.yml \
    scripts/deploy-gh-pages.sh
  git commit -m "[Homebrew] Record evidence-gated legacy retirement"
  git -C "$KANDELO_TAP_ROOT" add scripts/abi42-rollout.py \
    .github/workflows/selection-checks.yml \
    .github/workflows/dry-run-bottles.yml \
    .github/workflows/maintain-bottles.yml \
    .github/workflows/publish-bottles.yml \
    .github/workflows/publish-main-shell-mirror.yml
  git -C "$KANDELO_TAP_ROOT" commit -m \
    "[Homebrew] Mark legacy tap workflows for retirement"
  ```

---

### Task 14: Assess individually proven legacy entries without deleting them

**Repositories:** Kandelo and tap

**Files:**

- Create or update the assessment that names paths whose Task 13 result has
  `removable = true`; do not delete those paths during this execution.
- Modify: `abi/staging/legacy-retirement.toml`
- Modify focused validation/docs only to record the assessment and remaining
  activation gate.

**Interfaces:**

- Consumes: Task 13 exact assessment.
- Produces: a no-deletion assessment naming any individually qualified
  components and unchanged legacy files.

- [ ] **Step 1: Generate exact removable path set**

  ```bash
  scripts/dev-shell.sh bash -c '
    assessment_dir="$(mktemp -d)"
    assessment_path="$assessment_dir/kandelo-abi-retirement-assessment.json"
    host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
    cargo run -p xtask --target "$host_target" --quiet -- \
      abi-staging retirement assess \
      --ledger abi/staging/legacy-retirement.toml \
      --acceptance abi/staging/acceptance/evidence.generated.json \
      --out "$assessment_path"
    printf "%s\n" "$assessment_path"
  '
  ```

  Retain the printed task-specific path for the remaining steps. Do not target
  a broad directory. Expected first pass while complete external custody is
  deferred: no broad legacy path is removable.

- [ ] **Step 2: Stop safely when no entries qualify**

  If the exact set is empty, run validation, report that legacy cleanup is
  correctly blocked by named predicates, make no deletion commit, and continue
  to documentation/final verification. Do not treat this as incomplete
  promotion/Pages functionality.

- [ ] **Step 3: For each qualifying entry, verify and record exact scope**

  Re-run consumer/custody/evidence checks immediately, compare each exact path
  with the ledger, and verify it is not a directory, glob, or shared
  non-Homebrew component. Record the exact future cleanup set; do not remove
  any component during this execution.

- [ ] **Step 4: Run focused tests for the no-deletion assessment**

  Use each entry's checked-in validation list plus workflow trust, product
  authority, Pages, ABI, docs, and cross-repository tests as applicable. If any
  consumer or test remains, mark the entry blocked; never force the assessment.

- [ ] **Step 5: Commit the retained assessment without removals**

  The commit message leads with the retained retirement contract:

  ```text
  [Homebrew] Record qualified legacy cleanup without deleting it
  ```

  Verify that the commit contains no deleted path and that every qualified
  future cleanup target is named by exact repository and path.

---

### Task 15: Document operational behavior and explicit remaining limits

**Repositories:** Kandelo and tap

**Files:**

- Modify: `docs/abi-versioning.md`
- Modify: `docs/browser-support.md`
- Modify: `docs/homebrew-publishing.md`
- Modify: `docs/binary-releases.md`
- Modify: `docs/repository-organization.md`
- Modify: `docs/future-improvements.md`
- Modify: `Kandelo/README.md` in the tap
- Modify: `README.md` in the tap

**Interfaces:**

- Consumes: actual hosted activation/acceptance/retirement state, not planned
  aspiration.
- Produces: authoritative docs matching deployed facts and remaining blockers.

- [ ] **Step 1: Update ABI and Homebrew lifecycle docs**

  Explain exact-head requests, candidate nonendorsement, contract reuse,
  custody scope, independent verification/override, required/background
  completion, merge-triggered admission, unchanged layer promotion, current
  ABI metadata, and historical repair.

- [ ] **Step 2: Update browser/Pages docs**

  Explain Pages-owned product registry, canonical recomposition, lazy
  boundaries, final evidence, atomic whole-site rollout, and last-complete
  failure behavior. Do not promise future per-product gradual activation.

- [ ] **Step 3: Preserve explicit limitations/future work**

  Keep semantic ABI proof, complete external-source custody, man pages, fork
  exact-SHA authorization if still disabled, generic third-party adapters,
  full stock in-guest Homebrew hosted gate if still diagnostic, and future
  per-product Pages rollout explicit.

- [ ] **Step 4: Describe legacy state exactly**

  List what was removed only if Task 14 proved and removed it. List every
  retained legacy path/category and blocker, especially incomplete external
  custody. Do not say “legacy retired” while the ledger says otherwise.

- [ ] **Step 5: Run docs tests and commit each repository**

  ```bash
  scripts/dev-shell.sh npm run docs:build
  scripts/dev-shell.sh bash scripts/test-abi-staging-retirement.sh
  git add docs/abi-versioning.md docs/browser-support.md \
    docs/homebrew-publishing.md docs/binary-releases.md \
    docs/repository-organization.md docs/future-improvements.md
  git commit -m "[Docs] Describe admitted ABI product delivery"
  git -C "$KANDELO_TAP_ROOT" add Kandelo/README.md README.md
  git -C "$KANDELO_TAP_ROOT" commit -m \
    "[Docs] Describe ABI-qualified tap history"
  ```

---

### Task 16: Final whole-roadmap verification and evidence audit

**Files:**

- Verify all five plans, both repositories, hosted acceptance evidence,
  branch protection, GHCR, Checks, Pages, retention, and retirement ledger.

**Interfaces:**

- Consumes: Tasks 1–15 and Plans 1–4 exit evidence.
- Produces: exact final claims and remaining external/deferred blockers.

- [ ] **Step 1: Run Kandelo unit/integration suites**

  ```bash
  scripts/dev-shell.sh bash scripts/test-abi-staging-product-authority.sh
  scripts/dev-shell.sh bash scripts/test-abi-staging-request-feed.sh
  scripts/dev-shell.sh bash scripts/test-abi-staging-build-bottle.sh
  scripts/dev-shell.sh bash scripts/test-abi-staging-verify-bottle.sh
  scripts/dev-shell.sh bash scripts/test-abi-staging-product-evidence.sh
  scripts/dev-shell.sh bash scripts/test-abi-staging-pages-atomic.sh
  scripts/dev-shell.sh bash scripts/test-abi-staging-retirement.sh
  scripts/dev-shell.sh bash -c '
    host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
    cargo test -p xtask --target "$host_target" abi_staging
  '
  ```

  Expected: PASS.

- [ ] **Step 2: Run browser/VFS/Pages suites**

  ```bash
  scripts/dev-shell.sh npx tsx --test \
    scripts/abi-staging-product-node-evidence.test.ts \
    scripts/abi-staging-product-browser-evidence.test.ts \
    scripts/abi-staging-pages-readiness.test.ts
  scripts/dev-shell.sh bash -c '
    cd host
    npx vitest run \
      test/vfs-product-builder-contract.test.ts \
      test/staged-product-inputs.test.ts \
      test/abi-staging-product-builders.test.ts \
      test/abi-staging-mini-vfs.test.ts \
      test/optional-demo-vfs.test.ts \
      test/lazy-vfs.test.ts \
      test/vfs-image.test.ts
  '
  scripts/dev-shell.sh bash -c '
    cd apps/browser-demos
    npx playwright test test/abi-staging-product-evidence.spec.ts \
      --project=chromium
  '
  scripts/dev-shell.sh bash scripts/test-pages-deployment-contract.sh
  scripts/dev-shell.sh bash scripts/ci-check-pages-deployment.sh
  ```

  Expected: PASS.

- [ ] **Step 3: Run all workflow/security checks**

  ```bash
  scripts/dev-shell.sh ruby scripts/check-homebrew-publish-workflow-trust.rb
  scripts/dev-shell.sh ruby scripts/check-abi-staging-request-workflow.rb
  scripts/dev-shell.sh ruby scripts/check-abi-staging-pr-check-workflow.rb
  scripts/dev-shell.sh bash .github/scripts/test-merge-candidate-workflows.sh
  scripts/dev-shell.sh env KANDELO_TAP_ROOT="$KANDELO_TAP_ROOT" \
    ruby "$KANDELO_TAP_ROOT/scripts/test_check_abi_staging_workflows.rb"
  scripts/dev-shell.sh actionlint
  ```

  Expected: PASS.

- [ ] **Step 4: Run ABI/conformance-relevant checks and docs**

  ```bash
  scripts/dev-shell.sh bash scripts/check-abi-version.sh
  scripts/dev-shell.sh npm run docs:build
  ```

  Run any additional exact conformance/host/browser suites selected by
  `docs/agent-guidance/validation.md` for actual implementation diffs. Report
  commands not run; do not use unit tests to claim ABI semantics.

- [ ] **Step 5: Run complete tap suite**

  ```bash
  scripts/dev-shell.sh env PYTHONPATH="$KANDELO_TAP_ROOT" \
    python3 -m unittest discover \
      -s "$KANDELO_TAP_ROOT/scripts/abi_staging/tests" -v
  scripts/dev-shell.sh env \
    PYTHONPATH="$KANDELO_TAP_ROOT" KANDELO_TAP_ROOT="$KANDELO_TAP_ROOT" \
    python3 -m scripts.abi_staging.cli policy-check \
      --tap-root "$KANDELO_TAP_ROOT"
  scripts/dev-shell.sh env \
    PYTHONPATH="$KANDELO_TAP_ROOT" KANDELO_TAP_ROOT="$KANDELO_TAP_ROOT" \
    python3 -m scripts.abi_staging.cli tap-metadata-check \
      --tap-root "$KANDELO_TAP_ROOT"
  ```

  Expected: PASS.

- [ ] **Step 6: Reverify hosted evidence anonymously/read-only**

  ```bash
  scripts/dev-shell.sh python3 scripts/abi-staging-hosted-acceptance.py \
    verify \
    --fixture abi/staging/acceptance/successor-batch.toml \
    --evidence abi/staging/acceptance/evidence.generated.json
  ```

  Expected: PASS only if every criterion remains publicly verifiable. Re-query
  `abi/N` ref/protection, current tap ABI, required Check, canonical layer
  equality, historical repair, and public Pages site manifest.

- [ ] **Step 7: Audit genericity with fixture-directory exception**

  ```bash
  scripts/dev-shell.sh bash -c '
    generic_paths=(
      tools/xtask/src/abi_staging
      scripts/abi-staging-build-bottle.sh
      scripts/abi-staging-verify-bottle.sh
      scripts/abi-staging-product-node-evidence.ts
      scripts/abi-staging-product-browser-evidence.ts
      scripts/abi-staging-pages-readiness.ts
      "$KANDELO_TAP_ROOT/scripts/abi_staging"
      "$KANDELO_TAP_ROOT/Kandelo/staging/promotion-policy.toml"
      "$KANDELO_TAP_ROOT/.github/workflows/abi-staging-reconcile.yml"
    )
    if rg -n -i "abi[-_ ]?4[23]|integration/abi4[23]" "${generic_paths[@]}"; then
      echo "acceptance fixture leaked into generic implementation" >&2
      exit 1
    fi
    rg -n "integration/abi43-batch-linear-20260801|abi[^a-zA-Z0-9]*4[23]" \
      abi/staging/acceptance docs/superpowers
  '
  ```

  Expected: concrete values appear only in acceptance fixture/evidence and
  historical design/plan prose, not reusable implementation or policy.

- [ ] **Step 8: Audit worktrees, attribution, and retirement outcome**

  ```bash
  scripts/dev-shell.sh bash -c '
    git status --short --branch
    git diff --check origin/main...HEAD
    git log --format=fuller --stat origin/main..HEAD
    git -C "$KANDELO_TAP_ROOT" status --short --branch
    git -C "$KANDELO_TAP_ROOT" diff --check origin/main...HEAD
    git -C "$KANDELO_TAP_ROOT" log --format=fuller --stat origin/main..HEAD
  '
  ```

  Confirm unrelated dirty paths were never committed, contributor attribution
  is preserved, no path was deleted, every qualified future deletion is named
  by a proven ledger entry, and every legacy component remains present.

## Exit Criteria

- Exact merged requests trigger promotion; arbitrary main commits do not.
- Protected `abi/N` exists at the exact preactivation tap state and verified
  protection before any successor canonical/current-ABI mutation.
- Canonical manifests reuse exact candidate bottle layers, anonymous readback
  passes, metadata CAS is narrow, and admissions preserve original producers.
- Tap main never serves prior-ABI bottles as successor current; unpromoted
  Formulae are explicitly unavailable/pending and promote independently.
- Background Formulae continue after merge without a global gate; prior epoch
  drains independently and supports protected repair/security rebuilds.
- Candidate/source retention honors explicit pins, 30-day grace, immediate
  purge boundaries, and deletion tombstones.
- Every Pages registry product is recomposed from admissions with canonical
  references, required evidence reruns, and one complete site manifest.
- Pages deployment code and canaries prove one inert complete artifact through
  separated permissions and hold on an incomplete revision; production
  activation remains deliberately unapplied.
- The exact approved successor fixture demonstrates all supported acceptance
  criteria, or missing remote/protection/permission evidence is reported as a
  hard hosted gate without substitution.
- Legacy assessment qualifies removal only per proven ledger entry, but no
  deletion occurs. Expected source-custody blockers remain visible and prevent
  broad cleanup while complete external custody is deferred.
- Documentation matches what is operational and retains all explicit future
  work and narrower evidence claims.

This plan completes the approved roadmap. It does not authorize semantic ABI
proof work, complete external-source custody, man pages, arbitrary third-party
tap orchestration, or a future per-product Pages rollout.
