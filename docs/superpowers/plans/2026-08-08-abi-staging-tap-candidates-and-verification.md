# ABI Staging Tap Candidates, Custody, and Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn validated exact-head requests into tap-owned dependency plans,
complete bottle contracts, uncredentialed candidate builds, preserved Git
source custody, public nonendorsed OCI candidates, independent verification
receipts, bounded deterministic retries, and exact maintainer overrides.

**Architecture:** Protected tap code snapshots its exact commit, evaluates its
reviewed Formula inventory into inert normalized data, derives required roots
only from Kandelo request products, and resolves a separate eventually
consistent background set. A complete `BottleContractV1` determines reuse or
rebuild. Candidate jobs execute exact Kandelo/tap sources without write
credentials and upload a bounded handoff. Separate protected jobs validate
every regular file and identity, build deterministic OCI manifests, publish to
visibly nonendorsed/source namespaces, and verify anonymous readback. A second
uncredentialed job tests the exact public candidate digest; another protected
job publishes an immutable receipt. Reconciliation schedules only ready
subjects in bounded batches and records deterministic retry eligibility instead
of sleeping.

**Tech Stack:** Python standard library for protected tap planning, contracts,
records, OCI HTTP, and test fakes; existing Kandelo Homebrew build/inspection
scripts behind a new uncredentialed handoff; Git and deterministic archives for
MVP source custody; `oras` and GHCR for hosted OCI publication; GitHub Actions
artifacts as the inert cross-job bridge; Ruby workflow mutation tests; and
Kandelo `scripts/dev-shell.sh` for every local build/validation command.

## Global Constraints

- Consume Plan 1 product/record/guard contracts and Plan 2 request/lifecycle
  contracts without renaming them or adding mutable status to requests.
- All generic code derives target ABI from the request. No reusable path,
  namespace helper, policy, scheduler, or workflow contains an acceptance ABI
  or branch literal.
- Formula roots come exclusively from request-selected VFS products. The tap
  resolves actual transitive dependencies from its own exact Formula snapshot.
  `formula-build-inputs.toml` captures build inputs; it is not a staging root
  selector and cannot make an unselected Formula required.
- The plan contains two independent completion models: all required Formulae
  for a selected product must be usable; background Formulae continue
  independently and never gate a Kandelo merge.
- Contract identity includes output-affecting bytes and policies, not request
  head, PR number, branch, run, job, timestamp, or producer commit merely as
  provenance. Same complete contract may reuse an older candidate.
- Incomplete capture returns `build_input_capture_incomplete` before ordinary
  construction. It neither builds nor silently reuses. Only an exact
  `CaptureOverrideAuthorizationV1` permits that exact request, Formula,
  architecture, and contract to enter the normal uncredentialed builder.
- A candidate is public, immutable, content-addressed, visibly nonendorsed, and
  separate from verification. A failed verification leaves candidate bytes
  public but ordinarily ineligible.
- Candidate and verification execution have `contents: read`, no secrets, no
  registry login, no persisted credential, and no GitHub write permission.
- Protected publishers execute only protected tap code. They parse downloaded
  handoffs as bounded regular-file inventories, never source environment files,
  run artifact scripts, follow artifact symlinks, or trust artifact paths.
- Candidate packages use
  `ghcr.io/kandelo-dev/homebrew-tap-core-abi-<N>-candidates/<formula>`.
  Source custody uses
  `ghcr.io/kandelo-dev/homebrew-tap-core-abi-<N>-source-custody`.
  No Formula metadata points to the candidate namespace.
- The first source-custody MVP preserves exact Kandelo and tap Git commits,
  trees, required Git objects, pinned submodule commits, and required submodule
  content. It records upstream source/native input receipts but does not claim
  complete custody of every external source byte.
- Promotion, tap-main mutation, `abi/N` branches, candidate VFS products,
  Kandelo Checks, and Pages remain out of scope until later plans.
- Retry count is exactly three after the initial attempt for a protected
  classification of transient infrastructure failure. Application,
  deterministic contract, and integrity failures are not automatically
  retried.
- Retry delay uses Plan 1's exact SHA-256/NUL/full-jitter algorithm and records
  `next_eligible_at`; no workflow step sleeps until eligibility.
- Overrides cannot waive malformed/unauthorized request, source/ABI/arch/
  Formula mismatch, missing bytes, hash/size mismatch, unsafe inventory,
  identity collision, required custody mismatch, failed public readback, or
  candidate execution with write authority.
- All action references are full 40-character SHA pins with version comments.
- Existing legacy publishers remain operational and separately authoritative
  during rollout. New candidate publication begins observe-only and never
  updates current Formula metadata.
- Preserve unrelated worktree state. Run every local command through
  `scripts/dev-shell.sh`.

---

## Interfaces

### Tap policy and Formula build-input capture

`Kandelo/staging/tap-policy.toml` is `TapStagingPolicyV1`:

```toml
schema = 1
kind = "kandelo-tap-staging-policy"
version = 1
tap_repository = "kandelo-dev/homebrew-tap-core"
kandelo_repository = "Automattic/kandelo"
candidate_owner = "kandelo-dev"
candidate_repository_prefix = "homebrew-tap-core-abi-"
candidate_suffix = "-candidates"
source_custody_suffix = "-source-custody"
max_ready_subjects_per_cycle = 16
max_formulae = 256
max_edges = 4096
max_handoff_files = 256
max_handoff_bytes = 4294967296
max_record_bytes = 4194304
build_timeout_minutes = 360
verification_timeout_minutes = 360
automatic_retry_count = 3
retry_base_ms = 60000
retry_cap_ms = 900000
candidate_retention_days_after_unmerged_close = 30

[source_custody]
required_git_roles = ["kandelo", "tap", "pinned-submodule"]
external_source_bytes = "deferred"
```

Unknown fields fail. Numeric values are bounded, retry count must be exactly
three, build timeout exactly six hours, and source custody cannot claim
complete external-source coverage.

`Kandelo/staging/formula-build-inputs.toml` is
`FormulaBuildInputPolicyV1`. It has named, acyclic profiles plus exactly one
entry for every direct `Formula/*.rb` file:

```toml
schema = 1
kind = "kandelo-formula-build-inputs"
version = 1

[profiles.kandelo-common]
kandelo_paths = [
  "flake.nix",
  "flake.lock",
  "sdk",
  "libc",
  "crates/fork-instrument",
  "scripts/homebrew-bottle-build.sh",
  "scripts/run-wasm-fork-instrument.sh",
]
tap_paths = ["Kandelo/formula_support"]
environment_policy = "kandelo-homebrew-build-v1"

[[formulae]]
name = "bash"
architectures = ["wasm32"]
profiles = ["kandelo-common"]
kandelo_paths = []
tap_paths = []
```

The actual checked-in inventory contains the exact current Formula names and
architecture support; the example is shape only. Paths identify possible
repository reads. They do not name runtime dependencies, required products,
build order, candidate references, ABI values, or VFS materialization. The
tap's evaluated Formula graph remains dependency authority.

Capture validation expands profiles, hashes each regular file/tree against the
exact Kandelo/tap Git tree, binds environment/toolchain policy, Formula source,
resources, patches, upstream receipts, native-input receipts, and direct
dependency layers. A missing Formula entry, unmatched evaluated source role,
unavailable path, ambiguous generated input, or undeclared read produces an
incomplete assessment with exact diagnostics.

### Tap plan and scheduling

```python
@dataclass(frozen=True)
class FormulaIdentityV1:
    name: str
    version: str
    revision: int
    rebuild: int
    architecture: Literal["wasm32", "wasm64"]
    formula_path: str
    normalized_formula_sha256: str

@dataclass(frozen=True)
class FormulaDependencyV1:
    formula: str
    architecture: Literal["wasm32", "wasm64"]
    materialization_policy_sha256: str

@dataclass(frozen=True)
class FormulaPlanV1:
    identity: FormulaIdentityV1
    direct_dependencies: tuple[FormulaDependencyV1, ...]
    required_by_products: tuple[str, ...]
    work_class: Literal["required", "background"]
    capture: Mapping[str, object]
    contract_sha256: str | None

@dataclass(frozen=True)
class TapPlanV1:
    schema: int
    kind: Literal["kandelo-abi-staging-tap-plan"]
    request_digest: str
    request_asset_url: str
    tap_source: Mapping[str, str]
    target_abi: Mapping[str, object]
    selected_products: tuple[Mapping[str, object], ...]
    formulae: tuple[FormulaPlanV1, ...]
    graph_sha256: str
    required_subjects: tuple[str, ...]
    background_subjects: tuple[str, ...]
```

