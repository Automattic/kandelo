# Exact-Head ABI Request Feed and Reconciliation Implementation Plan

> **Junior-review edition:** The complete command-level version is preserved
> in docs-only commit `0153a8863`. This edition explains the same interfaces,
> tests, trust boundaries, and commit sequence in plainer language. During
> implementation, use the preserved task details together with any review
> changes approved against this edition.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish an immutable request for an exact Kandelo pull-request head
and let protected tap code discover and reconcile current and historical
requests without building anything yet.

**Architecture:** An uncredentialed Kandelo job inspects the exact head and
produces structural ABI evidence. Protected Kandelo code validates that inert
evidence, applies current protected policy, and appends one canonical request
asset to a public prerelease. Protected tap code independently downloads,
validates, and classifies requests. Both hosted paths begin in observe mode.

**Tech Stack:** Plan 1 Rust `xtask` models, TOML policy, Bash and `gh`, Python
standard library, Ruby workflow checkers, GitHub Actions pinned to full commit
SHAs, and local validation through `scripts/dev-shell.sh`.

## Global Constraints

- Keep the Plan 1 type and field names unchanged.
- Reusable code models ABI `N` to `N + 1`; concrete successor values belong
  only in Plan 5 fixture data.
- `build_source` is always the exact PR head commit and tree, never a synthetic
  merge.
- Protected policy and parsing code come from protected current main.
- Exact-head product and registry files are treated as inert data.
- Recompute requirements, policy, and guard digests; do not trust supplied
  digest claims.
- Never choose a current request by time, upload order, asset ID, Git SHA
  ordering, or a mutable latest pointer.
- Asset names are exactly
  `candidate-request-<full-head-sha>-sha256-<request-digest>.json`.
- Automatic issuance covers same-repository PRs only. Fork issuance remains
  disabled in this plan.
- More than one immutable request may exist for one head after policy changes.
- Old exact heads stay discoverable and buildable after the PR advances.
- Candidate-controlled code gets `contents: read`, no secrets, and no
  persisted credentials.
- The Release writer executes protected code only and treats artifacts as
  bounded inert data.
- Tap reconciliation is read-only in this plan: no builds, package writes,
  branch writes, Check writes, or mutable coordinator database.
- Scheduled and manual tap runs call the same validator/reconciler.
- Every third-party action is pinned to a full SHA with a version comment.
- New workflows start observe-only and do not replace legacy behavior.
- Use a separate tap implementation worktree. Do not edit the audit worktree.
- Keep unrelated Kandelo worktree state out of commits.
- Run all local commands through `scripts/dev-shell.sh`.

---

## Plain-language data flow

```text
exact PR head (untrusted code)
        |
        v
uncredentialed structural ABI report
        |
        v
protected current-main validator
        |
        +--> reads exact-head product/registry TOML as data
        |
        v
canonical request bytes + exact immutable filename
        |
        v
append-only public prerelease asset
        |
        v
protected tap downloader and validator
        |
        v
observe-only lifecycle decision
```

An older request is not stale merely because a new head exists. It is
historical work. “Current” is a separate calculation for the PR Check.

## Exact interfaces

### `RequestPolicyV1`

`abi/staging/request-policy.toml` contains exact issuer/tap identities,
same-repository/fork policy, release prefix, 4 MiB request limit, product and
evidence limits, and sorted protected implementation paths. Unknown fields,
unsafe paths, missing files, symlinks, and mutable workflow refs fail.

Generated `request-policy.generated.json` adds
`implementation = [{ path, sha256 }]`. Its canonical digest becomes
`issuance.policy_sha256`. A policy meaning change increments `version`; an
implementation-only change may keep the version while changing the digest.

Activation has exactly `schema`, `kind`, and `mode = "observe" | "active"`.

### Structural ABI evidence

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

The protected writer accepts only `Compatible` or `BumpedWithSnapshot`,
rechecks source/tree, hashes `abi/snapshot.json`, reads `ABI_VERSION` from inert
source, and rejects an incompatible unbumped change with the registered guard.

### Request derivation and current selection

