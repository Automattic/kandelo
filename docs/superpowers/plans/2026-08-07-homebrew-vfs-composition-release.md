# Homebrew VFS Composition Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the experimental ABI-42 Homebrew VFS after exact composition verification and bounded Node/Chromium selected-runtime startup, without making the memory-intensive stock tap/install lifecycle a publication dependency.

**Architecture:** Preserve the existing four-file builder-to-proof artifact boundary and exact byte binding. Add a shared lightweight startup proof and focused Node CLI, keep the complete lifecycle implementation unchanged for manual diagnostics, and narrow the final public artifact to the three inert composition files. The writer remains the only credentialed job; anonymous readback verifies only public availability and byte identity.

**Tech Stack:** TypeScript, Node test runner through `tsx`, Kandelo Node and browser kernel hosts, Playwright Chromium, GitHub Actions YAML, Ruby structural workflow checker, Bash mutation tests, `actionlint`.

## Global Constraints

- Do not clean, reset, stage, or edit the ABI-43 worktree at `integration/abi43-batch-linear-20260801`.
- Do not change ABI, kernel, libc, syscall, process-memory, bottle, selection, VFS composition, or package behavior.
- Keep `scripts/homebrew-flat-vfs-node-smoke.ts` and the full lifecycle/evidence implementation semantically unchanged for manual diagnostics.
- The intermediate candidate remains exactly `{VFS, selection, report, kernel}` and is downloaded on a fresh runner by exact same-run artifact ID.
- The release contains exactly `{VFS, selection, report}`; it contains neither `kernel.wasm` nor a lifecycle evidence file.
- Node startup must boot the exact candidate, run `/usr/bin/brew --version`, reject lazy downloads and host diagnostics, and tear down under a bounded deadline.
- Chromium must retain exact image/kernel identity checks and both selected Ruby startup cases.
- Build, test, and readback jobs remain `contents: read`; only the publisher has `contents: write`.
- Do not add swap, a larger runner, native package tools, pre-tapping, reduced guest memory, or a lifecycle bypass.
- Use `scripts/dev-shell.sh` for TypeScript and repository verification claims.

## File Map

- `homebrew/test/homebrew_flat_vfs_shipping_proof.ts`: add a bounded startup-only proof while preserving the full shipping proof.
- `homebrew/test/homebrew_flat_vfs_shipping_proof.test.ts`: prove startup success, failure, cleanup, and absence of tap/install.
- `homebrew/test/homebrew_guest_lifecycle_node.ts`: expose the Node adapter for the startup proof.
- `scripts/homebrew-flat-vfs-node-startup.ts`: bind exact files/tap source and run only Node startup.
- `scripts/homebrew-flat-vfs-node-startup.test.ts`: test arguments and exact input forwarding.
- `.github/workflows/homebrew-experimental-vfs-publish.yml`: use startup checks and publish three assets.
- `scripts/check-homebrew-experimental-vfs-workflow.rb`: freeze the new authority boundary.
- `scripts/test-homebrew-experimental-vfs-workflow.sh`: reject weakened or broadened workflow variants.
- `docs/homebrew-publishing.md`: document the precise release claim.

---

### Task 1: Shared bounded startup proof

**Files:**
- Modify: `homebrew/test/homebrew_flat_vfs_shipping_proof.test.ts`
- Modify: `homebrew/test/homebrew_flat_vfs_shipping_proof.ts`
- Modify: `homebrew/test/homebrew_guest_lifecycle_node.ts`

**Interfaces:**
- Consumes: `HomebrewFlatVfsEmbeddedRuntimeInput`, `HomebrewGuestLifecycleMachine`, and `createNodeLifecycleMachine`.
- Produces: `HomebrewFlatVfsStartupProofResult`, `runHomebrewFlatVfsStartupProof(options)`, and `runHomebrewFlatVfsStartupProofInNode(options)`.

- [ ] **Step 1: Write the failing startup-only test**

Import `runHomebrewFlatVfsStartupProof` and add:

```ts
test("runs only bounded embedded startup without the stock lifecycle", async () => {
  const scripts: Array<{ marker: string; script: string }> = [];
  let destroyed = false;
  const result = await runHomebrewFlatVfsStartupProof({
    runtime: {
      imageBytes: await createEmbeddedRuntimeImage(),
      shellPath: "/bin/bash",
      shellArgv0: "bash",
    },
    tapRevision: TAP_REVISION,
    deadlineMs: Date.now() + 1_000,
    createMachine: () => ({
      lazyDownloads: [],
      diagnostics: [],
      start: async () => {},
      readFile: async () => null,
      runShellScript: async ({ marker, script }) => {
        scripts.push({ marker, script });
      },
      exportRootfsImage: async () => new Uint8Array(),
      destroy: async () => { destroyed = true; },
    }),
  });

  assert.equal(destroyed, true);
  assert.equal(result.selectionSha256, SELECTION_SHA256);
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0]!.marker, HOMEBREW_FLAT_VFS_BREW_VERSION_MARKER);
  assert.match(scripts[0]!.script, /\/usr\/bin\/brew --version/);
  assert.doesNotMatch(scripts[0]!.script, /brew tap|brew install|brew uninstall/);
});
```

Add startup variants of the existing deadline, lazy-download, host-diagnostic,
and teardown assertions. Each variant must assert that `destroy()` runs.

- [ ] **Step 2: Run the test and verify red**

```bash
scripts/dev-shell.sh npx tsx --test \
  homebrew/test/homebrew_flat_vfs_shipping_proof.test.ts
```

Expected: FAIL because `runHomebrewFlatVfsStartupProof` is not exported.

- [ ] **Step 3: Implement the minimal shared startup path**

Add the non-lifecycle result type:

```ts
export interface HomebrewFlatVfsStartupProofResult {
  tapRevision: string;
  kandeloAbi: number;
  selectionSha256: string;
  lazyDownloads: readonly LazyDownloadEvent[];
}

export type HomebrewFlatVfsShippingProofResult =
  HomebrewFlatVfsStartupProofResult;
```

Extract the existing exact revision validation, embedded-runtime validation,
machine start, brew-version script, zero-lazy checks, diagnostics, and bounded
destruction into one private helper. Accept an optional callback that runs
after `brew --version` and before teardown. `runHomebrewFlatVfsStartupProof`
calls it without a callback. `runHomebrewFlatVfsShippingProof` supplies a
callback containing the unchanged core tap/install/pour step.

- [ ] **Step 4: Add the Node adapter**

```ts
export function runHomebrewFlatVfsStartupProofInNode(options: {
  runtime: HomebrewFlatVfsEmbeddedRuntimeInput;
  tapRevision: string;
  deadlineMs: number;
  kernelWasmBytes?: ArrayBuffer;
}): Promise<HomebrewFlatVfsStartupProofResult> {
  return runHomebrewFlatVfsStartupProof({
    runtime: options.runtime,
    tapRevision: options.tapRevision,
    deadlineMs: options.deadlineMs,
    createMachine: (runtime) => createNodeLifecycleMachine(runtime, {
      ...(options.kernelWasmBytes === undefined
        ? {}
        : { kernelWasmBytes: options.kernelWasmBytes }),
    }),
  });
}
```

- [ ] **Step 5: Run focused regressions**

```bash
scripts/dev-shell.sh npx tsx --test \
  homebrew/test/homebrew_flat_vfs_shipping_proof.test.ts \
  homebrew/test/homebrew_guest_lifecycle_node.test.ts \
  homebrew/test/homebrew_flat_vfs_proof_evidence.test.ts
```

Expected: PASS. Existing shipping coverage still observes two guest scripts;
startup coverage observes exactly the version script.

- [ ] **Step 6: Commit**

```bash
git add homebrew/test/homebrew_flat_vfs_shipping_proof.ts \
  homebrew/test/homebrew_flat_vfs_shipping_proof.test.ts \
  homebrew/test/homebrew_guest_lifecycle_node.ts
git commit -m "[Packaging/Homebrew] Separate VFS startup from lifecycle proof"
```

---

### Task 2: Focused exact-input Node startup CLI

**Files:**
- Create: `scripts/homebrew-flat-vfs-node-startup.ts`
- Create: `scripts/homebrew-flat-vfs-node-startup.test.ts`

**Interfaces:**
- Consumes: `loadHomebrewFlatVfsProofInputs(..., { includeRuntimeBytes: true })` and `runHomebrewFlatVfsStartupProofInNode` from Task 1.
- Produces: `parseHomebrewFlatVfsNodeStartupArgs(args)` and `runHomebrewFlatVfsNodeStartup(args, dependencies?)`.

- [ ] **Step 1: Write failing parser and forwarding tests**

Create a test with exactly six required flags:

```ts
const argv = [
  "--image", "image.vfs.zst",
  "--selection", "selection.json",
  "--report", "report.json",
  "--kernel", "kernel.wasm",
  "--tap-root", "tap",
  "--tap-revision", "1".repeat(40),
];

test("parses exactly the six startup inputs", () => {
  const parsed = parseHomebrewFlatVfsNodeStartupArgs(argv);
  assert.equal(parsed.tapRevision, "1".repeat(40));
  assert.match(parsed.image, /image\.vfs\.zst$/);
  assert.throws(
    () => parseHomebrewFlatVfsNodeStartupArgs([...argv, "--evidence", "x"]),
    /usage:/,
  );
});
```

Inject fake `loadInputs` and `runProof` functions. Assert the loader receives
the six resolved paths with `{ includeRuntimeBytes: true }`. Assert the proof
receives the exact `runtime`, `tapRevision`, and `kernelWasmBytes` returned by
the loader. Assert that no evidence path is accepted or written.

- [ ] **Step 2: Run the new test and verify red**

```bash
scripts/dev-shell.sh npx tsx --test \
  scripts/homebrew-flat-vfs-node-startup.test.ts
```

Expected: FAIL because the startup CLI module does not exist.

- [ ] **Step 3: Implement the focused CLI**

Use a five-minute total deadline and the existing exact-input loader. Define a
narrow injectable loader type so tests do not need to implement every overload:

```ts
const STARTUP_TIMEOUT_MS = 5 * 60_000;

type LoadRuntimeInputs = (
  paths: HomebrewFlatVfsProofInputPaths,
  options: { includeRuntimeBytes: true },
) => LoadedHomebrewFlatVfsProofRuntimeInput;

export async function runHomebrewFlatVfsNodeStartup(
  args: readonly string[],
  dependencies: {
    loadInputs?: LoadRuntimeInputs;
    runProof?: typeof runHomebrewFlatVfsStartupProofInNode;
  } = {},
): Promise<HomebrewFlatVfsStartupProofResult> {
  const options = parseHomebrewFlatVfsNodeStartupArgs(args);
  const loadInputs = dependencies.loadInputs ?? loadHomebrewFlatVfsProofInputs;
  const inputs = loadInputs({
    imagePath: options.image,
    selectionPath: options.selection,
    reportPath: options.report,
    kernelPath: options.kernel,
    tapRoot: options.tapRoot,
    tapRevision: options.tapRevision,
  }, { includeRuntimeBytes: true });
  const runProof = dependencies.runProof ??
    runHomebrewFlatVfsStartupProofInNode;
  return runProof({
    runtime: inputs.runtime,
    tapRevision: inputs.tapRevision,
    deadlineMs: Date.now() + STARTUP_TIMEOUT_MS,
    kernelWasmBytes: inputs.kernelWasmBytes,
  });
}
```

The executable entry point prints only a bounded success line containing the
selection SHA. It accepts no timeout override, network mode, evidence output,
or native tool path.

- [ ] **Step 4: Run startup and full-proof CLI tests**

```bash
scripts/dev-shell.sh npx tsx --test \
  scripts/homebrew-flat-vfs-node-startup.test.ts \
  scripts/homebrew-flat-vfs-node-smoke.test.ts
```

Expected: PASS. The full lifecycle CLI/evidence behavior remains unchanged.

- [ ] **Step 5: Commit**

```bash
git add scripts/homebrew-flat-vfs-node-startup.ts \
  scripts/homebrew-flat-vfs-node-startup.test.ts
git commit -m "[Packaging/Homebrew] Add bounded flat VFS startup proof"
```

---

### Task 3: Cut publication over to composition/startup

**Files:**
- Modify: `scripts/check-homebrew-experimental-vfs-workflow.rb`
- Modify: `scripts/test-homebrew-experimental-vfs-workflow.sh`
- Modify: `.github/workflows/homebrew-experimental-vfs-publish.yml`

**Interfaces:**
- Consumes: `scripts/homebrew-flat-vfs-node-startup.ts` and the existing Chromium cases selected by `--grep 'starts.*Ruby'`.
- Produces: a four-job workflow whose final tested artifact and release contain exactly three assets.

- [ ] **Step 1: Change structural expectations before workflow code**

Keep candidate constants unchanged and narrow public constants:

```rb
FIXED_ASSETS = %w[
  homebrew-selection.json
  homebrew-vfs-build-report.json
].freeze
IDENTITIES = %w[vfs selection report].freeze
CANDIDATE_FIXED_ASSETS = %w[
  homebrew-selection.json
  homebrew-vfs-build-report.json
  kernel.wasm
].freeze
CANDIDATE_IDENTITIES = %w[vfs selection report kernel].freeze
```