The planner evaluates Formulae at the exact snapshotted tap commit through a
read-only probe and validates that normalized probe output against the Formula
and sidecar files. It strips only the generated `bottle do` block before
computing `normalized_formula_sha256`; generated bottle metadata updates do
not manufacture tap-source drift. Any other Formula/support change does.

`schedule_ready_batch(plan, records, lifecycle, now)` returns at most sixteen
dependency-ready subjects, required first, then background, each ordered by
topological level and exact subject string. `now` affects retry eligibility
only; it never changes request applicability, identity, or ordering among
already eligible subjects.

### Bottle contract and reuse

`BottleContractV1` is canonical JSON with exact keys:

```text
schema
kind = kandelo-homebrew-bottle-contract
target = { abi, snapshot_sha256, architecture }
formula = { name, version, revision, rebuild,
            normalized_source_sha256, source_components }
kandelo_inputs = [{ id, kind, path, sha256 }]
tap_inputs = [{ id, kind, path, sha256 }]
sdk = { policy_sha256, component_sha256 }
libc = { policy_sha256, component_sha256 }
sysroot = { policy_sha256, component_sha256 }
toolchain = { policy_sha256, component_sha256 }
instrumentation = { policy_sha256, component_sha256 }
environment = { policy_sha256, variables_sha256 }
sources = [{ role, url, sha256, receipt_sha256 }]
native_inputs = [{ role, identity, sha256, receipt_sha256 }]
direct_dependencies = [{ formula, architecture, bottle_layer_sha256,
                         bottle_layer_bytes,
                         materialization_policy_sha256 }]
build_policy_sha256
```

Arrays sort by stable identity. Provenance fields are absent. The contract
digest is SHA-256 of canonical bytes. `CaptureAssessmentV1` contains
`complete`, sorted `captured`, sorted `missing`, sorted `ambiguous`, affected
products, and exact override subject. Only a complete assessment produces an
ordinary contract/reuse decision.

`CandidateReuseRecordV1` is added to the Plan 1 closed record enum. It binds a
new request and exact subject to an existing candidate record, contract,
source-custody locator, qualifying receipts, and original producer. It does
not create a new candidate or rewrite producer provenance.

`TapPlanRecordV1` is also added as the immutable, canonical form of
`TapPlanV1`. Unknown older validators fail closed until they are updated; the
new variants do not change existing record meanings.

### Build handoff

An uncredentialed build uploads exactly one directory:

```text
handoff/
  inventory.json
  bottle-contract.json
  attempt-record.json
  bottle.tar.gz                 # success only
  bottle-metadata.json          # success only
  build-result.json
  source-custody/
    manifest.json
    kandelo.bundle
    kandelo-tree.tar
    tap.bundle
    tap-tree.tar
    submodules/
      <stable-id>.bundle
      <stable-id>-tree.tar
  diagnostics/
    summary.txt
```

`BuildHandoffInventoryV1` lists every relative regular file with role, SHA-256,
and byte count. It has no symlink, hardlink, device, FIFO, socket, absolute
path, dot component, duplicate normalized path, or unlisted file. Failed
attempts omit bottle files and cannot claim a candidate. Success requires exact
bottle bytes and metadata.

The build command is:

```text
scripts/abi-staging-build-bottle.sh
  --request request.json
  --tap-plan tap-plan.json
  --formula-plan formula-plan.json
  --dependency-root dependency-inputs
  --handoff handoff
```

It strips GitHub, GHCR, Homebrew API, npm, SSH, cloud, and identity-token
credentials; uses the worktree-local SDK and existing normal Homebrew build
path; verifies exact dependency layers; and never publishes.

### Source custody

`SourceCustodyManifestV1` binds every member plus exact Git repository, commit,
tree, and submodule relationship. Git bundles contain required objects for the
named commits; deterministic tree archives are convenience views. The
protected validator uses `git bundle verify`, `git fsck`, `git cat-file`, and
tree/archive inventory checks without checkout hooks or candidate commands.

External source and native input receipts remain in the bottle contract and
attempt/candidate records. Their bytes are not placed in the MVP capsule, and
documentation retains that limitation.

### OCI record transport

```python
@dataclass(frozen=True)
class PublishedRecordLocatorV1:
    repository: str
    digest: str
    immutable_reference: str
    anonymous_readback_sha256: str

def publish_record(
    repository: str,
    record_bytes: bytes,
    descriptors: tuple[Mapping[str, object], ...],
) -> PublishedRecordLocatorV1: ...
```

The protected publisher locally builds canonical OCI manifest bytes, computes
their digest before upload, pushes blobs by digest, pushes the manifest under
`record-sha256-<record-digest>`, resolves it by digest, and performs anonymous
readback. The returned locator is not part of the bytes whose digest it names.
Content-addressed tags are discovery hints; every consumer uses and validates
the digest reference.

The candidate OCI manifest is the candidate record. It contains the exact
bottle-layer and source-custody descriptors plus nonendorsed annotations. Its
OCI digest is `candidate_record_digest`. A separate contract-index tag may
point to the first valid candidate for reuse, but it is never trusted without
validating manifest bytes and the complete contract.

Namespace bootstrap is lazy. After every first/later write, protected code
verifies GitHub repository association, manifest/layer digests and sizes, and
anonymous public readback. Failure emits `namespace_bootstrap_failed` or
`candidate_public_readback_failed` and makes the candidate ineligible.

### Verification, retries, and overrides

`VerificationResultV1` is an inert handoff binding exact candidate digest,
layer digest/bytes, test-definition digest, outcome, bounded diagnostics, and
run/job facts. The protected receipt publisher re-fetches the candidate by
digest and verifies every field before emitting `VerificationReceiptV1`.

Protected failure classification consumes GitHub job conclusion, bounded HTTP
status facts, artifact-service facts, and the builder's terminal result. Only
runner loss, Actions artifact unavailability, registry/GitHub rate limiting or
server errors, and transport reset before application execution classify as
`transient_infrastructure_failure`. A Formula build/test nonzero exit,
contract/capture failure, source 404/digest mismatch, malformed artifact, or
integrity failure never does.

Automatic retries are numbered `1`, `2`, and `3` after initial ordinal `0`.
Python must match Plan 1 vectors exactly:

```text
window_ms = min(cap_ms, base_ms * 2^(retry_number - 1))
seed = SHA256(request_digest NUL exact_subject NUL retry_number)
delay_ms = big_endian_u64(seed[0..8]) mod (window_ms + 1)
```

`CaptureOverrideAuthorizationV1` and `OverrideReceiptV1` retain Plan 1
meanings. A manual exhausted-retry request is a maintenance action and does not
emit an override receipt. Artifact risk acceptance requires an existing exact
candidate. Integrity guards remain impossible to select.

## File Map

### Kandelo repository

- Create: `scripts/abi-staging-build-bottle.sh`
- Create: `scripts/test-abi-staging-build-bottle.sh`
- Create: `scripts/abi-staging-verify-bottle.sh`
- Create: `scripts/test-abi-staging-verify-bottle.sh`
- Modify: `tools/xtask/src/abi_staging/records.rs`
- Modify: `tools/xtask/src/abi_staging/mod.rs`
- Create: `tools/xtask/tests/fixtures/abi-staging/retry-vectors.json`
- Modify: `scripts/test-abi-staging-product-authority.sh`
- Modify: `docs/homebrew-publishing.md`
- Modify: `docs/abi-versioning.md`
- Modify: `docs/future-improvements.md`

### Tap repository

