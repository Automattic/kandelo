# Generic ABI Staging Product Authority Foundation Implementation Plan

> **Junior-review edition:** The complete command-level version is preserved
> in docs-only commit `0153a8863`. This edition explains the same interfaces,
> tests, trust boundaries, and commit sequence in plainer language. During
> implementation, use the preserved task details together with any review
> changes approved against this edition.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make canonical TOML files the authority for Kandelo VFS products,
let Pages and tests select those products from their own registries, and add a
strict input/report boundary that stops builders from using undeclared
software.

**Architecture:** A Rust `xtask abi-staging` command validates human-written
TOML and generates canonical JSON. Product selection walks only those
manifests, so Homebrew Formula roots have one source of truth. Existing package
metadata and custom builders remain available as mechanical adapters, but new
staging calls them only through an exact resolved-input envelope and an exact
builder report.

**Tech Stack:** Rust and Cargo, TOML, canonical JSON, TypeScript, the existing
`MemoryFileSystem`, Node test runners, Bash, and repository tools invoked
through `scripts/dev-shell.sh`.

## Global Constraints

- New reusable code is generic in source ABI `N` and target ABI `N + 1`.
- The build source is the exact pull-request head, never a synthetic merge.
- Product TOML owns product identity, composition, direct software inputs,
  materialization, mounts, boot intent, and basic evidence IDs.
- A legacy package manifest, build manifest, Brewfile, lock, or builder may
  implement or project product intent. It may not add software dependencies.
- Pages and tests select products from separate consumer-owned registries.
- Preserve lazy loading of a whole VFS separately from lazy bottle/package
  references inside the VFS.
- Candidate and canonical references are visibly different. Final VFSs are
  recomposed around canonical references; bottle layers are not rebuilt merely
  to change reference class.
- Ordinary staging fails on missing, extra, mismatched, or incompletely
  captured inputs. It has no override flag.
- This plan adds no credentialed candidate job and writes no remote artifact.
- Keep all existing Homebrew, package, browser, and Pages paths working.
- Do not describe remote staging as operational after this plan.
- Keep `tests/sortix/os-test` and `.serena/` out of every commit.
- Run every build and validation command through `scripts/dev-shell.sh`.

---

## How to read this plan

Tasks 1–3 create the common parser, manifest model, and consumer registries.
The plain-language model, glossary, and full interface reference immediately
after those tasks explain how those pieces fit together. Read that reference
before implementing Task 1. Tasks 4–10 then migrate the real product inventory,
constrain builders, prove a miniature transition, and wire validation.

## Foundation tasks

### Task 1: Add canonical JSON and the `abi-staging` command

**Why:** Every repository must hash the same logical record to the same bytes.
This task creates that shared encoding before any schema depends on it.

**Files:**

- Modify: `tools/xtask/src/main.rs`
- Create: `tools/xtask/src/abi_staging/mod.rs`
- Create: `tools/xtask/src/abi_staging/canonical_json.rs`

**Interfaces:**

- Consumes: existing `xtask` dispatch and workspace `serde`, `serde_json`, and
  `sha2` dependencies.
- Produces:

  ```rust
  pub fn canonical_json_bytes<T: serde::Serialize>(value: &T)
      -> Result<Vec<u8>, String>;
  pub fn canonical_sha256<T: serde::Serialize>(value: &T)
      -> Result<String, String>;
  pub fn validate_sha256(value: &str) -> Result<(), String>;
  pub fn validate_git_sha(value: &str) -> Result<(), String>;
  pub fn validate_stable_id(value: &str, field: &str) -> Result<(), String>;
  pub fn validate_repo_path(root: &Path, value: &str) -> Result<PathBuf, String>;
  pub fn validate_absolute_posix_path(value: &str) -> Result<(), String>;
  ```

- Adds `xtask abi-staging <subcommand>` without changing existing commands.

- [ ] **Step 1: Write failing tests**

  Cover recursive object-key sorting, preserved array order, UTF-8, integers,
  one trailing line feed, and a stable digest. Reject floats, uppercase IDs,
  unsafe paths, wrong-length hashes, and over-limit strings.

- [ ] **Step 2: Run the tests and confirm red**

  ```bash
  scripts/dev-shell.sh bash -c '
    host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
    cargo test -p xtask --target "$host_target" abi_staging::canonical_json
  '
  ```

  Expected: FAIL because the module is missing.

- [ ] **Step 3: Implement the smallest correct encoder and dispatch**

  Convert to `serde_json::Value`, reject non-integer numbers, recursively
  rebuild objects with sorted keys, serialize without extra whitespace, and
  append one line feed. An unknown nested command exits with status 2.

- [ ] **Step 4: Run the tests and confirm green**

  ```bash
  scripts/dev-shell.sh bash -c '
    host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
    cargo test -p xtask --target "$host_target" abi_staging::canonical_json
    cargo run -p xtask --target "$host_target" --quiet -- abi-staging help
  '
  ```

  Expected: PASS; help lists only implemented foundation commands.

- [ ] **Step 5: Commit**

  ```bash
  git add tools/xtask/src/main.rs \
    tools/xtask/src/abi_staging/mod.rs \
    tools/xtask/src/abi_staging/canonical_json.rs
  git commit -m "[ABI] Add canonical staging data boundary"
  ```

---

### Task 2: Parse and generate product manifests

**Why:** Later code must be able to trust one strict product model and one
stable manifest digest.

**Files:**

- Modify: `tools/xtask/src/abi_staging/mod.rs`
- Create: `tools/xtask/src/abi_staging/product_manifest.rs`
- Create: `tools/xtask/tests/fixtures/abi-staging/canonical/product.toml`
- Create: `tools/xtask/tests/fixtures/abi-staging/canonical/product.json`

**Interfaces:**

- Consumes: Task 1 encoding and validators.
- Produces strict manifest types and:

  ```rust
  pub fn load_product_catalog(
      repository_root: &Path,
      product_dir: &Path,
  ) -> Result<VfsProductCatalogV1, String>;

  pub enum CatalogWriteMode { Generate, Check }

  pub fn write_or_check_product_catalog(
      mode: CatalogWriteMode,
      repository_root: &Path,
      product_dir: &Path,
      output: &Path,
  ) -> Result<(), String>;
  ```

- Adds `abi-staging products generate` and `products check`.

- [ ] **Step 1: Write failing positive and negative tests**

  The positive TOML must produce the exact fixture JSON. Reject unknown fields,
  an ABI field, Pages flag, candidate URL, command, retry/timeout, duplicate
  root, unsafe path, bad role/materialization, unknown toolchain provider,
  missing builder, product cycle, and cross-architecture composition.

- [ ] **Step 2: Run the tests and confirm red**

  ```bash
  scripts/dev-shell.sh bash -c '
    host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
    cargo test -p xtask --target "$host_target" abi_staging::product_manifest
  '
  ```

  Expected: FAIL because the model is missing.

- [ ] **Step 3: Implement strict parsing and whole-catalog checks**

  Use `deny_unknown_fields` on every serialized struct. Validate syntax first,
  then product IDs, outputs, references, graph cycles, and architecture. Error
  messages name the normalized file and field. Parsing never executes a
  builder or resolves software.

- [ ] **Step 4: Implement safe generation and freshness checking**

  Generate through a new sibling temporary file and rename only after complete
  serialization. `check` compares exact bytes and prints the regeneration
  command. Never replace a symlink or non-regular output.