```rust
pub fn derive_abi_staging_request(
    exact_head_root: &Path,
    pull_request: &PullRequestIdentityV1,
    protected: &ProtectedRequestContextV1,
    structural: &StructuralAbiReportV1,
    change_classes: &[ChangeClass],
) -> Result<AbiStagingRequestV1, String>;

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

`CurrentRequestSelectionV1` is `NotApplicable`, `Missing`, `Selected`, or
`Invalid`. A matching-head malformed asset makes the result invalid; it is not
silently skipped. Other valid heads are returned as historical inventory.

### Append-only Release plan

`RequestFeedActionV1` is `CreatePrerelease`, `AppendAsset`,
`AssetAlreadyIdentical`, or `RejectNameCollision`. The publisher may create a
prerelease or append one asset. It never clobbers/deletes an asset, moves a
tag, creates a latest alias, or stores lifecycle authority in the description.

### Tap discovery and lifecycle

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
        "observe-open", "observe-merged", "stop-new-work",
        "resume-same-head", "await-new-request",
    ]
    permitted_work: tuple[str, ...]
    blockers: tuple[Mapping[str, object], ...]
```

`permitted_work` is always empty in Plan 2. Build scheduling starts in Plan 3.

The manual client accepts only HTTPS GitHub Release URLs for the expected
repository, `abi-staging-pr-<positive-number>` tag, and exact asset grammar.
There are at most five HTTPS redirects to configured GitHub-owned asset hosts.
Userinfo/fragments fail, and the final body is at most 4 MiB with an exact
digest.

## File map

### Kandelo

- Modify: `tools/xtask/src/abi_staging/mod.rs`
- Modify: `tools/xtask/src/abi_staging/records.rs`
- Create: `tools/xtask/src/abi_staging/request_policy.rs`
- Create: `tools/xtask/src/abi_staging/request_derivation.rs`
- Create: `tools/xtask/src/abi_staging/request_feed.rs`
- Create request policy, activation, and fixtures under `abi/staging/` and
  `tools/xtask/tests/fixtures/abi-staging/request/`.
- Create: `.github/scripts/publish-abi-staging-request.sh`
- Create: `.github/scripts/test-publish-abi-staging-request.sh`
- Create: `.github/workflows/abi-staging-request-feed.yml`
- Create: `scripts/check-abi-staging-request-workflow.rb`
- Create: `scripts/test-abi-staging-request-feed.sh`
- Create: `scripts/test-abi-staging-cross-repo-fixtures.sh`
- Modify change-scope tests and ABI/repository documentation.

### Tap

- Create request issuer/activation/fixtures under `Kandelo/staging/`.
- Create `scripts/abi_staging/{canonical,request,github_public,reconcile,cli}.py`
  plus package files and unit tests.
- Create: `scripts/check_abi_staging_workflows.rb`
- Create: `scripts/test_check_abi_staging_workflows.rb`
- Create: `.github/workflows/abi-staging-reconcile.yml`
- Modify: `Kandelo/README.md`
- Modify: `README.md`

---

### Task 1: Bind request policy to protected implementation bytes

**Files:**

- Modify: `tools/xtask/src/abi_staging/mod.rs`
- Create: `tools/xtask/src/abi_staging/request_policy.rs`
- Create: `abi/staging/request-policy.toml`
- Create: `abi/staging/request-policy.generated.json`
- Create: `abi/staging/request-feed-activation.toml`

**Interfaces:** Produces `RequestPolicyV1`, `RequestFeedActivationV1`, and
`abi-staging request-policy generate|check`.

- [ ] Write failing tests for exact parsing, unknown/mutable fields, unsafe or
  missing implementation files, symlinks, digest drift, stale generated JSON,
  and a meaning change without a version bump.
- [ ] Run and confirm red:

  ```bash
  scripts/dev-shell.sh bash -c '
    host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
    cargo test -p xtask --target "$host_target" abi_staging::request_policy
  '
  ```

- [ ] Implement strict sorted path hashing and atomic generation/checking.
- [ ] Run tests, generate, and check the projection; expect PASS and
  `mode = "observe"`.
- [ ] Commit:

  ```bash
  git add tools/xtask/src/abi_staging/mod.rs \
    tools/xtask/src/abi_staging/request_policy.rs \
    abi/staging/request-policy.toml \
    abi/staging/request-policy.generated.json \
    abi/staging/request-feed-activation.toml
  git commit -m "[ABI] Bind staging request policy to protected code"
  ```

---

### Task 2: Derive a canonical request from one exact head

**Files:**

- Modify: `tools/xtask/src/abi_staging/mod.rs`
- Modify: `tools/xtask/src/abi_staging/records.rs`
- Create: `tools/xtask/src/abi_staging/request_derivation.rs`
- Create structural-report and current-request fixtures.

**Interfaces:** Produces `StructuralAbiReportV1`, `PullRequestIdentityV1`,
`ProtectedRequestContextV1`, `derive_abi_staging_request`, and the
`structural-report validate`/`request derive` commands.

- [ ] Write failing exact-source tests using temporary repositories where the
  head differs from a synthetic merge.