- Create: `Kandelo/staging/tap-policy.toml`
- Create: `Kandelo/staging/formula-build-inputs.toml`
- Create: `Kandelo/staging/generated/formula-build-inputs.json`
- Create: `Kandelo/staging/candidate-publication-activation.toml`
- Create: `Kandelo/staging/verification-tests.toml`
- Create: `Kandelo/staging/fixtures/formula-inventory.json`
- Create: `Kandelo/staging/fixtures/tap-plan.json`
- Create: `Kandelo/staging/fixtures/bottle-contract.json`
- Create: `Kandelo/staging/fixtures/build-handoff/inventory.json`
- Create: `Kandelo/staging/fixtures/build-handoff/build-result.json`
- Create: `Kandelo/staging/fixtures/source-custody/manifest.json`
- Modify: `scripts/abi_staging/__init__.py`
- Modify: `scripts/abi_staging/cli.py`
- Modify: `scripts/abi_staging/reconcile.py`
- Create: `scripts/abi_staging/policy.py`
- Create: `scripts/abi_staging/formula_inventory.py`
- Create: `scripts/abi_staging/plan.py`
- Create: `scripts/abi_staging/contract.py`
- Create: `scripts/abi_staging/scheduler.py`
- Create: `scripts/abi_staging/handoff.py`
- Create: `scripts/abi_staging/custody.py`
- Create: `scripts/abi_staging/records.py`
- Create: `scripts/abi_staging/oci.py`
- Create: `scripts/abi_staging/verification.py`
- Create: `scripts/abi_staging/override.py`
- Create: `scripts/abi_staging/tests/test_policy.py`
- Create: `scripts/abi_staging/tests/test_formula_inventory.py`
- Create: `scripts/abi_staging/tests/test_plan.py`
- Create: `scripts/abi_staging/tests/test_contract.py`
- Create: `scripts/abi_staging/tests/test_scheduler.py`
- Create: `scripts/abi_staging/tests/test_handoff.py`
- Create: `scripts/abi_staging/tests/test_custody.py`
- Create: `scripts/abi_staging/tests/test_records.py`
- Create: `scripts/abi_staging/tests/test_oci.py`
- Create: `scripts/abi_staging/tests/test_verification.py`
- Create: `scripts/abi_staging/tests/test_override.py`
- Modify: `.github/workflows/abi-staging-reconcile.yml`
- Create: `.github/workflows/abi-staging-maintenance.yml`
- Modify: `scripts/check_abi_staging_workflows.rb`
- Modify: `scripts/test_check_abi_staging_workflows.rb`
- Modify: `Kandelo/README.md`
- Modify: `README.md`

---

### Task 1: Define tap staging policy and complete Formula capture inventory

**Repository:** `kandelo-dev/homebrew-tap-core`

**Files:**

- Create: `Kandelo/staging/tap-policy.toml`
- Create: `Kandelo/staging/formula-build-inputs.toml`
- Create: `Kandelo/staging/generated/formula-build-inputs.json`
- Create: `Kandelo/staging/candidate-publication-activation.toml`
- Create: `Kandelo/staging/verification-tests.toml`
- Create: `scripts/abi_staging/policy.py`
- Create: `scripts/abi_staging/tests/test_policy.py`

**Interfaces:**

- Consumes: Plan 2 tap canonical helpers and exact current Formula tree.
- Produces: strict `TapStagingPolicyV1`, `FormulaBuildInputPolicyV1`, generated
  normalized capture catalog, verification test-definition digests, and
  activation `mode = "observe" | "active"` beginning at `observe`.

- [ ] **Step 1: Write failing policy and inventory tests**

  Assert exact timeout/retry/retention values, namespace grammar, unknown-field
  rejection, acyclic profiles, safe paths, no ABI literal, and exact one-to-one
  coverage of every direct `Formula/*.rb`. Reject an entry that names a runtime
  dependency, product, required/background class, VFS materialization,
  candidate URL, or build order.

- [ ] **Step 2: Freeze observed input coverage as negative fixtures**

  For every Formula, compare evaluated Formula source/resource/patch roles and
  the normal Kandelo build entrypoints it invokes with expanded capture paths.
  A currently read path absent from policy must fail with the Formula, path,
  input kind, affected architectures, and exact override subject. Do not add a
  wildcard that silently captures unrelated repository state.

- [ ] **Step 3: Run tests and verify red**

  ```bash
  scripts/dev-shell.sh env \
    PYTHONPATH="$KANDELO_TAP_ROOT" KANDELO_TAP_ROOT="$KANDELO_TAP_ROOT" \
    python3 -m unittest \
      scripts.abi_staging.tests.test_policy -v
  ```

  Expected: FAIL because policy support is absent.

- [ ] **Step 4: Implement strict policy loading and generation**

  Resolve profile paths deterministically, hash path strings only in the
  generated catalog, and defer Git content hashing to exact plan time. The
  generator emits every Formula entry sorted by name and every architecture,
  profile, and path sorted and duplicate-free.

- [ ] **Step 5: Populate all current Formula entries from repository evidence**

  Audit the exact current `Formula/`, `Kandelo/formula_support/`, patches,
  recipes, and Kandelo build entrypoints. Use shared profiles only when their
  path set is genuinely read by every member. If an observed read cannot be
  represented, report that concrete discrepancy before continuing; do not
  mark capture complete.

- [ ] **Step 6: Run policy tests and freshness check**

  ```bash
  scripts/dev-shell.sh env \
    PYTHONPATH="$KANDELO_TAP_ROOT" KANDELO_TAP_ROOT="$KANDELO_TAP_ROOT" \
    python3 -m scripts.abi_staging.cli policy-check \
      --tap-root "$KANDELO_TAP_ROOT"
  scripts/dev-shell.sh env PYTHONPATH="$KANDELO_TAP_ROOT" \
    python3 -m unittest scripts.abi_staging.tests.test_policy -v
  ```

  Expected: PASS; activation remains observe-only.

- [ ] **Step 7: Commit in the tap repository**

  ```bash
  git -C "$KANDELO_TAP_ROOT" add Kandelo/staging/tap-policy.toml \
    Kandelo/staging/formula-build-inputs.toml \
    Kandelo/staging/generated/formula-build-inputs.json \
    Kandelo/staging/candidate-publication-activation.toml \
    Kandelo/staging/verification-tests.toml \
    scripts/abi_staging/policy.py \
    scripts/abi_staging/tests/test_policy.py
  git -C "$KANDELO_TAP_ROOT" commit -m \
    "[ABI] Declare complete tap build-input capture"
  ```

---

### Task 2: Normalize the exact Formula inventory and dependency graph

**Repository:** `kandelo-dev/homebrew-tap-core`

**Files:**

- Create: `Kandelo/staging/fixtures/formula-inventory.json`
- Create: `scripts/abi_staging/formula_inventory.py`
- Create: `scripts/abi_staging/tests/test_formula_inventory.py`

**Interfaces:**

- Consumes: exact tap commit/tree, reviewed Formula DSL, per-Formula sidecars,
  and Task 1 capture policy.
- Produces: canonical `FormulaInventoryV1` with identities, target runtime
  dependencies, source/resource/patch roles, supported architectures, and
  normalized Formula source digests that exclude only generated bottle blocks.

- [ ] **Step 1: Write failing parser/probe contract tests**

  Use inert probe fixtures for no dependencies, target dependencies, native
  build requirements, resources, patches, mirrors, revisions, rebuilds, and
  dual architecture. Reject duplicate names, missing Formula files, sidecar
  drift, cycles, unknown first-party dependency, unsupported architecture, or
  a probe path outside the exact tap tree.

- [ ] **Step 2: Prove generated bottle metadata is the sole normalized exclusion**

  Mutate a bottle SHA/root/rebuild block and assert normalized recipe identity
  stays stable only where generated metadata policy permits. Mutate install,
  test, source URL/SHA, resource, patch, dependency, support module, or any
  other line and assert identity changes. Reject two bottle blocks or malformed
  block boundaries.

- [ ] **Step 3: Run tests and verify red**

  ```bash
  scripts/dev-shell.sh env PYTHONPATH="$KANDELO_TAP_ROOT" \
    python3 -m unittest \
      scripts.abi_staging.tests.test_formula_inventory -v
  ```

  Expected: FAIL because inventory normalization is absent.

- [ ] **Step 4: Implement a read-only evaluated inventory adapter**

  Keep Homebrew evaluation in the uncredentialed/read-only planner job. Emit a
  bounded JSON probe, then have protected Python verify it against exact
  Formula/sidecar bytes. Never use stale sidecar dependency arrays without the
  exact probe comparison.