- [ ] **Step 5: Run the tests and confirm green**

  ```bash
  scripts/dev-shell.sh bash -c '
    host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
    cargo test -p xtask --target "$host_target" abi_staging::product_manifest
  '
  ```

  Expected: PASS, including interruption and stale-file tests.

- [ ] **Step 6: Commit**

  ```bash
  git add tools/xtask/src/abi_staging/mod.rs \
    tools/xtask/src/abi_staging/product_manifest.rs \
    tools/xtask/tests/fixtures/abi-staging/canonical/product.toml \
    tools/xtask/tests/fixtures/abi-staging/canonical/product.json
  git commit -m "[VFS] Define canonical product manifests"
  ```

---

### Task 3: Add consumer registries and derive Formula roots

**Why:** Products describe what they are; Pages and tests must independently
decide where those products are used.

**Files:**

- Modify: `tools/xtask/src/abi_staging/mod.rs`
- Create: `tools/xtask/src/abi_staging/consumer_registry.rs`
- Create: `tools/xtask/src/abi_staging/selection.rs`
- Create: `tools/xtask/tests/fixtures/abi-staging/canonical/pages.toml`
- Create: `tools/xtask/tests/fixtures/abi-staging/canonical/pages.json`
- Create: `tools/xtask/tests/fixtures/abi-staging/canonical/tests.toml`
- Create: `tools/xtask/tests/fixtures/abi-staging/canonical/tests.json`

**Interfaces:**

- Consumes: Task 2 `VfsProductCatalogV1`.
- Produces `PagesProductRegistryV1`, `TestProductRegistryV1`,
  `SelectedVfsProductV1`, `FormulaRequirementV1`, and the two functions shown
  in the Exact Interfaces section.
- Adds `abi-staging registries generate`, `registries check`, and
  `requirements --change-class <abi|kernel|host>`.

- [ ] **Step 1: Write failing registry tests**

  Cover exact TOML/JSON fixtures, duplicate or missing products, unknown
  products/fields, empty evidence, and invalid applicability. Prove that a
  product-owned Pages field fails while adding the product to the Pages
  registry succeeds.

- [ ] **Step 2: Write failing selection tests**

  Use a small graph with embedded and lazy product edges and Formula roots.
  Prove Pages is required for all change classes, strongest applicability wins,
  dependencies remain topological, both lazy boundaries survive, and changing
  a Brewfile/package/builder outside the catalog cannot change requirements.

- [ ] **Step 3: Run the tests and confirm red**

  ```bash
  scripts/dev-shell.sh bash -c '
    host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
    cargo test -p xtask --target "$host_target" abi_staging::consumer_registry
    cargo test -p xtask --target "$host_target" abi_staging::selection
  '
  ```

  Expected: FAIL because registry and selection modules are missing.

- [ ] **Step 4: Implement pure selection and direct-root derivation**

  After parsing, keep selection filesystem-independent. Sort reasons and
  evidence, topologically sort products, and retain every declared
  materialization. Do not calculate transitive Formula dependencies.

- [ ] **Step 5: Run the tests and confirm green**

  ```bash
  scripts/dev-shell.sh bash -c '
    host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
    cargo test -p xtask --target "$host_target" abi_staging::consumer_registry
    cargo test -p xtask --target "$host_target" abi_staging::selection
  '
  ```

  Expected: PASS; no interface accepts a second Formula-root list.

- [ ] **Step 6: Commit**

  ```bash
  git add tools/xtask/src/abi_staging/mod.rs \
    tools/xtask/src/abi_staging/consumer_registry.rs \
    tools/xtask/src/abi_staging/selection.rs \
    tools/xtask/tests/fixtures/abi-staging/canonical/pages.toml \
    tools/xtask/tests/fixtures/abi-staging/canonical/pages.json \
    tools/xtask/tests/fixtures/abi-staging/canonical/tests.toml \
    tools/xtask/tests/fixtures/abi-staging/canonical/tests.json
  git commit -m "[VFS] Select products through consumer registries"
  ```

---

## What this plan does, in plain language

Today, information about a VFS image is spread across scripts, package files,
browser imports, mount declarations, and workflows. That makes it possible for
two callers to disagree about what the same image contains.

After this plan, one product manifest answers: “What is this VFS product?”
Consumer registries separately answer: “Where do we use it?” Builders receive
an exact list of allowed inputs and must report what they actually consumed.

```text
images/vfs/products/*.toml             lasting product authority
             |
             v
generated catalog.json                 checked, canonical projection
             |
      +------+------+
      |             |
      v             v
Pages registry   test registry         consumer-owned selection
      |             |
      +------+------+
             v
selected product graph
      |             |
      v             v
direct Formula   exact resolved         no parallel staging list
roots            builder inputs
                       |
                       v
                 builder report         exact consumed-input proof
```

## Terms used in this plan

- **Product manifest:** One TOML file describing one VFS product.
- **Catalog:** Canonical JSON containing every validated product manifest.
- **Direct root:** Software named directly by a selected product. The tap will
  resolve transitive Formula dependencies later.
- **Materialization:** `embedded` means bytes are placed in the VFS; `lazy`
  means the VFS contains a content-addressed reference instead.
- **Build-only input:** An input used to produce the VFS but not stored in it.
- **Resolved-input envelope:** The complete validated input list supplied to a
  staging builder.
- **Builder report:** The builder's exact account of output bytes and how each
  declared input was consumed.
- **Reference class:** `candidate` or `canonical`; the two may not be mixed.
- **Mechanical adapter:** A mapping from a canonical product to an existing
  package output or script. It contains no software requirements.

## Exact interfaces

### 1. `VfsProductManifestV1`

Every direct regular file under `images/vfs/products/*.toml` contains exactly
one manifest. Unknown fields fail.

| Part | Exact responsibility |
|---|---|
| `schema` | Must be integer `1`. |
| `id` | Stable product ID. |
| `architecture` | Exactly `wasm32` or `wasm64`. |
| `output` | One ABI-neutral `.vfs` or `.vfs.zst` filename. |
| `builder` | Normalized repository-relative transitional builder path. |
| `composition.product[]` | Direct product ID plus `embedded` or `lazy`. |
| `composition.repository[]` | Stable ID, exact path set, runtime/build role, and runtime materialization. |
| `software.homebrew[]` | Tap identity, ordinary Formula names, and materialization. |
| `software.package[]` | Package name, logical outputs/source roles, runtime/build role, and runtime materialization. |
| `software.archive[]` | Stable ID, credential-free HTTPS URL, SHA-256, runtime/build role, and runtime materialization. |
| `software.toolchain[]` | Stable ID, `repository-dev-shell` provider, component, runtime/build role, and runtime materialization. |
| `mounts[]` | One built-image root plus optional scratch mounts. |
| `boot` | `argv`, `cwd`, numeric UID/GID, and environment. |
| `evidence.node/browser.test` | Stable evidence IDs, not commands. |

Important validation rules:

- Stable IDs, Formula names, package names, outputs, and evidence IDs use
  lowercase ASCII letters, digits, dots, underscores, and hyphens. They start
  with an alphanumeric character and are at most 128 bytes.
- Repository/tap identities are at most 256 bytes.
- A manifest is at most 1 MiB. The catalog has at most 256 products.
- One product has at most 64 product edges, 64 mounts, 32 Homebrew groups,
  256 Formula roots, 256 package entries, 128 archives, 64 toolchain entries,
  and 128 repository entries with at most 256 paths each.
