# ABI-42 Publication Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore ABI-42 package activation and publish a canonical,
self-contained Homebrew shell plus current shell-derived images so the live
browser Node demo can install and run `cowsay` with npm.

**Architecture:** Treat the incident as one artifact lifecycle. Reconciliation
first learns how to skip authenticated terminal records from the legacy GitHub
release lifecycle. The package system then builds a 512 MiB canonical flat
Homebrew shell from a checked-in digest-bound selection, and the shared derived
image helper preserves that lineage while all reverse dependencies advance.
Staging and Pages consume those exact package candidates without reconstructing
lazy mirrors; activation dispatches Pages only after canonical indexes move.

**Tech Stack:** Bash, GitHub Actions YAML, TypeScript, Vitest, Playwright,
Rust `xtask`, SharedFS VFS images, npm, Nix dev shell.

## Global Constraints

- Keep `ABI_VERSION` at 42; this work changes no syscall, process, memory,
  channel, or VFS serialization contract.
- Preserve the existing `kandelo-homebrew-vfs-generous-v1` 768 MiB policy and
  add `kandelo-homebrew-vfs-main-shell-v1` with the same bottle/aggregate
  limits and a 512 MiB VFS maximum.
- The canonical selection is `main-shell-abi42-wasm32`, targets `wasm32`,
  requests `shell.vfs.zst`, and retains all 41 bottle descriptors from tap
  commit `3b3fcd6d59ae50c975fbfacfbbde290700858205` exactly.
- The tap selection source SHA-256 is
  `9516bac9b13b90fb10193bbef799e340b276e4e72b5c77cb4a678a1f58773c6b`.
- Publish shell revision 23, `node-vfs` 15, `lamp` 12, `wordpress` 13,
  `nginx-vfs` 3, and `nginx-php-vfs` 3 with authored commit
  `UNPUBLISHED` until candidate activation stamps exact provenance.
- Do not revive the retired closed-selection campaign, copy experimental VFS
  bytes into a package release, or add runtime compatibility for stale lazy
  images.
- GitHub Pages remains a fetch-only package consumer and the sole `gh-pages`
  writer.
- Every third-party GitHub Action stays pinned to a full 40-character SHA.
- Run build and verification claims through `scripts/dev-shell.sh`.
- Preserve the user's modified `tests/sortix/os-test` gitlink and untracked
  `.serena/`; remove only task-owned generated dirt after identifying it
  exactly.

---

### Task 1: Make reconciliation terminal-aware

**Files:**

- Modify: `.github/scripts/reconcile-merge-candidates.sh`
- Modify: `.github/scripts/test-reconcile-merge-candidates.sh`
- Modify: `.github/scripts/test-merge-candidate-workflows.sh`

**Interfaces:**

- Consumes: GitHub release JSON and paginated asset records containing numeric
  `id`, string `name`, and non-negative integer `size`.
- Produces: the existing three-column activation plan; valid terminal
  candidates produce no row, while malformed or nonterminal legacy releases
  return nonzero.

- [ ] **Step 1: Add failing legacy terminal fixtures**

Extend `make_release` so fixtures can choose `draft` and `immutable`, assign a
stable ID and content file to every asset, and add these cases:

```bash
TAG_LEGACY_REJECTED="merge-candidate-abi-v39-pr-9-run-90-attempt-1"
TAG_LEGACY_ACTIVATED="merge-candidate-abi-v39-pr-10-run-100-attempt-1"
TAG_LEGACY_NONTERMINAL="merge-candidate-abi-v39-pr-11-run-110-attempt-1"

make_terminal_release "$TAG_LEGACY_REJECTED" 109 rejected.json \
  '{"disposition_schema_version":1,"disposition":"rejected","repository":"example/repo","pr_number":9,"candidate_tag":"merge-candidate-abi-v39-pr-9-run-90-attempt-1","rejection_reason":"squash-parent-mismatch","merge_commit_sha":null,"rejected_at":"2026-07-14T03:00:00Z","activation_run":"https://github.example/example/repo/actions/runs/90"}'
make_terminal_release "$TAG_LEGACY_ACTIVATED" 110 activated.json \
  '{"schema_version":1,"repository":"example/repo","pr_number":10,"candidate_tag":"merge-candidate-abi-v39-pr-10-run-100-attempt-1","candidate_index_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","ready_at":"2026-07-14T02:00:00Z","merge_commit_sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","canonical_index_sha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","activated_at":"2026-07-14T03:00:00Z","activation_run":"https://github.example/example/repo/actions/runs/100"}'
make_release_state "$TAG_LEGACY_NONTERMINAL" '[{"name":"ready.json"}]' \
  111 false false
```

Assert both valid terminal releases are skipped before a PR API request. Add
mutations for both markers together, malformed marker JSON, a marker whose tag
or PR differs, a duplicate marker name, an oversized marker, and published
mutable `ready.json` without a terminal marker; each must fail with an empty
plan.

- [ ] **Step 2: Run the reconciliation test and observe the lifecycle failure**

Run:

```bash
scripts/dev-shell.sh bash .github/scripts/test-reconcile-merge-candidates.sh
```

Expected: FAIL because a published mutable release is rejected before its
terminal marker is read.

- [ ] **Step 3: Collect authenticated asset identities and validate markers**

Change the asset inventory to tab-separated `id`, `name`, and `size` rows.
Reject duplicate names and IDs. Download at most 1 MiB through the asset ID,
verify the byte count, and validate one marker against the selected tag, PR,
and repository:

```bash
gh_retry gh api \
  "/repos/${REPOSITORY}/releases/assets/${asset_id}" \
  -H 'Accept: application/octet-stream' >"$marker"

jq -e --arg repository "$REPOSITORY" --arg tag "$tag" --argjson pr "$pr" '
  .disposition_schema_version == 1 and
  .disposition == "rejected" and
  .repository == $repository and .candidate_tag == $tag and .pr_number == $pr and
  (.rejection_reason | type == "string" and test("^[a-z0-9-]+$")) and
  (.merge_commit_sha == null or
    (.merge_commit_sha | type == "string" and test("^[0-9a-f]{40}$"))) and
  (.rejected_at | type == "string" and length > 0) and
  (.activation_run | type == "string" and length > 0)
' "$marker"
```

Use the ready-receipt identity fields plus `merge_commit_sha`,
`canonical_index_sha256`, `activated_at`, and `activation_run` for the
activated schema. Exactly one valid terminal marker returns before current
lifecycle validation. Both markers, bad content, or any nonterminal release
outside `(draft && !immutable) || (!draft && immutable)` fails closed.

- [ ] **Step 4: Update the structural workflow assertion**

