# Tap Candidate Bottles, Custody, and Verification Implementation Plan

> **Junior-review edition:** The complete command-level version is preserved
> in docs-only commit `0153a8863`. This edition explains the same interfaces,
> tests, trust boundaries, and commit sequence in plainer language. During
> implementation, use the preserved task details together with any review
> changes approved against this edition.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a validated exact-head request into a tap-owned dependency plan,
safe uncredentialed bottle builds, public nonendorsed candidates, Git source
custody, independent verification, bounded retries, and exact overrides.

**Architecture:** Protected tap code evaluates Formulae from an exact tap
snapshot and creates a complete bottle contract. Uncredentialed jobs build or
verify exact subjects and upload bounded handoffs. Separate protected jobs
validate those handoffs as inert data, publish OCI objects, prove anonymous
readback, and emit immutable records. The reconciler schedules only ready work
and records retry eligibility instead of sleeping.

**Tech Stack:** Python standard library, existing Kandelo Homebrew build tools,
Git bundles/tree archives, `oras`, GHCR, GitHub Actions artifacts, Ruby workflow
tests, and `scripts/dev-shell.sh` for local commands.

## Global Constraints

- Keep Plan 1 record/guard types and Plan 2 request/lifecycle types unchanged.
- Derive ABI from the request. Generic code and namespaces contain no concrete
  acceptance ABI or branch.
- Formula roots come only from selected VFS products. The tap alone resolves
  the actual transitive Formula graph.
- `formula-build-inputs.toml` describes possible build reads; it is not another
  root list and cannot make a Formula required.
- Required Formulae are product gates. Background Formulae are eventually
  consistent and never block the Kandelo merge.
- Bottle identity includes every output-affecting input/policy and excludes PR,
  branch, run, timestamp, and producer provenance.
- Incomplete capture fails before ordinary build or reuse. Only an exact
  `CaptureOverrideAuthorizationV1` can permit that exact subject to build.
- Candidate identity is separate from verification and admission.
- Candidate and verifier jobs have read-only contents, no secrets, no registry
  login, no persisted credentials, and no GitHub write permission.
- Protected publishers execute protected tap code only and parse artifacts as
  bounded regular files. They never source or execute artifact content.
- Candidate bottles live under the visibly nonendorsed
  `homebrew-tap-core-abi-<N>-candidates` namespace. Custody uses the separate
  `homebrew-tap-core-abi-<N>-source-custody` namespace.
- No Formula metadata points to candidates.
- MVP custody preserves Kandelo/tap Git commits, trees, objects, and pinned
  submodules. External-source/native-input receipts are recorded, but complete
  custody of those external bytes is deferred.
- Promotion, tap-main writes, `abi/N`, product VFSs, Kandelo Checks, and Pages
  remain for later plans.
- Exactly three retries follow the initial attempt, and only for protected
  transient-infrastructure classification.
- Retry timing uses the shared deterministic full-jitter vectors. Runners do
  not sleep.
- Identity, integrity, custody, readback, malformed inventory, and credential
  contradictions cannot be overridden.
- Candidate publication begins observe-only and never changes current Formula
  metadata.
- Run every local command through `scripts/dev-shell.sh` and preserve unrelated
  worktree state.

---

## Plain-language data flow

```text
validated request + exact tap snapshot
                |
                v
Formula inventory and dependency graph
                |
                v
complete bottle contract
        |                       |
   exact reuse             uncredentialed build
        |                       |
        +-----------+-----------+
                    v
          bounded inert handoff
                    |
                    v
          protected OCI publisher
                    |
                    v
         public nonendorsed candidate
                    |
                    v
          independent uncredentialed test
                    |
                    v
        protected verification receipt
```

## Exact interfaces

### Tap policy and capture inventory

`TapStagingPolicyV1` fixes repositories/namespaces, batch limit 16, maximum
Formula/edge/handoff/record sizes, six-hour build and verification timeouts,
three retries, 60-second retry base, 15-minute cap, and 30-day ordinary
candidate retention after unmerged close. Unknown fields and false claims of
complete external custody fail.

`FormulaBuildInputPolicyV1` contains reusable acyclic path profiles and exactly
one entry for every direct `Formula/*.rb`. Entries name architectures and
possible Kandelo/tap repository reads. They cannot name runtime dependencies,
products, required/background class, build order, ABI, candidates, or VFS
materialization.

