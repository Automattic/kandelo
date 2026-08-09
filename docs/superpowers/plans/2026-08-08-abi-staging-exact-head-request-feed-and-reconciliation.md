# Exact-Head ABI Staging Request Feed and Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Issue immutable, canonical ABI-staging requests for exact Kandelo
pull-request heads and let protected tap automation discover and reconcile all
valid current and historical requests through equivalent scheduled and manual
read-only paths.

**Architecture:** Protected Kandelo code applies the current protected request
policy and parser to inert files from the exact pull-request head. An
uncredentialed job supplies structural ABI evidence; a separate write-capable
job validates that bounded artifact, derives `AbiStagingRequestV1`, and appends
it to one public prerelease per pull request without executing candidate code.
Protected tap code independently validates the public URL, release, filename,
canonical bytes, issuer, addressed tap, exact source, ABI, and policy
identities. A pure lifecycle reconciler emits deterministic decisions keyed by
request digest. The first deployment is observe-only; scheduling builds and
writing tap records begin in Plan 3.

**Tech Stack:** Existing Rust `xtask abi-staging` models and canonical JSON,
TOML protected policy, Bash and `gh` for the narrow Kandelo Release adapter,
Python standard library for protected tap HTTP/reconciliation logic, Ruby/YAML
workflow mutation checks, GitHub Actions with full-SHA action pins, and all
local validation through Kandelo's `scripts/dev-shell.sh`.

## Global Constraints

- Consume Plan 1 exactly. Do not rename `AbiStagingRequestV1`,
  `VfsProductCatalogV1`, `PagesProductRegistryV1`,
  `TestProductRegistryV1`, `SelectedVfsProductV1`, or
  `FormulaRequirementV1`.
- Reusable code is generic in source ABI `N` and target ABI `N + 1`. Local
  fixtures use arbitrary small values. Acceptance-branch values appear only in
  Plan 5's hosted fixture file.
- The authoritative build source is the exact pull-request head commit and
  tree. Never fetch, create, name, or accept a synthetic merge as
  `build_source`.
- Protected policy comes from the exact protected Kandelo `main` revision
  captured by the writer. Product manifests and consumer registries come from
  the exact head and are parsed as inert data by that protected implementation.
- `requirements.digest` is recomputed from exact-head normalized selection;
  `policy_sha256` is recomputed from protected policy plus its declared
  implementation-file digests; guard identity is separate.
- A later current-main policy implementation change re-evaluates open exact
  heads. It does not change an old request, invalidate historical work, or turn
  current-main bytes into the build source.
- The public feed has no timestamp ordering, upload ordering, lexical SHA
  ordering, mutable latest asset, lifecycle asset, merged asset, or mutable
  request body.
- The exact asset name is
  `candidate-request-<full-head-sha>-sha256-<request-digest>.json`.
- Same-repository pull requests are automatic. Fork authorization remains
  disabled in this plan; do not add a label or automatic fallback. The strict
  exact-SHA parser remains represented by the Plan 1 request model for a later
  extension.
- More than one request digest may name the same head. The current request must
  match exact current head, requirements digest, policy version/digest, and
  guard-registry version/digest.
- Previously issued heads remain discoverable and buildable after a pull
  request advances. Only the current exact head can satisfy the current Check.
- Candidate-controlled code runs only in a job with `contents: read`, no
  secrets, and no persisted credentials. The Release writer uses protected
  code and treats downloaded artifacts and exact-head files as bounded inert
  inputs.
- The tap reconciler has `contents: read` only in this plan. It does not
  dispatch builds, publish packages, mutate branches, update Kandelo Checks, or
  persist mutable coordinator state.
- Scheduled and manual reconciliation call the same command with the same
  validation and decision functions. Manual input accepts exactly one
  `request_asset_url`.
- All GitHub Actions are full 40-character SHA pins with version comments.
- Preserve all legacy workflows and current supported behavior. Both new
  workflows start in observe mode and are documented as non-gating.
- Preserve the unrelated dirty `tests/sortix/os-test` and `.serena/` paths.
- Run every build and validation command through `scripts/dev-shell.sh`.

---

## Plan 1 Interfaces Consumed

`AbiStagingRequestV1` retains exactly seven logical sections:

```text
schema + kind
pull_request
build_source
target_abi
requirements
issuance
informational_context
```

This plan does not add a tap revision, dependency closure, background
inventory, matrix, runner, retry, timeout, candidate, custody, lifecycle, or
status field to the request.

`request_is_current` remains the only applicability predicate:

```rust
pub fn request_is_current(
    request: &AbiStagingRequestV1,
    exact_head: &str,
    requirements_sha256: &str,
    policy_version: u64,
    policy_sha256: &str,
    guard_registry_version: u64,
    guard_registry_sha256: &str,
) -> bool;
```

The request filename parser must continue to validate the filename head and
digest against canonical request bytes. Discovery metadata never replaces
that validation.

## New Interfaces

### Protected request policy

`abi/staging/request-policy.toml` is parsed as `RequestPolicyV1`:

```toml
schema = 1
kind = "kandelo-abi-staging-request-policy"
version = 1
issuer_repository = "Automattic/kandelo"
issuer_workflow = ".github/workflows/abi-staging-request-feed.yml"
automatic_same_repository = true
fork_authorization = "disabled"
request_release_tag_prefix = "abi-staging-pr-"
request_asset_max_bytes = 4194304
max_products = 256
max_evidence_bindings = 512

addressed_taps = ["kandelo-dev/homebrew-tap-core"]

implementation_paths = [
  "tools/xtask/src/abi_staging/canonical_json.rs",
  "tools/xtask/src/abi_staging/product_manifest.rs",
  "tools/xtask/src/abi_staging/consumer_registry.rs",
  "tools/xtask/src/abi_staging/selection.rs",
  "tools/xtask/src/abi_staging/records.rs",
  "tools/xtask/src/abi_staging/request_policy.rs",
  "tools/xtask/src/abi_staging/request_derivation.rs",
  ".github/workflows/abi-staging-request-feed.yml",
]
```

Unknown fields fail. `implementation_paths` is sorted, duplicate-free,
repository-relative, regular, nonsymlinked, and nonempty. Generated
`abi/staging/request-policy.generated.json` contains the normalized policy plus
`implementation = [{ path, sha256 }]`. Its canonical digest is the issuance
`policy_sha256`; changing protected request behavior without changing that
digest fails freshness checks. `version` must increase if a field meaning
changes; content-only implementation changes may retain the version while
changing the digest.