Replace the name-only assertion with checks that reconciliation inventories
asset IDs, downloads terminal marker bytes, rejects the two-marker state, and
performs terminal handling before the current lifecycle predicate.

- [ ] **Step 5: Run focused reconciliation validation**

Run:

```bash
scripts/dev-shell.sh bash .github/scripts/test-reconcile-merge-candidates.sh
scripts/dev-shell.sh bash .github/scripts/test-merge-candidate-workflows.sh
scripts/dev-shell.sh bash -n .github/scripts/reconcile-merge-candidates.sh
```

Expected: all commands exit 0.

- [ ] **Step 6: Commit the reconciliation repair**

```bash
git add .github/scripts/reconcile-merge-candidates.sh \
  .github/scripts/test-reconcile-merge-candidates.sh \
  .github/scripts/test-merge-candidate-workflows.sh
git commit -m "CI: Reconcile terminal legacy package candidates"
```

### Task 2: Admit the canonical 512 MiB flat selection

**Files:**

- Create: `homebrew/main-shell-flat-selection.json`
- Modify: `host/src/homebrew-vfs-resource-policy.ts`
- Modify: `host/src/homebrew-bottle-selection.ts`
- Modify: `host/src/homebrew-vfs-builder.ts`
- Modify: `host/test/homebrew-bottle-selection.test.ts`
- Modify: `host/test/homebrew-flat-vfs-builder.test.ts`

**Interfaces:**

- Consumes: canonical selection JSON and one of the closed resource-policy IDs.
- Produces: `HomebrewBottleSelection.resourcePolicy` and
  `HomebrewFlatVfsBuildReport.resource_policy` typed as
  `HomebrewVfsResourcePolicyId`.

- [ ] **Step 1: Write failing policy and product-tuple tests**

Add assertions that the old policy remains exactly 768 MiB and the new policy
differs only in its ID and 512 MiB VFS maximum:

```ts
const generous = resolveHomebrewVfsResourcePolicy(
  "kandelo-homebrew-vfs-generous-v1",
);
const main = resolveHomebrewVfsResourcePolicy(
  "kandelo-homebrew-vfs-main-shell-v1",
);
expect(main).toEqual({
  ...generous,
  id: "kandelo-homebrew-vfs-main-shell-v1",
  vfs: { maxByteLength: 512 * 1024 * 1024 },
});
```

Create a canonical selection fixture with name
`main-shell-abi42-wasm32`, output `shell.vfs.zst`, and the main-shell policy;
require it to parse. Cross the experimental name/filename with the main policy,
and the main name/filename with the generous policy; require both to fail.

- [ ] **Step 2: Run the selection tests and observe unknown-policy failures**

Run:

```bash
scripts/dev-shell.sh bash -c \
  'cd host && npx vitest run test/homebrew-bottle-selection.test.ts test/homebrew-flat-vfs-builder.test.ts'
```

Expected: FAIL because the new policy ID and canonical filename are rejected.

- [ ] **Step 3: Add the closed policy and exact product tuples**

Define:

```ts
export type HomebrewVfsResourcePolicyId =
  | "kandelo-homebrew-vfs-generous-v1"
  | "kandelo-homebrew-vfs-main-shell-v1";

const MAIN_SHELL_V1 = deepFreeze({
  ...GENEROUS_V1,
  id: "kandelo-homebrew-vfs-main-shell-v1" as const,
  vfs: { maxByteLength: 512 * MEBIBYTE },
});
```

Resolve only those two IDs. In `projectHomebrewBottleSelection`, accept exactly
these product families after ABI and architecture validation:

```ts
const experimental =
  name.startsWith("experimental-") &&
  requestedVfsFilename.includes("experimental") &&
  requestedVfsFilename.includes("abi42") &&
  root.resourcePolicy === "kandelo-homebrew-vfs-generous-v1";
const mainShell =
  name === "main-shell-abi42-wasm32" &&
  arch === "wasm32" && kandeloAbi === 42 &&
  requestedVfsFilename === "shell.vfs.zst" &&
  root.resourcePolicy === "kandelo-homebrew-vfs-main-shell-v1";
if (!experimental && !mainShell) {
  fail("Homebrew bottle selection product fields do not form a supported tuple");
}
```

Use `HomebrewVfsResourcePolicyId` in the selection validator and flat build
report rather than another string literal.

- [ ] **Step 4: Materialize the canonical selection from the tap source**

Download the exact source selection at the pinned tap commit, verify its
SHA-256 is the value in Global Constraints, parse it with the repository
encoder, replace only `name`, `requestedVfsFilename`, and `resourcePolicy`, and
write the encoder's compact key-sorted LF-terminated bytes to
`homebrew/main-shell-flat-selection.json`. Fetch this exact URL:

```text
https://raw.githubusercontent.com/kandelo-dev/homebrew-tap-core/3b3fcd6d59ae50c975fbfacfbbde290700858205/Kandelo/selections/experimental-abi42-shell41-wasm32.json
```

Compare every bottle descriptor in the new file with the downloaded source
using:

```bash
jq -S '.bottles' source-selection.json >"$RUNNER_TEMP/source-bottles.json"
jq -S '.bottles' homebrew/main-shell-flat-selection.json \
  >"$RUNNER_TEMP/canonical-bottles.json"
cmp "$RUNNER_TEMP/source-bottles.json" \
  "$RUNNER_TEMP/canonical-bottles.json"
```

Also assert `.bottles | length == 41`, ABI 42, wasm32, the exact canonical
name/output/policy, and successful canonical parsing.

- [ ] **Step 5: Run selection and type validation**

Run:

```bash
scripts/dev-shell.sh bash -c \
  'cd host && npx vitest run test/homebrew-bottle-selection.test.ts test/homebrew-flat-vfs-builder.test.ts'
scripts/dev-shell.sh bash -c 'cd host && npm run typecheck'
```

Expected: both commands exit 0.

- [ ] **Step 6: Commit the canonical selection contract**

```bash
git add homebrew/main-shell-flat-selection.json \
  host/src/homebrew-vfs-resource-policy.ts \
  host/src/homebrew-bottle-selection.ts host/src/homebrew-vfs-builder.ts \
  host/test/homebrew-bottle-selection.test.ts \
  host/test/homebrew-flat-vfs-builder.test.ts
git commit -m "Packages: Define the canonical flat Homebrew shell"
```

### Task 3: Bind browser demo configuration in flat images

**Files:**

- Modify: `images/vfs/scripts/build-homebrew-vfs-image.ts`
- Modify: `images/vfs/scripts/build-homebrew-flat-vfs-image.ts`
- Modify: `host/test/homebrew-flat-vfs-image.test.ts`
- Modify: `host/test/homebrew-flat-vfs-cli.test.ts`