Capture expands profiles and binds exact Git trees, Formula source/resources/
patches, environment/toolchain policy, upstream/native receipts, and direct
dependency layers. Missing, unmatched, unavailable, ambiguous, or undeclared
inputs make `CaptureAssessmentV1.complete = false` with exact diagnostics.

### Tap plan

`TapPlanV1` binds request digest/URL, exact tap source, target ABI, selected
products, every Formula identity/direct dependency/capture/contract, graph
digest, and separate required/background subject lists.

Formula identity includes version, revision, rebuild, architecture, path, and
normalized source digest. Normalization removes only the generated `bottle do`
block. Any other Formula/support change is real source drift.

`schedule_ready_batch` returns at most 16 dependency-ready subjects, required
first, then background, ordered by topological level and exact subject.
Current time affects only retry eligibility.

### `BottleContractV1`

The contract includes exact target ABI/snapshot/architecture, normalized
Formula identity and source components, every Kandelo/tap input, SDK, libc,
sysroot, toolchain, instrumentation, environment, external/native receipts,
direct dependency bottle layers, materialization policies, and build policy.

It excludes request/run/branch/timestamp provenance. Equal complete contract
bytes permit exact reuse. Changed complete input rebuilds the Formula and
dependants. Incomplete capture permits neither ordinary reuse nor construction.

`CandidateReuseRecordV1` links a new request/subject to an existing candidate,
custody, contract, receipts, and original producer without publishing a new
candidate or inventing new provenance. `TapPlanRecordV1` is the immutable plan
record.

### Build handoff

The uncredentialed builder uploads exactly:

```text
handoff/
  inventory.json
  bottle-contract.json
  attempt-record.json
  bottle.tar.gz                 # successful build only
  bottle-metadata.json          # successful build only
  build-result.json
  source-custody/
    manifest.json
    kandelo.bundle
    kandelo-tree.tar
    tap.bundle
    tap-tree.tar
    submodules/<stable files>
  diagnostics/summary.txt
```

The inventory lists every relative regular file with role, digest, and bytes.
No symlink, hardlink, device, FIFO, socket, absolute/dot path, duplicate, or
unlisted file is allowed. A failed attempt has no bottle and no candidate.

### Source custody

`SourceCustodyManifestV1` binds exact repositories, commits, trees, members,
and submodule relationships. Protected validation uses `git bundle verify`,
`git fsck`, `git cat-file`, and deterministic archive inventory without
checkout hooks or candidate commands. External receipts remain records; their
source bytes are explicitly outside this MVP capsule.

### OCI publication

```python
@dataclass(frozen=True)
class PublishedRecordLocatorV1:
    repository: str
    digest: str
    immutable_reference: str
    anonymous_readback_sha256: str
```

Protected code computes canonical OCI manifest identity before upload, pushes
blobs/manifests by digest, resolves by digest, and performs anonymous readback.
Content-addressed tags are discovery hints only. The locator is outside the
record bytes it names.

The candidate manifest is the candidate record plus exact bottle/custody
descriptors and nonendorsed annotations. A contract-index tag may help discover
reuse but is never trusted without full contract/record validation.

### Verification, retries, and overrides

`VerificationResultV1` binds exact candidate/layer/test definition/outcome and
bounded diagnostics. Protected receipt code re-fetches by digest before
publishing `VerificationReceiptV1`.

Only runner loss, artifact unavailability, GitHub/registry rate limit or server
error, and transport reset before application execution are transient.
Application nonzero exit, contract/capture failure, source failure, malformed
artifact, or integrity mismatch is not.

```text
window_ms = min(cap_ms, base_ms * 2^(retry_number - 1))
seed = SHA256(request_digest NUL exact_subject NUL retry_number)
delay_ms = big_endian_u64(seed[0..8]) mod (window_ms + 1)
```

Retries are 1–3 after attempt 0. A maintainer may request a post-exhaustion
attempt, but that is maintenance rather than an override. Capture override
names the exact pre-build subject; artifact override requires an existing exact
candidate. Integrity guards are never selectable.

## File map

### Kandelo

- Create build/verify scripts and their tests:
  `scripts/abi-staging-{build,verify}-bottle.sh`.
- Modify staging record modules and foundation test.
- Create shared retry vector fixture.
- Modify Homebrew/ABI/future-work documentation.

### Tap

- Create policy, capture inventory, generated data, activation, verification
  definitions, and fixtures under `Kandelo/staging/`.
