# Candidate VFS Evidence and Kandelo PR Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compose every selected VFS product from exact nonendorsed candidate
inputs, prove its declared Node and browser behavior against the exact Kandelo
head, publish immutable product evidence, and project current required-product
readiness into the protected `Kandelo PR Check` without allowing background
Formula failures to gate.

**Architecture:** Protected tap planning resolves `ResolvedVfsProductInputsV1`
from Plan 3 candidate/custody/receipt records plus exact package, archive,
toolchain, repository, and composed-product inputs. Uncredentialed exact-head
builders consume only the Plan 1 accessor/report boundary and produce bounded
candidate VFS handoffs. A protected tap job validates and publishes exact VFS
bytes under the nonendorsed product namespace. Separate uncredentialed Node and
browser jobs run protected evidence definitions against the exact candidate
kernel, host, and VFS; a protected job publishes receipts and one
`ProductEvidenceRecordV1`. Protected Kandelo code anonymously reads immutable
records, recomputes current exact-head applicability under current policy, and
updates one Check projection. Observe mode proves hosted behavior before the
Check becomes enforceable.

**Tech Stack:** Existing Rust `xtask abi-staging` models, TypeScript VFS
builders and `MemoryFileSystem`, Node/Vitest, Playwright Chromium, Bash build
adapters, tap Python record/OCI modules from Plan 3, GitHub Checks API through a
narrow `gh` adapter, Ruby workflow mutation tests, and repository-declared
tools through `scripts/dev-shell.sh`.

## Global Constraints

- Consume Plans 1–3 exactly. Formula roots still come only from selected
  product manifests; no product workflow, evidence file, Check script, or
  builder may introduce a Formula root or transitive dependency.
- All reusable code derives ABI from the exact request/runtime inputs. No
  acceptance ABI or branch literal appears outside Plan 5 fixture data.
- The candidate runtime and product source is the exact pull-request head.
  Protected evidence policy/test harness code comes from the current protected
  Kandelo revision bound by the request policy. Neither source is a synthetic
  merge.
- Product manifests own identity, composition, software roots,
  materialization, mounts, boot, and evidence IDs. Evidence policy maps stable
  IDs to bounded typed probes; it cannot change product software inputs or
  Pages placement.
- Pages and test registries remain the only selection authorities. Every Pages
  product is required for ABI/kernel/host changes. Test applicability retains
  required, informational, or not-applicable semantics.
- Preserve both lazy boundaries. Pages/browser load mode remains eager/lazy for
  a whole VFS, while each resolved product input retains embedded,
  lazy-reference, or build-only placement. Product readiness does not force
  eager bytes.
- Candidate VFS lazy references point only to the visibly nonendorsed candidate
  namespace. A candidate input envelope or report containing a canonical
  reference fails. Canonical recomposition belongs to Plan 5.
- Every real product builder uses `openVfsProductBuild` accessors and emits
  `VfsBuilderReportV1`. Missing, extra, mismatched, or undeclared inputs and
  materialization drift fail. Legacy entrypoints retain their supported modes
  during rollout.
- Product composition, Node evidence, and browser evidence execute without
  write credentials. Protected VFS/evidence publishers run protected tap code
  and treat all artifacts as bounded inert data.
- Exact kernel/host/VFS identities enter `runtime_evidence_digest`; a mere
  request/head provenance change does not enter `BottleContractV1`.
- Formula verification is necessary input evidence but is not product
  readiness. A product succeeds only when all actual layers, the VFS report,
  and all declared required Node/browser evidence agree.
- One product's failure blocks only that product and its dependants. Unrelated
  products and background Formulae continue. The `Kandelo PR Check` succeeds
  only when every current selected required product succeeds.
- The Check is a human-readable projection, not a datastore, transaction,
  candidate identity, or global tap gate. It may show the first deterministic
  causal blocker prominently but cannot discard sibling facts.
- Current Check applicability is exact GitHub PR head plus current protected
  requirements, request-policy, and guard-registry identities. Release upload
  time, request timestamp, asset ID, and Git SHA ordering never choose it.
- A request older than the current head remains historical work. Its product
  evidence cannot satisfy the current head Check even if its bottle layers are
  reusable.
- Discovery delayed after fifteen minutes is an observability diagnostic based
  on Release audit metadata. It is not request authority or mandatory waiting.
- Existing synthetic-merge package preparation remains only for legacy
  nonreplaced package paths. New ABI product evidence and the new Check always
  bind the exact head. Do not delete unrelated package staging.
- New Check behavior begins in `observe`; branch protection is changed only
  after hosted exact-head success/failure/background canaries.
- All third-party actions are full 40-character SHA pins. Preserve unrelated
  dirty state and run all local commands through `scripts/dev-shell.sh`.

---

## Interfaces

### Evidence definition registry

Kandelo owns `abi/staging/evidence-definitions.toml` as
`EvidenceDefinitionRegistryV1`. It is protected policy, separate from product
and consumer registries:

```toml
schema = 1
kind = "kandelo-vfs-evidence-definitions"
version = 1

[[definitions]]
id = "main-shell-startup"
host = "node"
runner = "exec"
timeout_seconds = 120

[definitions.probe]
argv = ["bash", "-lc", "printf 'kandelo-main-shell-ready\\n'"]
stdout_exact = "kandelo-main-shell-ready\n"
```

Unknown fields fail. An evidence definition has exactly `id`, `host`,
`runner`, `timeout_seconds`, and one runner-specific `probe`. Allowed runners
are closed:

```text
exec
http
interactive-terminal
compile
sql
service-protocol
repository-suite
```

`exec` permits bounded argv/stdin/env and exact/contains/regular-expression
output predicates. `http` permits service argv, path, status, and bounded body
predicate. `interactive-terminal` permits ordered terminal input/output
predicates. `compile` names a checked compiler probe fixture. `sql` names
service argv and exact statements/results. `service-protocol` is limited to
registered Redis-style request/response probes. `repository-suite` names one
closed protected runner ID, never a shell command or path from a request.

Every definition is canonicalized with its protected implementation paths and
receives a `definition_sha256`. The registry digest enters request policy
implementation identity, so a change reissues current-head requests. Product
manifests and test registrations may name only existing same-host IDs.

The initial definitions bind the Plan 1 IDs to these principal behaviors:

| Product | Node evidence | Browser evidence | Principal proof |
|---|---|---|---|
| `platform-rootfs` | `rootfs-node-startup` | `rootfs-browser-startup` | Boot rootfs and execute the declared shell. |
| `browser-main-shell` | `main-shell-startup` | `main-shell-basic-e2e`, `main-shell-fbdoom-e2e`, `main-shell-modeset-e2e` | Boot interactive Bash, execute a terminal command, launch fbDOOM through its normal framebuffer path, and run the modeset demo. |
| `browser-node` | `node-vfs-node-startup` | `node-vfs-browser-startup` | Execute Node and print an exact JavaScript result. |
| `browser-nginx` | `nginx-vfs-node-startup` | `nginx-vfs-browser-startup` | Start nginx and fetch its normal HTTP page. |
| `browser-nginx-php` | `nginx-php-vfs-node-startup` | `nginx-php-vfs-browser-startup` | Start nginx/PHP-FPM and fetch dynamic PHP output. |
| `browser-wordpress` | `wordpress-sqlite-node-startup` | `wordpress-sqlite-browser-e2e` | Boot SQLite WordPress; browser completes the normal login path. |
| `browser-lamp` | `wordpress-mariadb-node-startup` | `wordpress-mariadb-browser-e2e` | Boot MariaDB WordPress; browser completes the normal login path. |
| `browser-mariadb-wasm32` | `mariadb-wasm32-node-startup` | `mariadb-wasm32-browser-startup` | Start MariaDB and execute an exact SQL query. |
| `browser-mariadb-wasm64` | `mariadb-wasm64-node-startup` | `mariadb-wasm64-browser-startup` | Start the architecture-matched MariaDB and execute the same SQL contract. |
| `browser-python` | `python-vfs-node-smoke` | `python-vfs-browser-smoke` | Execute Python and import its normal runtime library. |
| `browser-perl` | `perl-vfs-node-smoke` | `perl-vfs-browser-smoke` | Materialize lazy Perl on exec and load a standard module. |
| `browser-redis` | `redis-vfs-node-startup` | `redis-vfs-browser-startup` | Start Redis and receive `PONG` through its normal protocol. |
| `browser-erlang` | `erlang-vfs-node-smoke` | `erlang-vfs-browser-smoke` | Execute Erlang noninteractively and load OTP runtime code. |
| `developer-kandelo-sdk` | `kandelo-sdk-node-compile` | — | Compile and execute a tiny SDK program in Node. |
| `test-mariadb` | `mariadb-suite-node` | `mariadb-suite-browser` | Run the registered MariaDB product suite on both hosts. |
| `test-php` | `php-suite-node` | `php-suite-browser` | Run the registered PHP product suite on both hosts. |
| `test-sqlite` | `sqlite-suite-node` | `sqlite-suite-browser` | Run the registered SQLite product suite on both hosts. |

The em dash means no browser definition exists for that product. It is not an
unfinished placeholder.

### Exact runtime bundle

`ExactRuntimeBundleV1` is canonical JSON:

```text
schema
kind = kandelo-exact-runtime-bundle
source = { repository, commit, tree }
target_abi = { version, snapshot_sha256 }
kernel = { wasm_sha256, bytes, abi_version, snapshot_sha256 }
host = { bundle_sha256, bytes, generated_abi_sha256,
         worker_protocol_sha256 }
browser = { bundle_sha256, bytes, service_worker_sha256 }
build_policy_sha256
inventory = [{ path, sha256, bytes }]
```