- Repository paths are normalized, relative, nonsymlinked, at most 4,096
  bytes, and cannot contain `..`, a backslash, or NUL.
- Product composition is acyclic and architecture-matched.
- Runtime software has `embedded` or `lazy` materialization. Build-only
  software cannot declare materialization.
- Archive URLs are HTTPS, credential-free, fragment-free, and no longer than
  8,192 characters.
- Version 1 accepts only the `repository-dev-shell` toolchain provider. It
  does not accept a command, host path, or version probe.
- The only built-image mount is `/`. Other mounts are normalized absolute
  scratch paths with octal mode, UID/GID, and `ephemeral = true|false`.
- Boot is required for every Pages or required-test product. At least one Node
  or browser evidence ID is also required.
- A manifest cannot contain ABI selection, resolved dependencies, Pages
  placement, test applicability, candidate/canonical URLs, commands, runners,
  credentials, retries, timeouts, matrices, workflows, or mutable status.

`VfsProductCatalogV1` has exactly `schema`, `kind`, and `products`.
`kind` is `kandelo-vfs-product-catalog`. Each ID-sorted product entry contains
only `path`, canonical `sha256`, and the complete normalized manifest.

Canonical JSON recursively sorts object keys, keeps array order, permits JSON
integers but not floating-point numbers, emits no extra whitespace, and ends
with exactly one line feed. A manifest digest is SHA-256 over those canonical
manifest bytes.

### 2. Consumer registries

The Pages-owned file is
`apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.toml`:

```toml
schema = 1
kind = "kandelo-pages-vfs-products"

[[products]]
id = "platform-rootfs"
load = "eager"

[[products]]
id = "browser-node"
load = "lazy"
```

Each unique entry has exactly `id` and `load`. `load` is `eager` or `lazy` and
controls delivery of the whole VFS. The registry cannot contain software,
ABI, evidence, URLs, or workflow configuration.

The test-owned file is `tests/vfs-products.toml`:

```toml
schema = 1
kind = "kandelo-test-vfs-products"

[[registrations]]
product = "browser-main-shell"
node = ["main-shell-startup"]
browser = ["main-shell-basic-e2e"]

[registrations.applicability]
abi = "required"
kernel = "required"
host = "required"
```

Each registration names one product, at least one Node/browser evidence list,
and applicability for `abi`, `kernel`, and `host`. Applicability is exactly
`required`, `informational`, or `not-applicable`. It cannot contain software,
URLs, commands, runners, credentials, or workflow configuration.

Both TOML files have canonical generated JSON siblings. Pages products are
always required for ABI, kernel, and host changes. If Pages and tests both
select a product, the strongest applicability wins:
`required > informational > not-applicable`.

### 3. Selection and Formula roots

```rust
pub fn select_vfs_products(
    catalog: &VfsProductCatalogV1,
    pages: &PagesProductRegistryV1,
    tests: &TestProductRegistryV1,
    change_class: ChangeClass,
) -> Result<Vec<SelectedVfsProductV1>, String>;

pub fn derive_formula_requirements(
    catalog: &VfsProductCatalogV1,
    selection: &[SelectedVfsProductV1],
) -> Result<Vec<FormulaRequirementV1>, String>;
```

Selection includes every composed product and retains consumer reasons,
evidence IDs, applicability, and each product edge's materialization. Output
is topological, using product ID as the tie-breaker.

Formula derivation reads only selected manifests. It returns one requirement
per `(tap, Formula, architecture)` with every `{ product_id,
materialization }` use. It does not read Brewfiles, package/build manifests,
builders, workflow matrices, or a staging-only list. Plan 3 resolves the tap's
transitive graph.

### 4. Resolved inputs and builder reports

`ResolvedVfsProductInputsV1` is canonical JSON. It binds:

- product ID, manifest path/digest, architecture, and output;
- target ABI and ABI snapshot digest;
- build-policy and dev-shell-lock digests;
- reference class `candidate` or `canonical`;
- exact source repository, commit, and tree; and
- every sorted input with stable ID, tagged kind, role, declared/effective
  materialization, digest, byte count, and allowed local path/reference.

Input kinds are exactly `product-image`, `homebrew-bottle`, `package-output`,
`source-archive`, `toolchain-output`, and `repository-path`.

A lazy input requires an immutable reference and has no local path. An
embedded or build-only input requires a regular nonsymlink path below the
caller-owned input root. Candidate envelopes reject canonical references and
canonical envelopes reject candidate references. A `local-fixture` class is
accepted only by the miniature.

`VfsBuilderReportV1` binds product/manifest identity, resolved-input digest,
output digest/bytes, output ABI metadata, and one consumption entry for every
input. Placement is exactly `embedded`, `lazy-reference`, or `build-only`.
The report also has `capture.complete` and bounded
`capture.unreported_reads`.

Ordinary acceptance requires complete capture, no unreported reads, and an
exact one-to-one match by input ID, kind, digest, bytes, role, and placement.
There is no ordinary override option.

### 5. Shared request and record foundations

`AbiStagingRequestV1` has seven logical sections:

1. `schema` and fixed `kind`;
2. `pull_request` repository and number;
3. exact `build_source` repository, commit, and tree;
4. `target_abi` version and snapshot digest;
5. `requirements` digest, change classes, products, registries, and evidence;
6. `issuance` workflow/policy/guard identities and exact authorization; and
7. audit-only `informational_context`.

It excludes tap revision, transitive dependencies, background inventory,
build graph, matrix, retry, timeout, candidate state, custody, status, and
timestamps. Current applicability is exact head plus current requirements,
policy, and guard-registry identities.

The exact request asset name is:

```text
candidate-request-<full-head-sha>-sha256-<request-digest>.json
```

Durable variants are `AttemptRecordV1`, `CandidateRecordV1`,
`VerificationReceiptV1`, `ProductEvidenceRecordV1`,
`CaptureOverrideAuthorizationV1`, `OverrideReceiptV1`, `AdmissionRecordV1`,
and `DeletionRecordV1`. Identity, verification, override, admission, and
deletion remain separate facts. Unknown fields and guard codes fail closed.

A record never contains its own digest. After publication, the transport
returns `PublishedRecordLocatorV1` with the record digest and immutable
reference.

## Complete product inventory