- Add Python modules: `policy`, `formula_inventory`, `plan`, `contract`,
  `scheduler`, `handoff`, `custody`, `records`, `oci`, `verification`, and
  `override`, plus one focused test module for each.
- Modify the Plan 2 package, CLI, and reconciler.
- Modify `.github/workflows/abi-staging-reconcile.yml`.
- Create `.github/workflows/abi-staging-maintenance.yml`.
- Extend workflow trust/mutation tests and tap documentation.

---

### Task 1: Define tap policy and complete Formula capture inventory

**Files:** Create tap policy/capture/generated/activation/verification files,
`policy.py`, and `test_policy.py`.

**Interfaces:** Produces `TapStagingPolicyV1`,
`FormulaBuildInputPolicyV1`, policy check/generation commands, and observe-only
candidate activation.

- [ ] Write failing tests for exact limits, namespaces, unknown fields, profile
  cycles, safe paths, no ABI literal, one entry per Formula, and forbidden
  dependency/product/scheduling fields.
- [ ] Freeze the observed read set for every Formula as negative fixtures;
  missing coverage reports Formula, path, kind, architecture, and override
  subject.
- [ ] Run `test_policy.py` through the Kandelo dev shell with
  `PYTHONPATH="$KANDELO_TAP_ROOT"`; confirm red.
- [ ] Implement strict loading/profile expansion/canonical generation.
- [ ] Audit every current Formula/support/patch/recipe/build entrypoint and
  populate exact entries. Report any unrepresentable observed read.
- [ ] Run policy freshness and unit tests; expect PASS in observe mode.
- [ ] Commit the policy group in the tap.

---

### Task 2: Normalize the exact Formula inventory and graph

**Files:** Create Formula inventory fixture, `formula_inventory.py`, and its
tests.

**Interfaces:** Produces `FormulaInventoryV1` with exact identities,
architectures, direct dependencies, source/resources/patches, and normalized
source digests.

- [ ] Write failing tests around the read-only Formula probe, bounds,
  deterministic order, generated bottle-block exclusion, and rejection of all
  other source drift.
- [ ] Run focused tests; confirm red.
- [ ] Implement one protected probe at the exact tap snapshot and validate its
  inert output against Formula/sidecar files.
- [ ] Generate the exact current fixture and rerun tests; expect PASS.
- [ ] Commit in the tap.

---

### Task 3: Separate required work from background work

**Files:** Create tap-plan fixture, `plan.py`, `test_plan.py`; modify tap
records/CLI.

**Interfaces:** Produces `TapPlanV1`, `FormulaPlanV1`, and `TapPlanRecordV1`.

- [ ] Write failing tests proving required roots come only from request
  products; required transitive dependencies are included; unrelated Formulae
  are background; product failures block only affected products; and graph
  order is deterministic.
- [ ] Run focused tests; confirm red.
- [ ] Implement graph closure/classification without a global completion gate.
- [ ] Rerun tests and canonical fixture generation; expect PASS.
- [ ] Commit in the tap.

---

### Task 4: Calculate complete contracts and exact reuse

**Files:** Create contract fixture, `contract.py`, `test_contract.py`; modify
Kandelo/tap record modules.

**Interfaces:** Produces `BottleContractV1`, `CaptureAssessmentV1`, and
`CandidateReuseRecordV1`.

- [ ] Write failing capture tests for complete, missing, ambiguous, undeclared,
  changed Git/toolchain/source/dependency/policy inputs.
- [ ] Write failing identity tests proving provenance-only request changes
  reuse exact candidate/custody/producer while any output-affecting change
  rebuilds the Formula and reverse dependants.
- [ ] Run Rust and Python contract tests; confirm red.
- [ ] Implement canonical contract calculation. Incomplete capture returns its
  guard before contract/reuse.
- [ ] Rerun tests and cross-language record fixtures; expect PASS.
- [ ] Commit the matching Kandelo/tap record changes separately.

---

### Task 5: Seal the uncredentialed build handoff

**Files:** Create Kandelo build script/test; create tap handoff fixtures,
`handoff.py`, and `test_handoff.py`.

**Interfaces:** Produces `BuildHandoffInventoryV1`, exact build result, and the
fixed handoff tree above.

- [ ] Write failing shell tests for credential stripping, exact source/
  dependencies, normal SDK/build path, success/failure/timeout, and no network
  publication.
- [ ] Write failing protected handoff tests for every unsafe/unlisted/missing/
  mismatched file and bounded diagnostics.
