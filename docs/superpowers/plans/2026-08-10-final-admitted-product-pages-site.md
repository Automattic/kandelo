# Final Admitted-Product Pages Site Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the inert Pages canary build and exercise the seven exact admitted VFS products that its readiness and deployment manifests claim.

**Architecture:** Keep one bounded producer invocation with two internal phases. Phase A authenticates current tap metadata, recomposes each product, and runs its existing evidence once. Phase B builds the browser/docs/API site from a sealed exact product map, inventories the assembled tree, and emits the ready or hold result atomically.

**Tech Stack:** TypeScript/Node.js, Rust xtask, Python tap authority, Vite, Playwright/Chromium, GitHub Actions, canonical JSON, OCI/ORAS.

## Global Constraints

- Work only in Automattic/kandelo and kandelo-dev/homebrew-tap-core.
- Do not activate promotion or production Pages.
- Do not delete or purge artifacts and do not remove legacy infrastructure.
- Cleanup remains observe-only and has no package-write authority.
- Candidate VFS bytes are never fetched or relabeled.
- Product composition and Node/browser evidence run exactly once per producer invocation.
- Current tap main must retain the exact admitted Formula, sidecar, top-index, and link-manifest projection.
- The final source tree contains exactly seven VFS files at manifest-owned product paths and no legacy, candidate, prior-ABI, or Vite-asset VFS copy.
- `platform-rootfs` and `browser-main-shell` are eager; the remaining five Pages products are lazy.
- A hold directory contains exactly `readiness.json` and is never uploaded with `upload-pages-artifact`.
- Browser completion requires a real Chromium run against the exact assembled `source-tree`.
- All build and verification commands run through `scripts/dev-shell.sh`.
- Preserve unrelated dirty submodules, `.serena/`, and browser test results.

---

### Task 1: Bind admissions to current tap main and exact registries

**Files:**

- Modify: `../homebrew-tap-abi-staging-reconcile-1q1w6/scripts/abi_staging/cli.py`
- Modify: `../homebrew-tap-abi-staging-reconcile-1q1w6/scripts/abi_staging/tap_metadata.py`
- Modify: `../homebrew-tap-abi-staging-reconcile-1q1w6/scripts/abi_staging/tests/test_cli.py`
- Modify: `../homebrew-tap-abi-staging-reconcile-1q1w6/scripts/abi_staging/tests/test_tap_metadata.py`
- Modify: `.github/workflows/abi-staging-pages-canary.yml`
- Modify: `scripts/abi-staging-pages-producer.ts`
- Modify: `scripts/abi-staging-pages-producer.test.ts`
- Modify: `scripts/abi-staging-pages-producer-fixture.ts`
- Modify: `scripts/check-pages-vfs-product-registry.mjs`
- Modify: `scripts/check-pages-vfs-product-registry.test.mjs`
- Modify: `tools/xtask/src/abi_staging/pages_readiness.rs`

**Interfaces:**

- Produce tap CLI command `validate-admission-projection --tap-root ROOT --record RECORD --out OUT`.
- Produce canonical `AdmissionProjectionObservationV1`:

```ts
interface AdmissionProjectionObservationV1 {
  schema: 1;
  kind: "kandelo-pages-admission-projection";
  admission_record_sha256: string;
  formula: string;
  architecture: string;
  target_abi: number;
  formula_metadata_update_sha256: string;
  projection_sha256: string;
  tap_source: { repository: string; commit: string; tree: string };
}
```

- Extend the production handoff with exact `tap_root` and `tap_source` fields.
- Extend each selected admission identity with its projection observation and bind it into readiness/site-manifest product records.
- Export `readPagesRegistry(path)` from `scripts/check-pages-vfs-product-registry.mjs` for source/generated parity.

- [ ] **Step 1: Write tap projection RED tests**

Build one real four-path Formula projection and admission record. Require success only when the output has the exact tap source, record digest, update digest, and digest of `validate_formula_admission_projection`. Mutate Formula, sidecar, top-index row, and link manifest separately. Also reject a non-ancestor metadata source, dirty checkout, and wrong remote repository.

- [ ] **Step 2: Run tap tests and verify RED**

```bash
scripts/dev-shell.sh env PYTHONPATH="$KANDELO_TAP_ROOT" \
  python3 -m unittest scripts.abi_staging.tests.test_cli \
  scripts.abi_staging.tests.test_tap_metadata -v
```

