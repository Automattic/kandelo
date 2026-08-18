# Pages Homebrew-Only Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps
> use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the complete ABI 43 bottle closure and deploy the
seven production Pages products without any Kandelo package output.

**Architecture:** A small tap-owned canonicalizer promotes immutable
candidate bottles with only Formula, ABI, digest, byte-count, and public
readback checks. Three new tap Formulae own Node, PHP, and MariaDB.
Kandelo then composes whole canonical bottle trees into each VFS, takes
the kernel from the prepared runtime, and removes package-root
preparation from Pages CI.

**Tech Stack:** Python 3, Ruby/Homebrew Formula DSL, TypeScript, Rust,
TOML, GitHub Actions, OCI/GHCR, Kandelo VFS, Playwright/Chromium

**Spec:**
`docs/superpowers/specs/2026-08-18-pages-homebrew-only-cutover-design.md`

## Global Constraints

- The production set is exactly `platform-rootfs`, `browser-main-shell`,
  `browser-node`, `browser-nginx`, `browser-nginx-php`, `browser-lamp`,
  and `browser-wordpress`.
- No product in that recursive graph may declare `software.package` or
  resolve a `package-output` input.
- Formula output is published only under
  `kandelo-dev/homebrew-tap-core` GHCR namespaces.
- Existing candidate bottle bodies are reused when their current
  Formula, architecture, and ABI identities match.
- Publisher-policy suites, product evidence, signature checks, and
  cross-Formula admission ordering do not block this cutover.
- OCI manifest and layer digests, layer byte counts, Formula identity,
  architecture, ABI, and anonymous readback remain mandatory.
- Core userland, Vim, NetHack, and the other current lazy shell Formulae
  remain lazy bottle trees.
- The Kandelo kernel is a protected runtime/toolchain input, never a
  Formula or `software.package` input.
- The assembled tree must pass the real Chromium Pages smoke before the
  exact same tree is deployed.

---

### Task 1: Publish Existing Candidate Bottles Directly

**Files (tap repository):**

- Create: `scripts/abi_staging/pages_canonical.py`
- Create: `scripts/abi_staging/tests/test_pages_canonical.py`
- Modify: `scripts/abi_staging/promotion.py`
- Modify: `scripts/abi_staging/cli.py`
- Modify: `scripts/abi_staging/tap_metadata.py`
- Create: `.github/workflows/pages-canonicalize.yml`
- Modify: `scripts/check_abi_staging_workflows.rb`
- Modify: `scripts/test_check_abi_staging_workflows.rb`

**Interfaces:**

- Consumes: a public candidate OCI manifest and current tap checkout.
- Produces:
  `select_pages_canonical_candidate(candidate, tap_root,
  target_abi)` and
  `publish-pages-canonical --candidate-reference REF --formula NAME
  --target-abi 43 --out PATH`.
- Produces an exact Formula metadata projection after the canonical
  object is anonymously readable.
- The OCI output and Formula metadata use the existing canonical-bottle
  shapes so current VFS consumers remain compatible.

- [ ] **Step 1: Write failing candidate-selection tests**

Add tests that construct public candidate records for `nginx`, `login`,
and `sudo`, then assert exact matching and complete rejection cases:

```python
selected = select_pages_canonical_candidate(
    candidate,
    tap_root=TAP_ROOT,
    target_abi=43,
)
self.assertEqual(selected.formula, "nginx")
self.assertEqual(selected.architecture, "wasm32")
self.assertEqual(selected.bottle_sha256, BOTTLE_SHA256)
self.assertEqual(selected.bottle_bytes, len(BOTTLE_BYTES))
```

Mutate the Formula name, Formula source digest, architecture, ABI,
bottle digest, and bottle byte count one at a time. Each mutation must
raise `PagesCanonicalError`. An empty verification/admission inventory
must not change a valid selection. Assert that the metadata projection
changes the Formula bottle stanza, Formula sidecar, link manifest, and
top-level index to the exact canonical digest and byte count, and
rejects a stale tap-main compare-and-swap base.

- [ ] **Step 2: Run the tests to verify RED**

Run:

```bash
python3 -m unittest \
  scripts.abi_staging.tests.test_pages_canonical -v
```