- [ ] Run both suites; confirm red.
- [ ] Implement the smallest uncredentialed wrapper and inert validator.
- [ ] Rerun; expect PASS and no candidate claim for failure.
- [ ] Commit Kandelo and tap changes separately.

---

### Task 6: Preserve exact Git source custody

**Files:** Create source-custody fixture, `custody.py`, and
`test_custody.py`; modify handoff validation.

**Interfaces:** Produces `SourceCustodyManifestV1`, bundles/tree archives, and
protected custody verification.

- [ ] Write failing tests for exact commits/trees, missing objects, wrong
  submodules, nondeterministic archives, unsafe members, and receipt mismatch.
- [ ] Run focused tests; confirm red.
- [ ] Implement bundle/archive creation in the uncredentialed job and inert Git
  verification in protected code.
- [ ] Rerun tests twice; expect byte-stable custody identities.
- [ ] Commit in the tap.

---

### Task 7: Publish immutable source and candidate OCI objects

**Files:** Create `records.py`, `oci.py`, their tests; modify CLI.

**Interfaces:** Produces canonical record encoding, `publish_record`,
`PublishedRecordLocatorV1`, candidate/source repository naming, and anonymous
readback validation.

- [ ] Write failing record tests for canonical bytes, closed variants, no
  self-digest, nonendorsed annotations, exact descriptor sizes/digests, and
  producer provenance.
- [ ] Write failing OCI tests with a fake registry for blob/manifest order,
  digest resolution, package association, anonymous readback, idempotence,
  collisions, tag distrust, and bounded responses.
- [ ] Run focused tests; confirm red.
- [ ] Implement protected standard-library OCI planning plus `oras` execution.
  Compute identity before upload and return the locator outside record bytes.
- [ ] Verify repository association and anonymous bytes after every write.
- [ ] Rerun tests; expect PASS and failure guards for namespace/readback errors.
- [ ] Commit in the tap.

---

### Task 8: Verify exact public candidate bytes independently

**Files:** Create Kandelo verify script/test; create tap `verification.py` and
its tests.

**Interfaces:** Produces uncredentialed `VerificationResultV1` and protected
`VerificationReceiptV1` publication.

- [ ] Write failing verifier tests proving it downloads by immutable digest,
  verifies manifest/layer/contract, applies the exact definition, emits bounded
  inert results, has no credentials, and never mutates the candidate.
- [ ] Write failing receipt tests proving protected code re-fetches public
  bytes and rejects subject/test/run/result disagreement.
- [ ] Run both suites; confirm red.
- [ ] Implement uncredentialed verification and protected receipt emission.
- [ ] Rerun tests, including the host public-bottle verifier test; expect PASS.
- [ ] Commit Kandelo and tap changes separately.

---

### Task 9: Schedule ready work and deterministic retries

**Files:** Create shared retry-vector fixture, tap `scheduler.py` and tests;
modify reconciler.

**Interfaces:** Produces `RetryDecisionV1`, `schedule_ready_batch`, exact shared
jitter vectors, and bounded ready batches.

- [ ] Write failing cross-language retry-vector tests for attempts 0–3,
  inclusive windows, cap behavior, seed changes, exhaustion, and invalid
  ordinals.
- [ ] Write failing scheduler tests for dependency readiness, required-first
  order, 16-subject bound, background progress, close/reopen history, retry
  eligibility, and no sleep call.
- [ ] Write failing classification cases that distinguish infrastructure from
  application/contract/integrity failures.
- [ ] Run Rust/Python tests; confirm red.
- [ ] Implement the exact formula and pure scheduling/classification.
- [ ] Rerun both suites; expect identical decisions and no runner sleep.
- [ ] Commit retry vectors in Kandelo and scheduler code in the tap.

---

### Task 10: Add exact capture and artifact override workflows

**Files:** Create tap `override.py`, tests, and
`.github/workflows/abi-staging-maintenance.yml`; extend workflow checkers.

**Interfaces:** Produces exact capture authorization, artifact override receipt,
manual retry-after-exhaustion, and protected maintenance commands.

- [ ] Write failing policy tests: capture authorization names exact request,
  Formula, architecture, contract, guard, maintainer, and reason; artifact
  override names an existing exact candidate and allowed verification guard;
  integrity/identity/custody/readback/dependency guards fail selection.
- [ ] Write failing workflow mutations for broad subject, guessed digest,
  candidate code in write job, excessive permissions, hidden receipt,
  history deletion, and relabeling manual retry as override.