An uncredentialed exact-head job builds it. Protected code verifies regular
file inventory, source/ABI bindings, and Wasm metadata without executing the
bundle. Node/browser evidence downloads exact runtime artifacts from the same
run; final product evidence binds all digests.

### Resolved product plan and handoff

```python
@dataclass(frozen=True)
class ProductInputPlanV1:
    product_id: str
    manifest_path: str
    manifest_sha256: str
    architecture: str
    reference_class: Literal["candidate"]
    resolved_inputs_sha256: str
    dependency_product_ids: tuple[str, ...]
    required_formula_subjects: tuple[str, ...]
    runtime_bundle_sha256: str

@dataclass(frozen=True)
class CandidateProductLocatorV1:
    product_id: str
    repository: str
    manifest_digest: str
    immutable_reference: str
    vfs_layer_sha256: str
    vfs_layer_bytes: int
    builder_report_sha256: str
```

Tap product planning creates Plan 1 `ResolvedVfsProductInputsV1` with:

- `homebrew-bottle` entries from exact candidate/reuse records and qualifying
  verification/override receipts;
- `product-image` entries from already built dependency products, retaining
  each edge's whole-product embedded/lazy intent;
- `package-output` entries built/resolved through the exact-head normal package
  path and bound by exact digest/size;
- `source-archive` entries downloaded without credentials and checked against
  manifest URL/SHA-256;
- `toolchain-output` entries resolved from the exact declared dev shell and
  toolchain policy;
- `repository-path` entries from the exact head/tree and canonical path digest.

The planner does not let a legacy package/build manifest add a product input.
It may use Plan 1's mechanical adapter only to locate the declared output.
Missing package/archive/toolchain/repository input blocks that product with an
exact guard/diagnostic; it never silently substitutes a source build or stale
canonical object.

The uncredentialed composition handoff contains exactly:

```text
product-handoff/
  inventory.json
  resolved-inputs.json
  builder-report.json
  runtime-bundle.json
  product-build-result.json
  product.vfs or product.vfs.zst
  diagnostics/summary.txt
```

The protected publisher validates report/input/output/runtime identities and
publishes the VFS under:

```text
ghcr.io/kandelo-dev/homebrew-tap-core-abi-<N>-candidates/
  products/<product-id>@sha256:<manifest-digest>
```

Formula validators reject the reserved `products/` subtree.

### Runtime evidence and product record

Each host execution emits `ProductEvidenceResultV1`:

```text
schema
kind = kandelo-vfs-product-evidence-result
request_digest
product = { id, manifest_sha256 }
candidate_product = { manifest_digest, vfs_layer_sha256,
                      vfs_layer_bytes, builder_report_sha256 }
runtime = ExactRuntimeBundleV1 identities
host = node | browser
definition = { id, definition_sha256 }
outcome = success | failure | timeout
guard_codes
bounded_diagnostics
run = { repository, workflow_ref, run_id, job_id, attempt }
```

A protected publisher validates and publishes one
`VerificationReceiptV1` per host result, then one `ProductEvidenceRecordV1`
only after all results needed by that product are terminal. The product record
binds exact product manifest, selection registry digests/reasons, Formula
layers, package/archive/toolchain/repository inputs, VFS/report, runtime,
definitions, and receipts. Required readiness accepts success or an allowed
exact override and retains `accepted_with_override` visibly.

`runtime_evidence_digest` covers candidate product locator, runtime bundle,
evidence definitions, inputs, and receipt outcomes. It excludes wall-clock and
run IDs as identity while preserving them as provenance.

### Check projection

```rust
pub struct CurrentCheckContextV1 {
    pub repository: String,
    pub pull_request_number: u64,
    pub exact_head: String,
    pub current_requirements_sha256: String,
    pub current_policy_version: u64,
    pub current_policy_sha256: String,
    pub current_guard_registry_version: u64,
    pub current_guard_registry_sha256: String,
}

pub enum ComputedCheckConclusionV1 {
    NotApplicable,
    Pending,
    Failure,
    Success,
}

pub struct RecordLinkV1 {
    pub kind: String,
    pub digest: String,
    pub immutable_reference: String,
}

pub enum CheckSubjectStateV1 {
    Pending,
    Blocked,
    Queued,
    Running,
    Success,
    Failure,
    Timeout,
    Canceled,
    Skipped,
    AcceptedWithOverride,
}

pub struct SubjectProjectionV1 {
    pub subject: String,
    pub state: CheckSubjectStateV1,
    pub record: Option<RecordLinkV1>,
    pub guard_codes: Vec<String>,
}

pub struct ProductProjectionV1 {
    pub product_id: String,
    pub manifest_sha256: String,
    pub state: CheckSubjectStateV1,
    pub evidence: Option<RecordLinkV1>,
    pub guard_codes: Vec<String>,
}

pub struct BlockerV1 {
    pub guard_code: String,
    pub subject_kind: String,
    pub subject: String,
    pub record: Option<RecordLinkV1>,
}

pub enum RequiredCheckActivationV1 {
    Observe,
    Enforce,
}

pub struct CurrentCheckProjectionV1 {
    pub name: String,
    pub external_id: String,
    pub head_sha: String,
    pub computed_conclusion: ComputedCheckConclusionV1,
    pub published_conclusion: String,
    pub request: Option<RecordLinkV1>,
    pub tap_plan: Option<RecordLinkV1>,
    pub required_formulae: Vec<SubjectProjectionV1>,
    pub required_products: Vec<ProductProjectionV1>,
    pub background: Vec<SubjectProjectionV1>,
    pub blockers: Vec<BlockerV1>,
    pub discovery_delayed: bool,
    pub summary_markdown: String,
    pub details_markdown: String,
}

pub fn project_current_check(
    context: &CurrentCheckContextV1,
    public_records: &[AbiStagingRecordV1],
    activation: RequiredCheckActivationV1,
) -> Result<CurrentCheckProjectionV1, String>;
```

These are derived presentation types, not replacement durable states. Their
serialized spellings are lower snake case, all unknown variants and fields
fail closed, and the projector derives them from the orthogonal work, outcome,
artifact, promotion, retry, and blocker fields in immutable records.

The name is exactly `Kandelo PR Check`. `external_id` is
`abi-staging:<pr-number>:<head>:<current-request-digest>`. In observe mode,
`published_conclusion` is `neutral` while computed status is shown. In enforce
mode, not-applicable/success publish `success`, pending remains in progress,
and terminal required failure publishes `failure`. Background outcomes never
alter it.

Check Markdown is escaped/bounded and uses only validated public URLs. The
first deterministic causal blocker is prominent; the details retain every
known sibling result, retries, timeouts, override links, and background status.

## File Map

### Kandelo policy, runtime, evidence, and Check

- Modify: `tools/xtask/src/abi_staging/mod.rs`
- Modify: `tools/xtask/src/abi_staging/consumer_registry.rs`
- Modify: `tools/xtask/src/abi_staging/records.rs`
- Create: `tools/xtask/src/abi_staging/evidence_policy.rs`
- Create: `tools/xtask/src/abi_staging/product_evidence.rs`
- Create: `tools/xtask/src/abi_staging/check_projection.rs`
- Create: `abi/staging/evidence-definitions.toml`
- Create: `abi/staging/evidence-definitions.generated.json`
- Create: `abi/staging/required-check-activation.toml`
- Modify: `abi/staging/request-policy.toml`
- Modify: `abi/staging/request-policy.generated.json`
- Create: `scripts/abi-staging-prepare-runtime.sh`
- Create: `scripts/test-abi-staging-prepare-runtime.sh`
- Create: `scripts/abi-staging-product-node-evidence.ts`
- Create: `scripts/abi-staging-product-node-evidence.test.ts`
- Create: `scripts/abi-staging-product-browser-evidence.ts`
- Create: `scripts/abi-staging-product-browser-evidence.test.ts`
- Create: `.github/scripts/update-abi-staging-check.sh`
- Create: `.github/scripts/test-update-abi-staging-check.sh`
- Create: `.github/workflows/abi-staging-pr-check.yml`
- Create: `scripts/check-abi-staging-pr-check-workflow.rb`
- Create: `scripts/test-abi-staging-product-evidence.sh`
- Modify: `.github/workflows/prepare-merge.yml`
- Modify: `.github/scripts/test-merge-candidate-workflows.sh`
- Modify: `.github/actions/detect-change-scope/ci-scope-paths.sh`
- Modify: `.github/actions/detect-change-scope/test-ci-scope-paths.sh`

### Real VFS builder adaptations in Kandelo