**Interfaces:**

- Produces: `parseDemoConfigBytes(input: Uint8Array, path: string)` and optional
  `FlatHomebrewVfsCliOptions.demoConfig`.
- Metadata: top-level `demoConfig = {path, sha256, bytes}`; artifact report:
  optional `demo_config` with the same shape.

- [ ] **Step 1: Add failing CLI and image assertions**

Pass `--demo-config homebrew/main-shell-demo.json` in one full builder fixture
and assert:

```ts
expect(readVfsText(restored, "/etc/kandelo/demo.json")).toBe(
  readFileSync(DEMO_CONFIG, "utf8"),
);
expect(restored.getImageMetadata()?.demoConfig).toEqual({
  path: "/etc/kandelo/demo.json",
  sha256: sha(readFileSync(DEMO_CONFIG)),
  bytes: readFileSync(DEMO_CONFIG).byteLength,
});
expect(report.demo_config).toEqual(restored.getImageMetadata()?.demoConfig);
```

Keep a build without the option and require byte-identical behavior with no
`demoConfig` or `demo_config`. Add malformed JSON, symlink input, duplicate
flag, and base-image preexisting `/etc/kandelo/demo.json` rejection cases.

- [ ] **Step 2: Run the two flat image tests and observe the unknown flag**

Run:

```bash
scripts/dev-shell.sh bash -c \
  'cd host && npx vitest run test/homebrew-flat-vfs-image.test.ts test/homebrew-flat-vfs-cli.test.ts'
```

Expected: FAIL because `--demo-config` is unknown.

- [ ] **Step 3: Extract the byte parser and add the optional CLI field**

Make the old path reader call this exported parser:

```ts
export function parseDemoConfigBytes(
  input: Uint8Array,
  path: string,
): LoadedDemoConfig {
  if (input.byteLength > MAX_KANDELO_DEMO_CONFIG_BYTES) {
    throw new Error(`Kandelo demo config exceeds ${MAX_KANDELO_DEMO_CONFIG_BYTES} bytes: ${path}`);
  }
  const bytes = Uint8Array.from(input);
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const config = parseKandeloDemoConfig(source);
  if (config === null) throw new Error(`Kandelo demo config has an unsupported version: ${path}`);
  validateKandeloDemoConfig(config);
  return {
    config,
    source: bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.byteLength,
  };
}
```

Treat `--demo-config` as optional while all six existing flags remain required.
Read it through `readBoundedRegularFileNoFollow` and the new parser.

- [ ] **Step 4: Install, serialize, restore-check, and report the exact bytes**

Refuse an existing guest path, write mode 0644, add generic metadata without
changing `homebrewFlat`, and verify the restored file before publishing:

```ts
...(demo === undefined ? {} : {
  demoConfig: {
    path: KANDELO_DEMO_CONFIG_PATH,
    sha256: demo.sha256,
    bytes: demo.bytes,
  },
}),
```

Add the same optional binding as `demo_config` in the detached report. Existing
experimental invocations omit the flag and therefore preserve their exact
image/report bytes.

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```bash
scripts/dev-shell.sh bash -c \
  'cd host && npx vitest run test/homebrew-flat-vfs-image.test.ts test/homebrew-flat-vfs-cli.test.ts'
scripts/dev-shell.sh bash -c 'cd host && npm run typecheck'
```

Expected: both commands exit 0.

- [ ] **Step 6: Commit demo binding support**

```bash
git add images/vfs/scripts/build-homebrew-vfs-image.ts \
  images/vfs/scripts/build-homebrew-flat-vfs-image.ts \
  host/test/homebrew-flat-vfs-image.test.ts \
  host/test/homebrew-flat-vfs-cli.test.ts
git commit -m "VFS: Bind demo metadata in flat Homebrew images"
```

### Task 4: Preserve flat-shell lineage in derived images

**Files:**

- Modify: `images/vfs/scripts/shell-vfs-build.ts`
- Modify: `host/test/shell-vfs-build.test.ts`

**Interfaces:**

- Consumes: exactly one source-rootfs, legacy lazy Homebrew, or flat Homebrew
  lineage.
- Produces: derived metadata retaining `homebrewFlat`, `shellConfig`, and a
  recomputed top-level `demoConfig` while rebinding `baseImage` to the exact
  shell artifact.

- [ ] **Step 1: Add a flat-shell fixture and failing derivation tests**

Create metadata containing:

```ts
homebrewFlat: {
  selectionSha256: "d".repeat(64),
  requestedVfsFilename: "shell.vfs.zst",
  resourcePolicy: "kandelo-homebrew-vfs-main-shell-v1",
},
shellConfig: {
  path: "/opt/kandelo/homebrew/bin/bash",
  argv: ["bash", "--login"],
  sha256: sha256Hex(FLAT_SHELL_CONFIG),
  bytes: byteLength(FLAT_SHELL_CONFIG),
},
demoConfig: {
  path: DEMO_CONFIG_PATH,
  sha256: sha256Hex(SOURCE_DEMO_CONFIG),
  bytes: byteLength(SOURCE_DEMO_CONFIG),
},
```

Write both config files into the fixture, replace the demo file before save,
and expect the derived image to preserve exact flat/shell bindings while the
demo digest follows the replacement. Add failures for a missing flat field,
wrong shell-config bytes, invalid demo binding, a flat claim mixed with legacy
lazy claims, and a flat claim mixed with source composition.

- [ ] **Step 2: Run the focused test and observe unsupported lineage**

Run:

```bash
scripts/dev-shell.sh bash -c \
  'cd host && npx vitest run test/shell-vfs-build.test.ts'
```

Expected: FAIL with `omits a supported shell composition binding`.

- [ ] **Step 3: Implement three mutually exclusive lineage branches**

Import `KANDELO_SHELL_CONFIG_PATH`. Validate exact flat keys and file bindings,
compare the shell metadata digest/length with the unchanged guest shell config,
validate the inherited demo binding shape, then return:

```ts
return {
  version: 1,
  kernelAbi,
  createdBy: SHELL_DERIVED_CREATED_BY,
  capacity: { maxByteLength },
  baseImage: { sha256: baseSha256, bytes: baseBytes, kernelAbi },
  homebrewFlat,
  shellConfig,
  demoConfig: {
    path: KANDELO_DEMO_CONFIG_PATH,
    sha256: sha256Hex(currentDemoConfig),
    bytes: currentDemoConfig.byteLength,
  },
};
```