- [ ] **Step 5: Generate the canonical current fixture and run tests**

  ```bash
  scripts/dev-shell.sh env \
    PYTHONPATH="$KANDELO_TAP_ROOT" KANDELO_TAP_ROOT="$KANDELO_TAP_ROOT" \
    python3 -m scripts.abi_staging.cli formula-inventory-fixture \
      --tap-root "$KANDELO_TAP_ROOT" \
      --out "$KANDELO_TAP_ROOT/Kandelo/staging/fixtures/formula-inventory.json"
  scripts/dev-shell.sh env PYTHONPATH="$KANDELO_TAP_ROOT" \
    python3 -m unittest \
      scripts.abi_staging.tests.test_formula_inventory -v
  ```

  Expected: PASS and stable fixture bytes on a second run.

- [ ] **Step 6: Commit in the tap repository**

  ```bash
  git -C "$KANDELO_TAP_ROOT" add \
    Kandelo/staging/fixtures/formula-inventory.json \
    scripts/abi_staging/formula_inventory.py \
    scripts/abi_staging/tests/test_formula_inventory.py
  git -C "$KANDELO_TAP_ROOT" commit -m \
    "[Homebrew] Normalize the exact tap dependency graph"
  ```

---

### Task 3: Plan required and background Formulae from selected products

**Repository:** `kandelo-dev/homebrew-tap-core`

**Files:**

- Create: `Kandelo/staging/fixtures/tap-plan.json`
- Create: `scripts/abi_staging/plan.py`
- Create: `scripts/abi_staging/tests/test_plan.py`
- Modify: `scripts/abi_staging/records.py`
- Modify: `scripts/abi_staging/cli.py`

**Interfaces:**

- Consumes: validated request `FormulaRequirementV1` roots, Task 2 inventory,
  exact tap source, and Plan 1 record validators.
- Produces: `TapPlanV1`, `FormulaPlanV1`, `TapPlanRecordV1`, reverse-dependant
  graph, and `plan-request` CLI.

- [ ] **Step 1: Write failing required/background tests**

  Select two products with shared and disjoint roots. Assert required closure
  includes every actual dependency, `required_by_products` is complete,
  background is exactly the remaining supported first-party subject inventory,
  and no background failure changes required membership. Assert changing a
  Kandelo-side Brewfile, staging list, or legacy wave cannot alter the plan.

- [ ] **Step 2: Write graph and scope negative tests**

  Reject missing roots, an addressed third-party tap in the first-party lane,
  dependency cycles, architecture gaps, duplicate nodes, graph overflow, a
  request-provided transitive dependency, a request-provided build order, and a
  product record under the Formula namespace.

- [ ] **Step 3: Run tests and verify red**

  ```bash
  scripts/dev-shell.sh env PYTHONPATH="$KANDELO_TAP_ROOT" \
    python3 -m unittest scripts.abi_staging.tests.test_plan -v
  ```

  Expected: FAIL because tap planning is absent.

- [ ] **Step 4: Implement deterministic scoped planning**

  Snapshot exact tap commit/tree before the Formula probe, verify they remain
  unchanged after it, compute each required closure, union only for scheduling,
  and retain per-product reasons. Sort topologically with exact subject as tie
  break. Compute background from inventory after required classification.

- [ ] **Step 5: Generate and verify the miniature tap-plan fixture**

  ```bash
  scripts/dev-shell.sh env PYTHONPATH="$KANDELO_TAP_ROOT" \
    python3 -m unittest scripts.abi_staging.tests.test_plan -v
  scripts/dev-shell.sh env PYTHONPATH="$KANDELO_TAP_ROOT" \
    python3 -m scripts.abi_staging.cli fixture-check \
      --fixture "$KANDELO_TAP_ROOT/Kandelo/staging/fixtures/tap-plan.json"
  ```

  Expected: PASS.

- [ ] **Step 6: Commit in the tap repository**

  ```bash
  git -C "$KANDELO_TAP_ROOT" add \
    Kandelo/staging/fixtures/tap-plan.json \
    scripts/abi_staging/plan.py \
    scripts/abi_staging/records.py \
    scripts/abi_staging/cli.py \
    scripts/abi_staging/tests/test_plan.py
  git -C "$KANDELO_TAP_ROOT" commit -m \
    "[ABI] Derive required bottles from VFS products"
  ```

---

### Task 4: Calculate complete bottle contracts and exact reuse

**Repositories:** Kandelo and tap

**Files:**

- Create: `Kandelo/staging/fixtures/bottle-contract.json` in the tap
- Create: `scripts/abi_staging/contract.py` in the tap
- Create: `scripts/abi_staging/tests/test_contract.py` in the tap
- Modify: `tools/xtask/src/abi_staging/records.rs` in Kandelo
- Modify: `tools/xtask/src/abi_staging/mod.rs` in Kandelo

**Interfaces:**

- Consumes: Task 1 capture policy, Task 2 Formula inventory, Task 3 dependency
  layers, exact Kandelo/tap trees, and Plan 1 guards.
- Produces: `BottleContractV1`, `CaptureAssessmentV1`,
  `CandidateReuseRecordV1`, and `contract`/`reuse` CLI commands.

- [ ] **Step 1: Write failing component-inclusion tests**

  Independently mutate target ABI, structural snapshot, architecture, Formula
  source/version/revision/rebuild, resource, patch, selected build path, SDK,
  libc, sysroot, toolchain, instrumentation, environment policy, source/native
  receipt, direct dependency layer, and materialization-policy peer. Every
  mutation must change the contract digest.

- [ ] **Step 2: Write provenance-exclusion tests**

  Change PR number, branch hint, exact commit with identical tree/input bytes,
  request digest under identical build inputs, run/job ID, producer workflow,
  and timestamps. Contract/layer reuse identity must remain unchanged while a
  reuse record preserves new request provenance and original producer.

- [ ] **Step 3: Write failing capture decision tests**

  Assert complete/equal reuses exact candidate; complete/changed rebuilds;
  changed dependency layer invalidates reverse dependants; unchanged rebuilt
  dependency layer does not; incomplete/unknown fails immediately with exact
  diagnostics. Reject a reuse candidate with mismatched source custody,
  contract, layer, ABI, architecture, or nonendorsed classification.

- [ ] **Step 4: Run Rust and Python tests and verify red**

  ```bash
  scripts/dev-shell.sh bash -c '
    host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
    cargo test -p xtask --target "$host_target" \
      abi_staging::records
  '
  scripts/dev-shell.sh env PYTHONPATH="$KANDELO_TAP_ROOT" \
    python3 -m unittest scripts.abi_staging.tests.test_contract -v
  ```

  Expected: FAIL because new variants and contract logic are absent.

- [ ] **Step 5: Implement canonical contracts and fail-closed capture**

  Hash content components, not host paths. Store logical stable IDs and exact
  content digests. A directory digest is canonical over sorted relative path,
  file kind, mode policy, bytes, and SHA-256; reject symlinks unless the policy
  explicitly captures the Git tree's symlink target as inert text and the
  builder sandbox recreates that exact relationship.

- [ ] **Step 6: Implement reuse without invented producer history**

  A reused request emits `CandidateReuseRecordV1`; it references the existing
  candidate/custody/receipt locators and original attempt. It does not emit a
  candidate manifest or claim a build happened.

- [ ] **Step 7: Run tests and canonical fixture checks**

  ```bash
  scripts/dev-shell.sh bash -c '
    host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
    cargo test -p xtask --target "$host_target" \
      abi_staging::records
  '
  scripts/dev-shell.sh env PYTHONPATH="$KANDELO_TAP_ROOT" \
    python3 -m unittest scripts.abi_staging.tests.test_contract -v
  ```

  Expected: PASS with Rust/Python record vectors equal.

- [ ] **Step 8: Commit each repository**

  ```bash
  git add tools/xtask/src/abi_staging/records.rs \
    tools/xtask/src/abi_staging/mod.rs
  git commit -m "[ABI] Record exact candidate reuse without rebuilding"
  git -C "$KANDELO_TAP_ROOT" add \
    Kandelo/staging/fixtures/bottle-contract.json \
    scripts/abi_staging/contract.py \
    scripts/abi_staging/tests/test_contract.py
  git -C "$KANDELO_TAP_ROOT" commit -m \
    "[ABI] Fingerprint complete bottle inputs"
  ```

---

### Task 5: Seal the uncredentialed bottle-build handoff

**Repositories:** Kandelo and tap

**Files:**