Expected: FAIL because `pages_canonical` does not exist.

- [ ] **Step 3: Implement the minimal selector and canonical plan**

Define the selection as immutable data:

```python
@dataclass(frozen=True)
class PagesCanonicalSelectionV1:
    formula: str
    architecture: str
    target_abi: int
    candidate_record_sha256: str
    bottle_sha256: str
    bottle_bytes: int
```

Validate the candidate with the existing candidate-record parser.
Compare its normalized Formula source identity to a fresh current-tap
Formula capture. Reuse the existing canonical bottle metadata, bottle
layer, bottle-metadata layer, VFS composition descriptor rewriting, OCI
upload, anonymous readback, and deterministic tap-metadata projection
functions.
Do not call receipt, admission, history, product-evidence, signature, or
publisher-policy validators.

- [ ] **Step 4: Add the protected writer workflow**

The workflow accepts a bounded JSON array of Formula names. Its
read-only job discovers exactly one current candidate per Formula. Its
package writer has only `packages: write`, publishes the canonical
object,
performs anonymous readback, and uploads the exact publication result.
Candidate bytes never execute in the writer. A later metadata writer has
only `contents: write`; it independently reads back the canonical object
and applies the deterministic Formula, sidecar, link-manifest, and top
index projection with compare-and-swap against its checked-out tap main.
It does not require or create an admission record.

The invocation must be structurally equivalent to:

```yaml
- name: Publish exact canonical bottle
  env:
    HOMEBREW_GITHUB_PACKAGES_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    HOMEBREW_GITHUB_PACKAGES_USER: ${{ github.actor }}
  run: |
    python3 -m scripts.abi_staging.cli publish-pages-canonical \
      --candidate-reference "$CANDIDATE_REFERENCE" \
      --formula "$FORMULA" \
      --target-abi 43 \
      --anonymous-readback \
      --out "$RUNNER_TEMP/canonical.json"
```

The workflow checker must reject extra write permissions, candidate code
execution, omitted anonymous readback, non-ABI-43 input, and unbounded
Formula input. It must also reject combined package/content write
authority, metadata updates before anonymous readback, incomplete
Formula metadata projection, and any admission or signature
prerequisite.

- [ ] **Step 5: Run focused tap validation**

Run:

```bash
python3 -m unittest \
  scripts.abi_staging.tests.test_pages_canonical -v
ruby scripts/test_check_abi_staging_workflows.rb
ruby scripts/check_abi_staging_workflows.rb
```

Expected: PASS.

- [ ] **Step 6: Commit the direct canonicalizer**

```bash
git add scripts/abi_staging/pages_canonical.py \
  scripts/abi_staging/tests/test_pages_canonical.py \
  scripts/abi_staging/promotion.py scripts/abi_staging/cli.py \
  scripts/abi_staging/tap_metadata.py \
  .github/workflows/pages-canonicalize.yml \
  scripts/check_abi_staging_workflows.rb \
  scripts/test_check_abi_staging_workflows.rb
git commit -m "Homebrew: Canonicalize exact candidate bottles directly"
```

- [ ] **Step 7: Publish the fifteen existing candidates**

Dispatch exactly:

```json
[
  "dinit", "homebrew-bootstrap", "libpng", "libxml2", "login",
  "msmtpd", "nginx", "patch", "pax", "python", "redis", "sqlite",
  "sudo", "sudo-lite", "what"
]
```

After completion, anonymously fetch every canonical manifest and assert
its bottle-layer digest equals the selected candidate. Assert that each
current Formula bottle stanza and generated tap metadata names the same
digest and byte count. Rebuild only a Formula rejected because its
current Formula source differs.

---

### Task 2: Add Tap-Owned Node, PHP, and MariaDB Formulae

**Files (tap repository):**

- Create: `Formula/node.rb`
- Create: `Formula/php.rb`
- Create: `Formula/mariadb.rb`
- Create: `scripts/test_pages_service_formulae.py`
- Modify: `Kandelo/staging/formula-build-inputs.toml`
- Regenerate: `Kandelo/staging/generated/formula-build-inputs.json`

**Interfaces:**