### Structural ABI artifact

The uncredentialed exact-head job emits `StructuralAbiReportV1`:

```rust
pub struct ExactGitSourceV1 {
    pub repository: String,
    pub commit: String,
    pub tree: String,
}

pub struct StructuralAbiReportV1 {
    pub schema: u64,
    pub kind: String,
    pub source: ExactGitSourceV1,
    pub observed_previous_abi: Option<u64>,
    pub target_abi: u64,
    pub snapshot_sha256: String,
    pub snapshot_file_sha256: String,
    pub check_command_sha256: String,
    pub outcome: StructuralAbiOutcomeV1,
}

pub enum StructuralAbiOutcomeV1 {
    Compatible,
    BumpedWithSnapshot,
    ChangedWithoutBump,
    Invalid,
}
```

The report contains no timestamp or base authority. The protected writer
requires `Compatible` or `BumpedWithSnapshot`, verifies exact commit/tree,
re-hashes `abi/snapshot.json`, reads `ABI_VERSION` from inert exact-head source,
and rejects `ChangedWithoutBump` with
`abi_structure_changed_without_bump`. It never trusts the report to supply a
different source or target.

### Request derivation and current selection

```rust
pub struct PullRequestIdentityV1 {
    pub repository: String,
    pub number: u64,
    pub exact_head_repository: String,
    pub exact_head: String,
    pub exact_tree: String,
    pub base_commit: Option<String>,
    pub base_tree: Option<String>,
    pub ref_hint: Option<String>,
}

pub struct ProtectedRequestContextV1 {
    pub protected_repository: String,
    pub protected_commit: String,
    pub protected_tree: String,
    pub issuer_workflow_ref: String,
    pub policy: RequestPolicyV1,
    pub policy_sha256: String,
    pub guard_registry_version: u64,
    pub guard_registry_sha256: String,
}

pub fn derive_abi_staging_request(
    exact_head_root: &Path,
    pull_request: &PullRequestIdentityV1,
    protected: &ProtectedRequestContextV1,
    structural: &StructuralAbiReportV1,
    change_classes: &[ChangeClass],
) -> Result<AbiStagingRequestV1, String>;

pub struct RequestAssetV1 {
    pub name: String,
    pub browser_download_url: String,
    pub canonical_bytes: Vec<u8>,
}

pub enum CurrentRequestSelectionV1 {
    NotApplicable,
    Missing { expected_head: String },
    Selected {
        request_digest: String,
        asset_name: String,
        asset_url: String,
        request: AbiStagingRequestV1,
    },
    Invalid { errors: Vec<String> },
}

pub fn select_current_request(
    assets: &[RequestAssetV1],
    exact_head: &str,
    requirements_sha256: &str,
    policy_version: u64,
    policy_sha256: &str,
    guard_registry_version: u64,
    guard_registry_sha256: &str,
) -> CurrentRequestSelectionV1;
```

Selection filters by full filename head only as an index, validates every
matching asset, and then applies `request_is_current`. Two distinct valid
canonical assets matching the same complete current identity are an error;
canonical determinism should make them byte-identical and therefore one
digest. Assets for other heads are returned separately as historical valid
work, never considered “newer” or “older” by string comparison.

### Append-only feed plan

```rust
pub enum RequestFeedActionV1 {
    CreatePrerelease,
    AppendAsset,
    AssetAlreadyIdentical,
    RejectNameCollision,
}

pub struct RequestFeedPlanV1 {
    pub repository: String,
    pub pull_request_number: u64,
    pub tag: String,
    pub asset_name: String,
    pub asset_sha256: String,
    pub asset_bytes: u64,
    pub public_download_url: String,
    pub action: RequestFeedActionV1,
}
```

The shell adapter receives a canonical plan and request file. It may create
the prerelease or append one asset. It never passes `--clobber`, deletes an
asset, retags a Release, uses a mutable latest name, or appends lifecycle
assets. An existing identical asset is a successful no-op; different bytes at
the same name fail.

### Tap discovery and lifecycle decision

Protected tap Python mirrors the canonical request validator. Cross-repository
fixtures prove byte-for-byte agreement with Rust.

```python
@dataclass(frozen=True)
class DiscoveredRequestV1:
    request_digest: str
    asset_name: str
    asset_url: str
    release_tag: str
    request: Mapping[str, object]

@dataclass(frozen=True)
class PullRequestLifecycleV1:
    state: Literal["open", "merged", "closed"]
    current_head: str | None
    merged_commit: str | None

@dataclass(frozen=True)
class ReconciliationDecisionV1:
    request_digest: str
    claim_key: str
    lifecycle: PullRequestLifecycleV1
    current_for_pull_request: bool
    action: Literal[
        "observe-open",
        "observe-merged",
        "stop-new-work",
        "resume-same-head",
        "await-new-request",
    ]
    permitted_work: tuple[str, ...]
    blockers: tuple[Mapping[str, object], ...]
```

In Plan 2, `permitted_work` is always empty because build scheduling is not yet
active. The decision still distinguishes current versus historical heads and
all close/reopen/merge states so Plan 3 can add ready work without changing
lifecycle meaning.

The public client accepts only HTTPS URLs under:

```text
https://github.com/Automattic/kandelo/releases/download/
  abi-staging-pr-<positive-pr-number>/
  candidate-request-<full-head>-sha256-<digest>.json
```

Redirects may terminate only on GitHub-owned release asset hosts explicitly
listed in `Kandelo/staging/request-issuers.toml`; every hop remains HTTPS,
contains no userinfo or fragment, and is bounded to five redirects. A final
body is at most 4 MiB and must have the requested canonical digest. The allowlist
is a transport boundary, not an issuer substitute.

## File Map

### Kandelo repository