- Create: `scripts/abi-staging-build-bottle.sh` in Kandelo
- Create: `scripts/test-abi-staging-build-bottle.sh` in Kandelo
- Create: `Kandelo/staging/fixtures/build-handoff/inventory.json` in the tap
- Create: `Kandelo/staging/fixtures/build-handoff/build-result.json` in the tap
- Create: `scripts/abi_staging/handoff.py` in the tap
- Create: `scripts/abi_staging/tests/test_handoff.py` in the tap

**Interfaces:**

- Consumes: exact request/tap/Formula plan, complete contract or exact capture
  authorization, exact dependency layers, and existing normal Kandelo
  Homebrew build scripts.
- Produces: exact bounded `handoff/` inventory and `AttemptRecordV1`; never a
  registry write.

- [ ] **Step 1: Write failing Kandelo entrypoint tests**

  Inject fake normal builders and assert exact source checkouts, dependency
  digest verification, worktree-local SDK, declared output, six-hour external
  timeout contract, clean output directory, and credential-variable stripping.
  Reject incomplete capture without authorization and wrong-subject
  authorization before invoking the builder.

- [ ] **Step 2: Write failing handoff inventory tests**

  Cover success and failure inventories, unknown/unlisted file, size/count
  overflow, symlink, hardlink, device, FIFO, socket, path escape, duplicate
  normalized path, digest/size mismatch, success without bottle, failure with
  candidate identity, and diagnostics containing a secret-shaped value.

- [ ] **Step 3: Run focused tests and verify red**

  ```bash
  scripts/dev-shell.sh bash scripts/test-abi-staging-build-bottle.sh
  scripts/dev-shell.sh env PYTHONPATH="$KANDELO_TAP_ROOT" \
    python3 -m unittest scripts.abi_staging.tests.test_handoff -v
  ```

  Expected: FAIL because entrypoint/handoff validation is absent.

- [ ] **Step 4: Implement the uncredentialed adapter**

  Validate every input before calling the existing normal build path. Build in
  a new caller-owned directory, configure Homebrew caches inside it, disable
  Git credential helpers and hooks, and create deterministic metadata. Always
  emit an attempt/build result; emit bottle files only after normal inspection
  passes.

- [ ] **Step 5: Implement protected inert validation**

  Open inventory members with no-follow semantics below one root. Re-hash all
  files, validate canonical JSON with duplicate-key rejection, inspect archive
  paths without extraction, and create protected candidate data from verified
  facts rather than trusting artifact-provided environment or paths.

- [ ] **Step 6: Run tests and existing bottle regressions**

  ```bash
  scripts/dev-shell.sh bash scripts/test-abi-staging-build-bottle.sh
  scripts/dev-shell.sh bash scripts/test-homebrew-publish-workflow.sh
  scripts/dev-shell.sh bash scripts/test-homebrew-inspect-bottle.sh
  scripts/dev-shell.sh env PYTHONPATH="$KANDELO_TAP_ROOT" \
    python3 -m unittest scripts.abi_staging.tests.test_handoff -v
  ```

  Expected: PASS. Legacy build behavior is unchanged.

- [ ] **Step 7: Commit each repository**

  ```bash
  git add scripts/abi-staging-build-bottle.sh \
    scripts/test-abi-staging-build-bottle.sh
  git commit -m "[Homebrew] Emit bounded uncredentialed bottle handoffs"
  git -C "$KANDELO_TAP_ROOT" add \
    Kandelo/staging/fixtures/build-handoff \
    scripts/abi_staging/handoff.py \
    scripts/abi_staging/tests/test_handoff.py
  git -C "$KANDELO_TAP_ROOT" commit -m \
    "[Homebrew] Validate bottle handoffs as inert data"
  ```

---

### Task 6: Preserve exact Git source custody with actual build outputs

**Repository:** `kandelo-dev/homebrew-tap-core`

**Files:**

- Create: `Kandelo/staging/fixtures/source-custody/manifest.json`
- Create: `scripts/abi_staging/custody.py`
- Create: `scripts/abi_staging/tests/test_custody.py`
- Modify: `scripts/abi_staging/handoff.py`

**Interfaces:**

- Consumes: exact Kandelo/tap repositories at request/plan commits plus pinned
  submodule identities.
- Produces: `SourceCustodyManifestV1`, deterministic Git bundles/tree archives,
  capsule digest, and protected `validate_source_custody`.

- [ ] **Step 1: Write failing custody construction tests**

  Create tiny Git repositories with one pinned submodule. Assert exact commit,
  tree, repository, submodule gitlink, bundle object, deterministic tree
  archive, member digest/size, and shared-capsule digest. Run twice from
  different host paths and require identical bytes.

- [ ] **Step 2: Write failing protected-validation tests**

  Reject missing commit object, wrong tree, omitted submodule, extra member,
  wrong gitlink relation, bundle with replacement refs, unsafe archive entry,
  symlink, hash/size mismatch, malformed manifest, and custody referring to a
  different request/tap plan.

- [ ] **Step 3: Run custody tests and verify red**

  ```bash
  scripts/dev-shell.sh env PYTHONPATH="$KANDELO_TAP_ROOT" \
    python3 -m unittest scripts.abi_staging.tests.test_custody -v
  ```

  Expected: FAIL because custody support is absent.

- [ ] **Step 4: Implement deterministic Git custody**

  Disable hooks/config/includes and create bundles from exact object IDs.
  Generate tree archives with normalized owner/group/mtime/mode policy. The
  manifest records factual exact commits/trees plus member digests; the
  capsule's content identity excludes run/timestamp provenance.

- [ ] **Step 5: Implement protected verification without executing content**

  Use isolated temporary Git directories, `git bundle verify`, `git fsck`, and
  object/tree queries with hooks disabled. List archives before any optional
  extraction; no publisher step checks out or runs their files.

- [ ] **Step 6: Run custody and handoff tests**

  ```bash
  scripts/dev-shell.sh env PYTHONPATH="$KANDELO_TAP_ROOT" \
    python3 -m unittest \
      scripts.abi_staging.tests.test_custody \
      scripts.abi_staging.tests.test_handoff -v
  ```

  Expected: PASS.

- [ ] **Step 7: Commit in the tap repository**

  ```bash
  git -C "$KANDELO_TAP_ROOT" add \
    Kandelo/staging/fixtures/source-custody/manifest.json \
    scripts/abi_staging/custody.py \
    scripts/abi_staging/handoff.py \
    scripts/abi_staging/tests/test_custody.py
  git -C "$KANDELO_TAP_ROOT" commit -m \
    "[Homebrew] Preserve exact build Git sources"
  ```

---

### Task 7: Publish immutable candidate and source OCI objects

**Repository:** `kandelo-dev/homebrew-tap-core`

**Files:**

- Create: `scripts/abi_staging/records.py`
- Create: `scripts/abi_staging/oci.py`
- Create: `scripts/abi_staging/tests/test_records.py`
- Create: `scripts/abi_staging/tests/test_oci.py`
- Modify: `scripts/abi_staging/cli.py`

**Interfaces:**

- Consumes: validated Task 5 handoff, Task 6 custody, Plan 1 candidate/attempt
  records and guard registry, and protected registry credentials only inside
  publication.
- Produces: deterministic OCI blob/manifest plans, candidate/source locators,
  anonymous readback evidence, and `publish-candidate` CLI.

- [ ] **Step 1: Write failing record/OCI fixture tests**

  Assert exact media types, descriptor ordering, nonendorsed annotations,
  bottle/custody bindings, record digest, immutable reference, and absence of
  verification/admission fields. Prove `PublishedRecordLocatorV1` is returned
  outside hashed bytes and a record cannot embed its own digest.

- [ ] **Step 2: Write fake-registry publication tests**

  Cover new namespace, existing correct namespace, blob mount/upload,
  identical manifest idempotence, tag collision, manifest collision, wrong
  package association, wrong digest/size, private anonymous readback, readback
  byte drift, retryable server error, and hostile registry redirect.

- [ ] **Step 3: Run tests and verify red**

  ```bash
  scripts/dev-shell.sh env PYTHONPATH="$KANDELO_TAP_ROOT" \
    python3 -m unittest \
      scripts.abi_staging.tests.test_records \
      scripts.abi_staging.tests.test_oci -v
  ```

  Expected: FAIL because OCI publication is absent.

- [ ] **Step 4: Implement deterministic OCI construction**

  Construct and hash OCI bytes locally, validate repository/reference grammar,
  push exact blobs, then exact manifest, then resolve `@sha256:` and anonymously
  fetch it and every required blob. Use an isolated ORAS auth directory and
  remove it after the command; never place tokens in command output or record
  bytes.

