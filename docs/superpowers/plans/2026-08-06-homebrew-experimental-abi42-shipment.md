# Experimental ABI-42 Homebrew Shipment Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` to implement this plan task by
> task, with a specification review and code-quality review after each task.

**Goal:** Publish one explicitly experimental ABI-42 VFS built from the 40
already-public canonical-prefix bottles plus one freshly built Ruby bottle,
and prove stock in-guest Homebrew installation in Node.js and Chromium.

**Architecture:** Keep the existing ordinary one-Formula publisher unchanged
for the single Ruby rebuild. Add a parallel, provenance-free descriptor and
selection contract for product composition. Adapt the existing safe bottle
materializer to that contract, consume the Homebrew bootstrap support-data
bottle through an explicit code-owned runtime policy, and publish the VFS from
a small workflow with build and release credentials in separate jobs.

**Tech stack:** TypeScript, Vitest, Bash, Python/Ruby only where existing
publisher helpers require them, Kandelo `MemoryFileSystem`, upstream Homebrew
CLI, GitHub Actions, GHCR, and GitHub Releases.

**Repositories:**

- `Automattic/kandelo`, starting from ABI-42 `main` at `af80a443...`, then
  merged forward to the post-#1231 protected-main commit without resetting or
  cleaning any worktree.
- `Kandelo-dev/homebrew-tap-core`, starting from `main` at `d98a00a...`, in a
  new isolated worktree.

## Scope decisions

- The Ruby build uses `.github/workflows/publish-bottles.yml` with the ordinary
  `publish-kandelo-bottles` dispatch and no prefix-campaign inputs.
- Do not modify the 5,674-line reusable bottle publisher before Ruby ships.
- Do not create a second bottle uploader, Formula merger, or GHCR index
  implementation.
- The flat selection contains materialization facts only. Campaign, workflow,
  source ancestry, attestation, promotion, signature, and generation fields
  are rejected.
- The 40 legacy handoff releases are one-time import sources. Their campaign
  identity is not copied into active output.
- The experimental image contains all 41 selected bottles. The existing
  release-critical Bzip2 proof removes the precomposed Bzip2 keg in each fresh
  guest, then performs a genuine `brew install --force-bottle` and executes a
  compression round-trip.
- Do not gate the first release on Pages, the default shell, upgrade, durable
  reboot, general remove coverage, Firefox, WebKit, wasm64, campaign
  quarantine, or upstream workflow convergence.
- Do not touch `ABI_VERSION` or `abi/snapshot.json`.

## External prerequisites

1. GitHub Actions must recover from incident `qcvjkzcs7j74` before rerunning
   hosted checks or dispatching Ruby.
2. Kandelo PR #1231, “Restore sealed Formula browser runtime,” must merge to
   protected `main`. Ordinary bottle publication admits only current main.
3. The 40 f826 handoff assets and their GHCR blobs must remain anonymously
   readable. Any missing blob is a real missing package, not a reason to add a
   fallback.

Local implementation and tap-source preparation do not wait on those
prerequisites.

## Task 1: Define the flat bottle descriptor

**Files:**

- Create: `host/src/homebrew-bottle-types.ts`
- Create: `host/src/homebrew-bottle-descriptor.ts`
- Create: `host/test/homebrew-bottle-descriptor.test.ts`
- Modify: `host/src/homebrew-vfs-planner.ts`
- Modify: `host/src/index.ts`

**Step 1: Write the failing descriptor tests**

Add focused tests for this public shape:

```ts
export interface HomebrewBottleDependencyIdentity {
  fullName: string;
  version: string;
  revision: number;
  bottleRebuild: number;
  bottleSha256: string;
}

export interface HomebrewBottleSupportOutput {
  name: string;
  kegRelativePath: string;
  sha256: string;
  bytes: number;
}

export interface HomebrewBottleDescriptor {
  schema: 1;
  name: string;
  fullName: string;
  version: string;
  revision: number;
  bottleRebuild: number;
  arch: HomebrewBottleArch;
  kandeloAbi: number;
  bottleTag: string;
  layout: "kandelo-homebrew-v1";
  materialization: "keg" | "homebrew-runtime-support-v1";
  prefix: string;
  cellar: string;
  keg: string;
  payloadRoot: string;
  receipts: string[];
  links: HomebrewLinkEntry[];
  pathPrepend: string[];
  supportOutputs: HomebrewBottleSupportOutput[];
  dependencies: HomebrewBottleDependencyIdentity[];
  url: string;
  sha256: string;
  bytes: number;
  compression: "gzip";
}
```

Tests must reject:

- missing or extra keys;
- uppercase or malformed digests;
- zero, negative, fractional, or unsafe byte counts;
- non-HTTPS and non-public URLs;
- duplicate dependencies, receipts, links, or support outputs;
- arbitrary prefix, cellar, keg, payload-root, link, receipt, output, or PATH
  destinations;
- a support-data output on an ordinary keg;
- `homebrew-runtime-support-v1` on any identity other than
  `kandelo-dev/tap-core/homebrew-bootstrap`;
- a bootstrap descriptor without exactly
  `libexec/homebrew-bootstrap.zip` and `libexec/homebrew-brew.env`; and
- all spellings of campaign/provenance data, including `tapCommit`,
  `kandeloCommit`, `builtFrom`, `builtBy`, `generatedAt`, `releaseTag`,
  `workflow`, `campaign`, `provenance`, `signature`, `promotion`, and their
  snake-case forms.