- Modify: `tools/xtask/src/abi_staging/mod.rs`
- Modify: `tools/xtask/src/abi_staging/records.rs`
- Create: `tools/xtask/src/abi_staging/request_policy.rs`
- Create: `tools/xtask/src/abi_staging/request_derivation.rs`
- Create: `tools/xtask/src/abi_staging/request_feed.rs`
- Create: `abi/staging/request-policy.toml`
- Create: `abi/staging/request-policy.generated.json`
- Create: `abi/staging/request-feed-activation.toml`
- Create: `tools/xtask/tests/fixtures/abi-staging/request/structural-report.json`
- Create: `tools/xtask/tests/fixtures/abi-staging/request/current-request.json`
- Create: `tools/xtask/tests/fixtures/abi-staging/request/same-head-reissued-request.json`
- Create: `tools/xtask/tests/fixtures/abi-staging/request/historical-request.json`
- Create: `.github/scripts/publish-abi-staging-request.sh`
- Create: `.github/scripts/test-publish-abi-staging-request.sh`
- Create: `.github/workflows/abi-staging-request-feed.yml`
- Create: `scripts/check-abi-staging-request-workflow.rb`
- Create: `scripts/test-abi-staging-request-feed.sh`
- Create: `scripts/test-abi-staging-cross-repo-fixtures.sh`
- Modify: `.github/actions/detect-change-scope/ci-scope-paths.sh`
- Modify: `.github/actions/detect-change-scope/test-ci-scope-paths.sh`
- Modify: `docs/abi-versioning.md`
- Modify: `docs/repository-organization.md`
- Modify: `docs/superpowers/plans/2026-08-08-abi-staging-product-authority-foundation.md`

### Tap repository

- Create: `Kandelo/staging/request-issuers.toml`
- Create: `Kandelo/staging/reconciliation-activation.toml`
- Create: `Kandelo/staging/fixtures/request/current-request.json`
- Create: `Kandelo/staging/fixtures/request/same-head-reissued-request.json`
- Create: `Kandelo/staging/fixtures/request/historical-request.json`
- Create: `scripts/abi_staging/__init__.py`
- Create: `scripts/abi_staging/canonical.py`
- Create: `scripts/abi_staging/request.py`
- Create: `scripts/abi_staging/github_public.py`
- Create: `scripts/abi_staging/reconcile.py`
- Create: `scripts/abi_staging/cli.py`
- Create: `scripts/abi_staging/tests/__init__.py`
- Create: `scripts/abi_staging/tests/test_canonical.py`
- Create: `scripts/abi_staging/tests/test_request.py`
- Create: `scripts/abi_staging/tests/test_github_public.py`
- Create: `scripts/abi_staging/tests/test_reconcile.py`
- Create: `scripts/check_abi_staging_workflows.rb`
- Create: `scripts/test_check_abi_staging_workflows.rb`
- Create: `.github/workflows/abi-staging-reconcile.yml`
- Modify: `Kandelo/README.md`
- Modify: `README.md`

---

### Task 1: Freeze protected request policy and implementation identity

**Files:**

- Modify: `tools/xtask/src/abi_staging/mod.rs`
- Create: `tools/xtask/src/abi_staging/request_policy.rs`
- Create: `abi/staging/request-policy.toml`
- Create: `abi/staging/request-policy.generated.json`
- Create: `abi/staging/request-feed-activation.toml`

**Interfaces:**

- Consumes: Plan 1 canonical JSON, path, digest, guard registry, and product
  limits.
- Produces: strict `RequestPolicyV1`, generated protected implementation
  identity, `RequestFeedActivationV1`, and CLI commands:
  `abi-staging request-policy generate` and
  `abi-staging request-policy check`.
- `request-feed-activation.toml` has exactly `schema`, `kind`, and
  `mode = "observe" | "active"`; it begins as `observe`.

- [ ] **Step 1: Write failing policy tests**

  Add unit tests for exact parsing, unknown fields, a mutable workflow ref,
  duplicate/unsafe implementation paths, a symlink, missing implementation
  file, changed implementation bytes, stale generated JSON, and a policy
  meaning change without a version increment. Assert no ABI number, branch,
  candidate URL, retry, or runner appears in the policy.

- [ ] **Step 2: Run the focused tests and verify red**

  ```bash
  scripts/dev-shell.sh bash -c '
    host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
    cargo test -p xtask --target "$host_target" \
      abi_staging::request_policy
  '
  ```

  Expected: FAIL because the policy model and commands do not exist.

- [ ] **Step 3: Implement strict policy generation**

  Hash exact bytes of every sorted `implementation_paths` entry. Refuse
  directories, symlinks, missing files, duplicate normalized paths, or paths
  outside the repository root. Generate atomically and make `check` compare
  exact canonical bytes.

- [ ] **Step 4: Run focused tests and generate the checked projection**

  ```bash
  scripts/dev-shell.sh bash -c '
    host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
    cargo test -p xtask --target "$host_target" \
      abi_staging::request_policy
    cargo run -p xtask --target "$host_target" --quiet -- \
      abi-staging request-policy generate \
      --source abi/staging/request-policy.toml \
      --out abi/staging/request-policy.generated.json
    cargo run -p xtask --target "$host_target" --quiet -- \
      abi-staging request-policy check \
      --source abi/staging/request-policy.toml \
      --generated abi/staging/request-policy.generated.json
  '
  ```

  Expected: PASS; activation remains `observe`.

- [ ] **Step 5: Commit**

  ```bash
  git add tools/xtask/src/abi_staging/mod.rs \
    tools/xtask/src/abi_staging/request_policy.rs \
    abi/staging/request-policy.toml \
    abi/staging/request-policy.generated.json \
    abi/staging/request-feed-activation.toml
  git commit -m "[ABI] Bind staging request policy to protected code"
  ```

---

### Task 2: Derive one canonical request from an exact head

**Files:**

- Modify: `tools/xtask/src/abi_staging/mod.rs`
- Modify: `tools/xtask/src/abi_staging/records.rs`
- Create: `tools/xtask/src/abi_staging/request_derivation.rs`
- Create: `tools/xtask/tests/fixtures/abi-staging/request/structural-report.json`
- Create: `tools/xtask/tests/fixtures/abi-staging/request/current-request.json`

**Interfaces:**

- Consumes: Plan 1 product/registry selection and request model plus Task 1
  protected policy.
- Produces: `StructuralAbiReportV1`, `PullRequestIdentityV1`,
  `ProtectedRequestContextV1`, `derive_abi_staging_request`, and commands:
  `abi-staging structural-report validate` and
  `abi-staging request derive`.
- The fixture models a local source ABI `7` and target ABI `8`; these are test
  inputs, not defaults or policy.

- [ ] **Step 1: Write failing exact-source tests**

  Build temporary Git repositories whose head and tree differ from a synthetic
  merge. Assert the request always names the supplied exact head/tree, and
  reject a report, checkout, authorization head, filename head, or tree that
  disagrees. Assert base commit/tree/ref remain informational and changing
  them alone cannot change Formula requirements or bottle-facing source
  identity.