- Consumes: exact Kandelo checkout build helpers and canonical
  dependency bottle prefixes supplied by the Formula environment.
- Produces three ordinary wasm32 Kandelo bottle kegs with executable,
  runtime-data, and service-data paths represented in composition
  descriptors.

- [ ] **Step 1: Write failing Formula contract tests**

Assert that all three Formulae exist, use `KandeloFormulaSupport`,
declare wasm32, and never reference an Automattic package release or
package output:

```python
for name in ("node", "php", "mariadb"):
    source = (ROOT / f"Formula/{name}.rb").read_text()
    self.assertIn("include KandeloFormulaSupport", source)
    self.assertIn('kandelo_require_arch!("wasm32")', source)
    self.assertNotIn("binaries-abi-v", source)
    self.assertNotIn("WASM_POSIX_BINARY_CACHE_ROOT", source)
```

Also assert the declared dependency sets:

```python
self.assert_formula_dependencies("php", {
    "icu", "libcurl", "libcxx", "libiconv", "libxml2", "libzip",
    "openssl", "sqlite", "zlib",
})
self.assert_formula_dependencies("mariadb", {"libcxx", "pcre2"})
```

- [ ] **Step 2: Run the tests to verify RED**

```bash
python3 scripts/test_pages_service_formulae.py
```

Expected: FAIL because the Formula files do not exist.

- [ ] **Step 3: Implement `node.rb`**

Use the exact SpiderMonkey/Node build helper from the Kandelo checkout,
but stage only bytes built during this Formula invocation. The Formula
installs `bin/node`, validates it as wasm32, and runs:

```ruby
output = kandelo_run_wasm(bin/"node", ["-e", "print('node-ok')"])
assert_equal "node-ok", output.strip
```

The helper receives the downloaded source and Formula dependency
prefixes through explicit `WASM_POSIX_DEP_*` environment values. It
cannot resolve or copy a Kandelo package-generation artifact.

- [ ] **Step 4: Implement `php.rb`**

Invoke `packages/registry/php/build-php.sh` as a reviewed build helper
with explicit dependency prefixes. Install these outputs in the keg:

```text
bin/php
sbin/php-fpm
lib/php/extensions/opcache.so
lib/php/extensions/curl.so
lib/php/extensions/phar.so
lib/php/extensions/zip.so
lib/php/extensions/intl.so
share/php/icu.dat
```

Validate the CLI, FPM, and side modules with the shared Wasm validator.
The Formula test must run `php -r 'echo "php-ok\n";'` and assert the FPM
and opcache files exist.

- [ ] **Step 5: Implement `mariadb.rb`**

Invoke `packages/registry/mariadb/build-mariadb.sh` with explicit
`pcre2` and `libcxx` prefixes. Install:

```text
bin/mariadbd
bin/mysqltest
share/mariadb/system-tables/
share/mariadb/test-suite/
```

The Formula test validates both programs and performs one bounded
initialization using the installed system tables. No server process may
survive the test.

- [ ] **Step 6: Register and regenerate Formula input policy**

Add sorted entries binding each Formula and the precise Kandelo helper
paths it executes. Generate and check the catalog:

```bash
python3 -m scripts.abi_staging.cli policy-generate \
  --output Kandelo/staging/generated/formula-build-inputs.json
python3 -m scripts.abi_staging.cli policy-check
```

- [ ] **Step 7: Run focused Formula validation**

```bash
python3 scripts/test_pages_service_formulae.py
python3 -m scripts.abi_staging.tests.test_policy -v
ruby scripts/check_abi_staging_workflows.rb
```

Expected: PASS.

- [ ] **Step 8: Commit and build the new Formulae**

```bash
git add Formula/node.rb Formula/php.rb Formula/mariadb.rb \
  scripts/test_pages_service_formulae.py \
  Kandelo/staging/formula-build-inputs.toml \
  Kandelo/staging/generated/formula-build-inputs.json
git commit -m "Homebrew: Own Pages service runtimes in the tap"
```

Dispatch Node, PHP, and MariaDB candidate builds. Run their normal
Formula tests, then use Task 1's canonicalizer. Confirm all three
manifests are public before editing Kandelo product manifests.

---

### Task 3: Give Product Builders a Shared Bottle-Tree Adapter