Expected: FAIL because the command and observation do not exist.

- [ ] **Step 3: Implement the protected tap command**

Require `--tap-root` to equal the protected checkout, require a clean checkout and policy-owned remote, load the canonical admission, prove `formula_metadata_source.commit` is an ancestor of `HEAD` with `git merge-base --is-ancestor`, call `validate_formula_admission_projection`, and atomically write the exact observation. No caller supplies repository, commit, tree, Formula, or update.

- [ ] **Step 4: Write Kandelo admission/registry RED tests**

Reject a missing current-main projection, non-ancestor admission, conflicting current projections, source-only Pages/test registry mutation, and generated-only mutation. Require a ready result to bind exact tap source and projection digest.

- [ ] **Step 5: Run Kandelo tests and verify RED**

```bash
scripts/dev-shell.sh npx tsx --test scripts/abi-staging-pages-producer.test.ts \
  scripts/check-pages-vfs-product-registry.test.mjs
```

Expected: FAIL because current tap projection and source/generated parity are absent.

- [ ] **Step 6: Implement handoff and producer validation**

The canary anonymously clones public tap main with full history into a fresh `$RUNNER_TEMP` directory with credential helpers and prompts disabled. The producer invokes the protected tap command once per selected admission and exact-validates its output. Compare source and generated Pages registries through the exported parser, and use the existing protected Rust registry projection for the test registry rather than adding a second TOML authority.

Before writing the handoff, the workflow and the production producer both run
the equivalent of this protected freshness check against the exact source
root:

```bash
cargo run -p xtask --target "$host_target" --quiet -- \
  abi-staging registries check \
  --catalog images/vfs/products/generated/catalog.json \
  --pages apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.toml \
  --pages-generated apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.generated.json \
  --tests tests/vfs-products.toml \
  --tests-generated tests/vfs-products.generated.json
```

- [ ] **Step 7: Update Rust readiness validation**

Require every ready admission to carry one projection observation matching the top-level tap source. Reject duplicate Formula/architecture, wrong record digest, wrong ABI, or malformed projection digest. Holds carry no admission projections.

- [ ] **Step 8: Run Task 1 tests GREEN**

```bash
scripts/dev-shell.sh npx tsx --test scripts/abi-staging-pages-producer.test.ts \
  scripts/check-pages-vfs-product-registry.test.mjs
scripts/dev-shell.sh bash -c 'host_target=$(rustc -vV | awk "/^host/ {print \$2}"); cargo test -p xtask --target "$host_target" abi_staging::pages_readiness'
scripts/dev-shell.sh env PYTHONPATH="$KANDELO_TAP_ROOT" \
  python3 -m unittest scripts.abi_staging.tests.test_cli \
  scripts.abi_staging.tests.test_tap_metadata -v
```

Expected: PASS.

- [ ] **Step 9: Commit both repositories**

Commit tap changes as `[Pages] Revalidate admissions against tap main` and Kandelo changes as `[Pages] Bind readiness to current tap metadata`, staging only the files listed above.

---

### Task 2: Split product preparation from final-site readiness

**Files:**

- Modify: `scripts/abi-staging-pages-readiness.ts`
- Modify: `scripts/abi-staging-pages-readiness.test.ts`
- Modify: `scripts/abi-staging-pages-producer.ts`
- Modify: `scripts/abi-staging-pages-producer.test.ts`
- Modify: `scripts/abi-staging-pages-producer-fixture.ts`
- Modify: `tools/xtask/src/abi_staging/pages_readiness.rs`

**Interfaces:**

- Produce `preparePagesProducts(input, dependencies): Promise<PreparedPagesProductsV1>`.
- Produce `finalizePagesReadiness(input, prepared, siteMetadata): PagesReadinessResultV1`.
- Preserve `computePagesReadiness` as a wrapper for test callers already holding final site metadata.
- `PreparedPagesProductsV1.sealed_products` contains sorted entries with `id`, `load`, `bytes`, `sha256`, canonical `path`, and private `private_path`.
- Because no hosted record has been published, correct schema-1 hold semantics before first publication: `site_metadata_sha256` is `null` for a hold and a SHA-256 string for ready.

- [ ] **Step 1: Write phase-separation RED tests**

Prove builders/evidence run once, a complete preparation returns seven sealed entries, finalization performs no OCI/build/evidence work, post-preparation byte mutation fails, a hold has null site identity, and finalization rejects missing/extra/reordered/duplicate products.