- [ ] **Step 2: Write failing requirements tests**

  Derive exact-head selection for ABI, kernel, and host cases. Assert every
  product and registry path/digest is bound, every evidence ID and
  applicability is retained, Formula roots derive only from products, and no
  tap revision, transitive dependency, background Formula, matrix, timeout,
  or mutable status enters the request.

- [ ] **Step 3: Write failing ABI-report tests**

  Cover compatible same-ABI work, a correct successor bump, changed structure
  without bump, stale snapshot bytes, target mismatch, report source mismatch,
  an uppercase Git SHA, and a report that attempts to supply a second source.
  The protected comparison must produce the registered guard code rather than
  a free-form replacement.

- [ ] **Step 4: Run focused tests and verify red**

  ```bash
  scripts/dev-shell.sh bash -c '
    host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
    cargo test -p xtask --target "$host_target" \
      abi_staging::request_derivation
  '
  ```

  Expected: FAIL because derivation is absent.

- [ ] **Step 5: Implement minimal pure derivation**

  Load exact-head product TOML and registries through Plan 1 parsers, select by
  explicit change classes, canonicalize the requirements section without its
  own digest, insert that digest, then validate the complete request before
  returning it. Do not invoke GitHub, a Formula parser, or a builder.

- [ ] **Step 6: Generate and check the canonical fixture**

  ```bash
  scripts/dev-shell.sh bash -c '
    host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
    cargo test -p xtask --target "$host_target" \
      abi_staging::request_derivation
    cargo run -p xtask --target "$host_target" --quiet -- \
      abi-staging request fixture-check \
      --fixture tools/xtask/tests/fixtures/abi-staging/request
  '
  ```

  Expected: PASS and byte-stable output on two runs.

- [ ] **Step 7: Commit**

  ```bash
  git add tools/xtask/src/abi_staging/mod.rs \
    tools/xtask/src/abi_staging/records.rs \
    tools/xtask/src/abi_staging/request_derivation.rs \
    tools/xtask/tests/fixtures/abi-staging/request/structural-report.json \
    tools/xtask/tests/fixtures/abi-staging/request/current-request.json
  git commit -m "[ABI] Derive staging requests from exact heads"
  ```

---

### Task 3: Select the current request without discarding history

**Files:**

- Modify: `tools/xtask/src/abi_staging/mod.rs`
- Create: `tools/xtask/src/abi_staging/request_feed.rs`
- Create: `tools/xtask/tests/fixtures/abi-staging/request/same-head-reissued-request.json`
- Create: `tools/xtask/tests/fixtures/abi-staging/request/historical-request.json`

**Interfaces:**

- Consumes: Plan 1 filename/parser/current predicate and Task 2 canonical
  requests.
- Produces: `RequestAssetV1`, `CurrentRequestSelectionV1`,
  `RequestFeedPlanV1`, `select_current_request`, and commands:
  `abi-staging request select-current` and
  `abi-staging request plan-feed-write`.

- [ ] **Step 1: Write failing current-selection tests**

  Cover one current request, same-head policy reissuance, old-head assets,
  same-head stale requirements, stale guard registry, malformed matching-head
  asset, duplicate canonical current assets, nonmatching filenames, and no
  current request. Randomize input order and assert identical output.

- [ ] **Step 2: Write explicit anti-ordering tests**

  Add values whose lexical SHA order, upload order, synthetic timestamp, and
  release asset ID imply the wrong result. Assert none appears in the selector
  inputs or changes selection. Reject names such as `latest.json`,
  `current.json`, abbreviated heads, uppercase heads, and timestamp suffixes.

- [ ] **Step 3: Run focused tests and verify red**

  ```bash
  scripts/dev-shell.sh bash -c '
    host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
    cargo test -p xtask --target "$host_target" \
      abi_staging::request_feed
  '
  ```

  Expected: FAIL because feed planning is absent.

- [ ] **Step 4: Implement deterministic selection and write planning**

  Validate all assets matching the exact filename head. Treat an invalid
  matching asset as an explicit invalid result, not something silently skipped
  in favor of another. Return other fully valid assets as historical inventory
  for reconciliation. Make feed planning a pure comparison of desired bytes
  and bounded existing Release metadata.

- [ ] **Step 5: Run focused tests and verify green**

  ```bash
  scripts/dev-shell.sh bash -c '
    host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
    cargo test -p xtask --target "$host_target" \
      abi_staging::request_feed
  '
  ```

  Expected: PASS; fixture shuffling cannot change selection.

- [ ] **Step 6: Commit**

  ```bash
  git add tools/xtask/src/abi_staging/mod.rs \
    tools/xtask/src/abi_staging/request_feed.rs \
    tools/xtask/tests/fixtures/abi-staging/request/same-head-reissued-request.json \
    tools/xtask/tests/fixtures/abi-staging/request/historical-request.json
  git commit -m "[ABI] Select current requests by exact policy identity"
  ```

---

### Task 4: Implement the append-only Kandelo prerelease adapter

**Files:**

- Create: `.github/scripts/publish-abi-staging-request.sh`
- Create: `.github/scripts/test-publish-abi-staging-request.sh`

**Interfaces:**

- Consumes: Task 3 canonical `RequestFeedPlanV1`, canonical request bytes,
  `GH_TOKEN`, and GitHub's Release API through `gh`.
- Produces: one created/updated prerelease UI and one exact immutable asset;
  writes `release_id`, `asset_id`, `asset_url`, and `action` to
  `$GITHUB_OUTPUT`.
- Usage is exact:

  ```text
  publish-abi-staging-request.sh
    --repository Automattic/kandelo
    --protected-target <full-main-sha>
    --plan <canonical-plan-json>
    --request <canonical-request-json>
  ```

  The angle-bracket values above describe positional contracts; the workflow
  supplies concrete files and a full SHA.

- [ ] **Step 1: Write a fake-`gh` failing test harness**

  Model absent Release, existing correct prerelease, identical existing asset,
  name collision, wrong tag target, wrong prerelease flag, pagination, upload
  failure, and interrupted description update. Record every fake API call and
  assert no delete, clobber, tag move, lifecycle asset, or candidate checkout
  occurs.

- [ ] **Step 2: Run the adapter tests and verify red**

  ```bash
  scripts/dev-shell.sh bash \
    .github/scripts/test-publish-abi-staging-request.sh
  ```

  Expected: FAIL because the publisher script is absent.