| Product | Arch | Output | Transitional builder | Direct roots in plain language |
|---|---|---|---|---|
| `platform-rootfs` | wasm32 | `rootfs.vfs` | `packages/registry/rootfs/build-rootfs-package.sh` | Rootfs repository tree and the normal base command Formulae. |
| `browser-main-shell` | wasm32 | `shell.vfs.zst` | `scripts/build-homebrew-main-shell-product.sh` | Embedded `platform-rootfs`/`bash`; existing shell Formula set retains its current embedded/lazy policy. |
| `browser-node` | wasm32 | `node-vfs.vfs.zst` | `images/vfs/scripts/build-node-vfs-image.sh` | Main shell, Node output, exact npm archive. |
| `browser-nginx` | wasm32 | `nginx.vfs.zst` | `images/vfs/scripts/build-nginx-vfs-image.sh` | Main shell, nginx, dinit. |
| `browser-nginx-php` | wasm32 | `nginx-php.vfs.zst` | `images/vfs/scripts/build-nginx-php-vfs-image.sh` | Main shell, nginx, PHP-FPM, opcache, dinit; build-only kernel. |
| `browser-wordpress` | wasm32 | `wordpress.vfs.zst` | `images/vfs/scripts/build-wp-vfs-image.sh` | Main shell, web/PHP services, mail helper, WordPress and SQLite-integration archives; build-only kernel. |
| `browser-lamp` | wasm32 | `lamp.vfs.zst` | `images/vfs/scripts/build-lamp-vfs-image.sh` | Main shell, MariaDB source/runtime, web/PHP services, mail helper, WordPress archive; build-only kernel. |
| `browser-mariadb-wasm32` | wasm32 | `mariadb.vfs.zst` | `images/vfs/scripts/build-mariadb-vfs-image.sh` | MariaDB runtime/source, dash, coreutils, dinit. |
| `browser-mariadb-wasm64` | wasm64 | `mariadb-64.vfs.zst` | same builder | Architecture-matched MariaDB roots. |
| `browser-python` | wasm32 | `python.vfs.zst` | `images/vfs/scripts/build-python-vfs-image.sh` | CPython executable and runtime. |
| `browser-perl` | wasm32 | `perl.vfs.zst` | `images/vfs/scripts/build-perl-vfs-image.sh` | Lazy Perl executable and embedded standard library source role. |
| `browser-redis` | wasm32 | `redis.vfs.zst` | `images/vfs/scripts/build-redis-vfs-image.sh` | Redis server and dinit. |
| `browser-erlang` | wasm32 | `erlang.vfs.zst` | `images/vfs/scripts/build-erlang-vfs-image.sh` | Erlang executable and OTP runtime. |
| `developer-kandelo-sdk` | wasm32 | `kandelo-sdk.vfs.zst` | `images/vfs/scripts/build-kandelo-sdk-vfs-image.sh` | SDK/sysroot/glue, compiler resources, licenses, libcxx. |
| `test-mariadb` | wasm32 | `mariadb-test.vfs.zst` | `images/vfs/scripts/build-mariadb-test-vfs-image.sh` | MariaDB runtime/test/source roles and service tools. |
| `test-php` | wasm32 | `php-test.vfs.zst` | `images/vfs/scripts/build-php-test-vfs-image.sh` | Rootfs, PHP runtime/source, repository tests. |
| `test-sqlite` | wasm32 | `sqlite-test.vfs.zst` | `images/vfs/scripts/build-sqlite-test-vfs-image.sh` | SQLite/Tcl source, test executables, shell tools. |

Before writing a manifest, freeze what the current builder actually reads in
a failing test. If the audit finds an unlisted software input, stop and report
a concrete design discrepancy instead of silently expanding the manifest.

Initial Pages selection is eager for `platform-rootfs` and
`browser-main-shell`; it is lazy for `browser-node`, `browser-nginx`,
`browser-nginx-php`, `browser-wordpress`, and `browser-lamp`.

## File map

### Core Rust

- Modify: `tools/xtask/src/main.rs`
- Create: `tools/xtask/src/abi_staging/mod.rs`
- Create: `tools/xtask/src/abi_staging/canonical_json.rs`
- Create: `tools/xtask/src/abi_staging/product_manifest.rs`
- Create: `tools/xtask/src/abi_staging/consumer_registry.rs`
- Create: `tools/xtask/src/abi_staging/selection.rs`
- Create: `tools/xtask/src/abi_staging/builder_contract.rs`
- Create: `tools/xtask/src/abi_staging/guard_registry.rs`
- Create: `tools/xtask/src/abi_staging/records.rs`
- Create: `tools/xtask/src/abi_staging/local_transport.rs`
- Create: `tools/xtask/src/abi_staging/mini_lifecycle.rs`

### Canonical data

- Create all 17 `images/vfs/products/<product-id>.toml` files listed above.
- Create: `images/vfs/products/generated/catalog.json`
- Create: `apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.toml`
- Create: `apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.generated.json`
- Create: `tests/vfs-products.toml`
- Create: `tests/vfs-products.generated.json`
- Create: `abi/staging/guard-codes.toml`
- Create: `abi/staging/guard-codes.generated.json`
- Create: `abi/staging/legacy-vfs-adapters.toml`
- Create: `abi/staging/legacy-retirement.toml`

### Adapters and tests

- Modify: `scripts/check-homebrew-main-shell-brewfile.mjs`
- Modify: `scripts/test-homebrew-main-shell-closure.sh`
- Create: `scripts/vfs-product-catalog.mjs`
- Create: `scripts/vfs-product-catalog.test.mjs`
- Create: `scripts/check-pages-vfs-product-registry.mjs`
- Create: `scripts/check-pages-vfs-product-registry.test.mjs`
- Create: `images/vfs/scripts/vfs-product-builder-contract.ts`
- Create: `host/test/vfs-product-builder-contract.test.ts`
- Create: `scripts/run-vfs-product-builder.ts`
- Create: `scripts/run-vfs-product-builder.test.ts`
- Create canonical fixtures under `tools/xtask/tests/fixtures/abi-staging/`.
- Create: `images/vfs/scripts/build-abi-staging-mini-vfs.ts`
- Create: `host/test/abi-staging-mini-vfs.test.ts`
- Create: `scripts/test-abi-staging-mini-lifecycle.sh`

### CI and documentation

- Modify: `.github/actions/detect-change-scope/ci-scope-paths.sh`
- Modify: `.github/actions/detect-change-scope/test-ci-scope-paths.sh`
- Create: `scripts/test-abi-staging-product-authority.sh`
- Modify: `docs/abi-versioning.md`
- Modify: `docs/package-management.md`
- Modify: `docs/browser-support.md`
- Modify: `docs/repository-organization.md`
- Modify: `docs/future-improvements.md`
- Create: `docs/superpowers/specs/2026-08-08-abi-bottle-staging-design.md`

---

## Product migration and enforcement tasks

Tasks 1–3 above establish the parsers and selectors. Continue here after
reading the complete interfaces and file map.

### Task 4: Check in the complete product inventory

**Why:** The schemas are useful only after every current VFS builder has a
canonical product and every current consumer points to it.

**Files:**

- Modify: `tools/xtask/src/abi_staging/product_manifest.rs`
- Create all canonical product and generated catalog files in the File Map.
- Create both consumer registries and generated siblings.
- Create: `abi/staging/legacy-vfs-adapters.toml`

**Interfaces:**

- Consumes: Tasks 2–3 and the audited current builders, package inputs,
  browser imports, mounts, and boot declarations.
- Produces: the exact 17-product inventory above, both consumer registries,
  canonical JSON projections, and a dependency-free mechanical adapter map.

- [ ] **Step 1: Write the failing repository-inventory test**

  Assert the exact 17 IDs, one manifest per ID, unique
  `(architecture, output)` pairs, complete adapter coverage, and no
  dependency-bearing adapter key. For each legacy package mapping, prove every
  VFS-level software input is declared by the product. Dependencies internal
  to one package output remain package-recipe facts.

- [ ] **Step 2: Run the test and confirm red**

  ```bash
  scripts/dev-shell.sh bash -c '
    host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
    cargo test -p xtask --target "$host_target" \
      abi_staging::product_manifest::tests::repository_inventory
  '
  ```

  Expected: FAIL because the manifests do not exist.

- [ ] **Step 3: Implement the inventory by auditing each builder, then writing
  product and registry TOML**

  Preserve current output names, architecture, mounts, boot behavior, and
  effective materialization. Record build-only inputs separately. Reuse exact
  URLs/digests already owned by the relevant package/source helper. If the
  audit contradicts the approved inventory, stop and report it.

