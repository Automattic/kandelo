# Candidate VFS Evidence and Kandelo PR Check Implementation Plan

> **Junior-review edition:** The complete command-level version is preserved
> in docs-only commit `0153a8863`. This edition explains the same interfaces,
> tests, trust boundaries, and commit sequence in plainer language. During
> implementation, use the preserved task details together with any review
> changes approved against this edition.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build selected VFS products from exact nonendorsed candidate inputs,
run their declared Node/browser evidence against the exact Kandelo head, and
publish the exact-head `Kandelo PR Check` without letting background Formulae
gate the pull request.

**Architecture:** Protected tap code resolves exact product inputs from public
candidate records. Uncredentialed builders use the Plan 1 accessor/report API.
Protected code validates and publishes candidate VFS bytes. Separate
uncredentialed Node/browser jobs test an exact kernel/host/VFS bundle; protected
code emits receipts and product evidence. Protected Kandelo code reads public
records and projects one current-head Check.

**Tech Stack:** Rust `xtask`, TypeScript VFS builders, `MemoryFileSystem`,
Node/Vitest, Playwright Chromium, Bash, tap Python OCI/record code, GitHub
Checks API, Ruby workflow tests, and `scripts/dev-shell.sh`.

## Global Constraints

- Keep Plans 1–3 interfaces unchanged and keep Formula roots product-derived.
- Derive ABI from exact inputs; concrete acceptance values remain Plan 5 data.
- Runtime/product source is the exact PR head. Evidence policy comes from
  protected current Kandelo code. Neither is a synthetic merge.
- Product manifests own product inputs; evidence policy only maps stable test
  IDs to bounded probes.
- Pages/test registries remain the only product-selection authorities.
- Preserve whole-VFS eager/lazy load separately from embedded/lazy/build-only
  product inputs.
- Candidate products may contain candidate references only. Canonical
  recomposition is Plan 5.
- Every real builder uses `openVfsProductBuild` and emits
  `VfsBuilderReportV1`; legacy entrypoints remain supported during rollout.
- Product build and evidence execution have no write credentials.
- Protected publishers parse artifacts as bounded inert data.
- Formula verification is an input fact, not product readiness. A product also
  needs exact composition, report, runtime, and all required host evidence.
- Failure blocks only the product and its dependants. Background Formulae
  never change the PR Check result.
- The Check is a projection, not an artifact authority, transaction, or tap
  completion gate.
- Current Check applicability is exact PR head plus current requirements,
  policy, and guard identities. Time and hash ordering are irrelevant.
- Historical evidence remains valid history but cannot satisfy another head.
- A 15-minute discovery delay is diagnostic only; no runner waits for it.
- Legacy synthetic-merge package paths may remain, but new ABI evidence and
  the new Check always use exact head.
- Check activation starts `observe`; branch protection changes only after
  hosted canaries.
- Pin actions to full SHAs, preserve unrelated state, and run local commands
  through `scripts/dev-shell.sh`.

---

## Plain-language data flow

```text
candidate bottle records + exact product manifest
                         |
                         v
               resolved product inputs
                         |
                         v
               uncredentialed VFS builder
                         |
                         v
               protected VFS publisher
                         |
                         v
            public candidate VFS identity
                  |                 |
                  v                 v
            Node evidence      browser evidence
                  |                 |
                  +--------+--------+
                           v
               protected product record
                           |
                           v
          exact-head Kandelo PR Check projection
```

## Exact interfaces

### Evidence definitions

Kandelo owns `EvidenceDefinitionRegistryV1` in
`abi/staging/evidence-definitions.toml`. A definition has exact stable ID,
`node|browser` host, closed runner kind, timeout, and runner-specific probe.
Allowed runner kinds are:

```text
exec
http
interactive-terminal
compile
sql
service-protocol
repository-suite
```

Definitions contain bounded typed data, never a request-supplied command/path.
They are canonicalized with protected implementation paths and receive a
`definition_sha256`. The registry digest is part of request policy identity,
so policy changes reissue current heads.