- [ ] **Step 3: Implement bounded append/no-clobber behavior**

  Parse the plan with `jq`, verify request size/digest/name before any API
  call, create a prerelease anchored to the captured protected-main commit when
  absent, inspect every paginated asset, and upload only when the exact name is
  absent. If present, download to a new temporary directory and byte-compare.
  Update descriptive prose only after the asset is known good; description
  state is never read as authority.

- [ ] **Step 4: Run the adapter tests and verify green**

  ```bash
  scripts/dev-shell.sh bash \
    .github/scripts/test-publish-abi-staging-request.sh
  ```

  Expected: PASS for idempotence and every mutation.

- [ ] **Step 5: Commit**

  ```bash
  git add .github/scripts/publish-abi-staging-request.sh \
    .github/scripts/test-publish-abi-staging-request.sh
  git commit -m "[ABI] Append exact requests to the public feed"
  ```

---

### Task 5: Add the protected same-repository request workflow

**Files:**

- Create: `.github/workflows/abi-staging-request-feed.yml`
- Create: `scripts/check-abi-staging-request-workflow.rb`
- Create: `scripts/test-abi-staging-request-feed.sh`
- Modify: `.github/actions/detect-change-scope/ci-scope-paths.sh`
- Modify: `.github/actions/detect-change-scope/test-ci-scope-paths.sh`

**Interfaces:**

- Consumes: Tasks 1–4 commands and adapter plus existing
  `scripts/check-abi-version.sh` and protected change-scope logic.
- Produces: observe/active workflow behavior for same-repository PR events,
  protected-policy `push`, daily repair scan, and explicit `workflow_dispatch`
  by pull-request number.
- Job permission map is exact:

  | Job | Permissions | Candidate execution |
  |---|---|---|
  | `classify-exact-head` | `contents: read` | Yes, exact head only |
  | `derive-request` | `contents: read` | No; exact-head files are inert data |
  | `publish-request` | `contents: write`, `actions: read` | No; protected code only |

  Workflow-level permissions are `{}`. No job has a secret. Checkout always
  sets `persist-credentials: false`.

- [ ] **Step 1: Write failing structural workflow assertions**

  Check exact triggers, permission maps, full-SHA actions, current protected
  main capture, exact PR head/tree capture, same-repository predicate,
  observe-mode write suppression, artifact inventory, and separation between
  the candidate-executing and write jobs.

- [ ] **Step 2: Write failing workflow mutations**

  Mutate exact head to `refs/pull/.../merge`, add a merge command, grant write
  to classification, pass `GH_TOKEN` into classification, persist checkout
  credentials, execute a head script in the writer, trust the artifact's ABI
  without inert revalidation, use `--clobber`, select by timestamp, enable
  forks, or swallow publication failure. Every mutation must fail with a
  specific diagnostic.

- [ ] **Step 3: Run workflow and routing tests and verify red**

  ```bash
  scripts/dev-shell.sh ruby scripts/check-abi-staging-request-workflow.rb
  scripts/dev-shell.sh bash scripts/test-abi-staging-request-feed.sh
  scripts/dev-shell.sh bash \
    .github/actions/detect-change-scope/test-ci-scope-paths.sh
  ```

  Expected: FAIL because the workflow and routing are absent.

- [ ] **Step 4: Implement observe-mode workflow**

  The classification job checks out the exact head and emits only the bounded
  structural report. The derivation job captures current protected `main`,
  compiles protected `xtask`, reads exact-head product/registry files as data,
  and emits the canonical request and feed plan. The publisher downloads only
  named artifacts from the same run, revalidates them with protected `xtask`,
  and writes only when activation is `active`; in `observe`, it prints the
  exact intended public URL and digest.

- [ ] **Step 5: Add policy-change and repair enumeration**

  On protected policy/product-rule path changes and the daily repair scan,
  enumerate open same-repository PRs with bounded pagination and derive each
  exact current head independently. Do not batch source checkouts into one
  mutable worktree and do not drop older already-issued requests.

- [ ] **Step 6: Run workflow, routing, and local feed tests**

  ```bash
  scripts/dev-shell.sh ruby scripts/check-abi-staging-request-workflow.rb
  scripts/dev-shell.sh bash scripts/test-abi-staging-request-feed.sh
  scripts/dev-shell.sh bash \
    .github/actions/detect-change-scope/test-ci-scope-paths.sh
  scripts/dev-shell.sh actionlint \
    .github/workflows/abi-staging-request-feed.yml
  ```

  Expected: PASS while activation remains observe-only.

- [ ] **Step 7: Commit**

  ```bash
  git add .github/workflows/abi-staging-request-feed.yml \
    scripts/check-abi-staging-request-workflow.rb \
    scripts/test-abi-staging-request-feed.sh \
    .github/actions/detect-change-scope/ci-scope-paths.sh \
    .github/actions/detect-change-scope/test-ci-scope-paths.sh
  git commit -m "[ABI] Prepare protected exact-head request issuance"
  ```

---

### Task 6: Mirror request validation in protected tap code

**Repository:** `kandelo-dev/homebrew-tap-core`

**Files:**

- Create: `Kandelo/staging/request-issuers.toml`
- Create: `Kandelo/staging/fixtures/request/current-request.json`
- Create: `Kandelo/staging/fixtures/request/same-head-reissued-request.json`
- Create: `Kandelo/staging/fixtures/request/historical-request.json`
- Create: `scripts/abi_staging/__init__.py`
- Create: `scripts/abi_staging/canonical.py`
- Create: `scripts/abi_staging/request.py`
- Create: `scripts/abi_staging/tests/__init__.py`
- Create: `scripts/abi_staging/tests/test_canonical.py`
- Create: `scripts/abi_staging/tests/test_request.py`

**Interfaces:**

- Consumes: Kandelo Task 3 canonical fixtures and Plan 1 request contract.
- Produces: strict Python `canonical_bytes`, `canonical_sha256`,
  `parse_request_asset_name`, and `validate_request` functions.
- `request-issuers.toml` contains the exact Kandelo repository, request tag
  prefix, addressed tap identity, allowed GitHub Release hosts, body/field
  bounds, and accepted schema/kind. It contains no ABI or mutable workflow ref.

- [ ] **Step 1: Create the tap implementation worktree safely**

  At implementation time, use `superpowers:using-git-worktrees` to create a
  dedicated tap worktree from current `origin/main`. Set
  `KANDELO_TAP_ROOT` to its absolute path. Do not edit the read-only audit
  worktree used while this plan was written.