- [ ] Run unit/workflow tests; confirm red.
- [ ] Implement separated authorization, normal uncredentialed build, and
  post-build protected receipt. Manual retry adds a new attempt without
  deleting history or creating an override.
- [ ] Rerun unit, mutation, and actionlint checks; expect PASS.
- [ ] Commit in the tap.

---

### Task 11: Connect one bounded candidate pipeline to reconciliation

**Files:** Modify tap reconcile workflow, reconciler, CLI, and workflow tests.

**Interfaces:** Adds observe/active ready-batch orchestration while keeping
build, publish, verify, and receipt jobs capability-separated.

- [ ] Write failing workflow structure/mutation tests for protected plan job,
  uncredentialed matrix build, protected inert publisher, uncredentialed
  verifier, protected receipt publisher, artifact inventory, exact subject,
  batch bound, no candidate metadata write, and no credential crossing.
- [ ] Write failing reconciliation tests for build/reuse/dependency/background/
  retry/close/reopen cases and idempotent records.
- [ ] Run tests; confirm red.
- [ ] Implement observe mode first: compute and summarize intended work without
  dispatch/publication. In active mode, dispatch only validated ready subjects
  through the separated jobs.
- [ ] Rerun complete tap unit/workflow suites; expect PASS and bounded runs.
- [ ] Commit in the tap.

---

### Task 12: Run hosted candidate canaries before activation

**Files:** Modify candidate activation and Kandelo/tap documentation.

**Interfaces:** Produces exact hosted evidence and only then an activation
change from `observe` to `active`.

- [ ] Land observe-only code on protected tap main or stop at the hosted gate.
- [ ] Prove the candidate build job has no write credential or secrets.
- [ ] Run one successful build/custody/publication/readback/verification canary
  and retain exact run, record, and OCI digests.
- [ ] Run failure canaries for incomplete capture, malformed handoff, failed
  public readback, nontransient build failure, and transient retry scheduling.
- [ ] Prove identical contract reuse across provenance-only request change and
  rebuild after one complete input changes.
- [ ] Verify GHCR repository association and anonymous readback from a fresh
  unauthenticated client.
- [ ] Change only candidate activation to `active`, rerun local suites, and
  commit. Do not enable promotion, product VFS, Check, or Pages.
- [ ] Update docs to state exactly what is active and that external source bytes
  remain incompletely custodied.

---

### Task 13: Run the final Plan 3 capability audit and stop

**Files:** Verify every Plan 3 file in both repositories.

**Interfaces:** Produces evidence for tap planning/candidates/custody/
verification/retries/overrides only.

- [ ] Run the Plan 1 foundation suite and all new Kandelo build/verify/retry
  tests through `scripts/dev-shell.sh`.
- [ ] Run the full tap Python suite, workflow mutation tests, `actionlint`, and
  cross-repository request harness with `KANDELO_TAP_ROOT`.
- [ ] Run Homebrew publish workflow/trust tests and ABI checks.
- [ ] Audit workflow permissions and artifacts manually: candidate and verifier
  jobs are uncredentialed; only protected publishers write packages; no job
  mutates tap main or Kandelo Checks.
- [ ] Search generic infrastructure for concrete acceptance ABI/branch values,
  unfinished tokens, sleeps, `--clobber`, mutable latest tags, candidate URLs
  in Formula metadata, and a parallel staging root list.
- [ ] Audit both worktrees/commit histories and stop before product VFS work.

## Exit criteria

- Tap roots derive only from selected products; the tap resolves the real
  dependency graph and keeps background work separate.
- Every Formula has exact capture policy; incomplete capture fails immediately
  unless the exact subject has a protected authorization.
- Equal complete contracts reuse an existing candidate without rewriting
  producer provenance; changed complete inputs rebuild affected dependants.
- Candidate builds and verification have no write credentials.
- Protected code validates bounded inert handoffs and public bytes by digest.
- Exact Git custody and external/native receipts exist without claiming
  complete external byte custody.
- Candidates are public, immutable, visibly nonendorsed, associated with the
  repository, and anonymously readable.
- Verification and overrides are separate immutable records.
- Exactly three deterministic transient retries occur without sleeping.
- No promotion, tap-main/ABI-branch write, product VFS, Kandelo Check, or Pages
  behavior exists yet.

After these criteria pass, execute Plan 4. Public candidate availability alone
does not mean endorsement or admission.