Require the proof step to contain the new startup CLI, all six exact input
flags, and the bounded Chromium selector. Reject the full Node smoke CLI,
`homebrew-node-evidence.json`, `runner_heartbeat`, and stock lifecycle markers
from the workflow. Require a three-file final inventory and require the final
bind step to rehash VFS, selection, report, and kernel immediately before
upload. Remove only the evidence JSON field assertions.

Freeze this exact release note:

```text
Experimental ABI-42 flat Homebrew VFS; exact composition plus bounded Node and Chromium selected-runtime startup verified; stock in-guest tap/install lifecycle is not a release gate.
```

- [ ] **Step 2: Replace stale mutations**

Delete heartbeat and evidence-payload mutations. Add these rejection cases:

```text
node-startup-omitted
node-full-lifecycle-reintroduced
node-startup-evidence-reintroduced
candidate-post-startup-binding-omitted
candidate-kernel-added-to-final-artifact
fourth-release-asset
```

Keep candidate artifact-ID, exact-selection, kernel-claim, post-identify,
writer authority, permission, and anonymous-readback mutations. Adapt searched
step names from “four”/“proof evidence” to “three”/“startup-tested bytes” while
preserving what each mutation changes.

- [ ] **Step 3: Run the structural suite and verify the old workflow is red**

```bash
scripts/dev-shell.sh bash scripts/test-homebrew-experimental-vfs-workflow.sh
```

Expected: FAIL because the old workflow invokes the full lifecycle and exports
`homebrew-node-evidence.json`.

- [ ] **Step 4: Replace the proof step**

Remove the heartbeat and full lifecycle invocation. Run:

```bash
scripts/dev-shell.sh npx tsx \
  scripts/homebrew-flat-vfs-node-startup.ts \
  --image "$ASSET_ROOT/$vfs_filename" \
  --selection "$ASSET_ROOT/homebrew-selection.json" \
  --report "$ASSET_ROOT/homebrew-vfs-build-report.json" \
  --kernel local-binaries/kernel.wasm \
  --tap-root tap --tap-revision "$TAP_REVISION"
```

Then retain the existing clean-dev-shell Chromium command with
`--project=chromium --grep 'starts.*Ruby'`. Do not run the Bzip2 lifecycle case
and do not create an evidence file.

- [ ] **Step 5: Reduce final outputs to three files**

Rename the identify step to `Identify the exact three release assets`. Export
only `vfs_filename`, `{vfs,selection,report}_sha256`, and
`{vfs,selection,report}_bytes`.

Rename the next step to `Bind startup-tested bytes to the exact build
candidate`. Verify all three public files plus `local-binaries/kernel.wasm`
against `needs.build-image.outputs`, require exactly three entries under
`ASSET_ROOT`, and remove only the evidence `jq` check.

Rename upload to `Retain the fixed three-file artifact`, list only the three
release paths, and remove node-evidence outputs from `build-test`.

- [ ] **Step 6: Reduce publication and readback to three files**

Remove node-evidence environment variables, inventory entries, validation,
and release arguments from `publish` and `public-readback`. Preserve the unique
run/attempt tag, prerelease status, target SHA, digest/size checks,
empty-environment curl, and three unauthenticated downloads.

- [ ] **Step 7: Recompute frozen body digests after review**

After inspecting the complete new identify, writer, and readback bodies, update
`FINAL_IDENTIFY_RUN_SHA256`, `WRITER_RUN_SHA256`, and
`READBACK_RUN_SHA256`. Do not loosen whole-body hashing.

- [ ] **Step 8: Run workflow validation**

```bash
scripts/dev-shell.sh ruby scripts/check-homebrew-experimental-vfs-workflow.rb
scripts/dev-shell.sh bash scripts/test-homebrew-experimental-vfs-workflow.sh
actionlint .github/workflows/homebrew-experimental-vfs-publish.yml
git diff --check
```

Expected: all commands PASS.

- [ ] **Step 9: Commit**

```bash
git add .github/workflows/homebrew-experimental-vfs-publish.yml \
  scripts/check-homebrew-experimental-vfs-workflow.rb \
  scripts/test-homebrew-experimental-vfs-workflow.sh
git commit -m "[Packaging/Homebrew] Gate VFS release on composition startup"
```

---

### Task 4: Document the exact boundary

**Files:**
- Modify: `docs/homebrew-publishing.md`
- Modify: `docs/superpowers/specs/2026-08-07-homebrew-vfs-composition-release-design.md`

**Interfaces:**
- Consumes: the workflow behavior from Task 3.
- Produces: the authoritative composition/startup claim and ABI-43 restoration condition.

- [ ] **Step 1: Replace the stale full-Node/four-asset paragraph**

Use this substance in `docs/homebrew-publishing.md`:

```markdown
The experimental ABI-42 flat-VFS release is composition and selected-runtime
startup validated. The builder validates and materializes the exact canonical
selection, and a fresh runner rehashes the VFS, selection, report, and proof
kernel. Node boots that candidate and runs `/usr/bin/brew --version` without
lazy materialization; Chromium boots the same image/kernel identities and
starts selected Ruby directly and through the selected shell.

The release contains exactly three inert assets: the VFS, canonical selection,
and build report. It does not claim that hosted CI completed stock `brew tap`,
download, extraction, pour, uninstall, upgrade, or reboot coverage. The full
lifecycle remains a separate diagnostic until ABI-43 vfork-enabled Ruby and
bottles are rebuilt and the unchanged lifecycle demonstrates bounded RSS.
```

Retain the canonical prefix and tar/gzip composition contracts around this
paragraph; they remain implemented behavior.

- [ ] **Step 2: Mark the design implemented but not yet shipped**

Update the design status to say the implementation exists on this branch and
that release success still requires the post-merge dispatch and anonymous
readback. Do not claim the release has shipped locally.

- [ ] **Step 3: Check for stale claims**

```bash
rg -n "full Node lifecycle verified|exactly four inert assets|homebrew-node-evidence" \
  docs/homebrew-publishing.md \
  .github/workflows/homebrew-experimental-vfs-publish.yml
git diff --check
```

Expected: no stale release claim or public evidence asset reference.

- [ ] **Step 4: Commit**

```bash
git add docs/homebrew-publishing.md \
  docs/superpowers/specs/2026-08-07-homebrew-vfs-composition-release-design.md
git commit -m "[Packaging/Homebrew] Document the composition-gated VFS release"
```

---

### Task 5: Verify, merge, and ship

**Files:**
- Verify only; do not modify unrelated worktrees.

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: a packaging-only Kandelo PR and one exact three-asset experimental release.

- [ ] **Step 1: Run focused TypeScript suites**

```bash
scripts/dev-shell.sh npx tsx --test \
  homebrew/test/homebrew_flat_vfs_shipping_proof.test.ts \
  homebrew/test/homebrew_guest_lifecycle_node.test.ts \
  homebrew/test/homebrew_flat_vfs_proof_evidence.test.ts \
  scripts/homebrew-flat-vfs-node-startup.test.ts \
  scripts/homebrew-flat-vfs-node-smoke.test.ts
```

Expected: PASS with no skipped startup contract tests.

- [ ] **Step 2: Run workflow checks**

```bash
scripts/dev-shell.sh ruby scripts/check-homebrew-experimental-vfs-workflow.rb
scripts/dev-shell.sh bash scripts/test-homebrew-experimental-vfs-workflow.sh
actionlint .github/workflows/homebrew-experimental-vfs-publish.yml
git diff --check
git status --short
```

Expected: all checks PASS; only intentional branch files are present.

- [ ] **Step 3: Review the complete branch diff**

```bash
git diff --stat origin/main...HEAD
git diff --check origin/main...HEAD
git log --oneline origin/main..HEAD
```

Confirm the diff is exclusively packaging/Homebrew proof, workflow, tests, and
documentation. Confirm the full lifecycle implementation remains present and
its focused tests pass.

- [ ] **Step 4: Open and monitor the packaging-only PR**

The PR body begins with `## Why`, states the precise narrower release claim,
links run `31181316067` as the memory-bound evidence, and identifies ABI-43
vfork validation as follow-up. Wait for exact-head ordinary CI, then use the
existing `ready-to-ship` protected-merge path. Merge only this
packaging/Homebrew PR.

- [ ] **Step 5: Dispatch the exact release from merged main**

Use exactly:

```text
tap-revision=3b3fcd6d59ae50c975fbfacfbbde290700858205
selection-path=Kandelo/selections/experimental-abi42-shell41-wasm32.json
selection-sha256=9516bac9b13b90fb10193bbef799e340b276e4e72b5c77cb4a678a1f58773c6b
```

Require `build-image`, `build-test`, `publish`, and `public-readback` all to
succeed at the exact merged Kandelo main SHA.

- [ ] **Step 6: Verify the public result**

The derived prerelease contains exactly:

```text
kandelo-homebrew-experimental-abi42-wasm32.vfs.zst
homebrew-selection.json
homebrew-vfs-build-report.json
```

Compare release API sizes/digests to the `build-test` outputs and require the
credential-free readback job to have downloaded and rehashed all three. Report
the result as composition/startup validated, not as a complete stock Homebrew
lifecycle result.