- [ ] **Step 2: Copy exact canonical fixtures and write failing parity tests**

  Copy the three request fixture bytes without reserialization. Assert Python
  reproduces their SHA-256 and rejects every Rust negative vector: unknown
  fields, noncanonical whitespace/key order, wrong filename head/digest,
  unauthorized issuer, unaddressed tap, malformed Git identities, and an
  informational field used as authority.

- [ ] **Step 3: Run tap parity tests through the Kandelo dev shell**

  ```bash
  scripts/dev-shell.sh env \
    KANDELO_TAP_ROOT="$KANDELO_TAP_ROOT" \
    python3 -m unittest discover \
      -s "$KANDELO_TAP_ROOT/scripts/abi_staging/tests" \
      -p 'test_canonical.py'
  scripts/dev-shell.sh env \
    KANDELO_TAP_ROOT="$KANDELO_TAP_ROOT" \
    python3 -m unittest discover \
      -s "$KANDELO_TAP_ROOT/scripts/abi_staging/tests" \
      -p 'test_request.py'
  ```

  Expected: FAIL because tap validators are absent.

- [ ] **Step 4: Implement strict bounded Python validation**

  Use only the standard library. Reject floats, duplicate JSON keys, invalid
  UTF-8, extra fields, oversized arrays/strings, and noncanonical bytes.
  Validate the filename against canonical bytes after the complete typed shape
  passes. Preserve request fields as immutable mappings; never execute or
  source a value.

- [ ] **Step 5: Run parity tests and compare fixture bytes**

  ```bash
  scripts/dev-shell.sh env \
    KANDELO_TAP_ROOT="$KANDELO_TAP_ROOT" \
    python3 -m unittest discover \
      -s "$KANDELO_TAP_ROOT/scripts/abi_staging/tests" \
      -p 'test_canonical.py' -v
  scripts/dev-shell.sh env \
    KANDELO_TAP_ROOT="$KANDELO_TAP_ROOT" \
    python3 -m unittest discover \
      -s "$KANDELO_TAP_ROOT/scripts/abi_staging/tests" \
      -p 'test_request.py' -v
  ```

  Expected: PASS with identical digests in Rust and Python.

- [ ] **Step 6: Commit in the tap repository**

  ```bash
  git -C "$KANDELO_TAP_ROOT" add Kandelo/staging/request-issuers.toml \
    Kandelo/staging/fixtures/request \
    scripts/abi_staging/__init__.py \
    scripts/abi_staging/canonical.py \
    scripts/abi_staging/request.py \
    scripts/abi_staging/tests/__init__.py \
    scripts/abi_staging/tests/test_canonical.py \
    scripts/abi_staging/tests/test_request.py
  git -C "$KANDELO_TAP_ROOT" commit -m \
    "[ABI] Validate public staging requests in the tap"
  ```

---

### Task 7: Discover public assets and reconcile pull-request lifecycle

**Repository:** `kandelo-dev/homebrew-tap-core`

**Files:**

- Create: `Kandelo/staging/reconciliation-activation.toml`
- Create: `scripts/abi_staging/github_public.py`
- Create: `scripts/abi_staging/reconcile.py`
- Create: `scripts/abi_staging/cli.py`
- Create: `scripts/abi_staging/tests/test_github_public.py`
- Create: `scripts/abi_staging/tests/test_reconcile.py`

**Interfaces:**

- Consumes: Task 6 validated requests and public GitHub REST responses.
- Produces: bounded `GitHubPublicClient`, `DiscoveredRequestV1`,
  `PullRequestLifecycleV1`, `ReconciliationDecisionV1`, and commands:
  `python3 -m scripts.abi_staging.cli scan` and
  `python3 -m scripts.abi_staging.cli reconcile --request-asset-url URL`.
- `reconciliation-activation.toml` begins with `mode = "observe"` and rejects
  other fields.

- [ ] **Step 1: Write failing HTTP-boundary tests**

  Use an in-process fake HTTP opener, not the internet. Cover release and asset
  pagination, duplicate pages, response/body limits, five-hop redirect limit,
  wrong repository/tag/asset grammar, cross-host redirect, downgrade to HTTP,
  userinfo, fragment, wrong content length, truncated body, and digest drift.
  Prove manual and scan paths return identical `DiscoveredRequestV1`.

- [ ] **Step 2: Write failing lifecycle-table tests**

  Cover open current head, new head with old request, merged exact request,
  closed unmerged, reopened same head, reopened different head, a historical
  explicitly issued head, duplicate discovery, and shuffled API order. Assert
  deterministic claim key `sha256:<request-digest>` and no timestamp- or
  commit-order decision.

- [ ] **Step 3: Run tests and verify red**

  ```bash
  scripts/dev-shell.sh env \
    KANDELO_TAP_ROOT="$KANDELO_TAP_ROOT" \
    python3 -m unittest discover \
      -s "$KANDELO_TAP_ROOT/scripts/abi_staging/tests" \
      -p 'test_github_public.py' -v
  scripts/dev-shell.sh env \
    KANDELO_TAP_ROOT="$KANDELO_TAP_ROOT" \
    python3 -m unittest discover \
      -s "$KANDELO_TAP_ROOT/scripts/abi_staging/tests" \
      -p 'test_reconcile.py' -v
  ```

  Expected: FAIL because discovery/reconciliation is absent.

- [ ] **Step 4: Implement bounded public discovery**

  Fetch every prerelease whose tag matches the exact prefix and positive PR
  number, then every request asset with bounded pagination. Validate each body
  before returning it. The manual URL path first applies the exact URL grammar
  and then uses the same downloader/validator. Numeric Release/asset IDs remain
  audit metadata only.

- [ ] **Step 5: Implement pure lifecycle reconciliation**

  Read current PR state separately for every claimed request. Closing permits
  no new work, merge selects only the request associated with that PR, and
  reopening preserves attempt/retry history to be supplied by Plan 3. In this
  plan all decisions are observe-only and schedule no work.

- [ ] **Step 6: Run the complete tap unit suite**

  ```bash
  scripts/dev-shell.sh env \
    KANDELO_TAP_ROOT="$KANDELO_TAP_ROOT" \
    python3 -m unittest discover \
      -s "$KANDELO_TAP_ROOT/scripts/abi_staging/tests" -v
  ```

  Expected: PASS with no network or mutable local state.