- [ ] Write failing requirements tests for all change classes and prove all
  Formula roots come from products.
- [ ] Write failing structural ABI cases for compatible, correctly bumped,
  unbumped, stale snapshot, wrong target/source, and uppercase identities.
- [ ] Run and confirm red:

  ```bash
  scripts/dev-shell.sh bash -c '
    host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
    cargo test -p xtask --target "$host_target" abi_staging::request_derivation
  '
  ```

- [ ] Implement pure derivation from exact-head product/registry data. Compute
  the requirements digest without its own digest field, insert it, then
  validate the complete request. Do not call GitHub, Formula code, or builders.
- [ ] Run tests and `abi-staging request fixture-check`; expect byte-stable
  output from the local miniature ABI fixture.
- [ ] Commit:

  ```bash
  git add tools/xtask/src/abi_staging/mod.rs \
    tools/xtask/src/abi_staging/records.rs \
    tools/xtask/src/abi_staging/request_derivation.rs \
    tools/xtask/tests/fixtures/abi-staging/request
  git commit -m "[ABI] Derive staging requests from exact heads"
  ```

---

### Task 3: Select the current request without losing history

**Files:**

- Modify: `tools/xtask/src/abi_staging/mod.rs`
- Create: `tools/xtask/src/abi_staging/request_feed.rs`
- Create same-head-reissued and historical request fixtures.

**Interfaces:** Produces `RequestAssetV1`, `CurrentRequestSelectionV1`,
`RequestFeedPlanV1`, `select_current_request`, `request select-current`, and
`request plan-feed-write`.

- [ ] Write failing selection tests for current, reissued, historical, stale,
  malformed, duplicate, missing, and shuffled asset inputs.
- [ ] Add anti-ordering cases for lexical SHA, upload order, timestamps, asset
  IDs, `latest.json`, short/uppercase heads, and timestamp suffixes.
- [ ] Run `cargo test ... abi_staging::request_feed`; confirm red.
- [ ] Implement deterministic validation/selection and a pure append plan.
  Never skip a malformed matching-head asset.
- [ ] Rerun focused tests; expect identical results for shuffled input.
- [ ] Commit:

  ```bash
  git add tools/xtask/src/abi_staging/mod.rs \
    tools/xtask/src/abi_staging/request_feed.rs \
    tools/xtask/tests/fixtures/abi-staging/request
  git commit -m "[ABI] Select current requests by exact policy identity"
  ```

---

### Task 4: Add the append-only prerelease adapter

**Files:**

- Create: `.github/scripts/publish-abi-staging-request.sh`
- Create: `.github/scripts/test-publish-abi-staging-request.sh`

**Interfaces:** Consumes a canonical feed plan/request plus `GH_TOKEN`; writes
bounded Release/asset IDs, URL, and action to `$GITHUB_OUTPUT`.

- [ ] Build a failing fake-`gh` harness covering absent/existing Releases,
  identical asset, name collision, wrong tag/prerelease, pagination, upload
  failure, and interrupted description update. Assert no delete/clobber/tag
  move/candidate checkout.
- [ ] Run `scripts/dev-shell.sh bash
  .github/scripts/test-publish-abi-staging-request.sh`; confirm red.
- [ ] Implement size/digest/name checks before API access, anchored prerelease
  creation, paginated inspection, append-only upload, and byte comparison of an
  existing asset. Description prose is never authority.
- [ ] Rerun the harness; expect PASS.
- [ ] Commit:

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
- Modify both detect-change-scope scripts.

**Interfaces:** Produces observe/active behavior for same-repository PR events,
protected policy pushes, daily repair, and manual PR-number dispatch.

| Job | Exact permissions | May execute exact-head code? |
|---|---|---|
| `classify-exact-head` | `contents: read` | Yes |
| `derive-request` | `contents: read` | No; reads inert files |
| `publish-request` | `contents: write`, `actions: read` | No |

- [ ] Write failing structural and mutation tests for triggers, permissions,
  action pins, exact head/tree, same-repository predicate, artifact bounds,
  observe suppression, job separation, synthetic merges, leaked tokens,
  persisted credentials, candidate execution in writer, `--clobber`, ordering,
  forks, and swallowed errors.
- [ ] Run workflow, feed, and scope tests; confirm red.
- [ ] Implement three separated jobs. The writer downloads only same-run named
  artifacts, revalidates with protected `xtask`, and writes only in `active`.
- [ ] Add bounded enumeration of open same-repository PRs for policy changes
  and daily repair. Derive each head independently and retain old requests.