**Files (Kandelo repository):**

- Create: `images/vfs/scripts/homebrew-product-inputs.ts`
- Create: `host/test/homebrew-product-inputs.test.ts`
- Modify: `images/vfs/scripts/staged-product-inputs.ts`

**Interfaces:**

- Consumes: `homebrew-bottle` handles and their exact composition
  descriptors.
- Produces:
  `applyHomebrewProductInputs(fs, build, directFormulae)` returning a map
  from Formula name to materialized keg/link identity.

- [ ] **Step 1: Write failing adapter tests**

Create miniature bottle tarballs and descriptors. Assert:

```typescript
const installed = await applyHomebrewProductInputs(
  fs,
  build,
  new Set(["nginx", "dinit"]),
);
assert.equal(installed.get("nginx")?.bin("nginx"),
  "/opt/kandelo/homebrew/bin/nginx");
assert.equal(installed.get("dinit")?.sbin("dinit"),
  "/opt/kandelo/homebrew/sbin/dinit");
```

Reject an undeclared Formula, duplicate Formula, wrong ABI namespace,
conflicting link, mismatched digest/bytes, candidate reference in
canonical
mode, or a missing executable.

- [ ] **Step 2: Run the test to verify RED**

```bash
scripts/dev-shell.sh bash -lc \
  'cd host && npx --no-install vitest run test/homebrew-product-inputs.test.ts'
```

Expected: FAIL because the adapter module does not exist.

- [ ] **Step 3: Implement the adapter**

Reuse `parseHomebrewOriginalBottleTreeDescriptor`,
`registerHomebrewDeferredTreeCollection`, and
`materializeRegisteredDeferredTree`. Do not invent a second keg/link
format. Embedded inputs materialize immediately; lazy inputs register
only
their exact descriptor and URL. Return guest paths derived from the
descriptor's link inventory, never from package metadata.

- [ ] **Step 4: Integrate the adapter without changing products yet**

Replace main-shell's local descriptor loop with the shared adapter while
preserving current behavior. Keep package-backed bootstrap handling
until
Task 5 changes its manifest.

- [ ] **Step 5: Run focused adapter and main-shell tests**

```bash
scripts/dev-shell.sh bash -lc \
  'cd host && npx --no-install vitest run \
  test/homebrew-product-inputs.test.ts \
  test/abi-staging-product-builders.test.ts'
```

Expected: PASS.

- [ ] **Step 6: Commit the shared adapter**

```bash
git add images/vfs/scripts/homebrew-product-inputs.ts \
  images/vfs/scripts/staged-product-inputs.ts \
  host/test/homebrew-product-inputs.test.ts
git commit -m "Homebrew: Compose canonical bottle trees into products"
```

---

### Task 4: Move the Kernel to the Prepared Runtime Contract

**Files (Kandelo repository):**

- Modify: `scripts/abi-staging-prepare-runtime.sh`
- Modify: `scripts/test-abi-staging-prepare-runtime.sh`
- Modify: `scripts/abi-staging-product-input-sources.ts`
- Modify: `scripts/abi-staging-product-input-sources.test.ts`
- Modify: `scripts/abi-staging-collect-product-inputs.ts`
- Modify: `scripts/abi-staging-collect-product-inputs.test.ts`
- Modify: `scripts/vfs-product-catalog.mjs`
- Modify: `scripts/vfs-product-catalog.test.mjs`
- Modify: `tools/xtask/src/abi_staging/product_manifest.rs`

**Interfaces:**

- Consumes: exact `runtime/kernel.wasm` already bound by
  `runtime-bundle.json`.
- Produces: toolchain component
  `runtime/toolchain/kernel-wasm/kernel.wasm` and manifest declaration
  `toolchain-kernel-wasm`.

- [ ] **Step 1: Write failing runtime/toolchain tests**

Add the manifest fixture:

```toml
[[software.toolchain]]
id = "kernel-wasm"
provider = "prepared-runtime"
component = "kernel-wasm"
role = "build"
```

Assert the collector returns one `toolchain-output` whose archived
`kernel.wasm` digest equals `runtime.kernel.wasm_sha256`. Mutating
either copy must fail. Assert that `prepared-runtime` accepts only
bounded components from the attested runtime root, while existing
`repository-dev-shell` SDK components retain their current behavior.