Reject any cross-lineage claims before selecting a branch. Keep the existing
source and legacy lazy return shapes unchanged.

- [ ] **Step 4: Run focused and full host checks**

Run:

```bash
scripts/dev-shell.sh bash -c \
  'cd host && npx vitest run test/shell-vfs-build.test.ts'
scripts/dev-shell.sh bash -c 'cd host && npm run typecheck'
```

Expected: both commands exit 0.

- [ ] **Step 5: Commit flat-lineage derivation**

```bash
git add images/vfs/scripts/shell-vfs-build.ts \
  host/test/shell-vfs-build.test.ts
git commit -m "VFS: Preserve flat shell provenance in derived images"
```

### Task 5: Build the canonical shell through the package recipe

**Files:**

- Create: `packages/registry/shell/test-build-shell.sh`
- Modify: `packages/registry/shell/build-shell.sh`
- Modify: `packages/registry/shell/build.toml`
- Modify: `packages/registry/shell/package.toml`
- Modify: `scripts/test-homebrew-main-shell-closure.sh`

**Interfaces:**

- Consumes: resolver output/arch, isolated tracked source snapshot, canonical
  selection, platform rootfs sources, shell/demo configs, and public bottle
  URLs.
- Produces: only `$WASM_POSIX_DEP_OUT_DIR/shell.vfs.zst`.

- [ ] **Step 1: Write a failing package-wrapper contract test**

Use fake `bash`, `node`, and `npm` executables under the existing
`KANDELO_DEV_SHELL_TOOL_PATH` test boundary. Have fake `node` recognize
`mkrootfs.mjs` and `build-homebrew-flat-vfs-image.ts`, create their declared
outputs, and record arguments. Run two package builds concurrently and assert:

```bash
grep -Fq -- '--sab-size 536870912' "$log"
grep -Fq -- '--max-size 536870912' "$log"
grep -Fq -- '--selection */homebrew/main-shell-flat-selection.json' "$log"
grep -Fq -- '--shell-config */homebrew/main-shell-default.json' "$log"
grep -Fq -- '--demo-config */homebrew/main-shell-flat-demo.json' "$log"
grep -Fq -- '--out */shell.vfs.zst' "$log"
```

Require separate `.homebrew-shell-build` workspaces, credential removal,
`SOURCE_DATE_EPOCH=0`, cleanup on success and failure, rejection without
wasm32/output ownership, and no invocation of
`prepare-homebrew-main-shell-inputs.sh` or
`build-homebrew-main-shell-product.sh`.

- [ ] **Step 2: Run the wrapper test and observe retired-product invocation**

Run:

```bash
scripts/dev-shell.sh bash packages/registry/shell/test-build-shell.sh
```

Expected: FAIL because the current wrapper invokes the retired selection
product instead of the flat builder.

- [ ] **Step 3: Replace the package recipe with platform-base plus flat build**

Retain output/arch validation, credential stripping, deterministic environment,
isolated snapshot preparation, and cleanup. Read ABI from
`crates/shared/src/lib.rs`; create a 512 MiB platform-only base:

```bash
node "$SOURCE_ROOT/tools/mkrootfs/bin/mkrootfs.mjs" build \
  "$SOURCE_ROOT/MANIFEST" "$SOURCE_ROOT/images/rootfs" \
  --repo-root "$SOURCE_ROOT" \
  --sab-size 536870912 --max-size 536870912 \
  --kernel-abi "$ABI_VERSION" \
  -o "$PLATFORM_BASE"
```

Then invoke the flat builder through the snapshot's locked `tsx`:

```bash
"$SOURCE_ROOT/node_modules/.bin/tsx" \
  "$SOURCE_ROOT/images/vfs/scripts/build-homebrew-flat-vfs-image.ts" \
  --selection "$SOURCE_ROOT/homebrew/main-shell-flat-selection.json" \
  --base-image "$PLATFORM_BASE" \
  --bottle-cache "$BOTTLE_CACHE" \
  --shell-config "$SOURCE_ROOT/homebrew/main-shell-default.json" \
  --demo-config "$SOURCE_ROOT/homebrew/main-shell-flat-demo.json" \
  --out "$VFS" --report "$REPORT"
```

Verify image/report exist, copy only the VFS into the resolver output, and let
the trap remove base, cache, report, and snapshot.

- [ ] **Step 4: Replace package identity and retire canonical-package assertions from the legacy test**

Set shell revision 23, `commit = "UNPUBLISHED"`, and
`publication_state = "ready"`. Replace closed-selection/campaign inputs with
the canonical selection, flat builder, platform rootfs, configurations,
`host/src`, required session config sources, mkrootfs locks, and preparer
scripts. Update the manifest description to a fully materialized
`/opt/kandelo/homebrew` shell with no deferred authority. Retain only git,
node, npm, and tar host tools used by the recipe.

Keep `scripts/test-homebrew-main-shell-closure.sh` as a historical lazy-product
test, but remove its ownership of the canonical package wrapper, pending
selection state, and package build fake. Replace those assertions with one
call to `packages/registry/shell/test-build-shell.sh`; leave its legacy
workflow, artifact-lock, and mirror recovery tests intact.

- [ ] **Step 5: Run wrapper, registry, and historical-lane tests**

Run:

```bash
scripts/dev-shell.sh bash packages/registry/shell/test-build-shell.sh
scripts/dev-shell.sh bash packages/registry/shell/test-prepare-build-tools.sh
scripts/dev-shell.sh bash scripts/test-homebrew-main-shell-closure.sh
scripts/dev-shell.sh bash scripts/test-package-build-roots.sh
```

Expected: all commands exit 0.

- [ ] **Step 6: Build and inspect the real canonical shell**

Use a new temporary resolver cache and force the shell recipe through
`archive-stage`:

```bash
validation_root="$(mktemp -d)"
validation_head="$(git rev-parse HEAD)"
scripts/dev-shell.sh env \
  WASM_POSIX_BINARY_CACHE_ROOT="$validation_root/cache" \
  cargo xtask archive-stage \
    --package packages/registry/shell \
    --arch wasm32 \
    --out "$validation_root/archives" \
    --build-timestamp 2026-08-10T00:00:00Z \
    --build-host "local/canonical-shell@$validation_head" \
    --source-repository https://github.com/Automattic/kandelo \
    --source-commit "$validation_head" \
    --force-source-build
```

Inspect the staged member: ABI 42; 512 MiB maximum; exact canonical selection,
shell, and demo bindings; eager root-owned `/bin` and `/usr/bin` links for
`bash`, `sh`, and `env`; `/usr/bin/brew` targeting
`/opt/kandelo/homebrew/bin/brew`; 41 package reports; no lazy files or trees.
Extract the exact member for the later cross-host acceptance step:

```bash
shell_archive="$(find "$validation_root/archives" -maxdepth 1 -type f \
  -name 'shell-*.tar.zst' -print -quit)"
scripts/dev-shell.sh cargo xtask archive-extract-member \
  --archive "$shell_archive" \
  --member artifacts/shell.vfs.zst \
  --out "$validation_root/shell.vfs.zst"
```

- [ ] **Step 7: Commit the package cutover**

```bash
git add packages/registry/shell scripts/test-homebrew-main-shell-closure.sh
git commit -m "Packages: Build the canonical shell from flat Homebrew"
```

### Task 6: Advance and regenerate the full shell-derived package closure

**Files:**

- Modify: `packages/registry/node-vfs/build.toml`
- Modify: `packages/registry/node-vfs/package.toml`
- Modify: `packages/registry/node-vfs/build-node-vfs.sh`
- Modify: `packages/registry/lamp/build.toml`
- Modify: `packages/registry/lamp/package.toml`
- Modify: `packages/registry/wordpress/build.toml`
- Modify: `packages/registry/wordpress/package.toml`
- Modify: `packages/registry/nginx-vfs/build.toml`
- Modify: `packages/registry/nginx-vfs/package.toml`
- Modify: `packages/registry/nginx-php-vfs/build.toml`
- Modify: `packages/registry/nginx-php-vfs/package.toml`
- Modify: `packages/registry/program-packages.json`
- Modify: `host/test/shell-vfs-build.test.ts`

**Interfaces:**

- Consumes: shell revision 23 via each package's declared `shell@0.1.0`
  dependency.
- Produces: the six exact package identities in Global Constraints and a
  current generated package projection.

- [ ] **Step 1: Add a failing reverse-dependency revision assertion**

Extend the shell-derived builder inventory test with an exact map:

```ts
expect(shellDerivedRevisions).toEqual({
  "lamp": 12,
  "nginx-php-vfs": 3,
  "nginx-vfs": 3,
  "node-vfs": 15,
  "wordpress": 13,
});
```

Require each build file to carry `commit = "UNPUBLISHED"` and include
`shell-vfs-build.ts` plus the VFS metadata/config sources it consumes.

- [ ] **Step 2: Run the focused test and observe old revisions**

Run:

```bash
scripts/dev-shell.sh bash -c \
  'cd host && npx vitest run test/shell-vfs-build.test.ts'
```

Expected: FAIL on the current revision map.

- [ ] **Step 3: Advance truthful package identities and comments**

Apply the revisions in Global Constraints and set all five authored commits to
`UNPUBLISHED`. Replace comments claiming the shell owns lazy archives with
self-contained flat-shell wording. Do not change package versions, outputs,
dependencies, or fork-instrumentation policy.

- [ ] **Step 4: Regenerate the authoritative package projection**

Run:

```bash
scripts/dev-shell.sh bash -c '
  host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
  cargo run -p xtask --target "$host_target" --quiet -- \
    build-deps program-index \
    --source-repo-root "$(pwd -P)" \
    packages/registry packages/registry/program-packages.json
'
```

Then run the corresponding `program-index-check` command and require no diff
after a second generation.

- [ ] **Step 5: Run focused package identity checks**

Run:

```bash
scripts/dev-shell.sh bash -c \
  'cd host && npx vitest run test/shell-vfs-build.test.ts'
scripts/dev-shell.sh bash scripts/test-package-build-roots.sh
```

Expected: both commands exit 0.

- [ ] **Step 6: Build Node VFS from the exact local shell generation**

Force-source-build shell revision 23 and `node-vfs` revision 15 sequentially in
one fresh resolver cache:

```bash
validation_root="$(mktemp -d)"
validation_head="$(git rev-parse HEAD)"
for package in shell node-vfs; do
  scripts/dev-shell.sh env \
    WASM_POSIX_BINARY_CACHE_ROOT="$validation_root/cache" \
    cargo xtask archive-stage \
      --package "packages/registry/$package" \
      --arch wasm32 \
      --out "$validation_root/archives" \
      --build-timestamp 2026-08-10T00:00:00Z \
      --build-host "local/shell-node@$validation_head" \
      --source-repository https://github.com/Automattic/kandelo \
      --source-commit "$validation_head" \
      --force-source-build
done
node_archive="$(find "$validation_root/archives" -maxdepth 1 -type f \
  -name 'node-vfs-*.tar.zst' -print -quit)"
scripts/dev-shell.sh cargo xtask archive-extract-member \
  --archive "$node_archive" \
  --member artifacts/node-vfs.vfs \
  --out "$validation_root/node-vfs.vfs"
```

Inspect the produced Node image and assert:

```text
baseImage.sha256 == SHA-256(exact shell.vfs.zst)
homebrewFlat.requestedVfsFilename == shell.vfs.zst
demoConfig.sha256 == SHA-256(/etc/kandelo/demo.json)
no packageDeferredTrees/homebrewBootstrap/homebrew fields
```

The exact Node and Chromium runtime proof is Task 10 Step 3 after the CI asset
path can consume this flat product.

- [ ] **Step 7: Commit the reverse-dependency closure**

```bash
git add packages/registry/node-vfs packages/registry/lamp \
  packages/registry/wordpress packages/registry/nginx-vfs \
  packages/registry/nginx-php-vfs packages/registry/program-packages.json \
  host/test/shell-vfs-build.test.ts
git commit -m "Packages: Rebuild every canonical shell-derived image"
```

### Task 7: Make CI consume self-contained shell candidates

**Files:**

- Create: `scripts/inspect-canonical-flat-shell.ts`
- Create: `scripts/inspect-canonical-flat-shell.test.ts`
- Modify: `scripts/ci-homebrew-browser-mirror-state.sh`
- Modify: `scripts/ci-run-test-suite.sh`
- Modify: `scripts/test-homebrew-main-shell-closure.sh`
- Modify: `run.sh`
- Modify: `.github/workflows/staging-build.yml`
- Modify: `.github/scripts/test-merge-candidate-workflows.sh`

**Interfaces:**

- Inspector input: `--image`, `--selection`, `--shell-config`,
  `--demo-config`, and `--out`.
- Inspector output: schema 1 JSON containing exact image, selection,
  configuration, capacity, and `{kind:"flat-self-contained",
  mirror_required:false}` transport bindings.

- [ ] **Step 1: Write failing inspector and resolved-state tests**