Tests must prove canonical JSON encoding is deterministic and ends in one
newline.

**Step 2: Run the test and confirm RED**

```bash
scripts/dev-shell.sh bash -c \
  'cd host && npx vitest run test/homebrew-bottle-descriptor.test.ts'
```

Expected: failure because the descriptor module does not exist.

**Step 3: Implement the common types and descriptor parser**

- Move `HomebrewBottleArch` and `HomebrewLinkEntry` into
  `homebrew-bottle-types.ts`.
- Import and re-export those types from `homebrew-vfs-planner.ts` so existing
  callers do not break.
- Export `projectHomebrewBottleDescriptor`,
  `encodeHomebrewBottleDescriptor`, and `HomebrewBottleDescriptorError`.
- Derive layout paths from `KANDELO_HOMEBREW_GUEST_LAYOUT`; never accept paths
  merely because they are absolute.
- Validate GHCR digest URLs and release-asset URLs as closed public URL forms.

**Step 4: Run focused validation and confirm GREEN**

```bash
scripts/dev-shell.sh bash -c \
  'cd host && npx vitest run test/homebrew-bottle-descriptor.test.ts'
scripts/dev-shell.sh bash -c 'cd host && npm run typecheck'
```

**Step 5: Commit**

```bash
git add host/src/homebrew-bottle-types.ts \
  host/src/homebrew-bottle-descriptor.ts \
  host/src/homebrew-vfs-planner.ts host/src/index.ts \
  host/test/homebrew-bottle-descriptor.test.ts
git commit -m "Define provenance-free Homebrew bottle descriptors"
```

## Task 2: Project verified publisher output into a neutral descriptor

**Files:**

- Create: `scripts/homebrew-project-bottle-descriptor.ts`
- Create: `scripts/homebrew-project-bottle-descriptor.test.ts`
- Modify: `package.json` only if a script entry is needed

**Step 1: Write failing projection tests**

Use synthetic, bounded fixtures representing:

- one ordinary Bzip2 sidecar, link manifest, and bottle receipt;
- one Homebrew-bootstrap support-data sidecar and bottle; and
- one dependencyful Ruby sidecar.

The projector takes already-verified bottle bytes, one package entry from
`composition.sidecars-input.json`, and the canonical Task 1 descriptors for
each direct dependency. It must independently recompute bottle SHA-256/size,
inspect the TAR, read the actual `INSTALL_RECEIPT.json`, and emit only the
descriptor shape from Task 1. Dependency descriptors are generated first in
topological order; they are the authority for dependency revision, bottle
rebuild, and bottle SHA-256 values that are absent from a per-Formula sidecar.

For support data, inspect the two fixed keg members, recompute their digests
and sizes, and emit the closed support-output list. Do not parse Formula Ruby
to discover these members.

Tests must prove all provenance fields in the source are absent recursively
from output, that receipt/sidecar/dependency-descriptor disagreement fails,
and that missing, duplicate, or unused dependency descriptors fail.

**Step 2: Run and confirm RED**

```bash
scripts/dev-shell.sh npx vitest run \
  scripts/homebrew-project-bottle-descriptor.test.ts
```

**Step 3: Implement the projection CLI**

Supported arguments:

```text
--sidecars-input <json>
--formula <name>
--arch <wasm32|wasm64>
--bottle <tar.gz>
--public-url <https-url>
--dependency-descriptor <descriptor.json>  # repeat once per direct dependency
--out <descriptor.json>
```

Use `projectHomebrewBottleDescriptor` for the final validation and canonical
encoder. Read dependency descriptors through the canonical Task 1 parser,
sort the emitted dependency identities by canonical full name, and never use
handoff-manifest digests as bottle digests. The CLI writes atomically and
refuses an existing output path.

**Step 4: Run focused tests and shell/type checks**

```bash
scripts/dev-shell.sh npx vitest run \
  scripts/homebrew-project-bottle-descriptor.test.ts
scripts/dev-shell.sh bash -c 'cd host && npm run typecheck'
```

**Step 5: Commit**

```bash
git add scripts/homebrew-project-bottle-descriptor.ts \
  scripts/homebrew-project-bottle-descriptor.test.ts package.json
git commit -m "Project bottle outputs into neutral descriptors"
```

## Task 3: Define the flat selection and code-owned resource policy

**Files:**

- Create: `host/src/homebrew-bottle-selection.ts`
- Create: `host/src/homebrew-vfs-resource-policy.ts`
- Create: `host/test/homebrew-bottle-selection.test.ts`
- Create: `scripts/homebrew-validate-flat-selection.ts`
- Create: `scripts/homebrew-validate-flat-selection.test.ts`
- Modify: `host/src/index.ts`

**Step 1: Write the failing selection tests**

Use this shape:

```ts
export interface HomebrewBottleSelection {
  schema: 1;
  name: string;
  arch: HomebrewBottleArch;
  kandeloAbi: number;
  bottles: HomebrewBottleDescriptor[];
  requestedVfsFilename: string;
  resourcePolicy: "kandelo-homebrew-vfs-generous-v1";
  runtimeSupport: "kandelo-homebrew-bootstrap-v1";
}
```

Test rejection of:

- duplicate Formula identities or Cellar keg paths;
- mixed architecture, ABI, bottle tag, or layout;
- missing dependency nodes;
- edge drift across full name, version, revision, bottle rebuild, or bottle
  SHA-256;
- dependency cycles or a dependency listed after its consumer;
- unsorted dependency arrays;
- absent or duplicate Homebrew bootstrap runtime descriptor;
- arbitrary resource numbers in the selection; and
- a filename not containing both `experimental` and `abi42`.

Test stable order-preserving encoding and canonical parse rejection.

**Step 2: Run and confirm RED**

```bash
scripts/dev-shell.sh bash -c \
  'cd host && npx vitest run test/homebrew-bottle-selection.test.ts'
```

**Step 3: Implement validation and policy resolution**

Export:

```ts
projectHomebrewBottleSelection(value, { expectedAbi? })
encodeHomebrewBottleSelection(selection)
parseCanonicalHomebrewBottleSelection(bytes, options)
homebrewBottleSelectionSha256(bytes)
resolveHomebrewVfsResourcePolicy(id)
```

Add a thin CLI that reads one bounded regular file, parses canonical selection
bytes through the host API, optionally requires `--expected-abi`, and prints
the selection SHA-256 plus measured compressed bytes and descriptor count. It
must not fetch bottles or rewrite the selection.

The policy is code-owned and must bound:

- per-bottle compressed bytes, expanded bytes, entry count, path bytes, and
  link bytes;
- aggregate compressed/expanded bytes and entries;
- support-data ZIP bytes, expanded bytes, and entries; and
- final VFS image capacity.

Start with generous ceilings compatible with `vfs/tar.ts`,
`vfs/deferred-tree-limits.ts`, and the browser VFS format. Measure the actual
41-bottle selection before freezing the final values. Do not add a Ruby-only
exception.

**Step 4: Run and confirm GREEN**

```bash
scripts/dev-shell.sh bash -c \
  'cd host && npx vitest run test/homebrew-bottle-selection.test.ts'
scripts/dev-shell.sh npx vitest run \
  scripts/homebrew-validate-flat-selection.test.ts
scripts/dev-shell.sh bash -c 'cd host && npm run typecheck'
```

**Step 5: Commit**

```bash
git add host/src/homebrew-bottle-selection.ts \
  host/src/homebrew-vfs-resource-policy.ts host/src/index.ts \
  host/test/homebrew-bottle-selection.test.ts \
  scripts/homebrew-validate-flat-selection.ts \
  scripts/homebrew-validate-flat-selection.test.ts
git commit -m "Validate flat Homebrew bottle selections"
```

## Task 4: Share safe keg materialization with the flat path

**Files:**

- Create: `host/src/homebrew-vfs-materializer.ts`
- Create: `host/test/homebrew-flat-vfs-builder.test.ts`
- Modify: `host/src/homebrew-vfs-builder.ts`
- Modify: `host/src/homebrew-vfs-planner.ts`
- Modify: `host/test/homebrew-vfs-builder.test.ts`
- Modify: `host/test/homebrew-vfs-planner.test.ts`

**Step 1: Write failing flat-builder tests**

Add a provenance-free plan:

```ts
export interface HomebrewFlatVfsPlan {
  schema: 1;
  name: string;
  arch: HomebrewBottleArch;
  kandeloAbi: number;
  selectionSha256: string;
  requestedVfsFilename: string;
  resourcePolicy: HomebrewVfsResourcePolicyId;
  runtimeSupport: "kandelo-homebrew-bootstrap-v1";
  packages: HomebrewBottleDescriptor[];
}
```

Add tests for:

- exact SHA-256 and compressed-size validation before TAR parsing;
- dependency-first staging;
- traversal, escaping symlink/hardlink, unsupported entry, conflict,
  executable-mode, keg-containment, relocation, and opt-link behavior already
  covered by the legacy builder;
- actual receipt runtime dependencies matching descriptor edges;
- aggregate resource accounting across bottles;
- a late failure returning no usable filesystem/result; and
- `/etc/kandelo/homebrew-vfs.json` containing selection digest, ABI/arch,
  package identities, counts, receipts, links, and PATH, with none of the
  forbidden provenance keys.

**Step 2: Run and confirm RED**

```bash
scripts/dev-shell.sh bash -c \
  'cd host && npx vitest run test/homebrew-flat-vfs-builder.test.ts'
```

**Step 3: Extract the narrow materialization core**

Move only functional operations into `homebrew-vfs-materializer.ts`:

- bottle byte verification;
- bounded TAR parsing;
- staging and hardlink resolution;
- receipt validation and dependency extraction;
- placeholder relocation;
- declared link application; and
- canonical opt-link construction.

Keep the existing `buildHomebrewVfs(HomebrewVfsPlan, ...)` API and report
unchanged by adapting the legacy plan into that core.

Add:

```ts
planHomebrewVfsSelection(canonicalSelectionBytes, options?)
buildHomebrewVfsSelection(plan, options)
```

Do not fill legacy tap commit, release tag, built-from, cache key, migration
lock, or catalog fields with placeholders.

**Step 4: Run focused legacy and flat regression tests**

```bash
scripts/dev-shell.sh bash -c \
  'cd host && npx vitest run test/homebrew-flat-vfs-builder.test.ts test/homebrew-vfs-builder.test.ts test/homebrew-vfs-planner.test.ts'
scripts/dev-shell.sh bash -c 'cd host && npm run typecheck'
```