- Modify: `images/vfs/scripts/vfs-product-builder-contract.ts`
- Create: `images/vfs/scripts/staged-product-inputs.ts`
- Create: `host/test/staged-product-inputs.test.ts`
- Modify: `packages/registry/rootfs/build-rootfs-package.sh`
- Modify: `scripts/build-homebrew-main-shell-product.sh`
- Modify: `images/vfs/scripts/build-node-vfs-image.sh`
- Modify: `images/vfs/scripts/build-node-vfs-image.ts`
- Modify: `images/vfs/scripts/build-nginx-vfs-image.sh`
- Modify: `images/vfs/scripts/build-nginx-vfs-image.ts`
- Modify: `images/vfs/scripts/build-nginx-php-vfs-image.sh`
- Modify: `images/vfs/scripts/build-nginx-php-vfs-image.ts`
- Modify: `images/vfs/scripts/build-wp-vfs-image.sh`
- Modify: `images/vfs/scripts/build-wp-vfs-image.ts`
- Modify: `images/vfs/scripts/build-lamp-vfs-image.sh`
- Modify: `images/vfs/scripts/build-lamp-vfs-image.ts`
- Modify: `images/vfs/scripts/build-mariadb-vfs-image.sh`
- Modify: `images/vfs/scripts/build-mariadb-vfs-image.ts`
- Modify: `images/vfs/scripts/build-python-vfs-image.sh`
- Modify: `images/vfs/scripts/build-python-vfs-image.ts`
- Modify: `images/vfs/scripts/build-perl-vfs-image.sh`
- Modify: `images/vfs/scripts/build-perl-vfs-image.ts`
- Modify: `images/vfs/scripts/build-redis-vfs-image.sh`
- Modify: `images/vfs/scripts/build-redis-vfs-image.ts`
- Modify: `images/vfs/scripts/build-erlang-vfs-image.sh`
- Modify: `images/vfs/scripts/build-erlang-vfs-image.ts`
- Modify: `images/vfs/scripts/build-kandelo-sdk-vfs-image.sh`
- Modify: `images/vfs/scripts/build-kandelo-sdk-vfs-image.ts`
- Modify: `images/vfs/scripts/build-mariadb-test-vfs-image.sh`
- Modify: `images/vfs/scripts/build-mariadb-test-vfs-image.ts`
- Modify: `images/vfs/scripts/build-php-test-vfs-image.sh`
- Modify: `images/vfs/scripts/build-php-test-vfs-image.ts`
- Modify: `images/vfs/scripts/build-sqlite-test-vfs-image.sh`
- Modify: `images/vfs/scripts/build-sqlite-test-vfs-image.ts`
- Create: `host/test/abi-staging-product-builders.test.ts`

### Browser evidence in Kandelo

- Create: `apps/browser-demos/test/abi-staging-product-evidence.spec.ts`
- Modify: `apps/browser-demos/playwright.config.ts`
- Modify: `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts`
- Modify: `apps/browser-demos/pages/kandelo/kernel-host/optional-demo-vfs.ts`

### Tap product planning/publication

- Modify: `scripts/abi_staging/cli.py`
- Modify: `scripts/abi_staging/reconcile.py`
- Modify: `scripts/abi_staging/records.py`
- Create: `scripts/abi_staging/product.py`
- Create: `scripts/abi_staging/product_evidence.py`
- Create: `scripts/abi_staging/tests/test_product.py`
- Create: `scripts/abi_staging/tests/test_product_evidence.py`
- Create: `Kandelo/staging/fixtures/product/resolved-inputs.json`
- Create: `Kandelo/staging/fixtures/product/builder-report.json`
- Create: `Kandelo/staging/fixtures/product/evidence-record.json`
- Create: `Kandelo/staging/product-evidence-activation.toml`
- Modify: `.github/workflows/abi-staging-reconcile.yml`
- Modify: `scripts/check_abi_staging_workflows.rb`
- Modify: `scripts/test_check_abi_staging_workflows.rb`

### Documentation

- Modify: `docs/abi-versioning.md`
- Modify: `docs/browser-support.md`
- Modify: `docs/homebrew-publishing.md`
- Modify: `docs/repository-organization.md`
- Modify: `Kandelo/README.md` in the tap repository
- Modify: `README.md` in the tap repository

---

### Task 1: Define protected evidence policy and exact runtime identities

**Files:**

- Modify: `tools/xtask/src/abi_staging/mod.rs`
- Modify: `tools/xtask/src/abi_staging/consumer_registry.rs`
- Create: `tools/xtask/src/abi_staging/evidence_policy.rs`
- Create: `abi/staging/evidence-definitions.toml`
- Create: `abi/staging/evidence-definitions.generated.json`
- Modify: `abi/staging/request-policy.toml`
- Modify: `abi/staging/request-policy.generated.json`
- Create: `scripts/abi-staging-prepare-runtime.sh`
- Create: `scripts/test-abi-staging-prepare-runtime.sh`

**Interfaces:**

- Consumes: Plan 1 product/test registries, Plan 2 protected implementation
  identity, existing build/ABI tools, and the evidence table above.
- Produces: strict `EvidenceDefinitionRegistryV1`, generated definition
  digests, `ExactRuntimeBundleV1`, and CLI commands
  `evidence-definitions generate|check` and `runtime-bundle validate`.

- [ ] **Step 1: Write failing evidence-schema tests**

  Cover every runner kind and reject unknown fields/kinds, arbitrary shell
  command, unsafe repository-suite name, mismatched host, duplicate ID,
  unbounded argv/stdin/output, invalid regex, timeout outside bounds, product
  evidence ID missing from the registry, and test registration naming a
  definition for another product/host.

- [ ] **Step 2: Write failing complete-inventory tests**

  Assert every Plan 1 product evidence ID appears exactly once, every Pages
  product has both Node/browser basic evidence, the developer SDK has its
  declared Node-only evidence, and no evidence definition contains a Formula,
  package root, Pages flag, ABI, candidate URL, credential, retry, or workflow
  matrix.

- [ ] **Step 3: Write failing runtime-bundle tests**

  Build a fake exact source tree and reject wrong source/tree, stale kernel ABI
  metadata, wrong snapshot, generated TypeScript ABI drift, host/browser bundle
  mismatch, unlisted file, symlink, wrong digest/size, and source build from a
  synthetic merge.

- [ ] **Step 4: Run focused tests and verify red**

  ```bash
  scripts/dev-shell.sh bash -c '
    host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
    cargo test -p xtask --target "$host_target" \
      abi_staging::evidence_policy
  '
  scripts/dev-shell.sh bash scripts/test-abi-staging-prepare-runtime.sh
  ```

  Expected: FAIL because policy/runtime support is absent.

- [ ] **Step 5: Implement strict evidence policy and runtime handoff**

  Generate definition digests with protected implementation-path hashes. Add
  those paths to request policy so any behavior change changes
  `policy_sha256`. The runtime script builds the exact head in an
  uncredentialed job, emits only bounded regular files, and never resolves a
  released kernel as substitute.

- [ ] **Step 6: Generate policy and run focused tests**

  ```bash
  scripts/dev-shell.sh bash -c '
    host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
    cargo run -p xtask --target "$host_target" --quiet -- \
      abi-staging evidence-definitions generate \
      --source abi/staging/evidence-definitions.toml \
      --out abi/staging/evidence-definitions.generated.json
    cargo run -p xtask --target "$host_target" --quiet -- \
      abi-staging request-policy generate \
      --source abi/staging/request-policy.toml \
      --out abi/staging/request-policy.generated.json
    cargo test -p xtask --target "$host_target" \
      abi_staging::evidence_policy
  '
  scripts/dev-shell.sh bash scripts/test-abi-staging-prepare-runtime.sh
  ```

  Expected: PASS.

- [ ] **Step 7: Commit**

  ```bash
  git add tools/xtask/src/abi_staging/mod.rs \
    tools/xtask/src/abi_staging/consumer_registry.rs \
    tools/xtask/src/abi_staging/evidence_policy.rs \
    abi/staging/evidence-definitions.toml \
    abi/staging/evidence-definitions.generated.json \
    abi/staging/request-policy.toml \
    abi/staging/request-policy.generated.json \
    scripts/abi-staging-prepare-runtime.sh \
    scripts/test-abi-staging-prepare-runtime.sh
  git commit -m "[VFS] Define protected product evidence"
  ```

---

### Task 2: Resolve exact candidate product inputs in the tap

**Repository:** `kandelo-dev/homebrew-tap-core`

**Files:**

- Create: `scripts/abi_staging/product.py`
- Create: `scripts/abi_staging/tests/test_product.py`
- Create: `Kandelo/staging/fixtures/product/resolved-inputs.json`
- Create: `Kandelo/staging/product-evidence-activation.toml`
- Modify: `scripts/abi_staging/cli.py`
- Modify: `scripts/abi_staging/reconcile.py`

**Interfaces:**

- Consumes: request-selected products, Plan 3 tap/candidate/receipt records,
  exact Kandelo source, Plan 1 builder input model, and mechanical legacy
  adapters.
- Produces: `ProductInputPlanV1`, exact canonical
  `ResolvedVfsProductInputsV1`, product dependency scheduling, and activation
  beginning `observe`.

- [ ] **Step 1: Write failing resolver tests for every input kind**

  Cover product-image, Homebrew bottle, package output, source archive,
  toolchain output, and repository path. Assert exact digest/bytes/path or
  immutable reference rules and candidate-only reference class. Reject an
  unverified bottle, wrong architecture/ABI, stale custody, missing package
  output, archive SHA drift, ambient toolchain, wrong source tree, or canonical
  reference.

- [ ] **Step 2: Write materialization tests**

  Preserve lazy whole-product edges, lazy bottle layers, embedded inputs, and
  build-only inputs. Assert a shared object reachable through embedded and lazy
  roots becomes effectively embedded once with every requesting root recorded.
  Assert lazy inputs have no local bytes and builders cannot fetch them during
  composition.