- [ ] Run checker, feed, scope, and `actionlint`; expect PASS in observe mode.
- [ ] Commit:

  ```bash
  git add .github/workflows/abi-staging-request-feed.yml \
    scripts/check-abi-staging-request-workflow.rb \
    scripts/test-abi-staging-request-feed.sh \
    .github/actions/detect-change-scope/ci-scope-paths.sh \
    .github/actions/detect-change-scope/test-ci-scope-paths.sh
  git commit -m "[ABI] Prepare protected exact-head request issuance"
  ```

---

### Task 6: Implement the same request validator in protected tap code

**Repository:** Tap

**Files:**

- Create request issuer policy and three copied fixtures under
  `Kandelo/staging/`.
- Create: `scripts/abi_staging/__init__.py`
- Create: `scripts/abi_staging/canonical.py`
- Create: `scripts/abi_staging/request.py`
- Create matching unit-test package/files.

**Interfaces:** Produces strict Python `canonical_bytes`, `canonical_sha256`,
`parse_request_asset_name`, and `validate_request`.

- [ ] Use `superpowers:using-git-worktrees` to create a separate tap worktree
  from current `origin/main`; set its absolute path as `KANDELO_TAP_ROOT`.
- [ ] Copy fixture bytes without reserializing and write failing parity tests
  for every Rust positive/negative case.
- [ ] Run Python tests through the Kandelo dev shell; confirm red.
- [ ] Implement standard-library-only bounded parsing. Reject floats,
  duplicate JSON keys, invalid UTF-8, extra fields, oversized data, and
  noncanonical bytes. Never execute a supplied value.
- [ ] Rerun parity tests; expect identical Rust/Python digests.
- [ ] Commit in the tap:

  ```bash
  git -C "$KANDELO_TAP_ROOT" add Kandelo/staging/request-issuers.toml \
    Kandelo/staging/fixtures/request \
    scripts/abi_staging/__init__.py \
    scripts/abi_staging/canonical.py \
    scripts/abi_staging/request.py \
    scripts/abi_staging/tests
  git -C "$KANDELO_TAP_ROOT" commit -m \
    "[ABI] Validate public staging requests in the tap"
  ```

---

### Task 7: Discover assets and reconcile PR lifecycle

**Repository:** Tap

**Files:**

- Create: `Kandelo/staging/reconciliation-activation.toml`
- Create: `scripts/abi_staging/github_public.py`
- Create: `scripts/abi_staging/reconcile.py`
- Create: `scripts/abi_staging/cli.py`
- Create: `scripts/abi_staging/tests/test_github_public.py`
- Create: `scripts/abi_staging/tests/test_reconcile.py`

**Interfaces:** Produces a bounded `GitHubPublicClient`, discovery/lifecycle
types, and `scan` plus `reconcile --request-asset-url URL` commands.

- [ ] Write failing fake-HTTP tests for pagination, duplicates, body/response
  limits, five redirects, repository/tag/name grammar, cross-host/HTTP/userinfo/
  fragment rejection, truncation, and digest drift. Manual and scan paths must
  return identical discovery objects.
- [ ] Write a failing lifecycle table for open/current, new head/old request,
  merged, closed, reopen same/different head, historical work, duplicate
  discovery, and shuffled API order. Claim key is
  `sha256:<request-digest>`.
- [ ] Run the tap unit tests through `scripts/dev-shell.sh`; confirm red.
- [ ] Implement bounded discovery and validate every body before returning it.
  Numeric API IDs are audit facts only.
- [ ] Implement pure observe-only lifecycle reconciliation. Closed PRs stop new
  work; reopen preserves prior history; merge applies only to that PR's exact
  request.
- [ ] Run the full tap unit suite; expect PASS without network or mutable
  coordinator state.
- [ ] Commit:

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

**Repository:** Tap

**Files:**

- Create: `.github/workflows/abi-staging-reconcile.yml`
- Create: `scripts/check_abi_staging_workflows.rb`
- Create: `scripts/test_check_abi_staging_workflows.rb`

**Interfaces:** A five-minute schedule and optional manual
`request_asset_url` call the same protected CLI. Workflow permissions are `{}`;
the job has only `contents: read`.

- [ ] Write failing workflow/mutation tests for cron, one URL input, protected
  main checkout, no persisted credentials, full action pins, bounded timeout,
  identical coordinator path, and rejection of writes/secrets/request code/
  request refs/different manual logic/build dispatch.
- [ ] Run the Ruby checker tests through the dev shell; confirm red.
- [ ] Implement a thin workflow: schedule calls `scan`; a nonempty manual URL
  calls `reconcile`. Write only a bounded human summary.