The registry binds every Plan 1 evidence ID for all 17 products to its real
startup, protocol, compile, interactive, or registered suite proof. The SDK
product has Node compile evidence and no browser definition.

### Exact runtime bundle

`ExactRuntimeBundleV1` binds exact source repository/commit/tree, target ABI
and snapshot, kernel Wasm digest/bytes/metadata, host bundle/generated ABI/
worker protocol, browser bundle/service worker, build policy, and every
inventory file. An uncredentialed exact-head job builds it. Protected code
validates it without execution.

### Product input plan and handoff

`ProductInputPlanV1` binds product/manifest/architecture, candidate reference
class, resolved-input digest, dependency products, required Formula subjects,
and runtime bundle.

The tap resolves these Plan 1 input kinds:

- `homebrew-bottle` from exact candidates/reuse plus qualifying receipts;
- `product-image` from already built dependency products, preserving edge
  materialization;
- `package-output` from the exact-head normal package path;
- `source-archive` from credential-free URL plus manifest digest;
- `toolchain-output` from the declared dev shell/policy; and
- `repository-path` from the exact head/tree.

Legacy adapters may locate declared outputs but cannot add inputs. Missing
inputs block the exact product; no stale canonical or silent source-build
fallback is allowed.

The handoff contains exactly inventory, resolved inputs, builder report,
runtime bundle, product result, one VFS file, and bounded diagnostics.
Protected code publishes under the reserved nonendorsed
`products/<product-id>` subtree and returns `CandidateProductLocatorV1`.

### Evidence result and product record

`ProductEvidenceResultV1` binds request, product/manifest, candidate VFS/report,
exact runtime, host, evidence definition digest, outcome, guard codes,
diagnostics, and run provenance.

Protected code publishes one verification receipt per terminal host result and
one `ProductEvidenceRecordV1` after all declared results are terminal. The
record binds the manifest, consumer registry reasons/digests, every input,
VFS/report/runtime, definitions, and receipts. Exact accepted override remains
visible as `accepted_with_override`.

### Current Check projection

`CurrentCheckContextV1` contains repository/PR/head plus current requirements,
request-policy, and guard-registry identities. `CurrentCheckProjectionV1`
contains the exact Check name/external ID/head, computed and published
conclusions, request/plan links, required Formula/product projections,
background status, all blockers, discovery diagnostic, and bounded Markdown.

The Check name is exactly `Kandelo PR Check`; external ID is
`abi-staging:<pr>:<head>:<request-digest>`.

- Observe mode publishes `neutral` while showing the computed result.
- Enforce mode maps not-applicable/success to success, pending to in-progress,
  and terminal required failure to failure.
- Background outcomes never change the conclusion.
- The summary shows the first deterministic causal blocker; details preserve
  every sibling fact.

## File map

### Kandelo policy, evidence, and Check

- Modify staging modules; create `evidence_policy.rs`,
  `product_evidence.rs`, and `check_projection.rs`.
- Create evidence definition/generated/activation policy under `abi/staging/`;
  update request policy identity.
- Create runtime preparation, Node evidence, browser evidence, and tests.
- Create Check update adapter/test/workflow and workflow checker.
- Modify `prepare-merge.yml`, merge workflow tests, and change-scope routing.

### Real builder adapters

- Create `images/vfs/scripts/staged-product-inputs.ts` and host tests.
- Modify the rootfs and main-shell build scripts.
- Modify shell/TypeScript builders for Node, nginx, nginx+PHP, WordPress,
  LAMP, MariaDB, Python, Perl, Redis, Erlang, SDK, MariaDB test, PHP test, and
  SQLite test products.
- Preserve all existing legacy invocation modes.

### Tap

- Create product policy/activation/fixtures and Python modules
  `product_inputs.py`, `product_records.py`, and tests.
- Modify tap CLI/reconciler/OCI validation/workflows and workflow tests.
- Modify tap documentation.

---

### Task 1: Define evidence policy and exact runtime identity

**Files:** Create evidence policy/generated/activation, policy parser/tests,
runtime preparation script/test; update request policy and record modules.