- [ ] **Step 2: Run tests and verify RED**

```bash
scripts/dev-shell.sh npx tsx --test scripts/abi-staging-pages-readiness.test.ts \
  scripts/abi-staging-pages-producer.test.ts
```

Expected: FAIL because construction and final site identity are currently one operation.

- [ ] **Step 3: Extract product preparation**

Move catalog, registry, runtime, admission, recomposition, build, and evidence work into `preparePagesProducts`. Write private VFS bytes beneath the producer staging directory before returning. Keep all identities sorted and never serialize or accept the sealed map through the public CLI handoff.

- [ ] **Step 4: Implement finalization**

Re-read and authenticate every private product, validate final site metadata, build readiness/site manifest, and reject candidate strings or any VFS path outside the seven canonical paths. Phase-A blockers bypass Phase B and emit the null-site hold; hard authority errors still throw.

- [ ] **Step 5: Update Rust validators**

Require null site identity exactly for a non-ready record with blockers. Require SHA-256 site identity and the complete product set when ready.

- [ ] **Step 6: Run Task 2 tests GREEN**

```bash
scripts/dev-shell.sh npx tsx --test scripts/abi-staging-pages-readiness.test.ts \
  scripts/abi-staging-pages-producer.test.ts
scripts/dev-shell.sh bash -c 'host_target=$(rustc -vV | awk "/^host/ {print \$2}"); cargo test -p xtask --target "$host_target" abi_staging::pages_readiness'
scripts/dev-shell.sh bash scripts/test-abi-staging-pages-atomic.sh
```

Expected: PASS without builder/evidence replay.

- [ ] **Step 7: Commit**

Commit the listed files as `[Pages] Seal products before final site assembly`.

---

### Task 3: Build the browser from the sealed canonical product map

**Files:**

- Create: `scripts/abi-staging-pages-site-builder.ts`
- Create: `scripts/abi-staging-pages-site-builder.test.ts`
- Create: `apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-product-loader.ts`
- Create: `apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-product-loader.test.ts`
- Modify: `scripts/abi-staging-pages-producer.ts`
- Modify: `scripts/abi-staging-pages-producer.test.ts`
- Modify: `apps/browser-demos/vite.config.ts`
- Modify: `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts`
- Modify: `apps/browser-demos/pages/kandelo/kernel-host/optional-demo-vfs.ts`
- Modify: `scripts/check-pages-vfs-product-registry.mjs`
- Modify: `scripts/check-pages-vfs-product-registry.test.mjs`
- Modify: `abi/staging/request-policy.toml`
- Modify: `abi/staging/evidence-definitions.generated.json`
- Modify: `abi/staging/request-policy.generated.json`
- Modify: `.github/workflows/abi-staging-pages-canary.yml`

**Interfaces:**

- Produce `buildFinalPagesSite(options): PagesSiteMetadataV1`.
- Producer writes the in-process sealed map to a private staging file and sets absolute `KANDELO_PAGES_PRODUCT_MAP` only for its bounded site-builder child.
- Vite exports `virtual:kandelo-pages-vfs-products` and resolves all seven legacy VFS specifiers to literal canonical URL modules.
- Produce `createPagesVfsProductLoader(entries, fetcher)` with cached eager/lazy, exact-length, and SHA-256 validation.

- [ ] **Step 1: Write closed Vite-map RED tests**

Build from a seven-entry fixture and require no VFS in Vite output while `@rootfs-vfs`, shell, and five optional imports export the exact canonical paths. Reject missing, extra, duplicate, wrong-load, candidate, prior-ABI, unknown VFS, and legacy fallback mutations.

- [ ] **Step 2: Write loader RED tests**

Require both eager fetches to begin once at creation, all five lazy fetches to remain zero until their own activation, all promises to cache success/failure, and wrong length/digest or unknown ID to fail without fallback.

- [ ] **Step 3: Run tests and verify RED**

```bash
scripts/dev-shell.sh npx tsx --test scripts/abi-staging-pages-site-builder.test.ts \
  apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-product-loader.test.ts
```

Expected: FAIL because canonical Vite mode and loader do not exist.

- [ ] **Step 4: Implement canonical Vite resolution**

Parse the canonical size-bounded private map and cross-check it against product catalog, Pages registry, gallery registry, and `abi/staging/legacy-vfs-adapters.toml`. Register the canonical resolver before the ordinary binary resolver. Intercept `@rootfs-vfs?url`, shell imports, and every optional VFS glob/raw/transitional filename. Return literal base-prefixed product URLs and never call the ordinary binary resolver for a canonical VFS request.