- [ ] **Step 7: Commit in the tap repository**

  ```bash
  git -C "$KANDELO_TAP_ROOT" add \
    Kandelo/staging/reconciliation-activation.toml \
    scripts/abi_staging/github_public.py \
    scripts/abi_staging/reconcile.py \
    scripts/abi_staging/cli.py \
    scripts/abi_staging/tests/test_github_public.py \
    scripts/abi_staging/tests/test_reconcile.py
  git -C "$KANDELO_TAP_ROOT" commit -m \
    "[ABI] Reconcile exact request lifecycle from public facts"
  ```

---

### Task 8: Add equivalent scheduled and manual tap workflows

**Repository:** `kandelo-dev/homebrew-tap-core`

**Files:**

- Create: `.github/workflows/abi-staging-reconcile.yml`
- Create: `scripts/check_abi_staging_workflows.rb`
- Create: `scripts/test_check_abi_staging_workflows.rb`

**Interfaces:**

- Consumes: Task 7 CLI and activation policy.
- Produces: a five-minute schedule and one manual `request_asset_url` input,
  both invoking the exact protected `reconcile` command in observe mode.
- Exact permission map is workflow `{}` and job `{ contents: read }`.

- [ ] **Step 1: Write failing workflow contract and mutation tests**

  Assert `cron: "*/5 * * * *"`, one optional manual URL, no PR event, no
  `repository_dispatch`, protected tap-main checkout, `persist-credentials:
  false`, full-SHA actions, bounded timeout, and identical CLI path. Mutations
  granting write, adding secrets, executing request content, checking out a
  request-supplied ref, using a different manual coordinator, or dispatching a
  build must fail.

- [ ] **Step 2: Run checker tests and verify red**

  ```bash
  scripts/dev-shell.sh env \
    KANDELO_TAP_ROOT="$KANDELO_TAP_ROOT" \
    ruby "$KANDELO_TAP_ROOT/scripts/test_check_abi_staging_workflows.rb"
  ```

  Expected: FAIL because the workflow/checker is absent.

- [ ] **Step 3: Implement the thin workflow**

  Pin checkout and setup-python actions. Scheduled mode invokes `scan`;
  workflow dispatch with a nonempty URL invokes `reconcile`. Both write a
  bounded job summary containing request digest, exact head, current/historical
  classification, lifecycle, blockers, and the public asset URL. No output is
  treated as a Check or datastore.

- [ ] **Step 4: Run actionlint and mutation tests**

  ```bash
  scripts/dev-shell.sh env \
    KANDELO_TAP_ROOT="$KANDELO_TAP_ROOT" \
    actionlint "$KANDELO_TAP_ROOT/.github/workflows/abi-staging-reconcile.yml"
  scripts/dev-shell.sh env \
    KANDELO_TAP_ROOT="$KANDELO_TAP_ROOT" \
    ruby "$KANDELO_TAP_ROOT/scripts/test_check_abi_staging_workflows.rb"
  ```

  Expected: PASS; workflow has no write capability.

- [ ] **Step 5: Commit in the tap repository**

  ```bash
  git -C "$KANDELO_TAP_ROOT" add \
    .github/workflows/abi-staging-reconcile.yml \
    scripts/check_abi_staging_workflows.rb \
    scripts/test_check_abi_staging_workflows.rb
  git -C "$KANDELO_TAP_ROOT" commit -m \
    "[ABI] Observe requests through one tap reconciler"
  ```

---

### Task 9: Prove the cross-repository protocol locally

**Files:**

- Create: `scripts/test-abi-staging-cross-repo-fixtures.sh`
- Modify: `scripts/test-abi-staging-request-feed.sh`

**Interfaces:**

- Consumes: all Kandelo and tap work from Tasks 1–8.
- Produces: one deterministic no-network test that derives requests in
  Kandelo, publishes them into a fake Release directory, discovers them with
  protected tap code, and compares decisions.

- [ ] **Step 1: Write the failing cross-repository harness**

  Require a validated absolute `KANDELO_TAP_ROOT`, confirm its remote URL names
  `kandelo-dev/homebrew-tap-core`, create fresh temporary repositories, and run
  these cases: initial head, same-head policy reissue, PR advance, old-head
  completion, close, reopen same head, reopen different head, and merge.

- [ ] **Step 2: Add authority-negative cases**

  Reject synthetic build source, wrong Release repository, wrong tag PR,
  request filename/body mismatch, unaddressed tap, stale current policy, a
  timestamped latest alias, redirect escape, and a candidate-supplied
  reconciler path.

- [ ] **Step 3: Run the harness and verify red**

  ```bash
  scripts/dev-shell.sh env \
    KANDELO_TAP_ROOT="$KANDELO_TAP_ROOT" \
    bash scripts/test-abi-staging-cross-repo-fixtures.sh
  ```

  Expected: FAIL until the fake feed adapter and tap CLI are wired together.

- [ ] **Step 4: Complete only fixture adapters**

  Add no production fallback. The fake Release transport implements the same
  append/no-clobber and URL grammar, while the fake PR client supplies explicit
  lifecycle facts. Compare canonical request and decision bytes from two clean
  runs.

- [ ] **Step 5: Run the full local Plan 2 suite**

  ```bash
  scripts/dev-shell.sh env \
    KANDELO_TAP_ROOT="$KANDELO_TAP_ROOT" \
    bash scripts/test-abi-staging-request-feed.sh
  scripts/dev-shell.sh env \
    KANDELO_TAP_ROOT="$KANDELO_TAP_ROOT" \
    bash scripts/test-abi-staging-cross-repo-fixtures.sh
  ```

  Expected: PASS twice from fresh temporary directories.

- [ ] **Step 6: Commit in Kandelo**

  ```bash
  git add scripts/test-abi-staging-cross-repo-fixtures.sh \
    scripts/test-abi-staging-request-feed.sh
  git commit -m "[ABI] Prove the public request protocol locally"
  ```

---

### Task 10: Run observe-mode hosted canaries before activation

**Files:**

- Modify: `docs/abi-versioning.md`
- Modify: `docs/repository-organization.md`
- Modify: `Kandelo/README.md` in the tap repository
- Modify: `README.md` in the tap repository

**Interfaces:**

- Consumes: merged protected workflow revisions from Tasks 5 and 8.
- Produces: hosted run URLs/digests for exact-head derivation and tap discovery,
  then narrow activation commits if and only if canaries pass.

- [ ] **Step 1: Land observe-only workflow revisions on protected main**

  This is a hosted gate, not a local command. Record exact Kandelo and tap main
  SHAs. If either revision is not on protected main, complete documentation and
  local verification, report the gate, and do not simulate hosted success.