**Step 5: Commit**

```bash
git add host/src/homebrew-vfs-materializer.ts \
  host/src/homebrew-vfs-builder.ts host/src/homebrew-vfs-planner.ts \
  host/test/homebrew-flat-vfs-builder.test.ts \
  host/test/homebrew-vfs-builder.test.ts \
  host/test/homebrew-vfs-planner.test.ts
git commit -m "Share safe bottle materialization with flat VFS builds"
```

## Task 5: Materialize the Homebrew runtime support bottle

**Files:**

- Create: `host/src/homebrew-runtime-support-materializer.ts`
- Create: `host/test/homebrew-runtime-support-materializer.test.ts`
- Modify: `host/src/homebrew-vfs-builder.ts`
- Modify: `host/src/index.ts`

**Step 1: Write failing support-data tests**

Construct a small support-data bottle containing:

- `libexec/homebrew-bootstrap.zip` with `bin/brew`, library files, an
  executable, a directory, and a safe symlink; and
- `libexec/homebrew-brew.env` with the exact closed environment keys.

Test that the runtime policy:

- verifies descriptor output hashes/sizes before ZIP parsing;
- overlays the ZIP at `/opt/kandelo/homebrew`;
- preserves executable modes and safe symlinks;
- rejects traversal, absolute paths, duplicate paths, unsupported ZIP
  methods, oversized members, expansion over budget, and destination
  conflicts;
- creates `/usr/bin/brew -> /opt/kandelo/homebrew/bin/brew`;
- creates the documented mutable cache, tap, linked-keg, and lock paths with
  uid/gid 1000; and
- refuses to activate any Formula other than the one selected bootstrap
  descriptor.

**Step 2: Run and confirm RED**

```bash
scripts/dev-shell.sh bash -c \
  'cd host && npx vitest run test/homebrew-runtime-support-materializer.test.ts'
```

**Step 3: Implement the code-owned runtime policy**

Reuse `parseZipCentralDirectory`, `extractZipEntryBounded`,
`MemoryFileSystem`, and the canonical guest layout. Keep the support-data
contract explicit; do not create a package-name fallback in demo or shell
code.

Load and validate every selected bottle first. Materialize the bootstrap ZIP
into the canonical prefix before applying ordinary keg link plans, then stage
ordinary kegs dependency-first. This makes collisions deterministic and keeps
the Homebrew repository tree from overwriting a linked package command.

**Step 4: Run focused validation**

```bash
scripts/dev-shell.sh bash -c \
  'cd host && npx vitest run test/homebrew-runtime-support-materializer.test.ts test/homebrew-flat-vfs-builder.test.ts'
scripts/dev-shell.sh bash -c 'cd host && npm run typecheck'
```

**Step 5: Commit**

```bash
git add host/src/homebrew-runtime-support-materializer.ts \
  host/src/homebrew-vfs-builder.ts host/src/index.ts \
  host/test/homebrew-runtime-support-materializer.test.ts
git commit -m "Materialize Homebrew runtime support from its bottle"
```

## Task 6: Build a flat-selection VFS and separate result manifest

**Files:**

- Create: `host/src/homebrew-vfs-result-manifest.ts`
- Create: `host/test/homebrew-vfs-result-manifest.test.ts`
- Create: `images/vfs/scripts/build-homebrew-flat-vfs-image.ts`
- Create: `host/test/homebrew-flat-vfs-image.test.ts`
- Modify: `host/src/index.ts`
- Modify: `images/vfs/scripts/build-homebrew-vfs-image.ts` only to export
  genuinely shared image-loading/saving helpers

**Step 1: Write failing result-manifest tests**

Use:

```ts
export interface HomebrewVfsResultManifest {
  schema: 1;
  selectionSha256: string;
  vfs: {
    filename: string;
    url: string;
    sha256: string;
    bytes: number;
  };
  buildReport: HomebrewFlatVfsBuildReport;
}
```

Test filename drift, digest/size tampering, non-public URL, extra keys,
deterministic encoding, and recursive absence of provenance fields.

**Step 2: Write failing CLI integration tests**

Exercise a tiny dependency closure and bootstrap bottle. Assert that the CLI:

- accepts `--selection`, `--base-image`, `--bottle-cache`, `--shell-config`,
  `--out`, and `--report`;
- disables all metadata/fallback lookup;
- verifies every selected public bottle;
- saves one image whose kernel ABI is 42 and whose capacity matches the
  selected code-owned policy;
- restores the saved image and finds `/usr/bin/brew`, selected commands, and
  `/etc/kandelo/homebrew-vfs.json`;
- installs the validated shell descriptor from `homebrew/main-shell-default.json`
  and proves its executable is present; and
- does not rewrite the input selection.

**Step 3: Run and confirm RED**

```bash
scripts/dev-shell.sh bash -c \
  'cd host && npx vitest run test/homebrew-vfs-result-manifest.test.ts test/homebrew-flat-vfs-image.test.ts'
```

**Step 4: Implement the manifest and CLI**

The CLI builds from a base VFS produced by the same Kandelo checkout, calls
`planHomebrewVfsSelection` and `buildHomebrewVfsSelection`, serializes the VFS,
restores it once for structural assertions, and writes a local build report.
Publication URL is added later; the selection remains unchanged.