- [ ] Run `actionlint` and mutation tests; expect PASS with no write ability.
- [ ] Commit:

  ```bash
  git -C "$KANDELO_TAP_ROOT" add \
    .github/workflows/abi-staging-reconcile.yml \
    scripts/check_abi_staging_workflows.rb \
    scripts/test_check_abi_staging_workflows.rb
  git -C "$KANDELO_TAP_ROOT" commit -m \
    "[ABI] Observe requests through one tap reconciler"
  ```

---

### Task 9: Prove the two repositories agree locally

**Files:**

- Create: `scripts/test-abi-staging-cross-repo-fixtures.sh`
- Modify: `scripts/test-abi-staging-request-feed.sh`

**Interfaces:** Produces a no-network harness that derives requests in Kandelo,
uses a fake append-only Release directory, validates them with tap code, and
compares deterministic decisions.

- [ ] Write failing cases for initial head, same-head policy reissue, advance,
  old-head completion, close, reopen same/different head, and merge.
- [ ] Add negative authority cases for synthetic source, wrong repo/tag/name,
  filename/body mismatch, unaddressed tap, stale policy, latest alias, redirect
  escape, and candidate-supplied coordinator path.
- [ ] Run with a validated absolute `KANDELO_TAP_ROOT`; confirm red.
- [ ] Complete only fake transport/PR adapters. Do not add a production
  fallback. Compare bytes from two clean runs.
- [ ] Run both local Plan 2 harnesses twice; expect PASS.
- [ ] Commit:

  ```bash
  git add scripts/test-abi-staging-cross-repo-fixtures.sh \
    scripts/test-abi-staging-request-feed.sh
  git commit -m "[ABI] Prove the public request protocol locally"
  ```

---

### Task 10: Run observe-mode hosted canaries, then narrowly activate issuance

**Files:**

- Modify Kandelo ABI/repository documentation.
- Modify tap `Kandelo/README.md` and `README.md`.

**Interfaces:** Produces exact hosted run/asset evidence and, only after it
passes, one activation commit for same-repository issuance.

- [ ] Land observe-only workflow revisions on protected main in both repos.
  If unavailable, record the gate and do not simulate hosted success.
- [ ] Run a Kandelo manual observe canary for a same-repository exact head;
  retain run URL/digest and confirm no Release write.
- [ ] With explicit publication authority, append a canary asset and run tap
  manual URL reconciliation; verify same digest and no build/package/branch
  write.
- [ ] Prove identical rerun is a no-op and protected same-head policy change
  appends a second correct asset.
- [ ] Change only Kandelo request activation from `observe` to `active`, rerun
  the complete local suite, and commit. Do not enable forks or tap builds.
- [ ] Document exactly: same-repository request issuance is active; tap
  reconciliation is observe-only; all later stages remain unavailable.
- [ ] Commit docs separately in each repository.

---

### Task 11: Run the final Plan 2 audit and stop

**Files:** Verify every Plan 2 file in both repositories. Add no candidate
build, package write, Check write, promotion, branch mutation, or Pages change.

**Interfaces:** Produces evidence only for request issuance and read-only
reconciliation.

- [ ] Run Kandelo `xtask` tests, feed harness, workflow checker, ABI checker,
  and `actionlint` through `scripts/dev-shell.sh`.
- [ ] Run all tap Python tests, workflow mutation tests, and `actionlint`
  through the Kandelo dev shell with `KANDELO_TAP_ROOT`.
- [ ] Run the cross-repository harness and docs build.
- [ ] Audit permissions, secrets, persisted credentials, synthetic merge
  strings, clobber operations, and concrete successor ABI leakage. Confirm
  only Kandelo's protected publisher has `contents: write`.
- [ ] Audit both worktrees and commit histories, then stop before bottle work.

## Exit criteria

- Protected Kandelo code derives canonical requests from exact heads under
  current protected policy.
- Structural ABI code has no write credential and its output is revalidated.
- The public feed is append-only, exact-name, and idempotent.
- Same-head reissuance and older heads remain valid with no ordering heuristic.
- Scheduled and manual tap paths share one validator/reconciler.
- Lifecycle behavior covers open, advance, merge, close, and reopen cases.
- No tap build, package/branch/Check write, promotion, or Pages behavior exists.
- Local cross-repository tests pass; hosted claims have exact retained evidence.
- Documentation clearly separates active issuance, observe-only reconciliation,
  and unimplemented later stages.

After these criteria pass, execute Plan 3. A successful request canary does not
grant permission to publish candidate packages.