- [ ] **Step 5: Implement namespace bootstrap and association checks**

  Treat a 404 as absent only at the expected endpoint. After first push, query
  protected GitHub package metadata for source-repository association and
  visibility, then use an unauthenticated client for readback. Emit registered
  guards on failure; do not fall back to the legacy unqualified bottle root.

- [ ] **Step 6: Run tests and local fake-transport integration**

  ```bash
  scripts/dev-shell.sh env PYTHONPATH="$KANDELO_TAP_ROOT" \
    python3 -m unittest \
      scripts.abi_staging.tests.test_records \
      scripts.abi_staging.tests.test_oci -v
  scripts/dev-shell.sh bash scripts/test-abi-staging-mini-lifecycle.sh
  ```

  Expected: PASS.

- [ ] **Step 7: Commit in the tap repository**

  ```bash
  git -C "$KANDELO_TAP_ROOT" add \
    scripts/abi_staging/records.py \
    scripts/abi_staging/oci.py \
    scripts/abi_staging/cli.py \
    scripts/abi_staging/tests/test_records.py \
    scripts/abi_staging/tests/test_oci.py
  git -C "$KANDELO_TAP_ROOT" commit -m \
    "[Homebrew] Publish visibly nonendorsed candidate records"
  ```

---

### Task 8: Verify exact public candidate bytes independently

**Repositories:** Kandelo and tap

**Files:**

- Create: `scripts/abi-staging-verify-bottle.sh` in Kandelo
- Create: `scripts/test-abi-staging-verify-bottle.sh` in Kandelo
- Create: `scripts/abi_staging/verification.py` in the tap
- Create: `scripts/abi_staging/tests/test_verification.py` in the tap

**Interfaces:**

- Consumes: exact public candidate digest/layer, protected verification test
  definition, exact request runtime inputs, and existing bottle pour/runtime
  validation paths.
- Produces: inert `VerificationResultV1` and protected immutable
  `VerificationReceiptV1` locator.

- [ ] **Step 1: Write failing uncredentialed verifier tests**

  Assert exact digest download, fresh prefix/cache, no rebuild, no mutable tag,
  no credentials, exact ABI/architecture, structural pour/link inspection, and
  test-definition execution. Reject a changed layer behind a tag, candidate
  metadata mismatch, or fallback source build.

- [ ] **Step 2: Write failing receipt publisher tests**

  Cover success, failure, timeout, retry ordinal, different test definition,
  candidate mismatch, stale run, malformed handoff, and coexistence of failed
  and successful receipts. Retesting must add a receipt, never mutate or rename
  candidate identity.

- [ ] **Step 3: Run tests and verify red**

  ```bash
  scripts/dev-shell.sh bash scripts/test-abi-staging-verify-bottle.sh
  scripts/dev-shell.sh env PYTHONPATH="$KANDELO_TAP_ROOT" \
    python3 -m unittest scripts.abi_staging.tests.test_verification -v
  ```

  Expected: FAIL because verifier/receipt publication is absent.

- [ ] **Step 4: Implement exact-digest execution and inert results**

  Anonymous download uses the immutable reference and verifies descriptor,
  layer digest, and bytes before opening the archive. The command calls the
  existing normal verification path without registry writes and emits bounded
  result/diagnostic files only.

- [ ] **Step 5: Implement protected receipt publication**

  Re-fetch candidate manifest/layer anonymously, validate test definition and
  job provenance, create canonical receipt bytes, publish under the candidate
  record namespace, and anonymously read them back. A failed receipt remains a
  factual public result.

- [ ] **Step 6: Run verification regressions**

  ```bash
  scripts/dev-shell.sh bash scripts/test-abi-staging-verify-bottle.sh
  scripts/dev-shell.sh bash -c '
    cd host
    npx vitest run test/homebrew-public-bottle-verifier.test.ts
  '
  scripts/dev-shell.sh env PYTHONPATH="$KANDELO_TAP_ROOT" \
    python3 -m unittest scripts.abi_staging.tests.test_verification -v
  ```

  Expected: PASS.

- [ ] **Step 7: Commit each repository**

  ```bash
  git add scripts/abi-staging-verify-bottle.sh \
    scripts/test-abi-staging-verify-bottle.sh
  git commit -m "[Homebrew] Verify exact public candidate bottles"
  git -C "$KANDELO_TAP_ROOT" add \
    scripts/abi_staging/verification.py \
    scripts/abi_staging/tests/test_verification.py
  git -C "$KANDELO_TAP_ROOT" commit -m \
    "[Homebrew] Publish independent candidate receipts"
  ```

---

### Task 9: Schedule dependency-ready work and deterministic retries

**Repositories:** Kandelo and tap

**Files:**

- Create: `tools/xtask/tests/fixtures/abi-staging/retry-vectors.json` in Kandelo
- Create: `scripts/abi_staging/scheduler.py` in the tap
- Create: `scripts/abi_staging/tests/test_scheduler.py` in the tap
- Modify: `scripts/abi_staging/reconcile.py` in the tap

**Interfaces:**

- Consumes: Plan 1 retry algorithm/records, Task 3 graph, candidate/receipt
  records, lifecycle, and Task 1 retry policy.
- Produces: shared retry vectors, `RetryDecisionV1`, ready bounded batches,
  blocked-dependant projections, and reconciliation work intents.

- [ ] **Step 1: Generate failing cross-language jitter vectors**

  Include retries one through three, zero delay, window endpoint, cap behavior,
  different request/subject inputs, invalid retry zero/four, zero base, cap
  below base, and arithmetic overflow. Python must reproduce exact Rust output.

- [ ] **Step 2: Write failing scheduling tests**

  Cover required-first ordering, independent siblings, dependency failure,
  reverse-dependant invalidation only when the layer changes, batch limit,
  repeated reconciliation, open/merged/closed/reopened lifecycle, timeout,
  retry exhaustion, manual retry eligibility, and background continuation.

- [ ] **Step 3: Write failing classifier tests**

  Assert only protected infrastructure facts receive transient classification.
  Formula nonzero exit, test assertion, contract/capture failure, source
  mismatch, archive hazard, hash/readback failure, and unknown outcome must not
  auto-retry. Candidate output cannot self-classify as transient.

- [ ] **Step 4: Run cross-language tests and verify red**

  ```bash
  scripts/dev-shell.sh bash -c '
    host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
    cargo test -p xtask --target "$host_target" \
      abi_staging::mini_lifecycle
  '
  scripts/dev-shell.sh env PYTHONPATH="$KANDELO_TAP_ROOT" \
    python3 -m unittest scripts.abi_staging.tests.test_scheduler -v
  ```

  Expected: FAIL until shared vectors and Python scheduler exist.

- [ ] **Step 5: Implement pure classification and eligibility**

  Keep wall clock injectable. Record `next_eligible_at` as audit/eligibility
  only, return from reconciliation, and let a later scheduled run enqueue.
  Never call `sleep`, hold a matrix runner, reset ordinal on reopen, or delete a
  failed attempt.

- [ ] **Step 6: Run scheduler/lifecycle tests twice**

  ```bash
  scripts/dev-shell.sh env PYTHONPATH="$KANDELO_TAP_ROOT" \
    python3 -m unittest \
      scripts.abi_staging.tests.test_scheduler \
      scripts.abi_staging.tests.test_reconcile -v
  scripts/dev-shell.sh env PYTHONPATH="$KANDELO_TAP_ROOT" \
    python3 -m unittest scripts.abi_staging.tests.test_scheduler -v
  ```

  Expected: PASS with identical decisions for identical injected time/records.

- [ ] **Step 7: Commit each repository**

  ```bash
  git add tools/xtask/tests/fixtures/abi-staging/retry-vectors.json
  git commit -m "[ABI] Freeze deterministic retry vectors"
  git -C "$KANDELO_TAP_ROOT" add \
    scripts/abi_staging/scheduler.py \
    scripts/abi_staging/reconcile.py \
    scripts/abi_staging/tests/test_scheduler.py
  git -C "$KANDELO_TAP_ROOT" commit -m \
    "[ABI] Schedule bounded dependency-ready retries"
  ```

---

### Task 10: Add exact capture and artifact override workflows

**Repository:** `kandelo-dev/homebrew-tap-core`

**Files:**