**Interfaces:** Produces `EvidenceDefinitionRegistryV1`,
`ExactRuntimeBundleV1`, and strict generation/validation commands.

- [ ] Write failing closed-schema/runner/bounds/host/product-reference tests.
- [ ] Write failing runtime inventory/source/ABI/kernel/host/browser tests and
  credential-stripping checks.
- [ ] Run Rust and shell tests; confirm red.
- [ ] Implement policy generation and uncredentialed exact-head runtime
  handoff; protected validation never executes it.
- [ ] Rerun, regenerate request policy identity, and expect PASS in observe
  mode.
- [ ] Commit the policy/runtime group.

---

### Task 2: Resolve exact candidate inputs in the tap

**Files:** Create product policy/activation/fixtures,
`product_inputs.py`, and tests; modify CLI/records.

**Interfaces:** Produces `ProductInputPlanV1` and canonical
`ResolvedVfsProductInputsV1` with candidate references only.

- [ ] Write failing cases for every input kind, dependency product order,
  required receipts, missing/extra inputs, wrong reference class, wrong ABI/
  architecture, legacy dependency injection, and stale fallback.
- [ ] Run tap tests; confirm red.
- [ ] Implement pure exact resolution from manifests, records, adapters, and
  exact runtime identity.
- [ ] Rerun and generate fixtures; expect PASS.
- [ ] Commit in the tap.

---

### Task 3: Adapt rootfs and main-shell builders

**Files:** Create staged input helper/tests; modify rootfs and main-shell
builders plus focused tests.

**Interfaces:** Both builders accept the Plan 1 accessor API in staging mode,
preserve legacy mode, and emit exact reports.

- [ ] Freeze current reads/materialization/output as failing staging fixtures.
- [ ] Add negative tests for undeclared path, missing input, lazy fetch,
  materialization drift, and legacy-mode behavior change.
- [ ] Run focused tests; confirm red.
- [ ] Implement staging-mode accessors/reporting without changing legacy
  invocation.
- [ ] Rerun builder, VFS, and lazy regressions; expect PASS.
- [ ] Commit.

---

### Task 4: Adapt browser web-service builders

**Files:** Modify Node, nginx, nginx+PHP, WordPress, and LAMP shell/TypeScript
builders and their focused tests.

**Interfaces:** Each consumes only declared input IDs and reports exact
embedded/lazy/build-only placement.

- [ ] Freeze each current builder's reads and outputs as failing fixtures.
- [ ] Test archive/package/service/kernel inputs, dependency products, and
  undeclared-input rejection.
- [ ] Run focused tests; confirm red.
- [ ] Adapt one builder at a time through the shared helper, retaining legacy
  mode.
- [ ] Run focused plus existing browser/VFS regressions; expect PASS.
- [ ] Commit the coherent web-service group.

---

### Task 5: Adapt language, database, and service builders

**Files:** Modify MariaDB, Python, Perl, Redis, and Erlang builders/tests.

**Interfaces:** Same Plan 1 accessor/report contract; preserve Perl's lazy
executable and every existing architecture-specific behavior.

- [ ] Freeze reads/outputs and write failing embedded/lazy/build-only cases.
- [ ] Test wasm32/wasm64 separation, lazy Perl, runtime source roles, and
  undeclared inputs.
- [ ] Run focused tests; confirm red.
- [ ] Adapt each builder without changing legacy mode.
- [ ] Run product-specific and VFS regressions; expect PASS.
- [ ] Commit.

---

### Task 6: Adapt SDK and test-product builders

**Files:** Modify SDK, MariaDB-test, PHP-test, and SQLite-test builders/tests.

**Interfaces:** Same staging contract, including declared compiler/toolchain,
source-role, suite fixture, and package outputs.

- [ ] Freeze exact reads/outputs and write failing undeclared-toolchain/source/
  fixture cases.
- [ ] Run focused tests; confirm red.
- [ ] Adapt each builder through declared accessors and exact reporting.
- [ ] Run SDK compile and all product suite regressions; expect PASS.
- [ ] Commit.

---

### Task 7: Publish candidate VFS identity separately from evidence