- [ ] **Step 3: Prove no parallel product or Formula authority**

  Mutate Brewfiles, package dependencies, legacy arrays, evidence definitions,
  workflow matrices, and tap background inventory. None may add a resolved VFS
  software input. Mutating a selected canonical manifest must change inputs;
  mutating Pages/test selection changes selected products only through the
  request.

- [ ] **Step 4: Run tap tests and verify red**

  ```bash
  scripts/dev-shell.sh env PYTHONPATH="$KANDELO_TAP_ROOT" \
    python3 -m unittest scripts.abi_staging.tests.test_product -v
  ```

  Expected: FAIL because product resolution is absent.

- [ ] **Step 5: Implement deterministic exact input resolution**

  Resolve dependency products topologically. Download public candidates and
  archives only in the uncredentialed composition job; protected planning
  emits immutable locators/digests. Resolve package outputs through existing
  exact-head package artifacts or a declared uncredentialed package build,
  never through an undeclared source fallback.

- [ ] **Step 6: Run tap tests and fixture freshness**

  ```bash
  scripts/dev-shell.sh env PYTHONPATH="$KANDELO_TAP_ROOT" \
    python3 -m unittest scripts.abi_staging.tests.test_product -v
  scripts/dev-shell.sh env PYTHONPATH="$KANDELO_TAP_ROOT" \
    python3 -m scripts.abi_staging.cli fixture-check \
      --fixture "$KANDELO_TAP_ROOT/Kandelo/staging/fixtures/product/resolved-inputs.json"
  ```

  Expected: PASS; activation remains observe-only.

- [ ] **Step 7: Commit in the tap repository**

  ```bash
  git -C "$KANDELO_TAP_ROOT" add \
    scripts/abi_staging/product.py \
    scripts/abi_staging/tests/test_product.py \
    scripts/abi_staging/cli.py \
    scripts/abi_staging/reconcile.py \
    Kandelo/staging/fixtures/product/resolved-inputs.json \
    Kandelo/staging/product-evidence-activation.toml
  git -C "$KANDELO_TAP_ROOT" commit -m \
    "[VFS] Resolve products from exact candidate inputs"
  ```

---

### Task 3: Adapt rootfs and main-shell builders to the staging boundary

**Files:**

- Modify: `images/vfs/scripts/vfs-product-builder-contract.ts`
- Create: `images/vfs/scripts/staged-product-inputs.ts`
- Create: `host/test/staged-product-inputs.test.ts`
- Modify: `packages/registry/rootfs/build-rootfs-package.sh`
- Modify: `scripts/build-homebrew-main-shell-product.sh`
- Create: `host/test/abi-staging-product-builders.test.ts`

**Interfaces:**

- Consumes: Plan 1 `openVfsProductBuild`, Task 2 resolved inputs, exact
  `platform-rootfs` and `browser-main-shell` manifests.
- Produces: staging modes for both builders that account for every input and
  emit exact `VfsBuilderReportV1`; legacy invocation remains unchanged.

- [ ] **Step 1: Write failing shared adapter tests**

  Assert each typed accessor exposes only declared embedded/build paths or lazy
  references, all reads are recorded, outputs are created at the caller path,
  and `finish` is the only report writer. Reject direct resolver/cache access,
  undeclared environment paths, lazy byte reads, and report completion with an
  unused input.

- [ ] **Step 2: Write failing rootfs/main-shell inventory tests**

  For each product, inject all declared inputs and assert exact consumption,
  mounts, boot metadata, output name, ABI metadata, Homebrew root
  materialization, and lazy layer references. Add one undeclared Formula and
  one omitted repository input mutation; both must fail before a valid report.

- [ ] **Step 3: Run focused tests and verify red**

  ```bash
  scripts/dev-shell.sh bash -c '
    cd host
    npx vitest run \
      test/staged-product-inputs.test.ts \
      test/abi-staging-product-builders.test.ts
  '
  ```

  Expected: FAIL because real builders are not adapted.

- [ ] **Step 4: Implement opt-in staging mode**

  Add exact flags `--resolved-inputs`, `--builder-report`, and `--output` to the
  existing entrypoints. In staging mode, resolve every source through accessors
  and reject ambient binary caches/resolvers. With no staging flags, preserve
  current legacy behavior byte-for-byte.

- [ ] **Step 5: Run builder and legacy regressions**

  ```bash
  scripts/dev-shell.sh bash -c '
    cd host
    npx vitest run \
      test/staged-product-inputs.test.ts \
      test/abi-staging-product-builders.test.ts \
      test/homebrew-vfs-builder.test.ts \
      test/shell-vfs-build.test.ts \
      test/shell-lazy-archive-inputs.test.ts
  '
  scripts/dev-shell.sh bash scripts/test-homebrew-main-shell-product-state.sh
  ```

  Expected: PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add images/vfs/scripts/vfs-product-builder-contract.ts \
    images/vfs/scripts/staged-product-inputs.ts \
    packages/registry/rootfs/build-rootfs-package.sh \
    scripts/build-homebrew-main-shell-product.sh \
    host/test/staged-product-inputs.test.ts \
    host/test/abi-staging-product-builders.test.ts
  git commit -m "[VFS] Adapt root products to declared staging inputs"
  ```

---

### Task 4: Adapt browser web-service product builders

**Files:**

- Modify: `images/vfs/scripts/build-node-vfs-image.sh`
- Modify: `images/vfs/scripts/build-node-vfs-image.ts`
- Modify: `images/vfs/scripts/build-nginx-vfs-image.sh`
- Modify: `images/vfs/scripts/build-nginx-vfs-image.ts`
- Modify: `images/vfs/scripts/build-nginx-php-vfs-image.sh`
- Modify: `images/vfs/scripts/build-nginx-php-vfs-image.ts`
- Modify: `images/vfs/scripts/build-wp-vfs-image.sh`
- Modify: `images/vfs/scripts/build-wp-vfs-image.ts`
- Modify: `images/vfs/scripts/build-lamp-vfs-image.sh`
- Modify: `images/vfs/scripts/build-lamp-vfs-image.ts`
- Modify: `host/test/abi-staging-product-builders.test.ts`

**Interfaces:**

- Consumes: Task 3 adapter and exact manifests for node, nginx, nginx/PHP,
  WordPress/SQLite, and WordPress/MariaDB products.
- Produces: exact report-emitting staging modes preserving current boot/service
  behavior and product composition edges.

- [ ] **Step 1: Add failing table-driven builder tests**

  For each product, assert exact declared product/package/archive/repository
  inputs and placement. Restore output and verify service configuration,
  principal executable, mount/boot metadata, output ABI, and no bytes fetched
  for lazy whole-product/layer references.

- [ ] **Step 2: Add negative input mutations**

  Inject an undeclared WordPress archive, omit kernel build input, swap PHP or
  MariaDB output, change candidate to canonical reference, add ambient binary
  resolution, or alter effective materialization. Each must fail with the
  exact product/input ID and no accepted report.

- [ ] **Step 3: Run focused tests and verify red**

  ```bash
  scripts/dev-shell.sh bash -c '
    cd host
    npx vitest run test/abi-staging-product-builders.test.ts \
      test/wordpress-source-layout.test.ts \
      test/php-browser-kernel-owned-vfs.test.ts \
      test/mariadb-image-helpers.test.ts
  '
  ```

  Expected: FAIL on unadapted web builders.

- [ ] **Step 4: Implement staging input use product by product**

  Keep filesystem transforms in existing builders. Replace staging-mode
  resolver/path discovery with exact accessor handles, pass lazy locators
  through unchanged, and call `finish` only after current image validation.

- [ ] **Step 5: Run focused and legacy tests**

  ```bash
  scripts/dev-shell.sh bash -c '
    cd host
    npx vitest run \
      test/abi-staging-product-builders.test.ts \
      test/shell-vfs-build.test.ts \
      test/wordpress-source-layout.test.ts \
      test/php-browser-kernel-owned-vfs.test.ts \
      test/mariadb-image-helpers.test.ts \
      test/vfs-image.test.ts
  '
  ```

  Expected: PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add images/vfs/scripts/build-node-vfs-image.sh \
    images/vfs/scripts/build-node-vfs-image.ts \
    images/vfs/scripts/build-nginx-vfs-image.sh \
    images/vfs/scripts/build-nginx-vfs-image.ts \
    images/vfs/scripts/build-nginx-php-vfs-image.sh \
    images/vfs/scripts/build-nginx-php-vfs-image.ts \
    images/vfs/scripts/build-wp-vfs-image.sh \
    images/vfs/scripts/build-wp-vfs-image.ts \
    images/vfs/scripts/build-lamp-vfs-image.sh \
    images/vfs/scripts/build-lamp-vfs-image.ts \
    host/test/abi-staging-product-builders.test.ts
  git commit -m "[VFS] Adapt browser service products to staging inputs"
  ```

---

### Task 5: Adapt language, database, and service product builders

**Files:**

- Modify: `images/vfs/scripts/build-mariadb-vfs-image.sh`
- Modify: `images/vfs/scripts/build-mariadb-vfs-image.ts`
- Modify: `images/vfs/scripts/build-python-vfs-image.sh`
- Modify: `images/vfs/scripts/build-python-vfs-image.ts`
- Modify: `images/vfs/scripts/build-perl-vfs-image.sh`
- Modify: `images/vfs/scripts/build-perl-vfs-image.ts`
- Modify: `images/vfs/scripts/build-redis-vfs-image.sh`
- Modify: `images/vfs/scripts/build-redis-vfs-image.ts`
- Modify: `images/vfs/scripts/build-erlang-vfs-image.sh`
- Modify: `images/vfs/scripts/build-erlang-vfs-image.ts`
- Modify: `host/test/abi-staging-product-builders.test.ts`