- Create: `scripts/abi_staging/override.py`
- Create: `scripts/abi_staging/tests/test_override.py`
- Create: `.github/workflows/abi-staging-maintenance.yml`
- Modify: `scripts/check_abi_staging_workflows.rb`
- Modify: `scripts/test_check_abi_staging_workflows.rb`

**Interfaces:**

- Consumes: Plan 1 guard registry, `CaptureOverrideAuthorizationV1`,
  `OverrideReceiptV1`, exact public candidates, and collaborator permission
  facts.
- Produces: three separate maintenance commands:
  `authorize-capture`, `accept-artifact-risk`, and `retry-exhausted`.

- [ ] **Step 1: Write failing override model tests**

  Cover exact request/Formula/arch/contract capture authorization, wrong
  subject, unknown guard, never-overrideable guard, empty/oversized
  justification, unauthorized actor, guessed candidate in prebuild auth,
  postbuild receipt without candidate/layer, mismatched authorization, and
  accepted-with-override projection.

- [ ] **Step 2: Prove retry is not an override**

  `retry-exhausted` requires exact exhausted transient history and maintainer
  authority, schedules a new ordinal, and emits no override receipt. A build
  failure or missing bytes cannot be turned into promotion eligibility.

- [ ] **Step 3: Write workflow mutation tests**

  Reject PR triggers, non-main protected code, write plus candidate execution,
  free-form subject parsing, unverified actor permission, arbitrary guard,
  artifact override without digest, capture authorization with guessed digest,
  mutable receipt overwrite, or `continue-on-error` after validation.

- [ ] **Step 4: Run tests and verify red**

  ```bash
  scripts/dev-shell.sh env PYTHONPATH="$KANDELO_TAP_ROOT" \
    python3 -m unittest scripts.abi_staging.tests.test_override -v
  scripts/dev-shell.sh env KANDELO_TAP_ROOT="$KANDELO_TAP_ROOT" \
    ruby "$KANDELO_TAP_ROOT/scripts/test_check_abi_staging_workflows.rb"
  ```

  Expected: FAIL because override policy/workflow is absent.

- [ ] **Step 5: Implement immutable exact authorization/receipts**

  Query GitHub permission and require `maintain` or `admin`. Canonicalize
  bounded justification as data. Publish the prebuild authorization first;
  after the first valid exact authorized build, publish a new override receipt
  binding actual candidate/layer and authorization digest. Never mutate either
  object.

- [ ] **Step 6: Run override and workflow tests**

  ```bash
  scripts/dev-shell.sh env PYTHONPATH="$KANDELO_TAP_ROOT" \
    python3 -m unittest scripts.abi_staging.tests.test_override -v
  scripts/dev-shell.sh env KANDELO_TAP_ROOT="$KANDELO_TAP_ROOT" \
    ruby "$KANDELO_TAP_ROOT/scripts/test_check_abi_staging_workflows.rb"
  scripts/dev-shell.sh env KANDELO_TAP_ROOT="$KANDELO_TAP_ROOT" \
    actionlint "$KANDELO_TAP_ROOT/.github/workflows/abi-staging-maintenance.yml"
  ```

  Expected: PASS.

- [ ] **Step 7: Commit in the tap repository**

  ```bash
  git -C "$KANDELO_TAP_ROOT" add \
    scripts/abi_staging/override.py \
    scripts/abi_staging/tests/test_override.py \
    .github/workflows/abi-staging-maintenance.yml \
    scripts/check_abi_staging_workflows.rb \
    scripts/test_check_abi_staging_workflows.rb
  git -C "$KANDELO_TAP_ROOT" commit -m \
    "[ABI] Record exact staging risk acceptance"
  ```

---

### Task 11: Wire one bounded candidate pipeline into reconciliation

**Repository:** `kandelo-dev/homebrew-tap-core`

**Files:**

- Modify: `.github/workflows/abi-staging-reconcile.yml`
- Modify: `scripts/abi_staging/reconcile.py`
- Modify: `scripts/abi_staging/cli.py`
- Modify: `scripts/check_abi_staging_workflows.rb`
- Modify: `scripts/test_check_abi_staging_workflows.rb`

**Interfaces:**

- Consumes: Tasks 1–10.
- Produces: one workflow run with `discover-plan`, bounded `build-candidate`,
  `publish-candidate`, `verify-candidate`, and `publish-receipt` jobs.
- Permission map is exact:

  | Job | Permissions |
  |---|---|
  | `discover-plan` | `contents: read` |
  | `build-candidate` | `contents: read` |
  | `publish-candidate` | `contents: read`, `actions: read`, `packages: write` |
  | `verify-candidate` | `contents: read` |
  | `publish-receipt` | `contents: read`, `actions: read`, `packages: write` |

  Workflow-level permissions remain `{}`. No job passes secrets to a reusable
  candidate job. Build and verification timeouts are six hours.

- [ ] **Step 1: Extend failing workflow mutations**

  Reject a write permission in build/verify, publisher execution of handoff
  files, shared job combining execution/publication, unbounded matrix,
  candidate mutable tag, missing artifact digest bridge, missing anonymous
  readback, global all-Formula gate, background failure gating required work,
  sleep/backoff step, and checkout other than exact request/tap sources.

- [ ] **Step 2: Add failing at-least-once workflow fixtures**

  Simulate two scheduled runs seeing the same request, duplicate artifact
  publication, one dependency failure, an independent sibling, a transient
  timeout, close during build, and reopen. Assert immutable no-clobber records
  converge and already-running valid candidates may finish after close while
  no new work begins.

- [ ] **Step 3: Run workflow/unit tests and verify red**

  ```bash
  scripts/dev-shell.sh env KANDELO_TAP_ROOT="$KANDELO_TAP_ROOT" \
    ruby "$KANDELO_TAP_ROOT/scripts/test_check_abi_staging_workflows.rb"
  scripts/dev-shell.sh env PYTHONPATH="$KANDELO_TAP_ROOT" \
    python3 -m unittest discover \
      -s "$KANDELO_TAP_ROOT/scripts/abi_staging/tests" -v
  ```

  Expected: FAIL because jobs are not wired.

- [ ] **Step 4: Implement observe/active workflow branching**

  In observe mode, produce and summarize exact plans/intents without candidate
  jobs. In active mode, feed at most the policy batch into a matrix. Required
  work sorts first; background continues in available slots. Every writer
  checks activation and protected workflow revision again before writing.

- [ ] **Step 5: Implement artifact and run identity bridges**

  Upload handoffs with exact deterministic artifact names derived from request
  and subject digests. Publishers query current run/job/artifact metadata,
  require the expected producing job/conclusion/head/workflow, download by
  numeric artifact ID, then apply bounded inert validation. Never accept an
  arbitrary run ID from candidate output.

- [ ] **Step 6: Run all tap tests and actionlint**

  ```bash
  scripts/dev-shell.sh env PYTHONPATH="$KANDELO_TAP_ROOT" \
    python3 -m unittest discover \
      -s "$KANDELO_TAP_ROOT/scripts/abi_staging/tests" -v
  scripts/dev-shell.sh env KANDELO_TAP_ROOT="$KANDELO_TAP_ROOT" \
    ruby "$KANDELO_TAP_ROOT/scripts/test_check_abi_staging_workflows.rb"
  scripts/dev-shell.sh env KANDELO_TAP_ROOT="$KANDELO_TAP_ROOT" \
    actionlint \
      "$KANDELO_TAP_ROOT/.github/workflows/abi-staging-reconcile.yml" \
      "$KANDELO_TAP_ROOT/.github/workflows/abi-staging-maintenance.yml"
  ```

  Expected: PASS in observe mode.

- [ ] **Step 7: Commit in the tap repository**

  ```bash
  git -C "$KANDELO_TAP_ROOT" add \
    .github/workflows/abi-staging-reconcile.yml \
    scripts/abi_staging/reconcile.py \
    scripts/abi_staging/cli.py \
    scripts/check_abi_staging_workflows.rb \
    scripts/test_check_abi_staging_workflows.rb
  git -C "$KANDELO_TAP_ROOT" commit -m \
    "[ABI] Reconcile bounded candidate bottle batches"
  ```

---

### Task 12: Run hosted candidate canaries before active publication

**Repositories:** Kandelo and tap

**Files:**