- [ ] **Step 4: Generate canonical JSON**

  ```bash
  scripts/dev-shell.sh bash -c '
    host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
    cargo run -p xtask --target "$host_target" --quiet -- \
      abi-staging products generate \
      --source images/vfs/products \
      --out images/vfs/products/generated/catalog.json
    cargo run -p xtask --target "$host_target" --quiet -- \
      abi-staging registries generate \
      --pages apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.toml \
      --pages-out apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.generated.json \
      --tests tests/vfs-products.toml \
      --tests-out tests/vfs-products.generated.json
  '
  ```

- [ ] **Step 5: Run inventory and freshness checks**

  ```bash
  scripts/dev-shell.sh bash -c '
    host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
    cargo test -p xtask --target "$host_target" \
      abi_staging::product_manifest::tests::repository_inventory
    cargo run -p xtask --target "$host_target" --quiet -- \
      abi-staging products check \
      --source images/vfs/products \
      --generated images/vfs/products/generated/catalog.json
    cargo run -p xtask --target "$host_target" --quiet -- \
      abi-staging registries check \
      --catalog images/vfs/products/generated/catalog.json \
      --pages apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.toml \
      --pages-generated apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.generated.json \
      --tests tests/vfs-products.toml \
      --tests-generated tests/vfs-products.generated.json
  '
  ```

  Expected: PASS. Generated product data contains no ABI number or remote
  candidate/canonical location.

- [ ] **Step 6: Commit**

  ```bash
  git add tools/xtask/src/abi_staging/product_manifest.rs \
    images/vfs/products \
    abi/staging/legacy-vfs-adapters.toml \
    apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.toml \
    apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.generated.json \
    tests/vfs-products.toml tests/vfs-products.generated.json
  git commit -m "[VFS] Establish canonical product authority"
  ```

---

### Task 5: Check legacy selectors against product authority

**Why:** Existing workflows must keep working during migration, but they must
fail validation if they drift away from canonical product intent.

**Files:**

- Modify: `scripts/check-homebrew-main-shell-brewfile.mjs`
- Modify: `scripts/test-homebrew-main-shell-closure.sh`
- Create: `scripts/vfs-product-catalog.mjs`
- Create: `scripts/vfs-product-catalog.test.mjs`
- Create: `scripts/check-pages-vfs-product-registry.mjs`
- Create: `scripts/check-pages-vfs-product-registry.test.mjs`

**Interfaces:**

- Consumes: Task 4 generated catalog, registries, adapters, and current legacy
  files.
- Produces read-only projection validators:

  ```typescript
  export interface LoadedVfsProductCatalog {
    productById(id: string): Readonly<Record<string, unknown>>;
    homebrewRoots(id: string): readonly Readonly<{
      tap: string;
      formula: string;
      materialization: "embedded" | "lazy";
    }>[];
  }
  export declare function loadVfsProductCatalog(
    catalogPath: string,
  ): LoadedVfsProductCatalog;
  export declare function checkMainShellProjection(
    options: MainShellProjectionPaths,
  ): void;
  export declare function checkPagesVfsProductRegistry(
    options: PagesProjectionPaths,
  ): void;
  ```

The main-shell validator compares manifest roots with the union of Brewfile
roots and runtime-support roots. It deliberately ignores resolved closure and
order arrays. For this first-party MVP it has one asserted normalization from
`kandelo-dev/tap-core` to `kandelo-dev/homebrew-tap-core`; it does not create a
general tap-mapping registry.

The Pages validator checks the registry against browser imports, Vite aliases,
optional lazy loaders, and VFS-producing `run.sh` dependencies. Eager products
must have static imports; lazy products must use lazy loaders. Non-VFS browser
dependencies remain allowed.

- [ ] **Step 1: Write failing catalog-loader tests**

  Reject missing products, unknown fields, duplicate IDs, tampered manifest
  digests, and any executable Formula-root array in the main-shell checker.

- [ ] **Step 2: Write failing Homebrew projection mutations**

  Add a Formula to only one legacy source, remove an embedded root, and change
  manifest materialization. Each mutation must fail with product/root details.

- [ ] **Step 3: Write failing Pages projection mutations**

  Reject product-owned Pages fields, eager-only-glob imports, lazy static
  imports, missing outputs, unregistered VFS source code, an extra VFS target
  in `BROWSER_DEPS`, and a selected product missing its legacy target.

- [ ] **Step 4: Run tests and confirm red**

  ```bash
  scripts/dev-shell.sh npx tsx --test \
    scripts/vfs-product-catalog.test.mjs \
    scripts/check-pages-vfs-product-registry.test.mjs
  scripts/dev-shell.sh bash scripts/test-homebrew-main-shell-closure.sh
  ```

  Expected: FAIL because the validators are missing.

- [ ] **Step 5: Implement read-only checks**

  JavaScript reads only generated canonical JSON. Rust remains responsible for
  proving JSON freshness against TOML. Do not rewrite any legacy selector.

- [ ] **Step 6: Run tests and existing lazy-loading regressions**

  ```bash
  scripts/dev-shell.sh npx tsx --test \
    scripts/vfs-product-catalog.test.mjs \
    scripts/check-pages-vfs-product-registry.test.mjs
  scripts/dev-shell.sh bash scripts/test-homebrew-main-shell-closure.sh
  scripts/dev-shell.sh bash -c '
    cd host
    npx vitest run \
      test/homebrew-vfs-materialization-policy.test.ts \
      test/optional-demo-vfs.test.ts \
      test/shell-lazy-archive-inputs.test.ts
  '
  ```

  Expected: PASS. Optional whole-VFS imports stay lazy and the main shell stays
  eager.

- [ ] **Step 7: Commit**

  ```bash
  git add scripts/check-homebrew-main-shell-brewfile.mjs \
    scripts/test-homebrew-main-shell-closure.sh \
    scripts/vfs-product-catalog.mjs \
    scripts/vfs-product-catalog.test.mjs \
    scripts/check-pages-vfs-product-registry.mjs \
    scripts/check-pages-vfs-product-registry.test.mjs
  git commit -m "[VFS] Verify legacy consumers against product authority"
  ```

---

### Task 6: Enforce exact inputs at the builder boundary

**Why:** A manifest is not authoritative if a builder can quietly read other
software. This task makes undeclared inputs impossible through the staging
entry point.

**Files:**

- Modify: `tools/xtask/src/abi_staging/mod.rs`
- Create: `tools/xtask/src/abi_staging/builder_contract.rs`
- Create: `images/vfs/scripts/vfs-product-builder-contract.ts`
- Create: `host/test/vfs-product-builder-contract.test.ts`
- Create: `scripts/run-vfs-product-builder.ts`
- Create: `scripts/run-vfs-product-builder.test.ts`

**Interfaces:**