**Files:** Create tap product record/OCI fixtures, `product_records.py`, and
tests; modify OCI/CLI.

**Interfaces:** Produces `CandidateProductLocatorV1` after VFS validation and
later `ProductEvidenceRecordV1`; product identity never implies test success.

- [ ] Write failing handoff/inventory/report/runtime/namespace validation tests
  and prove a candidate product can exist before evidence.
- [ ] Test reserved `products/` subtree, content-addressed publication,
  nonendorsed annotations, association, anonymous readback, and collision
  handling.
- [ ] Run tap tests; confirm red.
- [ ] Implement protected inert publication and separate product-record
  assembly.
- [ ] Rerun tests; expect PASS.
- [ ] Commit in the tap.

---

### Task 8: Run protected Node evidence against exact products

**Files:** Create Node evidence runner/test and product evidence validators;
modify foundation suite.

**Interfaces:** Produces bounded canonical `ProductEvidenceResultV1` for host
`node` using exact runtime/product/definition identities.

- [ ] Write failing runner tests for every Node evidence kind, timeout,
  malformed definition, wrong runtime/product, missing lazy object, bounded
  diagnostics, and no credentials/writes.
- [ ] Run Node and Rust validation tests; confirm red.
- [ ] Implement closed protected runners against the candidate VFS and exact
  runtime bundle.
- [ ] Rerun all Node product evidence plus host/VFS regressions; expect PASS.
- [ ] Commit.

---

### Task 9: Run real browser evidence against exact products

**Files:** Create `scripts/abi-staging-product-browser-evidence.ts`, its test,
and `apps/browser-demos/test/abi-staging-product-evidence.spec.ts`; modify
`apps/browser-demos/playwright.config.ts`, `live-setup.ts`, and
`optional-demo-vfs.ts`.

**Interfaces:** Produces bounded canonical `ProductEvidenceResultV1` for host
`browser`; execution uses actual Playwright Chromium and exact candidate
artifacts.

- [ ] Write failing tests for each browser definition, exact runtime/VFS
  injection, lazy fetches, timeout/failure, bounded diagnostics, no mock-only
  success, and no write credentials.
- [ ] Run TypeScript tests and selected Playwright cases; confirm red.
- [ ] Implement the protected definition dispatcher and exact artifact setup.
- [ ] Run all declared required browser evidence plus browser asset tests;
  expect PASS.
- [ ] Commit.

---

### Task 10: Add product jobs to the protected tap reconciler

**Files:** Modify tap reconcile workflow/CLI/modules and workflow tests.

**Interfaces:** Adds separated jobs for product planning, uncredentialed
composition, protected VFS publication, uncredentialed Node/browser evidence,
and protected receipt/product-record publication.

- [ ] Write failing workflow/mutation tests for every permission boundary,
  exact artifact inventory, required/background scheduling, dependency product
  order, candidate-only references, and bounded matrix sizes.
- [ ] Write failing reconciliation tests for ready/blocked/failed/overridden/
  historical products and unrelated background progress.
- [ ] Run tap unit/workflow tests; confirm red.
- [ ] Implement observe mode first, then active behavior only behind product
  activation policy.
- [ ] Rerun unit, mutation, and actionlint suites; expect PASS.
- [ ] Commit in the tap.

---

### Task 11: Project immutable evidence into `Kandelo PR Check`

**Files:** Create `check_projection.rs`, Check adapter/test/workflow/checker,
required-check activation, and product-evidence integration script.

**Interfaces:** Produces `CurrentCheckProjectionV1` and one narrow protected
Checks API writer for the exact current head.

- [ ] Write failing projection tests for not-applicable, missing request,
  pending, success, required failure, exact override, background failure,
  historical evidence, stale policy/requirements/guard, sibling blockers,
  escaped/bounded Markdown, and 15-minute discovery diagnostic.
- [ ] Write failing adapter/workflow mutation tests for exact Check name/head/
  external ID, narrow permissions, protected code, inert public records, no
  candidate execution, and observe-mode neutral publication.