**Interfaces:**

- Consumes: Task 3 adapter and exact standalone product manifests.
- Produces: report-emitting staging modes for both MariaDB architectures,
  Python, lazy Perl, Redis, and Erlang.

- [ ] **Step 1: Add failing architecture/materialization tests**

  Assert MariaDB output/inputs match architecture; Python runtime output is
  embedded; Perl executable layer stays lazy while standard-library source is
  embedded; Redis/Erlang runtime inputs are exact. Restore each VFS and execute
  a metadata-level principal binary lookup without replacing runtime E2E.

- [ ] **Step 2: Add negative tests**

  Reject cross-architecture reuse, eager Perl executable bytes, absent Perl
  stdlib, extra MariaDB source role, Redis without dinit, Erlang without OTP,
  undeclared cache path, or report placement drift.

- [ ] **Step 3: Run focused tests and verify red**

  ```bash
  scripts/dev-shell.sh bash -c '
    cd host
    npx vitest run \
      test/abi-staging-product-builders.test.ts \
      test/mariadb-image-helpers.test.ts \
      test/homebrew-language-runtime-smoke.test.ts \
      test/lazy-vfs.test.ts
  '
  ```

  Expected: FAIL on unadapted builders.

- [ ] **Step 4: Implement exact accessor consumption**

  Preserve current output filenames and image semantics. In staging mode no
  builder scans a package cache or chooses architecture from host state; it
  uses manifest/envelope identity and exact handles.

- [ ] **Step 5: Run focused and legacy tests**

  ```bash
  scripts/dev-shell.sh bash -c '
    cd host
    npx vitest run \
      test/abi-staging-product-builders.test.ts \
      test/mariadb-image-helpers.test.ts \
      test/homebrew-language-runtime-smoke.test.ts \
      test/lazy-vfs.test.ts \
      test/vfs-image.test.ts
  '
  ```

  Expected: PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add images/vfs/scripts/build-mariadb-vfs-image.sh \
    images/vfs/scripts/build-mariadb-vfs-image.ts \
    images/vfs/scripts/build-python-vfs-image.sh \
    images/vfs/scripts/build-python-vfs-image.ts \
    images/vfs/scripts/build-perl-vfs-image.sh \
    images/vfs/scripts/build-perl-vfs-image.ts \
    images/vfs/scripts/build-redis-vfs-image.sh \
    images/vfs/scripts/build-redis-vfs-image.ts \
    images/vfs/scripts/build-erlang-vfs-image.sh \
    images/vfs/scripts/build-erlang-vfs-image.ts \
    host/test/abi-staging-product-builders.test.ts
  git commit -m "[VFS] Adapt standalone products to staging inputs"
  ```

---

### Task 6: Adapt SDK and test product builders

**Files:**

- Modify: `images/vfs/scripts/build-kandelo-sdk-vfs-image.sh`
- Modify: `images/vfs/scripts/build-kandelo-sdk-vfs-image.ts`
- Modify: `images/vfs/scripts/build-mariadb-test-vfs-image.sh`
- Modify: `images/vfs/scripts/build-mariadb-test-vfs-image.ts`
- Modify: `images/vfs/scripts/build-php-test-vfs-image.sh`
- Modify: `images/vfs/scripts/build-php-test-vfs-image.ts`
- Modify: `images/vfs/scripts/build-sqlite-test-vfs-image.sh`
- Modify: `images/vfs/scripts/build-sqlite-test-vfs-image.ts`
- Modify: `host/test/abi-staging-product-builders.test.ts`

**Interfaces:**

- Consumes: Task 3 adapter and SDK/MariaDB/PHP/SQLite test manifests.
- Produces: report-emitting staging modes that explicitly account for
  toolchain output, package source roles, generated test executables, and
  repository fixtures.

- [ ] **Step 1: Add failing exact-input tests**

  Assert SDK consumes declared sysroot/glue/licenses/libcxx and exact Clang
  resource headers as `toolchain-output`; MariaDB test consumes test/source
  roles; PHP consumes runtime/source/fixtures; SQLite consumes SQLite/Tcl
  sources and generated executables. Validate output ABI/report for each.

- [ ] **Step 2: Add negative tests for hidden build inputs**

  Remove toolchain output, use ambient Clang headers, add a PHP fixture path,
  omit a MariaDB source role, substitute SQLite/Tcl source, or create a test
  executable outside declared input/output roots. Each fails before evidence.

- [ ] **Step 3: Run focused tests and verify red**

  ```bash
  scripts/dev-shell.sh bash -c '
    cd host
    npx vitest run \
      test/abi-staging-product-builders.test.ts \
      test/mariadb-test-source-copy.test.ts \
      test/php-test-fixtures.test.ts \
      test/sqlite-testrunner-patch.test.ts
  '
  ```

  Expected: FAIL on unadapted builders.

- [ ] **Step 4: Implement explicit SDK/test input access**

  Preserve suite content and legacy entrypoints. Make staging mode consume
  declared source roles and toolchain handles and record them as build-only or
  embedded exactly as the manifest says.

- [ ] **Step 5: Run focused and legacy tests**

  ```bash
  scripts/dev-shell.sh bash -c '
    cd host
    npx vitest run \
      test/abi-staging-product-builders.test.ts \
      test/mariadb-test-source-copy.test.ts \
      test/php-test-fixtures.test.ts \
      test/sqlite-testrunner-patch.test.ts \
      test/vfs-image.test.ts
  '
  ```

  Expected: PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add images/vfs/scripts/build-kandelo-sdk-vfs-image.sh \
    images/vfs/scripts/build-kandelo-sdk-vfs-image.ts \
    images/vfs/scripts/build-mariadb-test-vfs-image.sh \
    images/vfs/scripts/build-mariadb-test-vfs-image.ts \
    images/vfs/scripts/build-php-test-vfs-image.sh \
    images/vfs/scripts/build-php-test-vfs-image.ts \
    images/vfs/scripts/build-sqlite-test-vfs-image.sh \
    images/vfs/scripts/build-sqlite-test-vfs-image.ts \
    host/test/abi-staging-product-builders.test.ts
  git commit -m "[VFS] Adapt SDK and test products to staging inputs"
  ```

---

### Task 7: Publish candidate VFS identity and product evidence separately

**Repository:** `kandelo-dev/homebrew-tap-core`

**Files:**

- Create: `scripts/abi_staging/product_evidence.py`
- Create: `scripts/abi_staging/tests/test_product_evidence.py`
- Create: `Kandelo/staging/fixtures/product/builder-report.json`
- Create: `Kandelo/staging/fixtures/product/evidence-record.json`
- Modify: `scripts/abi_staging/records.py`
- Modify: `scripts/abi_staging/reconcile.py`
- Modify: `scripts/abi_staging/cli.py`

**Interfaces:**

- Consumes: exact Task 2 input plan, Tasks 3–6 report-emitting builder, Plan 3
  OCI transport, exact runtime, and later Node/browser result handoffs.
- Produces: `CandidateProductLocatorV1`, product result validators, host
  receipts, and `ProductEvidenceRecordV1`.

- [ ] **Step 1: Write failing candidate-product publication tests**

  Validate exact product ID/repository path, VFS layer/report/input/runtime
  descriptors, nonendorsed annotations, candidate references, anonymous
  readback, and reserved `products/` isolation. Reject Formula metadata
  pointing into product repositories and product data in a Formula repository.

- [ ] **Step 2: Write failing product-record tests**

  Cover complete Node/browser success, Node-only product, required failure,
  informational failure, timeout, allowed exact override, missing sibling
  receipt, wrong definition/runtime/VFS/manifest/registry/layer, duplicate host
  receipt, and candidate/canonical crossover.

- [ ] **Step 3: Run tests and verify red**

  ```bash
  scripts/dev-shell.sh env PYTHONPATH="$KANDELO_TAP_ROOT" \
    python3 -m unittest \
      scripts.abi_staging.tests.test_product_evidence -v
  ```

  Expected: FAIL because product publication is absent.

- [ ] **Step 4: Implement identity-first product publication**

  Validate the handoff with protected code and publish exact candidate VFS
  bytes/report before runtime tests. Return an immutable locator; never add
  verification outcome to the VFS manifest or rename it after tests.

- [ ] **Step 5: Implement host receipts and aggregate product record**

  Re-fetch exact VFS/runtime/definition inputs, validate each inert host result,
  publish one receipt per attempt/host, then aggregate all terminal facts. A
  failed host remains visible and ordinary product readiness false.

- [ ] **Step 6: Run tests and fixture checks**

  ```bash
  scripts/dev-shell.sh env PYTHONPATH="$KANDELO_TAP_ROOT" \
    python3 -m unittest \
      scripts.abi_staging.tests.test_product_evidence \
      scripts.abi_staging.tests.test_oci -v
  ```

  Expected: PASS.

- [ ] **Step 7: Commit in the tap repository**

  ```bash
  git -C "$KANDELO_TAP_ROOT" add \
    scripts/abi_staging/product_evidence.py \
    scripts/abi_staging/records.py \
    scripts/abi_staging/reconcile.py \
    scripts/abi_staging/cli.py \
    scripts/abi_staging/tests/test_product_evidence.py \
    Kandelo/staging/fixtures/product/builder-report.json \
    Kandelo/staging/fixtures/product/evidence-record.json
  git -C "$KANDELO_TAP_ROOT" commit -m \
    "[VFS] Publish immutable candidate product evidence"
  ```