- [ ] **Step 2: Run focused tests to verify RED**

```bash
scripts/dev-shell.sh npx tsx --test \
  scripts/abi-staging-product-input-sources.test.ts \
  scripts/abi-staging-collect-product-inputs.test.ts
scripts/dev-shell.sh node --test scripts/vfs-product-catalog.test.mjs
scripts/dev-shell.sh bash scripts/test-abi-staging-prepare-runtime.sh
```

Expected: at least one new assertion FAILS because the component is
absent.

- [ ] **Step 3: Stage the exact kernel component**

After the runtime kernel is finalized, create the bounded component
with:

```bash
install -d -m 0700 "$OUT/runtime/toolchain/kernel-wasm"
install -m 0600 "$OUT/runtime/kernel.wasm" \
  "$OUT/runtime/toolchain/kernel-wasm/kernel.wasm"
```

The preparer must compare both SHA-256 values and sizes before emitting
the runtime bundle. Add `prepared-runtime` to the Rust and TypeScript
manifest contracts and require that provider to resolve only component
paths below the exact runtime root. Do not relabel the kernel as
`repository-dev-shell`; that provider remains reserved for SDK
components owned by the repository dev shell.

- [ ] **Step 4: Run focused tests and commit**

```bash
scripts/dev-shell.sh npx tsx --test \
  scripts/abi-staging-product-input-sources.test.ts \
  scripts/abi-staging-collect-product-inputs.test.ts
scripts/dev-shell.sh node --test scripts/vfs-product-catalog.test.mjs
scripts/dev-shell.sh bash scripts/test-abi-staging-prepare-runtime.sh
```

Expected: PASS.

```bash
git add scripts/abi-staging-prepare-runtime.sh \
  scripts/test-abi-staging-prepare-runtime.sh \
  scripts/abi-staging-product-input-sources.ts \
  scripts/abi-staging-product-input-sources.test.ts \
  scripts/abi-staging-collect-product-inputs.ts \
  scripts/abi-staging-collect-product-inputs.test.ts \
  scripts/vfs-product-catalog.mjs \
  scripts/vfs-product-catalog.test.mjs \
  tools/xtask/src/abi_staging/product_manifest.rs
git commit -m "Packages: Source product kernels from the exact runtime"
```

---

### Task 5: Convert the Seven Manifests and Builders

**Files (Kandelo repository):**

- Modify: `images/vfs/products/platform-rootfs.toml`
- Modify: `images/vfs/products/browser-main-shell.toml`
- Modify: `images/vfs/products/browser-node.toml`
- Modify: `images/vfs/products/browser-nginx.toml`
- Modify: `images/vfs/products/browser-nginx-php.toml`
- Modify: `images/vfs/products/browser-lamp.toml`
- Modify: `images/vfs/products/browser-wordpress.toml`
- Modify: `images/vfs/scripts/staged-product-inputs.ts`
- Modify: `host/test/abi-staging-product-builders.test.ts`
- Modify: `tools/xtask/src/abi_staging/product_manifest.rs`
- Regenerate: `images/vfs/products/generated/catalog.json`

**Interfaces:**

- Consumes: Task 3's bottle-tree adapter and Task 4's kernel component.
- Produces seven manifests with no package claims and builders that
  consume
  only product images, Homebrew bottles, archives, repository paths, and
  the kernel toolchain component.

- [ ] **Step 1: Write the seven-product invariant test**

Add a test that recursively resolves the seven product manifests and
asserts:

```rust
assert!(manifest.software.package.is_empty(), "{id}");
assert!(resolved_input_kinds.iter().all(|kind| kind != "package-output"));
```

Assert exact Homebrew roots and materialization for each product. The
base userland roots stay lazy; Bash and Homebrew bootstrap are embedded;
the main-shell demo set stays lazy; all service Formulae are embedded.

- [ ] **Step 2: Run manifest tests to verify RED**

```bash
scripts/dev-shell.sh bash -lc '
  host_target=$(rustc -vV | sed -n "s/^host: //p")
  cargo test -p xtask --target "$host_target" \
    abi_staging::product_manifest -- --nocapture
'
```