Build a small flat fixture and assert the inspector validates selection digest,
512 MiB capacity, ABI, `homebrewFlat`, `shellConfig`, `demoConfig`, no lazy
entries/trees, eager shell/brew, and exact file hashes. Mutate every binding,
add one lazy file, cross the selection, and add a symlinked input; require
rejection.

Update the CI state fixture so a resolved canonical flat image yields:

```json
{"mode":"resolved","mirror_required":false,"transport":"flat-self-contained"}
```

and rejects a resolved old lazy image under the new canonical selection.

- [ ] **Step 2: Run tests and observe the missing inspector/mirror mismatch**

Run:

```bash
scripts/dev-shell.sh npx tsx --test \
  scripts/inspect-canonical-flat-shell.test.ts
scripts/dev-shell.sh bash scripts/test-homebrew-main-shell-closure.sh
```

Expected: FAIL because the inspector does not exist and resolved state requires
a mirror.

- [ ] **Step 3: Implement exact flat-shell inspection**

Use no-follow bounded reads, `parseCanonicalHomebrewBottleSelection`,
`MemoryFileSystem.fromImagePreservingCapacity`, both config parsers, and the
resource-policy resolver. Emit the report only after all checks pass. The core
metadata assertion is:

```ts
expectExactRecord(metadata.homebrewFlat, {
  selectionSha256,
  requestedVfsFilename: selection.requestedVfsFilename,
  resourcePolicy: selection.resourcePolicy,
});
expect(fs.exportLazyEntries()).toHaveLength(0);
expect(fs.exportLazyArchiveEntries()).toHaveLength(0);
```

The implementation uses ordinary errors rather than Vitest assertions and
publishes the output with no-clobber semantics.

- [ ] **Step 4: Make resolved CI state require the inspector report**

During `create`, invoke the inspector against the selected shell and checked-in
canonical inputs. Record `transport` and `mirror_required=false`; validate the
same report again at producer and consumer boundaries. Keep the historical
publication-blocked and receipt-bound lazy-candidate modes intact for audit and
recovery, but no current resolved path may call
`recover-homebrew-bottle-mirror.ts`.

Change `prepare_ci_homebrew_browser_mirror` to return immediately for the
validated `flat-self-contained` transport. It must still reject an existing
closed mirror directory.

- [ ] **Step 5: Stop ordinary browser preparation from staging a lazy bootstrap**

In `cmd_prepare_browser`, fetch/resolve package assets without calling
`prepare_browser_homebrew_bootstrap`. Retain the bootstrap preparer only behind
the explicit historical `--require-sealed-homebrew-selection` path. Update the
function-level tests to require ordinary flat preparation to create no
`homebrew-bootstrap.zip` and the explicit legacy option to keep its existing
strict behavior.

- [ ] **Step 6: Route the required shell gate through package staging**

Remove `homebrew-main-shell-proof` from ordinary PR staging. Keep the historical
required check display name `exact current lazy shell (Node + Chromium)` so
branch protection does not silently disappear, but make its aggregate require
the generic package `test-gate`/browser results selected by
`homebrew-main-shell-prerequisites`. Update its comments and error text to say
the canonical shell is now package-owned; leave
`homebrew-main-shell-ci.yml` callable only for historical recovery.

Expose a boolean preflight output when the staged matrix contains wasm32
`node-vfs`. In the browser test cell, run the exact slow npm acceptance when
that output is true:

```bash
npx playwright test test/kandelo-node.spec.ts \
  --grep 'Kandelo Node demo installs cowsay with npm' \
  --project=chromium
```

- [ ] **Step 7: Run current CI contract validation**

Run:

```bash
scripts/dev-shell.sh npx tsx --test \
  scripts/inspect-canonical-flat-shell.test.ts
scripts/dev-shell.sh bash scripts/test-homebrew-main-shell-closure.sh
scripts/dev-shell.sh bash .github/scripts/test-merge-candidate-workflows.sh
scripts/dev-shell.sh bash tests/scripts/ci-run-test-suite-groups.test.sh
scripts/dev-shell.sh bash -n run.sh
scripts/dev-shell.sh bash -n scripts/ci-homebrew-browser-mirror-state.sh
```

Expected: all commands exit 0.

- [ ] **Step 8: Commit current staging consumption**

```bash
git add scripts/inspect-canonical-flat-shell.ts \
  scripts/inspect-canonical-flat-shell.test.ts \
  scripts/ci-homebrew-browser-mirror-state.sh \
  scripts/ci-run-test-suite.sh scripts/test-homebrew-main-shell-closure.sh \
  run.sh .github/workflows/staging-build.yml \
  .github/scripts/test-merge-candidate-workflows.sh
git commit -m "CI: Validate the package-owned self-contained shell"
```

### Task 8: Deploy Pages only from activated canonical packages

**Files:**

- Create: `apps/browser-demos/test/kandelo-canonical-flat-shell.spec.ts`
- Modify: `.github/workflows/activate-merge-candidate.yml`
- Modify: `.github/workflows/browser-demos-pages.yml`
- Modify: `.github/scripts/test-merge-candidate-workflows.sh`
- Modify: `scripts/verify-browser-shell-vfs-asset.sh`
- Modify: `scripts/test-verify-browser-shell-vfs-asset.sh`
- Modify: `scripts/ci-check-pages-deployment.sh`
- Modify: `scripts/test-pages-deployment-contract.sh`

**Interfaces:**

- Activation step output: `activated_any` string boolean.
- Pages consumes resolver-selected `programs/shell.vfs.zst` and
  `programs/node-vfs.vfs.zst`, plus the inspector report.
- Asset verifier accepts an optional exact asset stem, defaulting to
  `shell.vfs`; Pages also passes `node-vfs.vfs`.

- [ ] **Step 1: Add failing activation-dispatch structural tests**

Require `actions: write`, an activation step ID, initialization to false,
setting true after each successful activation, writing the output before the
step exits, and this post-step condition:

```yaml
if: always() && steps.activate.outputs.activated_any == 'true'
run: gh workflow run browser-demos-pages.yml --ref "$GITHUB_DEFAULT_BRANCH"
```

Assert an empty reconciliation plan cannot dispatch.

- [ ] **Step 2: Add failing Pages and generic asset-verifier tests**

Extend the verifier fixture with one hashed
`node-vfs.vfs-<hash>.zst` and require exact comparison only when the third
argument is `node-vfs.vfs`. Update the Pages checker to reject:

- `--require-sealed-homebrew-selection`;
- bootstrap/mirror/artifact-lock inputs;
- absence of `inspect-canonical-flat-shell.ts` or its negative tests;
- absence of exact shell and Node hashed-asset verification;
- source fallback;
- absence of the canonical flat-shell Chromium test; and
- absence of the exact cowsay Playwright invocation.