---

### Task 8: Run protected Node evidence against exact candidate products

**Files:**

- Create: `scripts/abi-staging-product-node-evidence.ts`
- Create: `scripts/abi-staging-product-node-evidence.test.ts`
- Create: `tools/xtask/src/abi_staging/product_evidence.rs`
- Modify: `tools/xtask/src/abi_staging/mod.rs`
- Modify: `tools/xtask/src/abi_staging/records.rs`
- Create: `scripts/test-abi-staging-product-evidence.sh`

**Interfaces:**

- Consumes: protected evidence definition, exact runtime bundle, immutable
  candidate VFS locator, boot/mount contract, and no credentials.
- Produces: canonical bounded `ProductEvidenceResultV1` for host `node`.

- [ ] **Step 1: Write failing typed-runner tests**

  Cover exec, HTTP, compile, SQL, service protocol, and registered repository
  suites with tiny local fixtures. Assert exact VFS/runtime/definition identity,
  boot contract, output bounds, timeout, deterministic result, and no shell
  interpretation of manifest/request values.

- [ ] **Step 2: Write failing product-level Node fixtures**

  Exercise the principal proof for every Node evidence ID using miniature VFS
  fixtures and faked service adapters where full packages are unavailable.
  Assert lazy Perl/bottle inputs fetch only on exec and embedded inputs do not
  perform a network fetch.

- [ ] **Step 3: Run tests and verify red**

  ```bash
  scripts/dev-shell.sh npx tsx --test \
    scripts/abi-staging-product-node-evidence.test.ts
  scripts/dev-shell.sh bash -c '
    host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
    cargo test -p xtask --target "$host_target" \
      abi_staging::product_evidence
  '
  ```

  Expected: FAIL because the runner/result validator is absent.

- [ ] **Step 4: Implement protected typed execution**

  The runner code/definition comes from protected current policy; candidate
  inputs supply only exact runtime/VFS bytes. Map runner enums to direct process
  APIs, never concatenate a shell command. Capture bounded stdout/stderr and
  emit an exact terminal result even on timeout/failure.