Expected: FAIL and report all seven package-owning products.

- [ ] **Step 3: Replace package claims with Homebrew claims**

Use these exact direct root sets:

```text
platform-rootfs lazy:
  dash bash ncurses coreutils gawk grep sed bc file-formula m4 make
  findutils diffutils posix-utils-lite

browser-main-shell embedded:
  homebrew-bootstrap

browser-main-shell lazy:
  fbdoom modeset less tar curl netcat wget git gzip bzip2 xz zstd zip
  unzip lsof nano vim nethack login sudo-lite sudo ruby

browser-node embedded: node
browser-nginx embedded: nginx dinit
browser-nginx-php embedded: nginx php dinit
browser-lamp embedded: nginx php mariadb dinit msmtpd
browser-wordpress embedded: nginx php dinit msmtpd
```

Add the build-only kernel toolchain declaration to the
PHP/WordPress/LAMP
products that require it. Remove the second PHP build package claim;
the embedded PHP keg supplies both runtime and CLI paths.

- [ ] **Step 4: Convert platform and main-shell builders**

Build the repository rootfs first, reopen it as a
`MemoryFileSystem`, and
apply the base bottle trees. Register lazy trees without fetching their
bodies. Materialize only embedded claims. For Homebrew bootstrap, read
`libexec/homebrew-bootstrap.zip` and
`libexec/homebrew-brew.env` from the
materialized keg and feed those exact bytes to the existing bootstrap
consumer-state functions.

- [ ] **Step 5: Convert service builders**

Open the embedded main-shell product, apply each service bottle keg, and
use descriptor-derived guest paths. Service definitions must execute:

```text
/opt/kandelo/homebrew/sbin/dinit
/opt/kandelo/homebrew/bin/nginx
/opt/kandelo/homebrew/sbin/php-fpm
/opt/kandelo/homebrew/bin/mariadbd
/opt/kandelo/homebrew/bin/msmtpd
```

Read MariaDB system tables and PHP extension/runtime data from their
installed kegs. Read `kernel.wasm` only from `toolchain-kernel-wasm`.

- [ ] **Step 6: Run builder tests and regenerate the catalog**

```bash
scripts/dev-shell.sh bash -lc \
  'cd host && npx --no-install vitest run \
  test/homebrew-product-inputs.test.ts \
  test/abi-staging-product-builders.test.ts'
scripts/dev-shell.sh bash -lc '
  host_target=$(rustc -vV | sed -n "s/^host: //p")
  cargo run -p xtask --target "$host_target" --quiet -- \
    vfs-products generate
  cargo run -p xtask --target "$host_target" --quiet -- \
    vfs-products check
'
```

Expected: PASS.

- [ ] **Step 7: Commit the product cutover**

```bash
git add images/vfs/products images/vfs/scripts/staged-product-inputs.ts \
  host/test/abi-staging-product-builders.test.ts \
  tools/xtask/src/abi_staging/product_manifest.rs
git commit -m "Homebrew: Build Pages products only from bottles"
```

---

### Task 6: Remove Admission and Package Roots from the Pages Producer

**Files (Kandelo repository):**

- Modify: `scripts/abi-staging-pages-producer.ts`
- Modify: `scripts/abi-staging-pages-producer.test.ts`
- Modify: `scripts/abi-staging-pages-readiness.ts`
- Modify: `scripts/abi-staging-pages-readiness.test.ts`
- Modify: `scripts/abi-staging-pages-producer-fixture.ts`
- Create: `scripts/abi-staging-pages-bottle-closure.ts`
- Create: `scripts/abi-staging-pages-bottle-closure.test.ts`

**Interfaces:**

- Consumes: current tap Formula bottle stanzas and public canonical OCI
  repositories.
- Produces: one complete missing-Formula report and direct canonical
  bottle
  inputs. No admission record is required.

- [ ] **Step 1: Write failing direct-resolution tests**

Construct a Formula with a wasm32 bottle SHA and a canonical OCI
manifest
whose bottle layer matches it:

```typescript
const resolved = await resolveCanonicalPagesBottle({
  abi: 43,
  formula: "nginx",
  tapRoot,
  transport,
});
assert.equal(resolved.bottle.sha256, nginxSha256);
assert.equal(resolved.formula, "nginx");
```

Assert that no admission repository is requested. Reject multiple
matching canonical manifests, a missing Formula stanza, digest/byte
mismatch, wrong
ABI, candidate namespace, and unauthenticated failure.

- [ ] **Step 2: Run producer tests to verify RED**

```bash
scripts/dev-shell.sh npx tsx --test \
  scripts/abi-staging-pages-bottle-closure.test.ts \
  scripts/abi-staging-pages-producer.test.ts \
  scripts/abi-staging-pages-readiness.test.ts
```

Expected: FAIL because direct canonical resolution is absent.

- [ ] **Step 3: Implement one cheap closure resolver**

Load the seven real manifests, recursively collect Homebrew Formula
names, and check each current Formula bottle stanza plus canonical OCI
manifest.
Return:

```typescript
interface PagesBottleClosureV1 {
  schema: 1;
  abi: number;
  formulae: Array<{
    name: string;
    bottle_sha256: string;
    bottle_bytes: number;
    canonical_reference: string;
    descriptor_reference: string;
  }>;
  missing: string[];
  conflicts: string[];
}
```

The preflight fetches manifests/configs only. Bottle and descriptor
bodies are fetched later, once, by the producer. Report every
missing/conflicting
Formula in one failure.

- [ ] **Step 4: Remove admission and package-root inputs**

Delete admission discovery from the production path. Remove
`current_inputs.package_roots` from the handoff schema. Reject any
supplied
`package-output` input. Keep source archives, repository bundles,
product-image inputs, toolchain inputs, and direct Homebrew bottle
inputs.

- [ ] **Step 5: Run producer/readiness tests and commit**

```bash
scripts/dev-shell.sh npx tsx --test \
  scripts/abi-staging-pages-bottle-closure.test.ts \
  scripts/abi-staging-pages-producer.test.ts \
  scripts/abi-staging-pages-readiness.test.ts
```

Expected: PASS.

```bash
git add scripts/abi-staging-pages-bottle-closure.ts \
  scripts/abi-staging-pages-bottle-closure.test.ts \
  scripts/abi-staging-pages-producer.ts \
  scripts/abi-staging-pages-producer.test.ts \
  scripts/abi-staging-pages-readiness.ts \
  scripts/abi-staging-pages-readiness.test.ts \
  scripts/abi-staging-pages-producer-fixture.ts
git commit -m "Pages: Resolve canonical bottles without admissions"
```

---

### Task 7: Remove Legacy Package Preparation from Pages CI

**Files (Kandelo repository):**

- Modify: `.github/workflows/abi-staging-pages-canary.yml`
- Modify: `scripts/ci-check-pages-deployment.sh`
- Modify: `scripts/test-pages-deployment-contract.sh`
- Modify: `scripts/test-abi-staging-pages-atomic.sh`
- Modify: `abi/staging/request-policy.toml`
- Regenerate: `abi/staging/request-policy.generated.json`
- Regenerate if changed: `abi/staging/evidence-definitions.generated.json`

**Interfaces:**

- Consumes: Task 6's closure JSON before runtime preparation.
- Produces: a workflow handoff containing no package list, package root,
  package cache, or `fetch-binaries.sh` product input.

- [ ] **Step 1: Write failing workflow mutations**

The checker must reject a workflow that contains any of:

```text
software.package
package-list.txt
package-roots.json
all-package-roots.json
fetch-binaries.sh
```

It must reject product-input package-cache materialization rather than a
same-named cache variable used by unrelated runtime compilation. The
production producer handoff must contain no package root or
package-output
authority.

It must also reject runtime preparation before the closure preflight and
a preflight that does not report the complete missing set.

- [ ] **Step 2: Run the deployment contract to verify RED**

```bash
scripts/dev-shell.sh bash scripts/test-pages-deployment-contract.sh
```

Expected: FAIL because the live workflow still prepares package roots.

- [ ] **Step 3: Replace package preparation with closure preflight**