**Step 5: Run focused and regression validation**

```bash
scripts/dev-shell.sh bash -c \
  'cd host && npx vitest run test/homebrew-vfs-result-manifest.test.ts test/homebrew-flat-vfs-image.test.ts test/homebrew-vfs-image-save.test.ts'
scripts/dev-shell.sh bash -c 'cd host && npm run typecheck'
scripts/dev-shell.sh bash scripts/test-homebrew-vfs-release.sh
```

**Step 6: Commit**

```bash
git add host/src/homebrew-vfs-result-manifest.ts host/src/index.ts \
  images/vfs/scripts/build-homebrew-flat-vfs-image.ts \
  images/vfs/scripts/build-homebrew-vfs-image.ts \
  host/test/homebrew-vfs-result-manifest.test.ts \
  host/test/homebrew-flat-vfs-image.test.ts
git commit -m "Build experimental VFS images from flat selections"
```

## Task 7: Add the experimental VFS publication workflow

**Files:**

- Create: `.github/workflows/homebrew-experimental-vfs-publish.yml`
- Create: `scripts/test-homebrew-experimental-vfs-workflow.sh`
- Create: `scripts/publish-homebrew-experimental-vfs.sh`
- Create: `scripts/test-publish-homebrew-experimental-vfs.sh`
- Create: `homebrew/test/homebrew_flat_vfs_shipping_proof.ts`
- Create: `homebrew/test/homebrew_flat_vfs_shipping_proof.test.ts`
- Create: `scripts/homebrew-flat-vfs-node-smoke.ts`
- Create: `apps/browser-demos/test/homebrew-flat-vfs-shipping.spec.ts`
- Modify: `docs/homebrew-publishing.md`

**Step 1: Write failing workflow and publisher tests**

The structural test must require:

- `workflow_dispatch` only, guarded to Kandelo's default branch;
- exact tap SHA, exact selection path, and expected selection SHA inputs;
- Kandelo source fixed to the exact workflow execution SHA;
- pinned third-party actions;
- one read-only build/test job;
- one `contents: write` publication job that never executes downloaded
  artifact content;
- one read-only anonymous public-readback job;
- fixed artifact names and exact inventories; and
- no campaign, handoff, promotion, mirror, default-shell, or Pages inputs.

The release helper test must cover create/no-clobber behavior, exact asset
inventory, digest/size validation, prerelease naming containing
`experimental` and `abi42`, and safe failure when an existing asset differs.

The shipping-proof test must reuse
`createHomebrewGuestShippingProofScript(..., "core")`, but admit a fully
embedded Homebrew runtime with no expected lazy bootstrap or bottle-mirror
downloads. It must retain the exact tap-revision check, real Bzip2 transition
uninstall/install, poured-receipt assertion, execution round-trip, bounded
output, process deadlines, and unexpected-diagnostic rejection. Add one shared
embedded-runtime validator so Node and Chromium do not grow separate product
semantics.

**Step 2: Run and confirm RED**

```bash
scripts/dev-shell.sh bash scripts/test-homebrew-experimental-vfs-workflow.sh
scripts/dev-shell.sh bash scripts/test-publish-homebrew-experimental-vfs.sh
scripts/dev-shell.sh npx vitest run \
  homebrew/test/homebrew_flat_vfs_shipping_proof.test.ts
```

**Step 3: Implement the Kandelo-owned workflow**

Build/test job:

1. Check out the exact workflow-execution Kandelo commit and exact tap commit
   without persisted credentials.
2. Verify the selection path and canonical SHA before any build.
3. Build the ABI-42 kernel, host, browser test assets, and base VFS through
   `scripts/dev-shell.sh`.
4. Build the flat VFS with public bottle fallback disabled.
5. Run `brew --version` and the existing release-critical core shipping proof
   through the new embedded-runtime adapter in Node.js and Chromium against
   that exact VFS.
6. Upload exactly the VFS, canonical selection, local report, Node evidence,
   and Chromium evidence.

Publication job:

1. Download the fixed same-run artifact.
2. Validate names, regular-file types, canonical JSON, SHA-256, and sizes.
3. Do not execute artifact content.
4. Create the result manifest using the immutable selection, tested VFS bytes,
   and final public release URL.
5. Publish the VFS, selection, result manifest, build report, and both evidence
   files as a prerelease in the caller repository with a name containing
   `experimental` and `abi42`.

Readback job:

1. Fetch every public asset anonymously.
2. Verify the public bytes against the tested artifact identities.
3. Verify the public result manifest against the immutable selection and VFS
   bytes.
4. Confirm public selection bytes are exactly the tested input; never rewrite
   them.

**Step 4: Run focused workflow checks and the repository pin audit**

```bash
scripts/dev-shell.sh bash scripts/test-homebrew-experimental-vfs-workflow.sh
scripts/dev-shell.sh bash scripts/test-publish-homebrew-experimental-vfs.sh
scripts/dev-shell.sh npx vitest run \
  homebrew/test/homebrew_flat_vfs_shipping_proof.test.ts
bash -n scripts/publish-homebrew-experimental-vfs.sh
grep -rhoE "^[[:space:]]*(-[[:space:]]*)?uses:[[:space:]]*[^[:space:]]+" .github/ \
  | sed -E "s/^[[:space:]]*(-[[:space:]]*)?uses:[[:space:]]*//" \
  | sort -u | grep -v '^\./' | grep -vE '@[0-9a-f]{40}$'
```