- [ ] **Step 5: Run Node/product regressions**

  ```bash
  scripts/dev-shell.sh npx tsx --test \
    scripts/abi-staging-product-node-evidence.test.ts
  scripts/dev-shell.sh bash scripts/test-abi-staging-product-evidence.sh
  scripts/dev-shell.sh bash -c '
    cd host
    npx vitest run \
      test/homebrew-language-runtime-smoke.test.ts \
      test/homebrew-vfs-formula-layer.test.ts \
      test/lazy-vfs.test.ts
  '
  ```

  Expected: PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add scripts/abi-staging-product-node-evidence.ts \
    scripts/abi-staging-product-node-evidence.test.ts \
    scripts/test-abi-staging-product-evidence.sh \
    tools/xtask/src/abi_staging/product_evidence.rs \
    tools/xtask/src/abi_staging/mod.rs \
    tools/xtask/src/abi_staging/records.rs
  git commit -m "[VFS] Run exact candidate product evidence in Node"
  ```

---

### Task 9: Run required browser evidence against exact candidate products

**Files:**

- Create: `scripts/abi-staging-product-browser-evidence.ts`
- Create: `scripts/abi-staging-product-browser-evidence.test.ts`
- Create: `apps/browser-demos/test/abi-staging-product-evidence.spec.ts`
- Modify: `apps/browser-demos/playwright.config.ts`
- Modify: `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts`
- Modify: `apps/browser-demos/pages/kandelo/kernel-host/optional-demo-vfs.ts`

**Interfaces:**

- Consumes: same exact runtime/VFS/definition as Task 8, delivered to a local
  browser server with candidate reference mode.
- Produces: canonical bounded `ProductEvidenceResultV1` for host `browser`.

- [ ] **Step 1: Write failing browser fixture/selection tests**

  Assert one selected product is loaded by exact immutable VFS locator, whole
  product eager/lazy mode matches Pages registry where applicable, candidate
  inner references remain candidate, and unselected/default VFS imports cannot
  substitute. Reject canonical references in candidate mode.

- [ ] **Step 2: Write failing Playwright evidence tests**

  Parameterize the closed browser runner kinds and all browser evidence IDs.
  Required Pages products must execute normal boot/principal UI/service paths,
  including interactive shell, HTTP service, and WordPress login. Suite product
  IDs invoke exact registered suite adapters. Failure/timeout produce bounded
  inert results rather than a swallowed/skipped pass. The main-shell evidence
  matrix includes separate `main-shell-fbdoom-e2e` and
  `main-shell-modeset-e2e` definitions, both bound to the exact candidate
  `browser-main-shell` image rather than the default imported image.

- [ ] **Step 3: Run browser unit/Playwright tests and verify red**

  ```bash
  scripts/dev-shell.sh npx tsx --test \
    scripts/abi-staging-product-browser-evidence.test.ts
  scripts/dev-shell.sh bash -c '
    cd apps/browser-demos
    npx playwright test test/abi-staging-product-evidence.spec.ts \
      --project=chromium
  '
  ```

  Expected: FAIL because candidate evidence mode is absent.

- [ ] **Step 4: Implement exact candidate browser mode**

  Add a test-only boot input accepted only by the protected evidence runner,
  with exact digest/size/source-kind validation and existing untrusted boot
  descriptor limits. Do not add a product-owned Pages flag or app-loader
  fallback. Use normal `KernelHost`, workers, VFS mounts, and UI/service paths.

- [ ] **Step 5: Run browser and lazy-loading regressions**

  ```bash
  scripts/dev-shell.sh npx tsx --test \
    scripts/abi-staging-product-browser-evidence.test.ts
  scripts/dev-shell.sh bash -c '
    cd apps/browser-demos
    npx playwright test \
      test/abi-staging-product-evidence.spec.ts \
      test/kandelo-homebrew-main-shell.spec.ts \
      test/kandelo-merge-gate.spec.ts \
      test/kandelo-modeset.spec.ts \
      --project=chromium
  '
  scripts/dev-shell.sh bash -c '
    cd host
    npx vitest run test/optional-demo-vfs.test.ts test/lazy-vfs.test.ts
  '
  ```

  Expected: PASS with real Chromium evidence, including the fbDOOM case in
  `kandelo-merge-gate.spec.ts` and the dedicated modeset suite.

- [ ] **Step 6: Manually verify the candidate product route**

  Run `./run.sh browser` through the declared environment, select one eager and
  one lazy candidate product, execute their principal behavior, and inspect
  Network/console evidence that lazy whole-VFS and inner-layer fetch timing is
  preserved. Record exact products and outcomes; do not claim all products
  manually tested unless they were.

- [ ] **Step 7: Commit**

  ```bash
  git add scripts/abi-staging-product-browser-evidence.ts \
    scripts/abi-staging-product-browser-evidence.test.ts \
    apps/browser-demos/test/abi-staging-product-evidence.spec.ts \
    apps/browser-demos/playwright.config.ts \
    apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts \
    apps/browser-demos/pages/kandelo/kernel-host/optional-demo-vfs.ts
  git commit -m "[VFS] Run exact candidate product evidence in browsers"
  ```

---

### Task 10: Add product jobs to the protected tap reconciler

**Repository:** `kandelo-dev/homebrew-tap-core`

**Files:**

- Modify: `.github/workflows/abi-staging-reconcile.yml`
- Modify: `scripts/abi_staging/reconcile.py`
- Modify: `scripts/abi_staging/product.py`
- Modify: `scripts/abi_staging/product_evidence.py`
- Modify: `scripts/check_abi_staging_workflows.rb`
- Modify: `scripts/test_check_abi_staging_workflows.rb`

**Interfaces:**

- Consumes: Tasks 1–9 and Plan 3 bounded scheduling.
- Produces: jobs `prepare-runtime`, `compose-product`,
  `publish-product-candidate`, `node-product-evidence`,
  `browser-product-evidence`, and `publish-product-evidence`.
- Exact permissions:

  | Job | Permissions |
  |---|---|
  | `prepare-runtime` | `contents: read` |
  | `compose-product` | `contents: read` |
  | `publish-product-candidate` | `contents: read`, `actions: read`, `packages: write` |
  | `node-product-evidence` | `contents: read` |
  | `browser-product-evidence` | `contents: read` |
  | `publish-product-evidence` | `contents: read`, `actions: read`, `packages: write` |

  Product timeout is exactly three hours for composition plus required E2E.

- [ ] **Step 1: Write failing workflow mutations**

  Reject write permission in runtime/composition/evidence, combined execution
  and publication, candidate script in a publisher, missing report validation,
  canonical reference in candidate product, mutable VFS tag, missing browser
  job for Pages product, skipped evidence treated success, background Formula
  failure gating a ready product, global product transaction, or sleeping job.

- [ ] **Step 2: Write failing workflow lifecycle fixtures**

  Cover dependency-ready product, blocked dependency, shared product input,
  one product failure with independent sibling, exact runtime change with
  reused bottles, closed request, reopened request, duplicate scheduled runs,
  and an informational product failure. Assert idempotent records and
  required-first work.

- [ ] **Step 3: Run tap tests and verify red**

  ```bash
  scripts/dev-shell.sh env PYTHONPATH="$KANDELO_TAP_ROOT" \
    python3 -m unittest \
      scripts.abi_staging.tests.test_product \
      scripts.abi_staging.tests.test_product_evidence \
      scripts.abi_staging.tests.test_reconcile -v
  scripts/dev-shell.sh env KANDELO_TAP_ROOT="$KANDELO_TAP_ROOT" \
    ruby "$KANDELO_TAP_ROOT/scripts/test_check_abi_staging_workflows.rb"
  ```

  Expected: FAIL because workflow jobs are absent.

- [ ] **Step 4: Implement bounded product scheduling**

  Schedule only products whose exact required inputs exist. Reuse one runtime
  bundle per request/head. Publish VFS identity before tests, then independent
  host receipts and aggregate evidence. On failure record blockers and return;
  later reconciliation resumes missing/retry-eligible work.

- [ ] **Step 5: Run full tap workflow tests**

  ```bash
  scripts/dev-shell.sh env PYTHONPATH="$KANDELO_TAP_ROOT" \
    python3 -m unittest discover \
      -s "$KANDELO_TAP_ROOT/scripts/abi_staging/tests" -v
  scripts/dev-shell.sh env KANDELO_TAP_ROOT="$KANDELO_TAP_ROOT" \
    ruby "$KANDELO_TAP_ROOT/scripts/test_check_abi_staging_workflows.rb"
  scripts/dev-shell.sh env KANDELO_TAP_ROOT="$KANDELO_TAP_ROOT" \
    actionlint "$KANDELO_TAP_ROOT/.github/workflows/abi-staging-reconcile.yml"
  ```

  Expected: PASS in observe mode.

- [ ] **Step 6: Commit in the tap repository**

  ```bash
  git -C "$KANDELO_TAP_ROOT" add \
    .github/workflows/abi-staging-reconcile.yml \
    scripts/abi_staging/reconcile.py \
    scripts/abi_staging/product.py \
    scripts/abi_staging/product_evidence.py \
    scripts/check_abi_staging_workflows.rb \
    scripts/test_check_abi_staging_workflows.rb
  git -C "$KANDELO_TAP_ROOT" commit -m \
    "[VFS] Reconcile required candidate product evidence"
  ```

---

### Task 11: Project immutable records into the Kandelo PR Check

**Files:**

- Create: `tools/xtask/src/abi_staging/check_projection.rs`
- Modify: `tools/xtask/src/abi_staging/mod.rs`
- Create: `abi/staging/required-check-activation.toml`
- Create: `.github/scripts/update-abi-staging-check.sh`
- Create: `.github/scripts/test-update-abi-staging-check.sh`
- Create: `.github/workflows/abi-staging-pr-check.yml`
- Create: `scripts/check-abi-staging-pr-check-workflow.rb`

**Interfaces:**

- Consumes: current GitHub PR head, current protected requirements/policy/guard
  identity, public request/tap/candidate/receipt/product records, and fifteen
  minute observability threshold.
- Produces: `CurrentCheckProjectionV1` and exact `Kandelo PR Check` update.
- Activation begins `mode = "observe"`; the update adapter writes a neutral
  Check with computed conclusion in its text.

- [ ] **Step 1: Write failing projection tests**

  Cover not applicable, request missing, discovery delayed, current request
  selected, old-head-only evidence, stale policy/requirements, required bottle
  pending/failed, required product Node/browser pending/failed/success,
  accepted override, informational failure, background failure, tap plan
  blocker, and all-required success.

- [ ] **Step 2: Write status/Markdown safety tests**

  Assert exact Check name/external ID/head, observe versus enforce conclusion,
  deterministic first causal blocker, all sibling details, bounded lengths,
  escaped untrusted text, validated links, retries/timeouts/override links, and
  no record mutation. Random input order must produce identical projection.

- [ ] **Step 3: Write fake-`gh` adapter tests**

  Model no prior Check, same external ID update, old-head Check, duplicate
  matching Check, API pagination, failed write, and stale head immediately
  before write. The adapter must never post status to a different SHA or read a
  mutable latest asset.

- [ ] **Step 4: Write workflow mutation tests**

  Reject candidate checkout/execution in the Check workflow, workflow-level
  write, contents/checks write combined with untrusted script, missing exact
  head recheck, timestamp current selection, background gating, skipped product
  success, observe mode publishing failure, or swallowed API failure.

- [ ] **Step 5: Run focused tests and verify red**

  ```bash
  scripts/dev-shell.sh bash -c '
    host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
    cargo test -p xtask --target "$host_target" \
      abi_staging::check_projection
  '
  scripts/dev-shell.sh bash .github/scripts/test-update-abi-staging-check.sh
  scripts/dev-shell.sh ruby scripts/check-abi-staging-pr-check-workflow.rb
  ```

  Expected: FAIL because projection/workflow are absent.

- [ ] **Step 6: Implement pure projection and narrow update adapter**

  Recompute current requirements using the protected parser against the exact
  head's inert product/registry files. Select request by complete current
  identity. Validate every public record/digest/reference before projection.
  Query exact current head again immediately before creating/updating the Check.

- [ ] **Step 7: Implement protected scheduled/manual workflow**

  `pull_request_target`, five-minute schedule, and workflow dispatch enumerate
  applicable open PRs. A read-only `collect-project` job emits a bounded inert
  projection; a `publish-check` job has only `contents: read`, `actions: read`,
  and `checks: write`, checks out protected code, revalidates projection, and
  updates the exact head. It executes no candidate code.

- [ ] **Step 8: Run focused workflow tests**

  ```bash
  scripts/dev-shell.sh bash -c '
    host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
    cargo test -p xtask --target "$host_target" \
      abi_staging::check_projection
  '
  scripts/dev-shell.sh bash .github/scripts/test-update-abi-staging-check.sh
  scripts/dev-shell.sh ruby scripts/check-abi-staging-pr-check-workflow.rb
  scripts/dev-shell.sh actionlint \
    .github/workflows/abi-staging-pr-check.yml
  ```

  Expected: PASS in observe mode.

- [ ] **Step 9: Commit**

  ```bash
  git add tools/xtask/src/abi_staging/check_projection.rs \
    tools/xtask/src/abi_staging/mod.rs \
    abi/staging/required-check-activation.toml \
    .github/scripts/update-abi-staging-check.sh \
    .github/scripts/test-update-abi-staging-check.sh \
    .github/workflows/abi-staging-pr-check.yml \
    scripts/check-abi-staging-pr-check-workflow.rb
  git commit -m "[ABI] Project required products into an exact-head Check"
  ```

---

### Task 12: Bind protected merge preparation to current exact-head evidence

**Files:**

- Modify: `.github/workflows/prepare-merge.yml`
- Modify: `.github/scripts/test-merge-candidate-workflows.sh`
- Modify: `.github/actions/detect-change-scope/ci-scope-paths.sh`
- Modify: `.github/actions/detect-change-scope/test-ci-scope-paths.sh`

**Interfaces:**

- Consumes: Task 11 Check, exact-head structural ABI check, existing
  ready-to-ship gate, and change scope.
- Produces: enforce-mode merge gating for applicable changes while retaining
  unrelated legacy package staging behavior.

- [ ] **Step 1: Add failing exact-head gate assertions**

  Require a separate read-only `abi-staging-exact-head-structure` job for the
  PR head and require the gate to validate `Kandelo PR Check` success on that
  exact SHA/current context when activation is enforce. Assert legacy synthetic
  merge outputs cannot satisfy either condition.

- [ ] **Step 2: Add mutation tests**

  Reject using synthetic merge SHA, accepting a Check on base/old head,
  trusting name without external/current identity, ignoring policy digest,
  treating neutral observe Check as enforce success, bypassing on background
  failure, or running candidate structural code in a write-capable gate job.

- [ ] **Step 3: Run prepare-merge tests and verify red**

  ```bash
  scripts/dev-shell.sh bash .github/scripts/test-merge-candidate-workflows.sh
  scripts/dev-shell.sh ruby scripts/check-abi-staging-pr-check-workflow.rb
  ```

  Expected: FAIL because the exact-head gate is absent.

- [ ] **Step 4: Implement gated coexistence**

  Add the no-write structural job and validate its bounded result in the
  existing gate. In observe mode, report computed staging state without
  blocking. In enforce mode, block applicable ABI/kernel/host changes unless
  current exact-head structure and Check succeed. Preserve synthetic package
  preparation for still-active non-Homebrew consumers and explain the two
  source identities beside the workflow.

- [ ] **Step 5: Run prepare-merge, ABI, and actionlint checks**

  ```bash
  scripts/dev-shell.sh bash .github/scripts/test-merge-candidate-workflows.sh
  scripts/dev-shell.sh bash scripts/check-abi-version.sh
  scripts/dev-shell.sh ruby scripts/check-abi-staging-pr-check-workflow.rb
  scripts/dev-shell.sh actionlint \
    .github/workflows/prepare-merge.yml \
    .github/workflows/abi-staging-pr-check.yml
  ```

  Expected: PASS while activation remains observe.

- [ ] **Step 6: Commit**

  ```bash
  git add .github/workflows/prepare-merge.yml \
    .github/scripts/test-merge-candidate-workflows.sh \
    .github/actions/detect-change-scope/ci-scope-paths.sh \
    .github/actions/detect-change-scope/test-ci-scope-paths.sh
  git commit -m "[ABI] Prepare merge gating on exact product evidence"
  ```

---

### Task 13: Run hosted product/Check canaries and enable the required gate

**Repositories:** Kandelo and tap

**Files:**

- Modify: `Kandelo/staging/product-evidence-activation.toml` in the tap
- Modify: `abi/staging/required-check-activation.toml` in Kandelo
- Modify: `docs/abi-versioning.md`
- Modify: `docs/browser-support.md`
- Modify: `docs/homebrew-publishing.md`
- Modify: `docs/repository-organization.md`
- Modify: `Kandelo/README.md` in the tap
- Modify: `README.md` in the tap

**Interfaces:**

- Consumes: protected-main Plan 4 observe workflows and active Plan 3
  candidates.
- Produces: hosted exact-head product and Check evidence, then narrow activation
  commits and an external branch-protection request.

- [ ] **Step 1: Run required-product composition in observe mode**

  For one exact same-repository request, retain runtime/input/VFS/report and
  Node/browser receipt digests for every selected required product. Confirm
  candidate namespace references, exact head/runtime, three-hour timeout, and
  lazy materialization. Any missing required evidence keeps computed Check
  pending/failure.

- [ ] **Step 2: Run a background-failure canary**

  Cause or use a deterministic unrelated background Formula failure while all
  required products succeed. Confirm computed `Kandelo PR Check` is success and
  the background failure remains visible informational detail.

- [ ] **Step 3: Run a required-failure and stale-head canary**

  Make one required product evidence fixture fail, confirm computed failure,
  then advance the PR head. Confirm old product evidence remains public but the
  new exact head is pending and cannot reuse runtime evidence merely by head
  ordering.

- [ ] **Step 4: Prove browser behavior on hosted Chromium**

  Retain Playwright reports for all required browser definitions and inspect
  one eager/one lazy product's network behavior. A skipped browser job or
  missing report is not success.

- [ ] **Step 5: Activate tap product evidence**

  Change only tap product activation from observe to active, run all tap tests,
  and commit.

  ```bash
  scripts/dev-shell.sh env PYTHONPATH="$KANDELO_TAP_ROOT" \
    python3 -m unittest discover \
      -s "$KANDELO_TAP_ROOT/scripts/abi_staging/tests" -v
  git -C "$KANDELO_TAP_ROOT" add \
    Kandelo/staging/product-evidence-activation.toml
  git -C "$KANDELO_TAP_ROOT" commit -m \
    "[VFS] Activate candidate product evidence"
  ```

- [ ] **Step 6: Activate the Kandelo Check in code**

  Change only `required-check-activation.toml` from observe to enforce, run the
  exact Check/merge workflow tests, and commit. Do not change promotion or
  Pages.

  ```bash
  scripts/dev-shell.sh bash scripts/test-abi-staging-product-evidence.sh
  scripts/dev-shell.sh ruby scripts/check-abi-staging-pr-check-workflow.rb
  scripts/dev-shell.sh bash .github/scripts/test-merge-candidate-workflows.sh
  git add abi/staging/required-check-activation.toml
  git commit -m "[ABI] Enforce required exact-head product evidence"
  ```

- [ ] **Step 7: Add `Kandelo PR Check` to branch protection externally**

  Verify the exact protected ruleset/repository setting after the enforce
  commit is on main. This is an explicit maintainer/repository-administration
  gate. If unavailable, leave code ready, report the gate, and do not claim the
  PR is protected.

- [ ] **Step 8: Update docs to the exact operational claim**

  Describe candidate VFS/product evidence and required Check behavior, exact
  head/current policy semantics, background non-gating, browser evidence, and
  the narrower-than-full-stock Homebrew lifecycle claim. Keep promotion,
  protected ABI history, canonical recomposition, Pages integration, and
  retirement unimplemented.

- [ ] **Step 9: Commit documentation in both repositories**

  ```bash
  git add docs/abi-versioning.md docs/browser-support.md \
    docs/homebrew-publishing.md docs/repository-organization.md
  git commit -m "[Docs] Describe required candidate product evidence"
  git -C "$KANDELO_TAP_ROOT" add Kandelo/README.md README.md
  git -C "$KANDELO_TAP_ROOT" commit -m \
    "[Docs] Describe candidate VFS evidence publication"
  ```

---

### Task 14: Final Plan 4 verification and exact-head audit

**Files:**

- Verify every Plan 4 file, both repositories, browser evidence, hosted records,
  Check runs, and branch-protection state if configured.

**Interfaces:**

- Consumes: Tasks 1–13.
- Produces: evidence for required candidate products and exact-head Check only.

- [ ] **Step 1: Run complete product authority/builder tests**

  ```bash
  scripts/dev-shell.sh bash scripts/test-abi-staging-product-authority.sh
  scripts/dev-shell.sh bash scripts/test-abi-staging-product-evidence.sh
  scripts/dev-shell.sh bash -c '
    host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
    cargo test -p xtask --target "$host_target" abi_staging
    cd host
    npx vitest run \
      test/vfs-product-builder-contract.test.ts \
      test/staged-product-inputs.test.ts \
      test/abi-staging-product-builders.test.ts \
      test/optional-demo-vfs.test.ts \
      test/lazy-vfs.test.ts \
      test/vfs-image.test.ts
  '
  ```

  Expected: PASS.

- [ ] **Step 2: Run Node and browser evidence tests**

  ```bash
  scripts/dev-shell.sh npx tsx --test \
    scripts/abi-staging-product-node-evidence.test.ts \
    scripts/abi-staging-product-browser-evidence.test.ts
  scripts/dev-shell.sh bash -c '
    cd apps/browser-demos
    npx playwright test test/abi-staging-product-evidence.spec.ts \
      --project=chromium
  '
  ```

  Expected: PASS; this is actual browser evidence, not Node-only inference.

- [ ] **Step 3: Run workflow/security checks**

  ```bash
  scripts/dev-shell.sh ruby scripts/check-abi-staging-pr-check-workflow.rb
  scripts/dev-shell.sh bash .github/scripts/test-update-abi-staging-check.sh
  scripts/dev-shell.sh bash .github/scripts/test-merge-candidate-workflows.sh
  scripts/dev-shell.sh env KANDELO_TAP_ROOT="$KANDELO_TAP_ROOT" \
    ruby "$KANDELO_TAP_ROOT/scripts/test_check_abi_staging_workflows.rb"
  scripts/dev-shell.sh actionlint \
    .github/workflows/abi-staging-pr-check.yml \
    .github/workflows/prepare-merge.yml
  ```

  Expected: PASS.

- [ ] **Step 4: Run complete tap tests and documentation**

  ```bash
  scripts/dev-shell.sh env PYTHONPATH="$KANDELO_TAP_ROOT" \
    python3 -m unittest discover \
      -s "$KANDELO_TAP_ROOT/scripts/abi_staging/tests" -v
  scripts/dev-shell.sh npm run docs:build
  ```

  Expected: PASS.

- [ ] **Step 5: Audit exact source, materialization, and genericity**

  ```bash
  scripts/dev-shell.sh bash -c '
    if rg -n -i "abi[-_ ]?4[23]|integration/abi4[23]" \
      abi/staging \
      tools/xtask/src/abi_staging \
      scripts/abi-staging-* \
      images/vfs/scripts/staged-product-inputs.ts \
      apps/browser-demos/test/abi-staging-product-evidence.spec.ts \
      "$KANDELO_TAP_ROOT/scripts/abi_staging" \
      "$KANDELO_TAP_ROOT/Kandelo/staging"; then
      echo "acceptance ABI leaked into product evidence" >&2
      exit 1
    fi
    rg -n "refs/pull/.*/merge|synthetic" \
      .github/workflows/abi-staging-pr-check.yml \
      .github/workflows/prepare-merge.yml \
      scripts/abi-staging-* \
      "$KANDELO_TAP_ROOT/.github/workflows/abi-staging-reconcile.yml"
  '
  ```

  Manually confirm every “synthetic” match in `prepare-merge.yml` is explicitly
  legacy/non-ABI, every staging input is exact head, every product builder
  reports all inputs, and candidate lazy references stay noncanonical.

- [ ] **Step 6: Audit hosted Check and stop**

  Inspect one success, required failure, stale-head pending, and background
  failure Check. Verify exact head/external ID/current policy and immutable
  links. If branch protection was not configured, report that precise external
  gate. Do not promote a candidate in this plan.

## Exit Criteria

- Every product manifest evidence ID has one protected bounded definition.
- Every real VFS builder can consume exact resolved inputs and emit an exact
  report without changing its legacy supported mode.
- Candidate products preserve whole-VFS and inner-layer lazy/eager contracts
  and contain only candidate references.
- Product composition and Node/browser execution have no write credentials;
  protected publishers treat handoffs as inert and prove anonymous readback.
- `ProductEvidenceRecordV1` binds exact manifest, selecting registries,
  Formula/package/archive/toolchain/repository inputs, VFS/report, runtime,
  definitions, and receipts.
- Required product failures/pending evidence gate; unrelated background
  Formula and informational product failures do not.
- Current exact-head/current-policy selection is proven; historical heads remain
  valid but cannot satisfy a newer Check.
- The `Kandelo PR Check` is enforced only after hosted observe evidence and
  branch-protection verification. If external protection is absent, that fact
  is reported without weakening the gate.
- Documentation still makes the full stock in-guest Homebrew lifecycle a
  narrower deferred/diagnostic claim and keeps promotion/Pages unimplemented.

After these criteria are met, execute Plan 5. A green candidate-product Check
authorizes merge under current policy; it does not itself admit candidates to
canonical namespaces or mutate tap main.