- [ ] **Step 2: Run a Kandelo manual dry-run canary**

  Select a same-repository PR head, run `abi-staging-request-feed.yml` in
  observe mode, and retain the run URL plus canonical request digest. Confirm
  workflow/job permission views, exact head/tree, and absence of a Release
  write.

- [ ] **Step 3: Run a tap manual URL canary against fixture bytes**

  After an append/no-clobber publication canary is explicitly authorized,
  supply its ordinary browser download URL to the tap workflow. Retain the run
  URL and verify the same request digest, lifecycle decision, no build
  dispatch, and no package or branch write.

- [ ] **Step 4: Prove append idempotence and same-head reissuance**

  Invoke the Kandelo writer twice for identical bytes and once after a protected
  policy digest change in a canary branch. The first rerun must no-op; the
  policy change must append a second correctly named same-head asset. Restore
  no Release state because the feed is intentionally historical.

- [ ] **Step 5: Activate automatic same-repository issuance narrowly**

  Change only `abi/staging/request-feed-activation.toml` from `observe` to
  `active`, run the complete local suite, and commit. Do not activate fork
  issuance or tap build scheduling.

  ```bash
  scripts/dev-shell.sh env \
    KANDELO_TAP_ROOT="$KANDELO_TAP_ROOT" \
    bash scripts/test-abi-staging-request-feed.sh
  git add abi/staging/request-feed-activation.toml
  git commit -m "[ABI] Activate exact-head request issuance"
  ```

- [ ] **Step 6: Update documentation to the exact deployed claim**

  State that same-repository exact-head requests are public and tap
  reconciliation is observe-only. State that fork authorization, bottle
  execution, candidate publication, verification, product evidence, Check
  gating, promotion, ABI history, and Pages integration are not operational.

- [ ] **Step 7: Commit documentation in each repository**

  ```bash
  git add docs/abi-versioning.md docs/repository-organization.md
  git commit -m "[Docs] Describe the exact-head request feed"
  git -C "$KANDELO_TAP_ROOT" add Kandelo/README.md README.md
  git -C "$KANDELO_TAP_ROOT" commit -m \
    "[Docs] Describe observe-only ABI reconciliation"
  ```

---

### Task 11: Final Plan 2 verification and handoff audit

**Files:**

- Verify every Plan 2 file in both repositories. Add no candidate build,
  packages write, Check write, promotion, branch mutation, or Pages change.

**Interfaces:**

- Consumes: completed Tasks 1–10 and fresh protected-main/hosted evidence where
  available.
- Produces: evidence for request feed and read-only reconciliation only.

- [ ] **Step 1: Run Kandelo tests**

  ```bash
  scripts/dev-shell.sh bash -c '
    host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
    cargo test -p xtask --target "$host_target" abi_staging
  '
  scripts/dev-shell.sh bash scripts/test-abi-staging-request-feed.sh
  scripts/dev-shell.sh ruby scripts/check-abi-staging-request-workflow.rb
  scripts/dev-shell.sh bash scripts/check-abi-version.sh
  scripts/dev-shell.sh actionlint \
    .github/workflows/abi-staging-request-feed.yml
  ```

  Expected: PASS.

- [ ] **Step 2: Run tap tests through the declared environment**

  ```bash
  scripts/dev-shell.sh env \
    KANDELO_TAP_ROOT="$KANDELO_TAP_ROOT" \
    python3 -m unittest discover \
      -s "$KANDELO_TAP_ROOT/scripts/abi_staging/tests" -v
  scripts/dev-shell.sh env \
    KANDELO_TAP_ROOT="$KANDELO_TAP_ROOT" \
    ruby "$KANDELO_TAP_ROOT/scripts/test_check_abi_staging_workflows.rb"
  scripts/dev-shell.sh env \
    KANDELO_TAP_ROOT="$KANDELO_TAP_ROOT" \
    actionlint "$KANDELO_TAP_ROOT/.github/workflows/abi-staging-reconcile.yml"
  ```

  Expected: PASS.

- [ ] **Step 3: Run cross-repository and documentation checks**

  ```bash
  scripts/dev-shell.sh env \
    KANDELO_TAP_ROOT="$KANDELO_TAP_ROOT" \
    bash scripts/test-abi-staging-cross-repo-fixtures.sh
  scripts/dev-shell.sh npm run docs:build
  ```

  Expected: PASS.

- [ ] **Step 4: Audit workflow capabilities and genericity**

  ```bash
  scripts/dev-shell.sh bash -c '
    rg -n "permissions:|secrets:|persist-credentials|refs/pull/.*/merge|clobber" \
      .github/workflows/abi-staging-request-feed.yml \
      "$KANDELO_TAP_ROOT/.github/workflows/abi-staging-reconcile.yml"
    if rg -n -i "abi[-_ ]?4[23]|integration/abi4[23]" \
      tools/xtask/src/abi_staging \
      abi/staging \
      .github/workflows/abi-staging-request-feed.yml \
      "$KANDELO_TAP_ROOT/scripts/abi_staging" \
      "$KANDELO_TAP_ROOT/Kandelo/staging"; then
      echo "acceptance ABI leaked into generic request infrastructure" >&2
      exit 1
    fi
  '
  ```

  Manually verify that only Kandelo's publisher has `contents: write`, no
  candidate-executing job has write permission, and tap reconciliation has no
  write or dispatch path.

- [ ] **Step 5: Audit both worktrees and stop**

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

  Do not start bottle planning or publication in this plan.

## Exit Criteria

- Protected code derives a canonical request from the exact head and inert
  exact-head product/consumer files under current protected policy.
- Structural ABI evidence runs without write credentials and is revalidated
  before Release writes.
- The feed is one prerelease per PR, append-only by exact asset name, and
  idempotent for identical bytes.
- Same-head policy reissuance and historical older heads remain valid without a
  latest pointer or ordering heuristic.
- Manual and scheduled tap paths use one validator and reconciler.
- Pull-request lifecycle decisions match the approved open/new-head/merged/
  closed/reopened table.
- No tap build, package write, branch write, Check write, promotion, or Pages
  behavior exists yet.
- Local cross-repository fixtures pass; any claimed hosted behavior has exact
  retained run/asset evidence.
- Documentation distinguishes active same-repository request issuance from
  observe-only tap reconciliation and all later unimplemented stages.

After these criteria are met, execute Plan 3. Do not infer permission to
publish candidate packages from a successful request-feed canary.