Expected final command output: empty.

**Step 5: Commit**

```bash
git add .github/workflows/homebrew-experimental-vfs-publish.yml \
  scripts/test-homebrew-experimental-vfs-workflow.sh \
  scripts/publish-homebrew-experimental-vfs.sh \
  scripts/test-publish-homebrew-experimental-vfs.sh \
  homebrew/test/homebrew_flat_vfs_shipping_proof.ts \
  homebrew/test/homebrew_flat_vfs_shipping_proof.test.ts \
  scripts/homebrew-flat-vfs-node-smoke.ts \
  apps/browser-demos/test/homebrew-flat-vfs-shipping.spec.ts \
  docs/homebrew-publishing.md
git commit -m "Publish tested experimental Homebrew VFS images"
```

## Task 8: Derive and verify the 40 reusable descriptors

**Files:**

- Create in tap: `Kandelo/selections/experimental-abi42-reuse40-wasm32.json`
- Create temporary local outputs outside either repository for downloaded
  handoff assets and bottle bytes

**Step 1: Resolve the one-time legacy import set**

Read:

- `Kandelo/campaigns/prefix-v1/successor/f826-successor-scope.json`;
- its referenced f826 aborted record; and
- `canonical-shell41-wasm32.json` only to cross-check the expected identity
  set and dependency edges.

Require exactly 40 unique successful wasm32 handoff releases and Ruby as the
only build task. Do not inherit array order from any campaign record.

**Step 2: Fetch and verify each handoff release anonymously**

For each Formula:

1. Fetch `handoff.json` and the named sidecar/bottle JSON/bottle assets.
2. Verify release-record SHA-256 and size before parsing.
3. Fetch the descriptor's GHCR URL anonymously and prove it equals the release
   bottle bytes.
4. Run the active `/opt/kandelo/homebrew` bottle verifier.
5. Project one neutral descriptor with Task 2's CLI.

Abort on the first missing or mismatched object; do not use current
`Kandelo/metadata.json` as a fallback because it describes the retired prefix.

**Step 3: Compose the 40-bottle selection**

Enrich direct dependency edges with exact selected descriptor identities and
derive a stable topological order from those edges. Use the campaign graph
only as a cross-check that the identity and edge sets agree; never use its
array order as product order. Set ABI 42/wasm32, select the two code-owned
policy IDs, and validate canonical bytes with the host selection parser.

The requested filename is
`kandelo-homebrew-experimental-abi42-wasm32.vfs.zst`; Ruby is absent at this
stage, so this file is derivation input and must not be published as the final
selection.

**Step 4: Measure resource use**

Record total compressed bytes, total expanded TAR bytes, total entries,
bootstrap ZIP expansion, and estimated final image capacity. Adjust only the
generic `kandelo-homebrew-vfs-generous-v1` policy if the measured valid set
exceeds it; rerun policy boundary tests. Never add package-specific limits.

**Step 5: Validate and commit in the tap worktree**

```bash
scripts/dev-shell.sh npx tsx scripts/homebrew-validate-flat-selection.ts \
  --selection <tap>/Kandelo/selections/experimental-abi42-reuse40-wasm32.json \
  --expected-abi 42
git -C <tap> diff --check
git -C <tap> add \
  Kandelo/selections/experimental-abi42-reuse40-wasm32.json
git -C <tap> commit -m "Record reusable ABI-42 bottle selection"
```

If the validator CLI does not yet exist, add it as a thin wrapper around Task
3's parser, with a focused test, before this step.

## Task 9: Activate the canonical tap source and the 40 verified bottle blocks

**Files in tap:**

- Modify: selected `Formula/*.rb` paths named by the target-source manifest
- Modify: `Kandelo/formula_support/kandelo_formula_support.rb`
- Modify: `Kandelo/formula_support/test/kandelo_formula_support_test.rb`
- Modify: `Kandelo/recipes/ruby/build.sh`
- Modify: `Kandelo/recipes/ruby/recipe.json`

**Step 1: Create an isolated tap worktree**

Create it from the verified remote `main`. Do not reuse, clean, or reset any
existing tap worktree.

**Step 2: Promote the already-reviewed canonical source bytes**

From `Kandelo/campaigns/prefix-v1/manifest.json`, select only active product
paths under `Formula/`, `Kandelo/formula_support/`, and
`Kandelo/recipes/{ruby,homebrew-bootstrap}/`. Copy each exact target byte
stream from `Kandelo/campaigns/prefix-v1/source/<same-path>` into its active
path. Do not promote the campaign README/runbook, authority records, or
controller tests, and do not edit or delete the historical source snapshot.

Verify byte equality with `cmp` for every promoted path, then inspect the diff
to ensure the active source uses `/opt/kandelo/homebrew`. Ruby must be revision
2 with libyaml/zlib runtime dependencies and no bottle block before its fresh
build.

**Step 3: Mechanically merge the 40 public bottle records**

For each Task 8 descriptor, use its already-verified `reuse.bottle.json` with
`homebrew-merge-bottle-json.sh` against the promoted Formula. Require the
canonical GHCR root, canonical Cellar, ABI-42 release tag, exact descriptor
SHA-256, and the selected rebuild. Never hand-edit a bottle block.