- Modify: `Kandelo/staging/candidate-publication-activation.toml` in the tap
- Modify: `docs/homebrew-publishing.md` in Kandelo
- Modify: `docs/abi-versioning.md` in Kandelo
- Modify: `docs/future-improvements.md` in Kandelo
- Modify: `Kandelo/README.md` in the tap
- Modify: `README.md` in the tap

**Interfaces:**

- Consumes: protected-main Plan 2 request feed and merged observe-mode Plan 3
  tap workflow.
- Produces: actual GHCR namespace/association/readback evidence and a narrow
  activation commit only after success.

- [ ] **Step 1: Verify hosted prerequisites without mutation**

  Confirm the exact request asset is public, tap workflow revision is on
  protected main, `packages: write` is available only to publisher jobs, and no
  candidate namespace is assumed to exist. If a prerequisite is absent, report
  it and do not use legacy credentials or a personal token as fallback.

- [ ] **Step 2: Run one observe-mode plan and inspect exact capture**

  Retain request/tap-plan/contract digests. Confirm selected roots came from
  products, tap dependencies came from the exact Formula snapshot, capture is
  complete or fails immediately, and background membership is separate.

- [ ] **Step 3: Authorize one protected candidate canary**

  Use the exact planned subject; do not accept a manually typed alternative
  Formula. Run build, source custody, candidate publication, anonymous
  readback, independent verification, and receipt publication. Retain run,
  candidate, layer, custody, and receipt digests plus public URLs.

- [ ] **Step 4: Exercise a nonendorsed failure canary**

  Run a fixture verification definition that deterministically fails after a
  valid candidate exists. Confirm the candidate remains public, a failed
  receipt is added, ordinary eligibility is false, and no canonical Formula
  metadata or namespace changes.

- [ ] **Step 5: Exercise retry and exact-override canaries**

  Use protected test hooks to classify one infrastructure failure and verify
  recorded next eligibility/no sleep. Exercise a fixture exact-artifact
  override and a wrong-subject rejection. Do not override an integrity guard.

- [ ] **Step 6: Activate candidate publication narrowly**

  Change only tap `candidate-publication-activation.toml` to `active`, rerun
  all local tap tests, and commit. Reconciliation may now build and verify
  bottles, but no product evidence, PR Check, promotion, or tap-main metadata
  update is enabled.

  ```bash
  scripts/dev-shell.sh env PYTHONPATH="$KANDELO_TAP_ROOT" \
    python3 -m unittest discover \
      -s "$KANDELO_TAP_ROOT/scripts/abi_staging/tests" -v
  git -C "$KANDELO_TAP_ROOT" add \
    Kandelo/staging/candidate-publication-activation.toml
  git -C "$KANDELO_TAP_ROOT" commit -m \
    "[ABI] Activate nonendorsed candidate publication"
  ```

- [ ] **Step 7: Update documentation to the hosted facts**

  Document public candidate/source/receipt namespaces, nonendorsement,
  incomplete-capture failure, exact override semantics, retry count/jitter,
  and the external-source custody limitation. Keep product evidence, Check,
  promotion, historical branches, and Pages explicitly unimplemented.

- [ ] **Step 8: Commit documentation in both repositories**

  ```bash
  git add docs/homebrew-publishing.md docs/abi-versioning.md \
    docs/future-improvements.md
  git commit -m "[Docs] Describe candidate bottle staging"
  git -C "$KANDELO_TAP_ROOT" add Kandelo/README.md README.md
  git -C "$KANDELO_TAP_ROOT" commit -m \
    "[Docs] Describe nonendorsed candidate publication"
  ```

---

### Task 13: Final Plan 3 verification and capability audit

**Files:**

- Verify every Plan 3 file in both repositories and retained hosted evidence.

**Interfaces:**

- Consumes: Tasks 1–12.
- Produces: evidence for tap planning/candidates/custody/verification only.

- [ ] **Step 1: Run Kandelo validation**

  ```bash
  scripts/dev-shell.sh bash scripts/test-abi-staging-product-authority.sh
  scripts/dev-shell.sh bash scripts/test-abi-staging-build-bottle.sh
  scripts/dev-shell.sh bash scripts/test-abi-staging-verify-bottle.sh
  scripts/dev-shell.sh bash -c '
    host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
    cargo test -p xtask --target "$host_target" abi_staging
  '
  scripts/dev-shell.sh bash scripts/check-abi-version.sh
  ```

  Expected: PASS.

- [ ] **Step 2: Run the complete tap suite**

  ```bash
  scripts/dev-shell.sh env \
    PYTHONPATH="$KANDELO_TAP_ROOT" KANDELO_TAP_ROOT="$KANDELO_TAP_ROOT" \
    python3 -m unittest discover \
      -s "$KANDELO_TAP_ROOT/scripts/abi_staging/tests" -v
  scripts/dev-shell.sh env KANDELO_TAP_ROOT="$KANDELO_TAP_ROOT" \
    ruby "$KANDELO_TAP_ROOT/scripts/test_check_abi_staging_workflows.rb"
  scripts/dev-shell.sh env KANDELO_TAP_ROOT="$KANDELO_TAP_ROOT" \
    actionlint \
      "$KANDELO_TAP_ROOT/.github/workflows/abi-staging-reconcile.yml" \
      "$KANDELO_TAP_ROOT/.github/workflows/abi-staging-maintenance.yml"
  ```

  Expected: PASS.

- [ ] **Step 3: Run legacy regressions and docs**

  ```bash
  scripts/dev-shell.sh bash scripts/test-homebrew-publish-workflow.sh
  scripts/dev-shell.sh ruby scripts/check-homebrew-publish-workflow-trust.rb
  scripts/dev-shell.sh npm run docs:build
  ```

  Expected: PASS. Existing canonical publication remains untouched.

- [ ] **Step 4: Audit genericity and credential separation**

  ```bash
  scripts/dev-shell.sh bash -c '
    if rg -n -i "abi[-_ ]?4[23]|integration/abi4[23]" \
      scripts/abi-staging-* \
      tools/xtask/src/abi_staging \
      "$KANDELO_TAP_ROOT/Kandelo/staging" \
      "$KANDELO_TAP_ROOT/scripts/abi_staging" \
      "$KANDELO_TAP_ROOT/.github/workflows/abi-staging-"*; then
      echo "acceptance ABI leaked into candidate infrastructure" >&2
      exit 1
    fi
    rg -n "permissions:|packages: write|contents: write|secrets:|sleep " \
      "$KANDELO_TAP_ROOT/.github/workflows/abi-staging-reconcile.yml" \
      "$KANDELO_TAP_ROOT/.github/workflows/abi-staging-maintenance.yml"
  '
  ```

  Manually verify build/verify jobs have no write capability, publishers run
  only protected code, and no sleep implements retry eligibility.

- [ ] **Step 5: Audit records and namespaces anonymously**

  For every hosted canary, download request, candidate manifest, bottle layer,
  custody manifest/members, and verification receipt without authentication;
  recompute exact digests. Confirm candidate annotations say nonendorsed and no
  canonical/tap-main reference exists.

- [ ] **Step 6: Audit both worktrees and stop**

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

  Do not compose candidate VFS products or update a Kandelo Check in this plan.

## Exit Criteria

- The tap snapshots and records one exact plan whose required Formulae derive
  only from selected VFS products and whose background set is separate.
- Every current Formula/architecture has explicit build-input capture policy;
  incomplete capture fails before ordinary building with exact diagnostics.
- Complete identical contracts reuse exact candidates without invented
  producer history; changed inputs/dependency layers invalidate only affected
  subjects.
- Candidate builds and verification run without write credentials.
- Protected code validates bounded inert handoffs, preserves required Git
  sources, publishes visibly nonendorsed candidate/source objects, and proves
  anonymous readback.
- Verification creates separate immutable receipts and failed receipts do not
  delete or rename candidates.
- Retry classification/count/jitter match the approved model and no runner
  sleeps while waiting.
- Capture and artifact overrides are exact/public/distinguished; retry repair
  is not mislabeled as override; integrity contradictions remain impossible to
  waive.
- Background work continues independently, but no product readiness, PR gate,
  promotion, tap-main change, ABI branch, or Pages deployment exists yet.
- Documentation states the precise custody limitation and nonendorsement.

After these criteria are met, execute Plan 4 using exact public candidate and
receipt locators. Do not treat Formula verification alone as required VFS
product evidence.