- [ ] **Step 5: Implement the digest-validating loader**

Use `crypto.subtle.digest("SHA-256", bytes)`. Require same-origin URL under the configured Vite base, HTTP success, exact content length, received length, and digest. Insert one promise before fetch so concurrent activation cannot duplicate it. Preserve existing development/release behavior when canonical mode is absent, but never evaluate fallback in canonical mode.

- [ ] **Step 6: Implement bounded Phase B builder**

Create private HOME/TMP, use a positive environment allowlist, run browser/docs/API builds through the dev shell, copy no symlinks, write each VFS once at its canonical path, and return the full site inventory. Reject any VFS outside the seven paths.

- [ ] **Step 7: Integrate and refresh identities**

Remove the workflow pre-producer site build. Add new protected dependencies to request-policy/evidence identity. Regenerate evidence definitions first and request policy second.

- [ ] **Step 8: Run Task 3 tests GREEN**

```bash
scripts/dev-shell.sh npx tsx --test scripts/abi-staging-pages-site-builder.test.ts \
  apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-product-loader.test.ts \
  scripts/abi-staging-pages-producer.test.ts \
  scripts/check-pages-vfs-product-registry.test.mjs
scripts/dev-shell.sh bash -c 'host_target=$(rustc -vV | awk "/^host/ {print \$2}"); cargo run -p xtask --target "$host_target" --quiet -- abi-staging evidence-definitions check --source abi/staging/evidence-definitions.toml --generated abi/staging/evidence-definitions.generated.json; cargo run -p xtask --target "$host_target" --quiet -- abi-staging request-policy check --source abi/staging/request-policy.toml --generated abi/staging/request-policy.generated.json'
```

Expected: PASS with exactly seven VFS files after final assembly and none in Vite output.

- [ ] **Step 9: Commit**

Commit the listed files as `[Pages] Build the site from admitted VFS products`.

---

### Task 4: Make holds inert and correct hosted sequencing

**Files:**

- Modify: `.github/workflows/abi-staging-pages-canary.yml`
- Modify: `scripts/ci-check-pages-deployment.sh`
- Modify: `scripts/test-pages-deployment-contract.sh`
- Modify: `scripts/check-pages-run-freshness.sh`
- Modify: `scripts/test-pages-run-freshness.sh`
- Modify: `docs/superpowers/plans/2026-08-08-abi-staging-promotion-pages-and-retirement.md`
- Modify: `docs/browser-support.md`

**Interfaces:**

- Workflow output `ready` comes from validated readiness.
- Ready path validates/uploads one inert Pages artifact.
- Hold path validates exactly one `readiness.json`, summarizes digest/blockers, and uploads one ordinary bounded artifact.
- A hosted hold permits inactive Task 10 preparation; a later ready rerun after admissions is required for activation/deployment.

- [ ] **Step 1: Write workflow mutation RED tests**

Reject a hold that reads a site manifest, calls `upload-pages-artifact`, lacks ordinary retention, contains another file, or skips readiness validation. Reject documentation that makes the first pre-admission hold a ready/deploy gate.

- [ ] **Step 2: Run tests and verify RED**

```bash
scripts/dev-shell.sh bash scripts/test-pages-deployment-contract.sh
scripts/dev-shell.sh bash scripts/test-pages-run-freshness.sh
scripts/dev-shell.sh bash scripts/ci-check-pages-deployment.sh
```

Expected: FAIL because the canary assumes every output has a site.

- [ ] **Step 3: Implement ready/hold branching**

Validate readiness first and write `ready=true|false` to `$GITHUB_OUTPUT`. Hold validates exact one-file inventory and uses a full-SHA-pinned ordinary upload after the newest-run guard. Ready alone validates site/source tree and invokes the pinned Pages upload. Neither path has Pages, identity-token, contents, or package write authority.

- [ ] **Step 4: Correct Task 10 sequencing and docs**

Document this order: hosted hold for inactive preparation; successor promotion/admissions; canary rerun; ready result; only then activation/deployment.

- [ ] **Step 5: Run Task 4 tests GREEN**