After all 40 merges, parse every Formula with Homebrew and assert its
`wasm32_kandelo` block agrees with the neutral descriptor. The active
`Kandelo/metadata.json` remains a legacy input until quarantine; it is not the
source of truth for this experimental selection. Add a clear note to the tap
README pointing maintainers to `Kandelo/selections/` for the experimental
ABI-42 product.

**Step 4: Run tap source and Formula-support tests**

```bash
ruby Kandelo/formula_support/test/kandelo_formula_support_test.rb
python3 -B scripts/test_prefix_campaign_source.py
ruby Kandelo/test-workflow-trust.rb
find Formula -type f -name '*.rb' -print0 | xargs -0 -n1 ruby -c
git diff --check
```

The campaign test remains a temporary regression because campaign files have
not moved yet; passing it does not make campaign completion a release gate.

**Step 5: Commit without the future Kandelo SHA pin**

```bash
git add Formula Kandelo/formula_support Kandelo/recipes/ruby \
  Kandelo/recipes/homebrew-bootstrap README.md
git commit -m "Activate verified canonical-prefix Homebrew bottles"
```

Do not merge this tap branch until Task 10 supplies the exact protected-main
Kandelo SHA and all tap checks pass together.

## Task 10: Complete the Ruby browser-runtime prerequisite

**GitHub object:** Automattic/kandelo PR #1231

**Step 1: Wait for official Actions recovery**

Do not rerun while the incident remains investigating/major-outage. Continue
local tasks instead.

**Step 2: Audit the failed/cancelled job logs**

Confirm failures are runner/API/outage failures rather than test assertions.
If a test assertion failed, use systematic debugging and fix the packaging PR
before rerunning.

**Step 3: Rerun failed jobs once**

Rerun the failed/cancelled staging jobs after recovery. Do not churn all-green
jobs or force-push unchanged source.

**Step 4: Verify the exact head and merge packaging-only PR #1231**

Require all mandatory checks green, record the merge commit, and verify it is
current protected `main`. This merge is authorized because it is exclusively
Homebrew packaging/runtime-test support.

**Step 5: Merge the new main into the implementation branch**

Fetch and merge; do not reset or clean the worktree. Rerun affected local
tests on the merged tree.

**Step 6: Rebind the unchanged rootfs package bytes to new main**

The ordinary publisher rejects the current rootfs package-generation tag once
`main` advances, even though #1231 does not edit package recipes. Reuse the
existing `promote-package-generation.yml` projection path; do not rebuild the
rootfs closure and do not weaken the ordinary publisher's exact-generation
check.

Read the current generation's `generation.json` and dispatch on exact new
`main` with:

```text
source-tag: preserved-package-generation-rootfs-wasm32-abi-v42-source-662f00c44f3e1d0ebc0d1a573df101e721b73006-sha256-0f60546befd9287a17420a00c0e2d68a5dbd22bc9d5861d31bd3e75acb38eb48
producer-sha: 662f00c44f3e1d0ebc0d1a573df101e721b73006
validated-main-sha: <Task 10 exact protected-main SHA>
validation-method: identical-package-cache-projection-v1
expected-abi: 42
selection-kind: root-package
root-package: rootfs
arch: wasm32
```

Require the projection to prove identical package inputs and record its new
content-addressed `package-generation-rootfs-wasm32-...` tag. If projection
fails, that is evidence that package inputs changed; stop and build a fresh
generation rather than relabeling the old one.

## Task 11: Pin the tap publisher and merge the Ruby-source tap PR

**Files in tap:**

- Modify: `.github/workflows/publish-bottles.yml`
- Modify: `Kandelo/test-workflow-trust.rb`
- Include the Task 8 and Task 9 tap changes

**Step 1: Replace only the current ordinary publisher pins**

Replace both `af80...` values in `publish-bottles.yml`—the reusable `uses:`
ref and `kandelo-ref`—with Task 10's exact protected-main SHA. Replace the old
rootfs package-generation tag with the exact tag produced by Task 10 Step 6.

Update `CURRENT_KANDELO_WORKFLOW_SHA` in the trust test to the same value.
Update `PACKAGE_GENERATION_WASM32_TAG` to the new exact tag.
Leave historical prefix-campaign, closed-selection, mirror, canary, and
first-publication authorities unchanged.

**Step 2: Run exact tap checks**

```bash
ruby Kandelo/test-workflow-trust.rb
python3 -B scripts/test_abi42_rollout.py
python3 -B scripts/test_prefix_campaign_source.py
ruby Kandelo/formula_support/test/kandelo_formula_support_test.rb
git diff --check
```

**Step 3: Review the PR as packaging-only**

The PR description must explain that it activates the 40 already-public
canonical bottle records, makes canonical Ruby directly publishable, records
the neutral reusable selection, and pins the one-Formula publisher. It must
not claim campaign completion or default-shell cutover.

**Step 4: Merge and record exact tap main SHA**

Merge only after the diff and checks match the claim. This tap merge is part of
the authorized Homebrew packaging work.

## Task 12: Build and publish Ruby once

**Step 1: Dispatch the existing ordinary publisher**

Send `publish-kandelo-bottles` with:

```json
{
  "formulae": "ruby",
  "arches": "wasm32",
  "tap_sha": "<Task 11 exact tap main SHA>",
  "release_tag": "bottles-abi-v42",
  "force": true,
  "require_vfs_acceptance": false,
  "dispatch_token": "ruby-fast-c14"
}
```