- Consumes: Tasks 1–4 canonical product and selection identities.
- Produces strict Rust validators, an accessor-only TypeScript build API, and
  the only future staging runner:

  ```rust
  pub fn validate_resolved_inputs(
      canonical_bytes: &[u8],
      allowed_input_root: &Path,
  ) -> Result<ResolvedVfsProductInputsV1, String>;
  pub fn validate_builder_report(
      canonical_bytes: &[u8],
      allowed_report_root: &Path,
  ) -> Result<VfsBuilderReportV1, String>;
  pub fn compare_builder_report(
      inputs: &ResolvedVfsProductInputsV1,
      report: &VfsBuilderReportV1,
  ) -> Result<BuilderValidationV1, String>;
  ```

  ```typescript
  export type VfsProductInputHandle =
    | Readonly<{
        id: string; sha256: string; bytes: number;
        placement: "embedded" | "build-only"; path: string;
      }>
    | Readonly<{
        id: string; sha256: string; bytes: number;
        placement: "lazy-reference"; reference: string;
      }>;

  export interface VfsProductBuild {
    requireProductImage(id: string): VfsProductInputHandle;
    requireHomebrewBottle(id: string): VfsProductInputHandle;
    requirePackageOutput(id: string): VfsProductInputHandle;
    requireSourceArchive(id: string): VfsProductInputHandle;
    requireToolchainOutput(id: string): VfsProductInputHandle;
    requireRepositoryPath(id: string): VfsProductInputHandle;
    finish(outputPath: string): Promise<void>;
  }

  export declare function openVfsProductBuild(
    inputsPath: string,
    reportPath: string,
  ): Promise<VfsProductBuild>;

  export declare function runVfsProductBuilder(
    options: VfsProductBuilderOptions,
    dependencies: VfsProductBuilderDependencies,
  ): Promise<void>;
  ```

Production supplies real injected operations; tests supply fakes. Neither API
exposes a resolver cache or override hook.

- [ ] **Step 1: Write failing Rust envelope/report tests**

  Reject unknown fields, duplicate IDs, unsafe/symlink paths, invalid
  references, candidate/canonical crossover, wrong architecture, undeclared
  toolchain output, missing/extra consumption, digest/size mismatch,
  incomplete capture, unreported reads, wrong placement/output, and wrong
  output ABI metadata.

- [ ] **Step 2: Write failing TypeScript accessor tests**

  Prove accessors return only the requested declared input, never fetch lazy
  bytes, record exact consumption, and refuse `finish` until every input has
  the required disposition. Failed output validation writes no report.

- [ ] **Step 3: Write failing runner tests**

  Prove the runner strips GitHub, package-registry, Homebrew, npm, SSH, and
  identity credentials; passes exact paths; creates a caller-owned work
  directory; rejects preexisting/symlink outputs; and requires a validated
  report.

- [ ] **Step 4: Run tests and confirm red**

  ```bash
  scripts/dev-shell.sh bash -c '
    host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
    cargo test -p xtask --target "$host_target" abi_staging::builder_contract
  '
  scripts/dev-shell.sh bash -c '
    cd host
    npx vitest run test/vfs-product-builder-contract.test.ts
  '
  scripts/dev-shell.sh npx tsx --test scripts/run-vfs-product-builder.test.ts
  ```

  Expected: FAIL because the boundary is missing.

- [ ] **Step 5: Implement the fail-closed boundary**

  Validate input bytes before exposing paths. Track accesses by stable ID.
  `finish` hashes the output and writes the report atomically. The runner
  validates before launch and compares the report afterward. Add no
  `allow-incomplete`, `ignore-extra`, or override option.

  Legacy callers may still invoke old builders. Until Plan 4 adapts a builder,
  the new staging runner rejects it for not producing a report.

- [ ] **Step 6: Run tests and confirm green**

  ```bash
  scripts/dev-shell.sh bash -c '
    host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
    cargo test -p xtask --target "$host_target" abi_staging::builder_contract
  '
  scripts/dev-shell.sh bash -c '
    cd host
    npx vitest run test/vfs-product-builder-contract.test.ts
  '
  scripts/dev-shell.sh npx tsx --test scripts/run-vfs-product-builder.test.ts
  ```

  Expected: PASS; undeclared inputs and dishonest reports are rejected.

- [ ] **Step 7: Commit**

  ```bash
  git add tools/xtask/src/abi_staging/mod.rs \
    tools/xtask/src/abi_staging/builder_contract.rs \
    images/vfs/scripts/vfs-product-builder-contract.ts \
    host/test/vfs-product-builder-contract.test.ts \
    scripts/run-vfs-product-builder.ts \
    scripts/run-vfs-product-builder.test.ts
  git commit -m "[VFS] Fail closed on undeclared builder inputs"
  ```

---

### Task 7: Add guard policy, durable records, and retirement inventory

**Why:** Later workflows need shared names for failures and strict immutable
record shapes. Cleanup also needs a checked list that begins nonremovable.

**Files:**

- Modify: `tools/xtask/src/abi_staging/mod.rs`
- Create: `tools/xtask/src/abi_staging/guard_registry.rs`
- Create: `tools/xtask/src/abi_staging/records.rs`
- Create: `abi/staging/guard-codes.toml`
- Create: `abi/staging/guard-codes.generated.json`
- Create: `abi/staging/legacy-retirement.toml`

**Interfaces:**

- Consumes: canonical encoding and selected requirement identities.
- Produces `GuardCodeRegistryV1`, the closed record enum, exact request naming,
  and the retirement ledger.

The initial guard codes are exactly:

```text
request_invalid
request_unauthorized
abi_structure_changed_without_bump
source_identity_mismatch
source_custody_mismatch
build_input_capture_incomplete
build_failed
build_timeout
transient_infrastructure_failure
candidate_integrity_mismatch
candidate_public_readback_failed
verification_failed
verification_timeout
dependency_unavailable
tap_source_drift
namespace_bootstrap_failed
policy_version_unknown
pages_product_incomplete
```