- [ ] Run Rust/shell/Ruby tests; confirm red.
- [ ] Implement pure projection and a protected writer that recomputes current
  identities and anonymously validates every linked record.
- [ ] Rerun tests and `actionlint`; expect PASS in observe mode.
- [ ] Commit.

---

### Task 12: Bind merge preparation to current exact-head evidence

**Files:** Modify `.github/workflows/prepare-merge.yml` and
`.github/scripts/test-merge-candidate-workflows.sh`; extend routing.

**Interfaces:** Keeps unrelated legacy synthetic-merge preparation but adds a
separate exact-head structural/evidence gate for ABI staging.

- [ ] Write failing workflow cases proving merge preparation rejects absent,
  stale, wrong-head, neutral-observe, or failed required Check evidence and
  accepts only enforced current exact-head success.
- [ ] Prove existing nonreplaced package lanes remain unchanged and cannot be
  mistaken for ABI staging evidence.
- [ ] Run merge workflow tests; confirm red.
- [ ] Add the smallest exact-head gate and focused path routing.
- [ ] Rerun merge/workflow/actionlint tests; expect PASS.
- [ ] Commit.

---

### Task 13: Run hosted product/Check canaries and enable the gate

**Files:** Modify product/check activation and exact deployed documentation.

**Interfaces:** Produces hosted product/evidence/Check URLs and only then
activation/enforcement plus external branch-protection setup.

- [ ] Land observe-only revisions on protected main in both repositories or
  stop at the hosted gate.
- [ ] Run one exact-head required-product success canary and retain all runtime,
  VFS, report, receipt, product-record, and neutral Check identities.
- [ ] Run required failure, background-only failure, historical-head, delayed
  discovery, and lazy-reference canaries.
- [ ] Prove browser evidence used a real browser and every executing job lacked
  write credentials.
- [ ] Change product activation to active and Check activation to enforce only
  after all canaries pass; rerun local suites and commit narrow changes.
- [ ] Have a maintainer add `Kandelo PR Check` to branch protection. Workflow
  code does not grant itself administration rights.
- [ ] Update documentation to the exact operational claim.

---

### Task 14: Run the final Plan 4 exact-head audit and stop

**Files:** Verify every Plan 4 file in both repositories.

**Interfaces:** Produces evidence for candidate products, exact runtime tests,
and required current-head Check only.

- [ ] Run foundation, builder, product evidence, Node/browser, Check, merge,
  browser-asset, ABI, workflow trust, and docs suites through the dev shell.
- [ ] Run all tap Python/workflow/actionlint tests and cross-repository fixtures.
- [ ] Audit exact-head identity through request, runtime, product, evidence, and
  Check records; prove historical evidence cannot satisfy current head.
- [ ] Audit all real builder input access/reporting and both lazy boundaries.
- [ ] Audit permissions: product/evidence execution has no writes; protected
  publishers execute only protected code; the Check writer has only required
  Checks/contents/actions permissions.
- [ ] Search generic infrastructure for concrete acceptance values, synthetic
  merge source, product-owned Pages/Formula roots, candidate/canonical mixing,
  sleeps, mutable latest state, and unfinished tokens.
- [ ] Audit both worktrees and stop before promotion, `abi/N`, tap-main
  metadata, canonical products, or Pages deployment.

## Exit criteria

- All real builders accept exact staging inputs and report every consumption
  while retaining legacy mode.
- Candidate products preserve exact inputs and both lazy boundaries and contain
  only visibly nonendorsed references.
- Exact runtime, Node, and real-browser evidence is separately recorded.
- Product evidence binds complete composition and all required receipts.
- One product failure blocks only it/dependants; background Formulae do not gate.
- `Kandelo PR Check` applies only to current head and current policy identities,
  preserves sibling/background details, and starts observe-only.
- Merge preparation requires enforced current-head success without replacing
  unrelated legacy package paths.
- No promotion, protected ABI branch, tap-main metadata update, canonical VFS,
  or Pages deployment exists yet.

After these criteria pass, execute Plan 5. A successful Check authorizes merge;
it does not itself promote or deploy anything.