Do not include prefix campaign tag/dependencies, deferred finalization,
revalidation source, or closed-selection inputs.

**Step 2: Monitor the existing job chain**

Require success from:

- `build-and-test`: Ruby build plus Formula Node.js/Chromium tests;
- `upload-bottle`: immutable child upload;
- `publish-bottle-index`: ordinary resolvable version index;
- `verify-bottle`: anonymous public readback and force-pour; and
- `finalize-tap`: generated Formula bottle block and sidecars.

Do not start a successor campaign if Ruby fails. Diagnose the functional
failure in this one run and rerun only after a real fix.

**Step 3: Verify public Ruby independently**

Resolve the public Ruby descriptor from the finalized tap bytes, anonymously
fetch the GHCR blob, and verify SHA-256, byte count, canonical prefix/cellar,
receipt dependencies, ABI 42, fork instrumentation, and Formula revision 2.

## Task 13: Land the flat lane, compose the 41-bottle selection, and publish

**Files in tap:**

- Create: `Kandelo/selections/experimental-abi42-shell41-wasm32.json`

**Step 1: Merge the Kandelo flat-lane PR**

Merge Task 10's current `main` into the implementation branch without reset or
clean, run the Task 14 local suites, then open and merge the packaging-only
Kandelo PR containing Tasks 1-7. Record the exact protected-main merge SHA.
This occurs after Ruby publication so advancing Kandelo main does not force a
second rootfs-generation projection before the one required bottle build.

**Step 2: Append the verified Ruby descriptor**

Project Ruby with Task 2's CLI, insert it dependency-first after libyaml/zlib,
and validate the complete 41-descriptor closure. The active selection must not
reference f826, a campaign tag, a handoff release, or a provenance report.

**Step 3: Run tap and Kandelo workflow checks**

```bash
ruby Kandelo/test-workflow-trust.rb
git diff --check
```

The tap workflow inventory must remain unchanged. Run the Kandelo workflow
structural test against its merged workflow as well.

**Step 4: Open, review, and merge the packaging-only tap PR**

Record the exact final tap SHA and selection SHA-256 after merge.

**Step 5: Dispatch the experimental VFS workflow**

Dispatch Kandelo's `homebrew-experimental-vfs-publish.yml` on exact current
main. Use the exact tap SHA, selection path, selection SHA-256, and a
prerelease tag containing `experimental` and `abi42`.

## Task 14: Final validation and shipment report

**Step 1: Run complete relevant local regression suites**

```bash
scripts/dev-shell.sh bash -c 'cd host && npm run typecheck'
scripts/dev-shell.sh bash scripts/ci-run-test-suite.sh vitest
scripts/dev-shell.sh bash scripts/ci-run-test-suite.sh browser
scripts/dev-shell.sh bash scripts/test-homebrew-vfs-release.sh
scripts/dev-shell.sh bash scripts/test-homebrew-publish-workflow.sh
scripts/dev-shell.sh ruby scripts/check-homebrew-publish-workflow-trust.rb
git diff --check
```

No kernel/POSIX/libc/ABI suite is required unless implementation unexpectedly
touches those contracts. If it does, stop and expand validation rather than
claiming the original scope.

**Step 2: Verify the public release anonymously**

Check:

- selection URL/SHA/bytes;
- 41 unique descriptors and complete dependency closure;
- VFS URL/SHA/bytes;
- result-manifest agreement;
- Node evidence for `brew --version` and real Bzip2 install/round-trip;
- Chromium evidence for the same exact VFS digest and behavior; and
- release name visibly containing `experimental` and `abi42`.

**Step 3: State omitted validation precisely**

The shipment report must say that default shell, Pages, upgrade, durable
reboot, general remove behavior, Firefox, WebKit, wasm64, campaign quarantine,
and upstream Homebrew workflow convergence were not part of this release.

**Step 4: Commit any final documentation-only corrections**

```bash
git add docs/homebrew-publishing.md
git commit -m "Document the experimental ABI-42 Homebrew release"
```

## Follow-up plans, not shipment gates

1. Move campaign/trust implementation into
   `deferred/homebrew-campaign-trust/` in both repositories after replacing
   all active callers.
2. Generate a tap from `brew tap-new --github-packages`, adopt
   `Homebrew/actions/setup-homebrew`, and prove the smallest Formula through
   `brew test-bot`.
3. Upstream the smallest truthful wasm architecture/tag and GHCR platform
   extensions, then replace custom bottle merge/upload with
   `brew bottle --merge --write` and `brew pr-upload` as each path becomes
   capable of Kandelo bottles.
4. Design candidate namespaces and semantic ABI invalidation for ABI-bumping
   pull requests.

## Critical-path estimate

- Tasks 1-7 local implementation and validation: 6-10 engineering hours.
- Tasks 8-9 can overlap: 2-4 hours, dominated by 40 public downloads and
  validation.
- Tasks 10-12 after Actions recovery: 2.5-6 elapsed hours, dominated by Ruby;
  the rootfs generation step republishes projection-identical bytes rather
  than rebuilding them.
- Tasks 13-14: 2-4 elapsed hours, dominated by Node/Chromium hosted proof.

Best case is one long working day after Actions recovers. A second day is the
honest contingency if Ruby exposes another functional failure or a supposedly
public legacy bottle is unavailable.