Identity, custody, integrity, policy, and dependency contradictions are never
overrideable. `build_input_capture_incomplete` permits only exact-subject build
risk authorization. Verification failure/timeout permits only exact-artifact
risk acceptance. Retry, rebuild, dependency repair, replanning, and namespace
repair are recovery paths, not overrides.

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
pub fn candidate_request_asset_name(
    head: &str,
    request_digest: &str,
) -> Result<String, String>;
pub fn parse_candidate_request_asset(
    filename: &str,
    canonical_request_bytes: &[u8],
) -> Result<AbiStagingRequestV1, String>;
pub fn validate_record(record: &AbiStagingRecordV1) -> Result<(), String>;
```

- [ ] **Step 1: Write failing guard-registry tests**

  Assert the exact code set, unique meanings, allowed override/recovery values,
  generated freshness, and append-only version behavior.

- [ ] **Step 2: Write failing record-invariant tests**

  Cover contradictory states, candidate-without-bytes, success-with-blockers,
  promotion-without-admission, malformed subject, forbidden override, invalid
  capture authorization, mutated authorization, and post-build receipt without
  exact candidate/authorization. Prove timestamps and Git ordering cannot
  decide currentness.

- [ ] **Step 3: Write failing request-name tests**

  Cover valid/reissued/historical heads, short or uppercase SHA, wrong filename
  head/digest, mutable latest aliases, and timestamp-based selection.

- [ ] **Step 4: Write the failing retirement-inventory test**

  Require entries for every audited Kandelo/tap Homebrew workflow, selector,
  lock, browser dependency list, Pages path, shell image builder, and retained
  source path. Every entry starts with `removable = false` and has consumers,
  replacement, evidence IDs, and removal conditions.

- [ ] **Step 5: Run tests and confirm red**

  ```bash
  scripts/dev-shell.sh bash -c '
    host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
    cargo test -p xtask --target "$host_target" abi_staging::guard_registry
    cargo test -p xtask --target "$host_target" abi_staging::records
  '
  ```

  Expected: FAIL because policy and record types are missing.

- [ ] **Step 6: Implement strict policy and record validation**

  Require factual identity even for failures. Use `artifact_class = "none"`
  instead of zero digests. Keep source, verification, override, admission, and
  deletion separate. Request-name parsing does not look up current state.

- [ ] **Step 7: Populate the retirement ledger from the audit**

  Record repository plus exact path for tap entries. Require a real transition,
  required product/Pages evidence, independent promotion, historical repair,
  consumer audit, retained-source custody, and failure/recovery evidence before
  removal.

- [ ] **Step 8: Run tests and confirm green**

  ```bash
  scripts/dev-shell.sh bash -c '
    host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
    cargo test -p xtask --target "$host_target" abi_staging::guard_registry
    cargo test -p xtask --target "$host_target" abi_staging::records
    cargo run -p xtask --target "$host_target" --quiet -- \
      abi-staging guard-codes check \
      --source abi/staging/guard-codes.toml \
      --generated abi/staging/guard-codes.generated.json
  '
  ```

  Expected: PASS; every legacy entry remains nonremovable.

- [ ] **Step 9: Commit**

  ```bash
  git add tools/xtask/src/abi_staging/mod.rs \
    tools/xtask/src/abi_staging/guard_registry.rs \
    tools/xtask/src/abi_staging/records.rs \
    abi/staging/guard-codes.toml \
    abi/staging/guard-codes.generated.json \
    abi/staging/legacy-retirement.toml
  git commit -m "[ABI] Define staging records and guard policy"
  ```

---

### Task 8: Prove the model with a local miniature transition

**Why:** Before touching GitHub or GHCR, prove that the interfaces can carry a
complete generic transition and preserve both lazy boundaries.

**Files:**

- Modify: `tools/xtask/src/abi_staging/mod.rs`
- Create: `tools/xtask/src/abi_staging/local_transport.rs`
- Create: `tools/xtask/src/abi_staging/mini_lifecycle.rs`
- Create miniature fixtures under
  `tools/xtask/tests/fixtures/abi-staging/mini-transition/`
- Create: `images/vfs/scripts/build-abi-staging-mini-vfs.ts`
- Create: `host/test/abi-staging-mini-vfs.test.ts`
- Create: `scripts/test-abi-staging-mini-lifecycle.sh`

**Interfaces:**

- Consumes: Tasks 1–7 and the existing real VFS implementation.
- Produces a digest-addressed fake transport and:

  ```rust
  pub fn deterministic_retry_delay_ms(
      request_digest: &str,
      exact_subject: &str,
      retry_number: u8,
      base_ms: u64,
      cap_ms: u64,
  ) -> Result<u64, String>;
  pub fn run_mini_lifecycle(
      fixture_dir: &Path,
      new_work_dir: &Path,
  ) -> Result<MiniLifecycleSummaryV1, String>;
  ```

`abi-staging mini run --fixture <dir> --work <new-dir>` reads source/target ABI
from fixture TOML and requires target = source + 1. The fake transport has
separate candidate, canonical, and source roots, writes by digest without
clobbering, and offers a fresh read-only handle.

- [ ] **Step 1: Write failing transport tests**

  Cover digest writes/reads, namespace separation, anonymous readback,
  identical-write idempotence, collision rejection, symlink safety, and an
  interrupted write that leaves the previous object intact.

- [ ] **Step 2: Write failing real-VFS tests**

  Build and restore a tiny VFS with one embedded and one lazy layer. Verify
  embedded bytes, absent lazy bytes, exact lazy reference, seals/metadata, and
  complete report. Recompose canonically and prove bottle-layer identity stays
  the same while the VFS identity changes.

- [ ] **Step 3: Write the failing lifecycle harness**

  Require this order:

  1. exact-head request;
  2. product-derived required roots;
  3. fake tap dependencies plus unrelated background work;
  4. one new candidate and one exact reuse;
  5. exact source custody;
  6. inert protected publication;
  7. fresh anonymous verification;
  8. candidate VFS build/restore/test;
  9. required readiness while background remains pending;
  10. protected/verified source `abi/N` history;
  11. merge and independent promotion;
  12. byte-for-byte source history preservation;
  13. canonical VFS recomposition with unchanged bottle layers;
  14. failed incomplete Pages inventory retains the old site; and
  15. complete inventory atomically replaces it.

  Negative fixtures cover incomplete capture, wrong-subject override,
  application failure mislabeled transient, stale policy, missing/unverified
  history, and a synthetic merge as source.

- [ ] **Step 4: Run tests and confirm red**

  ```bash
  scripts/dev-shell.sh bash -c '
    host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
    cargo test -p xtask --target "$host_target" abi_staging::local_transport
    cargo test -p xtask --target "$host_target" abi_staging::mini_lifecycle
  '
  scripts/dev-shell.sh bash -c '
    cd host
    npx vitest run test/abi-staging-mini-vfs.test.ts
  '
  scripts/dev-shell.sh bash scripts/test-abi-staging-mini-lifecycle.sh
  ```

  Expected: FAIL because the miniature is missing.

- [ ] **Step 5: Implement fake transport and fixture planning**

  The fixture has two required Formulae in dependency order and one unrelated
  background Formula. It is inert TOML, not Ruby execution.

- [ ] **Step 6: Implement the miniature with the real VFS APIs**

  Use `MemoryFileSystem`, `saveImage`, restore, seals, and metadata validation.
  Do not replace a VFS with a directory or JSON marker. All bytes pass through
  declared input accessors.

- [ ] **Step 7: Implement deterministic retry timing without sleep**

  Retry numbers are `1`, `2`, and `3` after initial attempt `0`:

  ```text
  window_ms = min(cap_ms, base_ms * 2^(retry_number - 1))
  seed = SHA256(request_digest NUL exact_subject NUL retry_number)
  delay_ms = big_endian_u64(seed[0..8]) mod (window_ms + 1)
  ```

  Record the next eligible time and return. The miniature advances a fixture
  clock; it never sleeps.

- [ ] **Step 8: Run the complete miniature twice**

  ```bash
  scripts/dev-shell.sh bash scripts/test-abi-staging-mini-lifecycle.sh
  scripts/dev-shell.sh bash scripts/test-abi-staging-mini-lifecycle.sh
  ```

  Expected: both fresh runs pass and produce the same canonical identities.

- [ ] **Step 9: Run focused regressions**

  ```bash
  scripts/dev-shell.sh bash -c '
    host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
    cargo test -p xtask --target "$host_target" abi_staging
  '
  scripts/dev-shell.sh bash -c '
    cd host
    npx vitest run \
      test/abi-staging-mini-vfs.test.ts \
      test/lazy-vfs.test.ts \
      test/homebrew-vfs-formula-layer.test.ts \
      test/vfs-image.test.ts
  '
  ```

  Expected: PASS; existing lazy and serialization behavior is unchanged.

- [ ] **Step 10: Commit**

  ```bash
  git add tools/xtask/src/abi_staging/mod.rs \
    tools/xtask/src/abi_staging/local_transport.rs \
    tools/xtask/src/abi_staging/mini_lifecycle.rs \
    tools/xtask/tests/fixtures/abi-staging/mini-transition \
    images/vfs/scripts/build-abi-staging-mini-vfs.ts \
    host/test/abi-staging-mini-vfs.test.ts \
    scripts/test-abi-staging-mini-lifecycle.sh
  git commit -m "[ABI] Prove a local generic staging transition"
  ```

---

### Task 9: Route checks and document only what now works

**Why:** CI should run the new checks when relevant, and documentation must not
turn an inert foundation into a promise of hosted staging.

**Files:**

- Modify: `.github/actions/detect-change-scope/ci-scope-paths.sh`
- Modify: `.github/actions/detect-change-scope/test-ci-scope-paths.sh`
- Create: `scripts/test-abi-staging-product-authority.sh`
- Modify: `docs/abi-versioning.md`
- Modify: `docs/package-management.md`
- Modify: `docs/browser-support.md`
- Modify: `docs/repository-organization.md`
- Modify: `docs/future-improvements.md`
- Create: `docs/superpowers/specs/2026-08-08-abi-bottle-staging-design.md`

**Interfaces:**

- Consumes: every foundation checker and fixture.
- Produces one cheap foundation validation entry point, effect-based path
  routing, restored approved design, and truthful reference docs.

- [ ] **Step 1: Write failing path-routing cases**

  Cover product/consumer/guard/selection paths. Prove plan-only documentation
  does not schedule package builds and new paths do not enter an existing
  credentialed publisher through a special case.

- [ ] **Step 2: Write the validation script before docs**

  It must fail because docs do not yet state the foundation/deferred boundary.
  It rejects arguments and resolves every file from the repository root.

- [ ] **Step 3: Run checks and confirm red**

  ```bash
  scripts/dev-shell.sh bash \
    .github/actions/detect-change-scope/test-ci-scope-paths.sh
  scripts/dev-shell.sh bash scripts/test-abi-staging-product-authority.sh
  ```

  Expected: FAIL on routing and documentation assertions.

- [ ] **Step 4: Implement focused routing**

  Extend existing anchored patterns. Do not create another scope action or a
  broad `.github/` wildcard. Preserve frozen publisher exceptions.

- [ ] **Step 5: Update authoritative documentation**

  Restore the approved specification byte-for-byte from commit
  `6e1b7ff24e544463d6f9c5f6b7fb67a873e1337a`. Document product authority,
  consumer registries, legacy projections, the builder boundary, both lazy
  choices, and the exact local miniature claim. State that remote issuance,
  tap execution, publication, Check, promotion, history, and Pages integration
  are not operational.

  Add only the approved future-work entries for semantic ABI modeling,
  complete external-source custody, and man pages. Preserve newer unrelated
  future-improvement content.

- [ ] **Step 6: Run routing, foundation, and docs checks**

  ```bash
  scripts/dev-shell.sh bash \
    .github/actions/detect-change-scope/test-ci-scope-paths.sh
  scripts/dev-shell.sh bash scripts/test-abi-staging-product-authority.sh
  scripts/dev-shell.sh npm run docs:build
  ```

  Expected: PASS; docs explicitly say remote staging is not operational.

- [ ] **Step 7: Commit**

  ```bash
  git add .github/actions/detect-change-scope/ci-scope-paths.sh \
    .github/actions/detect-change-scope/test-ci-scope-paths.sh \
    scripts/test-abi-staging-product-authority.sh \
    docs/abi-versioning.md docs/package-management.md \
    docs/browser-support.md docs/repository-organization.md \
    docs/future-improvements.md \
    docs/superpowers/specs/2026-08-08-abi-bottle-staging-design.md
  git commit -m "[ABI] Document the inert staging foundation"
  ```

---

### Task 10: Run the final foundation audit and stop

**Why:** This task proves only the local foundation and confirms that no later
hosted capability slipped into the change.

This is a read-only completion gate, not an implementation task. It has no
red/green cycle and creates no commit; any failure sends work back to the task
that owns the affected behavior.

**Files:**

- Verify every file in this plan. Update the plan before adding another file.

**Interfaces:**

- Consumes: committed Tasks 1–9 and the unchanged baseline.
- Produces fresh local evidence and no code or remote state.

- [ ] **Step 1: Check worktree and commit scope**

  ```bash
  scripts/dev-shell.sh bash -c '
    git status --short --branch
    git diff --check origin/main...HEAD
    git diff --name-only origin/main...HEAD
  '
  ```

  Confirm unrelated submodule and `.serena/` state is absent from commits.

- [ ] **Step 2: Run the complete foundation suite**

  ```bash
  scripts/dev-shell.sh bash scripts/test-abi-staging-product-authority.sh
  scripts/dev-shell.sh bash -c '
    host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
    cargo test -p xtask --target "$host_target" abi_staging
  '
  scripts/dev-shell.sh npx tsx --test \
    scripts/vfs-product-catalog.test.mjs \
    scripts/check-pages-vfs-product-registry.test.mjs \
    scripts/run-vfs-product-builder.test.ts
  scripts/dev-shell.sh bash -c '
    cd host
    npx vitest run \
      test/vfs-product-builder-contract.test.ts \
      test/abi-staging-mini-vfs.test.ts \
      test/homebrew-vfs-materialization-policy.test.ts \
      test/optional-demo-vfs.test.ts \
      test/shell-lazy-archive-inputs.test.ts \
      test/lazy-vfs.test.ts \
      test/homebrew-vfs-formula-layer.test.ts \
      test/vfs-image.test.ts
  '
  scripts/dev-shell.sh bash scripts/ci-check-browser-assets.sh
  scripts/dev-shell.sh npm run docs:build
  ```

  Expected: PASS. This is not evidence for hosted GitHub/GHCR/Checks/Pages.

- [ ] **Step 3: Run ABI and workflow safety checks**

  ```bash
  scripts/dev-shell.sh bash scripts/check-abi-version.sh
  scripts/dev-shell.sh bash -c '
    ruby scripts/check-homebrew-publish-workflow-trust.rb
    ruby scripts/check-homebrew-experimental-vfs-workflow.rb
    ruby scripts/check-homebrew-closed-selection-workflow.rb
    actionlint
  '
  ```

  Expected: PASS; this plan changes neither ABI snapshot nor workflow authority.

- [ ] **Step 4: Audit genericity and ownership**

  Search new infrastructure for concrete acceptance ABI values and unfinished
  tokens. Manually verify all public type names, product-derived Formula roots,
  consumer-owned Pages placement, preserved lazy intent, and every negative
  test named in Tasks 2, 3, 6, 7, and 8.

- [ ] **Step 5: Review history and stop**

  ```bash
  scripts/dev-shell.sh bash -c '
    git log --format=fuller --stat origin/main..HEAD
    git diff --stat origin/main...HEAD
  '
  ```

  Do not add request workflows, tap writers, OCI publication, Checks,
  promotion, ABI-branch writes, Pages deployment, or legacy deletion.

## Exit criteria

- All 17 products have canonical TOML and generated JSON.
- Pages/tests select products without copying software roots.
- Formula roots come only from selected product manifests.
- Embedded and lazy intent survives selection, resolution, reporting, and the
  miniature candidate-to-canonical path.
- The builder boundary rejects missing, extra, mismatched, or incompletely
  captured software.
- Guard and record validators reject contradictions and unauthorized states.
- The miniature proves a generic successor transition, custody, anonymous
  readback, independent promotion, prior history, and last-complete Pages
  behavior locally.
- Hosted behavior remains unchanged.
- Every legacy entry remains nonremovable.
- Documentation preserves the three explicit future-work items.

After these checks, execute the separately reviewed Plan 2. Do not start Plan 2
implementation in the same change.