Run the closure CLI immediately after tap checkout and before
`abi-staging-prepare-runtime.sh`. Preserve archive downloads required by
WordPress/npm and the protected runtime preparation. Build the producer
handoff without `package_roots`.

- [ ] **Step 4: Regenerate request identity and run workflow checks**

```bash
scripts/dev-shell.sh bash -lc '
  host_target=$(rustc -vV | sed -n "s/^host: //p")
  cargo run -p xtask --target "$host_target" --quiet -- \
    abi-staging request-policy generate \
    --source abi/staging/request-policy.toml \
    --generated abi/staging/request-policy.generated.json
  cargo run -p xtask --target "$host_target" --quiet -- \
    abi-staging request-policy check \
    --source abi/staging/request-policy.toml \
    --generated abi/staging/request-policy.generated.json
'
scripts/dev-shell.sh bash scripts/test-pages-deployment-contract.sh
scripts/dev-shell.sh bash scripts/ci-check-pages-deployment.sh
```

Expected: PASS.

- [ ] **Step 5: Commit the workflow cutover**

```bash
git add .github/workflows/abi-staging-pages-canary.yml \
  scripts/ci-check-pages-deployment.sh \
  scripts/test-pages-deployment-contract.sh \
  scripts/test-abi-staging-pages-atomic.sh \
  abi/staging/request-policy.toml \
  abi/staging/request-policy.generated.json \
  abi/staging/evidence-definitions.generated.json
git commit -m "Pages: Stop rebuilding legacy package inputs"
```

---

### Task 8: Prove and Deploy the Exact Seven-Product Tree

**Files (Kandelo repository):**

- Modify only if a truthful failure requires it:
  `apps/browser-demos/test/abi-staging-pages-assembled.spec.ts`
- Modify: `docs/package-management.md`
- Modify: `docs/binary-releases.md`

**Interfaces:**

- Consumes: public canonical ABI 43 bottles, exact runtime, source
  archives, and the seven current manifests.
- Produces: one producer-returned tree whose manifest and VFS files are
  exactly the files uploaded to Pages.

- [ ] **Step 1: Run the local atomic production graph**

```bash
scripts/dev-shell.sh bash scripts/test-abi-staging-pages-atomic.sh
```

Expected: PASS, including seven-product production, two eager and five
lazy VFS placements, service startup, and hostile VFS mutations.

- [ ] **Step 2: Run focused regression gates**

```bash
scripts/dev-shell.sh npx tsx --test \
  scripts/abi-staging-pages-bottle-closure.test.ts \
  scripts/abi-staging-pages-producer.test.ts \
  scripts/abi-staging-pages-readiness.test.ts
scripts/dev-shell.sh bash -lc \
  'cd host && npx --no-install vitest run \
  test/homebrew-product-inputs.test.ts \
  test/abi-staging-product-builders.test.ts'
scripts/dev-shell.sh bash scripts/test-pages-deployment-contract.sh
scripts/dev-shell.sh bash scripts/ci-check-pages-deployment.sh
git diff --check
```

Expected: PASS.

- [ ] **Step 3: Update authoritative package documentation**

Document that the seven production Pages products consume only
canonical tap bottles, that non-Pages products remain a separate
migration, and that Kandelo GitHub Releases are platform/toolchain
distribution rather than a Formula-output channel.

- [ ] **Step 4: Commit final documentation**

```bash
git add docs/package-management.md docs/binary-releases.md \
  apps/browser-demos/test/abi-staging-pages-assembled.spec.ts
git commit -m "Docs: Describe the Homebrew-only Pages graph"
```

- [ ] **Step 5: Open and land the Kandelo PR**

Push the branch, open a purpose-led PR with `## Why` first, wait for
required CI, and rebase-merge. Do not squash contributor commits.

- [ ] **Step 6: Dispatch and observe production Pages**

Dispatch `abi-staging-pages-canary.yml` from the exact merged main SHA.
Require the closure preflight, producer, assembled Chromium smoke, and
artifact upload to succeed. Deploy the exact produced tree and verify
the
public deployment manifest plus all seven VFS identities.

- [ ] **Step 7: Record deferred non-Pages work**

List every remaining non-Pages manifest containing `software.package`.
Do not reintroduce any of those package roots into the Pages workflow.