- [ ] **Step 3: Run structural tests and observe old lazy workflow assumptions**

Run:

```bash
scripts/dev-shell.sh bash .github/scripts/test-merge-candidate-workflows.sh
scripts/dev-shell.sh bash scripts/test-pages-deployment-contract.sh
```

Expected: FAIL on missing dispatch and the old bootstrap/mirror Pages lane.

- [ ] **Step 4: Record activation success and dispatch Pages**

Give the activation step `id: activate`, keep processing candidates after an
individual failure, and use:

```bash
activated_any=false
if bash scripts/dev-shell.sh bash .github/scripts/activate-merge-candidate.sh \
    --candidate-tag "$candidate_tag" --pr-number "$pr_number"
then
  activated_any=true
else
  failed=1
fi
# after the loop, before exit
echo "activated_any=$activated_any" >>"$GITHUB_OUTPUT"
exit "$failed"
```

Dispatch Pages in an `always()` step only for true. Keep schedule/manual empty
scans quiet and retain least privilege apart from the required `actions: write`.

- [ ] **Step 5: Replace Pages lazy-product admission with canonical package admission**

Run `./run.sh --fetch-only prepare-browser` as the final preparation command.
Resolve both exact images, inspect the shell against checked-in selection and
configs, record both SHA-256 values, build the site, and verify both hashed
assets. Delete bootstrap copies, mirror URLs, lazy artifact locks, and all
strict lazy-shell environment variables from this workflow.

Boot `test/kandelo-canonical-flat-shell.spec.ts` against `dist` with the shell
digest, then run:

```bash
npx playwright test test/kandelo-node.spec.ts \
  --grep 'Kandelo Node demo installs cowsay with npm' \
  --project=chromium
```

Keep the full gallery build, documentation trees, size bound, newest-run check,
single writer, and pinned deploy action unchanged.

- [ ] **Step 6: Implement the flat-shell Chromium acceptance**

Load the normal Kandelo page, verify the requested shell response SHA-256,
wait for the terminal, and execute through the selected shell:

```bash
/usr/bin/brew --version && \
/opt/kandelo/homebrew/bin/ruby --version && \
/opt/kandelo/homebrew/bin/bash -lc 'printf KANDELO_FLAT_SHELL_OK'
```

Assert zero command status, `KANDELO_FLAT_SHELL_OK`, no VFS I/O error, and no
lazy Homebrew download rows. This test uses the ordinary production page, not
the private flat-shipping proof page.

- [ ] **Step 7: Run workflow, browser-support, and syntax checks**

Run:

```bash
scripts/dev-shell.sh bash .github/scripts/test-merge-candidate-workflows.sh
scripts/dev-shell.sh bash scripts/test-pages-deployment-contract.sh
scripts/dev-shell.sh bash scripts/test-verify-browser-shell-vfs-asset.sh
scripts/dev-shell.sh bash scripts/ci-check-pages-deployment.sh
scripts/dev-shell.sh bash -n scripts/verify-browser-shell-vfs-asset.sh
scripts/dev-shell.sh actionlint \
  .github/workflows/activate-merge-candidate.yml \
  .github/workflows/browser-demos-pages.yml
```

Expected: every command exits 0.

- [ ] **Step 8: Commit activation and Pages sequencing**

```bash
git add .github/workflows/activate-merge-candidate.yml \
  .github/workflows/browser-demos-pages.yml \
  .github/scripts/test-merge-candidate-workflows.sh \
  apps/browser-demos/test/kandelo-canonical-flat-shell.spec.ts \
  scripts/verify-browser-shell-vfs-asset.sh \
  scripts/test-verify-browser-shell-vfs-asset.sh \
  scripts/ci-check-pages-deployment.sh \
  scripts/test-pages-deployment-contract.sh
git commit -m "Release: Deploy Pages after canonical package activation"
```

### Task 9: Update authoritative publication documentation

**Files:**

- Modify: `docs/package-management.md`
- Modify: `docs/binary-releases.md`
- Modify: `docs/browser-support.md`
- Modify: `docs/homebrew-publishing.md`
- Modify: `docs-site/.vitepress/homebrew-doc-links.test.mjs`

**Interfaces:**

- Documents current implemented behavior only; the already-committed
  `docs/future-improvements.md` owns historical/persisted lazy image support.

- [ ] **Step 1: Add a documentation contract assertion before prose edits**

Extend `docs-site/.vitepress/homebrew-doc-links.test.mjs` to require all four
documents to name `homebrew/main-shell-flat-selection.json`, the canonical
package release, self-contained `/opt/kandelo/homebrew`, and post-activation
Pages dispatch. Require current sections not to call shell revision 23 pending
or Pages a lazy mirror consumer.

- [ ] **Step 2: Run the docs assertion and observe stale current behavior**

Run the exact Node or shell documentation check containing the new assertions.
Expected: FAIL on pending/lazy current documentation.

- [ ] **Step 3: Describe the implemented current lifecycle**

Replace the transition section in package management with the package-owned
flat shell and six-revision rebuild. Explain in binary releases that candidate
activation dispatches Pages after index movement. Update the browser image
table so shell and Node are self-contained and Pages verifies both exact
hashed assets plus npm/cowsay. Add a clearly dated current-state section to
Homebrew publishing and label the closed-selection/lazy-mirror procedures as
historical recovery, not the normal publisher.

- [ ] **Step 4: Run docs checks and whitespace validation**

Run:

```bash
scripts/dev-shell.sh node --test docs-site/.vitepress/homebrew-doc-links.test.mjs
scripts/dev-shell.sh npm run docs:build
scripts/dev-shell.sh node --test docs-site/.vitepress/homebrew-doc-output.test.mjs
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit current publication docs**

```bash
git add docs/package-management.md docs/binary-releases.md \
  docs/browser-support.md docs/homebrew-publishing.md \
  docs-site/.vitepress/homebrew-doc-links.test.mjs
git commit -m "Docs: Describe canonical flat shell publication"
```

### Task 10: Verify the complete candidate locally

**Files:**

- No intentional source changes; remove only exact task-generated artifacts.

**Interfaces:**

- Produces: evidence for reconciliation, package graph, Node/browser behavior,
  workflow structure, and ABI non-change.

- [ ] **Step 1: Run focused unit and contract suites from a clean dependency install**

Run:

```bash
scripts/dev-shell.sh bash -c 'cd host && npm ci --no-audit --no-fund'
scripts/dev-shell.sh bash -c 'cd host && npm run typecheck'
scripts/dev-shell.sh bash -c 'cd host && npx vitest run \
  test/homebrew-bottle-selection.test.ts \
  test/homebrew-flat-vfs-builder.test.ts \
  test/homebrew-flat-vfs-image.test.ts \
  test/homebrew-flat-vfs-cli.test.ts \
  test/shell-vfs-build.test.ts'