```bash
scripts/dev-shell.sh bash scripts/test-pages-deployment-contract.sh
scripts/dev-shell.sh bash scripts/test-pages-run-freshness.sh
scripts/dev-shell.sh bash scripts/ci-check-pages-deployment.sh
scripts/dev-shell.sh actionlint .github/workflows/abi-staging-pages-canary.yml
```

Expected: PASS with no deployment.

- [ ] **Step 6: Commit**

Commit the listed files as `[Pages] Preserve incomplete canaries as holds`.

---

### Task 5: Prove the assembled site in Chromium and cut the ABI-test snapshot

**Files:**

- Create: `apps/browser-demos/test/abi-staging-pages-assembled-site.spec.ts`
- Modify: `apps/browser-demos/playwright.config.ts`
- Modify: `scripts/abi-staging-pages-producer.test.ts`
- Modify: `scripts/test-abi-staging-pages-atomic.sh`
- Modify: `scripts/test-pages-deployment-contract.sh`
- Modify: `docs/browser-support.md`

**Interfaces:**

- Test the exact producer-returned `source-tree`, served at `/kandelo/` with production service worker and isolation headers.
- Use the hidden deployment manifest only as expected observation ledger; browser authority comes from the sealed build map.

- [ ] **Step 1: Write assembled-site Chromium RED test**

Record every VFS request/response. Require exactly two eager URLs before activation, zero lazy URLs, then activate one representative profile for each lazy product and require its one canonical URL plus basic boot. Hash every response. Reject any other VFS/external request. Add corrupt, wrong-length, missing, extra, wrong-load, duplicate-rootfs, legacy, candidate, and prior-ABI mutations.

- [ ] **Step 2: Run Chromium test and verify RED**

```bash
scripts/dev-shell.sh env PLAYWRIGHT_BROWSERS_PATH="$PLAYWRIGHT_BROWSERS_PATH" \
  npx playwright test apps/browser-demos/test/abi-staging-pages-assembled-site.spec.ts \
  --project=chromium
```

Expected: FAIL because the final bundle currently consumes legacy VFS assets.

- [ ] **Step 3: Complete fixture and atomic gate**

The fixture may replace external OCI/current-input collection and heavy guest semantics with bounded local authorities, but it retains real producer ordering, final Vite build, final assembly, service worker, BrowserKernel, and Chromium. It never constructs a second site or injects candidate evidence. Add the exact Chromium command to the atomic gate and require it from the canary checker.

- [ ] **Step 4: Run the complete local snapshot gate**

```bash
scripts/dev-shell.sh npx tsx --test scripts/abi-staging-pages-readiness.test.ts \
  scripts/abi-staging-pages-producer.test.ts \
  scripts/abi-staging-pages-site-builder.test.ts \
  scripts/abi-staging-product-node-evidence.test.ts \
  scripts/abi-staging-product-browser-evidence.test.ts
scripts/dev-shell.sh bash scripts/test-abi-staging-pages-atomic.sh
scripts/dev-shell.sh bash scripts/test-pages-deployment-contract.sh
scripts/dev-shell.sh bash scripts/test-pages-run-freshness.sh
scripts/dev-shell.sh bash scripts/ci-check-pages-deployment.sh
scripts/dev-shell.sh bash scripts/test-abi-staging-prepare-runtime.sh
scripts/dev-shell.sh bash -c 'host_target=$(rustc -vV | awk "/^host/ {print \$2}"); cargo test -p xtask --target "$host_target" abi_staging::pages_readiness; cargo test -p xtask --target "$host_target" abi_staging::builder_contract'
scripts/dev-shell.sh actionlint .github/workflows/abi-staging-pages-canary.yml
git diff --check
```

Expected: PASS. Report the intentional Node skip by exact test name and keep the browser claim bounded to Chromium and the assembled fixture.

- [ ] **Step 5: Independently review both repositories**

Generate exact review packages from Task 1 bases through Task 4 heads. Require no Critical or Important finding on admission freshness, single-build semantics, VFS inventory, eager/lazy timing, hold behavior, workflow permissions, or cross-repository schema compatibility.

- [ ] **Step 6: Commit the final test gate**

Commit the listed files as `[Pages] Prove admitted products in the assembled site`.

- [ ] **Step 7: Record and open the partial-landing snapshot**

Update the Plan 5 ledger with exact commits and outputs. Keep promotion disabled, Pages activation legacy, and cleanup observe-only. Push both branches, open purpose-led pull requests with `## Why` first, wait for required CI, fix failures through reviewed commits, and merge only when both stacks are green in dependency order.