scripts/dev-shell.sh bash .github/scripts/test-reconcile-merge-candidates.sh
scripts/dev-shell.sh bash .github/scripts/test-merge-candidate-workflows.sh
scripts/dev-shell.sh bash scripts/test-homebrew-main-shell-closure.sh
scripts/dev-shell.sh bash scripts/test-pages-deployment-contract.sh
scripts/dev-shell.sh bash scripts/test-package-build-roots.sh
scripts/dev-shell.sh bash scripts/check-abi-version.sh
```

Expected: every command exits 0 and ABI snapshot remains unchanged.

- [ ] **Step 2: Build every changed package candidate**

Use one fresh cache and one archive directory to build shell 23, node-vfs 15,
lamp 12, wordpress 13, nginx-vfs 3, and nginx-php-vfs 3 in dependency order:

```bash
validation_root="$(mktemp -d)"
validation_head="$(git rev-parse HEAD)"
validation_host="$(scripts/dev-shell.sh rustc -vV | awk '/^host:/ { print $2 }')"
for package in shell node-vfs lamp wordpress nginx-vfs nginx-php-vfs; do
  scripts/dev-shell.sh cargo run --release -p xtask \
    --target "$validation_host" --quiet -- archive-stage \
      --package "packages/registry/$package" \
      --arch wasm32 \
      --out "$validation_root/archives" \
      --build-timestamp 2026-08-10T00:00:00Z \
      --build-host "local/full-closure@$validation_head" \
      --source-repository https://github.com/Automattic/kandelo \
      --source-commit "$validation_head" \
      --cache-root "$validation_root/cache" \
      --binaries-dir "$(pwd)/binaries" \
      --force-source-build
done
```

List every produced archive, require exactly one current identity for each of
the six packages, and use `archive-extract-member` to re-read each declared
artifact from the archive rather than trusting the resolver cache tree. The
workflow-level staging validator is exercised by
`.github/scripts/test-merge-candidate-workflows.sh` above and by the real PR
staging release in Task 11.

- [ ] **Step 3: Run Node and Chromium acceptance against exact staged bytes**

Materialize the six local candidates, run the Node shell startup proof, then:

```bash
scripts/dev-shell.sh env PREPARE_BROWSER_ASSETS=1 \
  bash scripts/ci-run-test-suite.sh browser all
```

Also run the exact slow Node spec explicitly. Require npm exit 0, no
`TAR_ENTRY_ERROR`, no `EACCES`, and output containing `< Kandelo >`.

- [ ] **Step 4: Run broad non-kernel regression surfaces**

Run the complete Vitest suite and browser asset check. Kernel/POSIX suites are
not required by semantics because no kernel/runtime behavior changed; report
that they were considered and not rerun unless the final diff unexpectedly
touches their contracts.

- [ ] **Step 5: Clean and audit the worktree**

Restore the task-dirtied `libc/musl` submodule to its recorded gitlink only
after proving its dirt came from this task, remove the exact generated
`apps/browser-demos/test-results/` directory, and preserve user-owned dirt.
Run:

```bash
git status --short
git diff --check
git diff --stat origin/main...HEAD
git log --format=fuller origin/main..HEAD
```

Expected: only intentional tracked changes plus the user's preexisting
`tests/sortix/os-test` and `.serena/` remain.

### Task 11: Publish through the reviewed merge lifecycle

**Files:**

- External GitHub state only after the exact local head is committed.

**Interfaces:**

- Produces: one reviewed PR, immutable merge candidates, canonical ABI-42
  package assets/indexes, and a post-activation Pages run.

- [ ] **Step 1: Push and open the purpose-led pull request**

Push with lease to `origin/emdash/npm-install-failing-uzuds`. Create a PR whose
title is `Restore canonical ABI-42 package publication` and whose body begins
with `## Why`, followed by `## What changed`, `## Validation`, and rollout/risk
notes wrapped at 72 columns.

- [ ] **Step 2: Monitor every required check and fix root causes**

Watch staging, the retained required shell aggregate, merge-candidate workflow
tests, package matrix builds, browser suites, and Pages contract tests. For any
failure, inspect the complete job log, reproduce the focused command locally,
add a failing regression test, implement the smallest contract-level repair,
push, and restart observation.

- [ ] **Step 3: Prepare and merge the exact green head**

Add the repository's `ready-to-ship` label only after the exact head is green.
Confirm prepare-merge seals candidates for all six expected revisions and the
merge-gate target URL names that exact candidate. Merge without bypassing
branch protection or mutating candidate releases.

- [ ] **Step 4: Monitor activation and post-activation Pages dispatch**

Confirm reconciliation skips
`merge-candidate-abi-v42-pr-1122-run-30391739960-attempt-1` as terminally
rejected, activates the new candidate, updates `binaries-abi-v42/index.toml`,
and dispatches `browser-demos-pages.yml`. A partial candidate failure must
remain visible; do not edit canonical indexes by hand.

### Task 12: Verify anonymous live publication

**Files:**

- No source changes unless live verification reveals a reproducible defect;
  such a defect starts a new failing-test cycle and revision advance.

**Interfaces:**

- Consumes: anonymous GitHub release assets and deployed GitHub Pages.
- Produces: final exact digests and browser acceptance evidence.

- [ ] **Step 1: Verify canonical index identities anonymously**

Download `binaries-abi-v42/index.toml` without a token. Require shell 23,
node-vfs 15, lamp 12, wordpress 13, nginx-vfs 3, and nginx-php-vfs 3, then
download every named archive and verify its index SHA-256 and size.

- [ ] **Step 2: Verify live shell and Node asset provenance**

Extract shell and Node VFS members, run
`scripts/inspect-canonical-flat-shell.ts` on the shell, and inspect Node metadata
for exact shell base digest, flat lineage, current demo binding, ABI 42, and no
lazy authority.

- [ ] **Step 3: Verify deployed Pages and npm/cowsay**

Wait for the post-activation Pages workflow and deployed `gh-pages` commit.
Run the canonical flat-shell Playwright test and exact slow npm/cowsay test
against the public Pages base. Require successful `cowsay` execution and no
materialization, tar, permission, or stale-asset error.

- [ ] **Step 4: Mark the active goal complete with evidence**

Record package/index digests, PR/merge/activation/Pages run URLs, exact local
and live validation commands, and every unrun suite. Only then mark the active
goal complete and report the final outcome.
