# Binary releases

Prebuilt Wasm binaries — the kernel, userspace stub, user programs,
and library archives — live in GitHub Releases rather than the Git repo. This
keeps the repo small and makes rebuilds optional for contributors:
fetch once, use everywhere.

The flow is **per-package + index-ledger**: every release tag carries
a single `index.toml` ledger that records every published archive's
URL + sha + cache-key. Each `packages/registry/<name>/build.toml` points
its `[binary]` entry at that ledger (typically via `index_url` with a
`{abi}` placeholder so one `build.toml` survives ABI bumps).

Adding or rebuilding one package re-uploads that package's `.tar.zst`
**and** updates exactly that package's entry in `index.toml` —
atomically, under a workflow-level state-lock so concurrent
matrix-build jobs serialize their writes to the same ledger without
clobbering each other.

See [docs/plans/2026-05-13-binary-resolution-via-index-ledger-design.md](plans/2026-05-13-binary-resolution-via-index-ledger-design.md)
for the design rationale and [docs/package-management.md](package-management.md)
for the resolver behavior, schema, and build-script contract.
For third-party repositories that publish their own package archives,
see [docs/package-sources.md](package-sources.md).

Program archives have a second, source-controlled index:
`packages/registry/program-packages.json`. It is not a release ledger and does
not select archive URLs. Rust generates it from `package.toml` so every
consumer agrees on output/runtime closure membership, mirror placement, target
arches, and fork policy. Schema `kandelo-program-packages-v2` also records an
identity for every package kind and each program's full transitive dependency
identity per consumer architecture. Repository TypeScript, shell resolution,
external registry roots, and the standalone host npm package consume that
projection. The generated manifest digests and cache keys prevent a changed
selected recipe or dependency from silently using old policy. For an ordered
multi-root registry, the highest-priority existing index contains the complete
first-hit identity and program projection across lower roots too. A
dependency-only override rekeys affected lower programs in that combined
context; lower indexes remain standalone suffix-context fallbacks. The
first-party `kernel` and `userspace` boot artifacts retain identities in the
index but are excluded from its guest-program map because their outputs publish
at the binary root rather than below `programs/<arch>/`. Regenerate the
projection whenever a package manifest or ordered dependency context changes;
package checks reject stale committed output.

Source-checkout program resolution runs
`xtask build-deps program-index-context-check` synchronously before each public
program-resolution boundary. That one Rust implementation recomputes every
existing registry root in its ordered suffix context, including `build.toml`
revision and declared inputs, global toolchain inputs, and transitive
dependency identities. It fails closed when an index is missing or stale.
The standalone npm package does not reach back into a checkout; its projection
is checked before packaging and shipped as immutable package content.
Index generation stages complete JSON and serializes cooperating publishers
through a persistent advisory sidecar lock held across source refresh, target
validation, replacement, and directory sync. The lock file is intentionally
retained so concurrent writers always coordinate on one inode.

Homebrew bottles use a separate publication model. Bottle tarballs are
Homebrew-native artifacts published through the `kandelo-dev/homebrew-tap-core`
tap and GHCR/Homebrew bottle URL shape; Kandelo-specific sidecars and
provenance publish as tap git state. A required dependency-bearing acceptance
run also publishes its exact Node-and-Chromium-proven VFS image and evidence in
the source tap repository under `homebrew-vfs-sha256-<image-sha256>`. Lazy
runtime content publishes separately under
`homebrew-runtime-layer-sha256-<bundle-sha256>`; that closed identity binds its
shell base, payload inventory, bottle provenance, and acceptance evidence.
The eager release contains its five acceptance assets. A schema-5 direct
runtime release contains its closed descriptor plus one exact payload per
deferred bottle; a historical schema-4 one-tree release contains its descriptor
and single payload. Generic browser gallery output
remains run-scoped diagnostic evidence. None of these
artifacts appears in the main repository's `binaries-abi-v<N>` `index.toml`
ledger. See [docs/homebrew-publishing.md](homebrew-publishing.md) for formula
authoring, the immutable VFS descriptor contract, and operations.

These content-addressed releases share one manifest-driven immutable-release
publisher. Before using a credential it stages and verifies the manifest's
bounded duplicate-free JSON, safe unique basenames, exact sizes, and SHA-256
digests. Under a tag-specific
state lock it can resume an exact partial draft, but rejects unknown, duplicate,
or changed assets. It verifies every complete draft asset through the
authenticated API and establishes an exact lightweight tag at the planned tap
commit before publishing. It then requires GitHub release immutability and
exact anonymous readback before
atomically emitting a machine-readable receipt. Release and asset discovery are
paginated, so the same protocol covers the production shell mirror's 35 bottle
objects and canonical plan rather than relying on the small embedded asset list
in a release response.

The unprivileged Homebrew build job fetch-only materializes the wasm32 Dash,
Coreutils, Grep, and Sed artifacts from `binaries-abi-v<N>` so Formula tests can
execute installed shell scripts on Kandelo. These unqualified host-resolver
paths intentionally remain wasm32 when the bottle matrix target is wasm64.
Generic Homebrew runtime verification fetches only that base command set and
the declared rootfs needed to exercise a Formula or dependency-bearing VFS.
The file-formula gallery smoke separately prepares Kandelo's supported interactive
browser graph. These base tools, kernel, host-runtime, and VFS artifacts are
platform prerequisites. The
migrated package being verified is poured from the Homebrew bottle: the local
bottle in a dry run, or the anonymously read-back GHCR bottle in a write run.
It is not selected from Kandelo's package registry archive ledger.

## Producer side: the matrix flow

Every staging-build run (PR push or `workflow_dispatch`) follows the
same matrix flow in `.github/workflows/staging-build.yml`. After this
PR's [Phase 10 workflow rewrite](plans/2026-05-13-binary-resolution-via-index-ledger-plan.md):

```
preflight → toolchain-cache → matrix-build → test-gate → merge-gate
```

- **preflight** asks `xtask staging-reuse expected` for the complete,
  cache-keyed package/arch ledger. It may reuse `pr-<N>-staging` only
  directly when the target index has the exact ABI, covers every managed entry
  once, every indexed archive names one uploaded, nonempty release asset whose
  GitHub `sha256:` digest matches the ledger, and every entry has the current
  version, revision, cache key, and success status. A structurally complete
  target with stale entries can instead participate in a zero-build union only
  when the canonical release supplies every stale key as an exact current
  success with the same asset guarantees. An absent, partial,
  ambiguous, malformed, or incomplete union falls back to the canonical ABI
  release and the normal build matrix. A single matching filename is never
  enough to authorize release-level reuse.
- **toolchain-cache** does a one-shot build of the wasm32 + wasm64
  musl sysroot + libc++ headers, uploads them as a workflow
  artifact, and saves the same content into actions/cache. The
  cache key is content-addressed over the sysroot recipe + musl
  submodule SHA, so toolchain churn is rare.
- **matrix-build** runs once per `(package, arch)` matrix entry.
  Per-entry steps:
  1. Download the toolchain artifact.
  2. Run `xtask archive-stage` to produce the per-entry `.tar.zst`
     (pinned commit-bound `--build-timestamp` + `--build-host`).
  3. Invoke `scripts/index-update.sh --target-tag <tag> --package
     <name> --version <v> --revision <r> --arch <a> --status success
     --archive-path <staged> --archive-name <n> --cache-key-sha <s>`.
     The script acquires the state-lock for `<tag>`, downloads the
     current `index.toml` (or bootstraps an empty one for a fresh
     tag), runs `xtask index-update` to mutate this package's entry,
     uploads the archive and publishes the new `index.toml` through the
     journaled release-index state machine described below, then releases the
     lock. Candidate and legacy staging tags use their isolated mutable index;
     canonical tags never replace `index.toml` with an unjournaled clobber.
  4. On failure: a separate `if: failure()` step runs
     `scripts/index-update.sh --status failed --error <msg>` so the
     ledger reflects the failure. If a prior successful build for
     this `(name, version, arch)` exists in the entry, it's
     preserved in `fallback_archive_url` — consumers can keep
     using the last-green archive while CI iterates on the rebuild.
- **test-gate** handles first/partial runs through the canonical index plus
  local `file://` overlays for matrix outputs. When preflight reused a
  complete staging release, the gate re-downloads its index and paginated
  asset metadata after all matrix writers finish, requires every expected
  entry to be current, and verifies each archive's snapshotted size and
  sha256 while downloading it. A target+canonical union snapshots and verifies
  both sources independently, rejects conflicting same-name bytes, and overlays
  only the exact canonical keys selected to replace stale target entries. The
  composed index is rewritten to relative archive basenames and consumed from
  the same local `file://` directory, so later release mutation cannot redirect
  the tested resolver. Source validation and the Cargo-only suites run in
  parallel with this preparation. The prepared workspace retains the
  materialized package tree because its root filesystem refers to package-backed
  executables lazily (for example, `/bin/sh`). libc-test runs as
  functional+regression and math shards; Sortix runs as include, basic, and
  remaining-runtime shards. Browser-local assets are generated in the browser
  consumer from the already-materialized package tree, without fetching the
  index a second time.
- **merge-gate** posts `merge-gate=success` on the PR's HEAD SHA
  once test-gate passes. No bot-PR amend step exists anymore — the
  ledger on the release IS the consumer-visible state, so there's
  nothing in-tree to amend.

`prepare-merge.yml` (triggered by the `ready-to-ship` label) reuses the
same build shape against an isolated merge-candidate prerelease. It does not
write `binaries-abi-v<N>/index.toml` before merge. See "Merge candidates and
canonical activation" below.
`force-rebuild.yml` is the manual escape hatch (`workflow_dispatch`)
for republishing selected packages.

## Merge candidates and canonical activation

Each package-changing Prepare merge run owns one release tag:

```text
merge-candidate-abi-v<N>-pr-<PR>-run-<RUN>-attempt-<ATTEMPT>
```

Preflight owns the attempt number in that tag and carries the same value into
candidate metadata and sealing. A full workflow rerun executes preflight again
and creates a candidate for the new attempt. A "rerun failed jobs" operation
can instead reuse the successful preflight job and its outputs while GitHub
increments the workflow's global attempt number. Downstream jobs therefore use
the preflight output, not the later global value, so they seal the candidate
that was actually created and tested.

Preflight stores three candidate assets before package writers start:

- `candidate.json` binds the repository, PR, target branch and base SHA, PR
  head SHA, synthetic merge and tree SHAs, merge method, ABI, workflow run, and
  whether the canonical release was present or confirmed absent at snapshot.
- `base-index.toml` is the immutable canonical ledger snapshot used as the
  activation compare point.
- `index.toml` begins as that snapshot, except relative archive names become
  absolute URLs into the canonical release. Existing packages therefore remain
  fetchable while candidate-only entries use the candidate release.

Staging promotion and matrix builds use the ordinary `index-update.sh` path,
but their target is the candidate tag. The test gate resolves that candidate
index from a local snapshot captured before binary materialization. The
snapshot retains the exact source bytes for hashing and derives a resolver view
that only makes relative candidate archive URLs absolute, so every resolver
invocation observes one ledger even if the release changes later. After all
tests and the final base-drift check pass, `ready.json` records the sha256 of
the snapshotted source candidate index and sealing verifies the live release
still has those exact bytes. A ready candidate is sealed; supported index
writers refuse further mutation.

When the canonical release already contains the exact cache-keyed archive but
its ledger entry is stale, Prepare merge snapshots that asset's release digest,
copies and verifies those exact bytes into the candidate, and updates the
candidate ledger. Canonical bytes take precedence over a same-name PR staging
asset. This repairs ledger drift without rebuilding or attempting to replace an
immutable canonical archive during activation.

Prepare merge accepts either a non-dismissed approval on the exact tested head
from a reviewer with write, maintain, or admin permission, or an explicit
maintainer attestation. Applying `ready-to-ship` counts as that attestation only
when the label-event sender currently has maintain or admin permission, the
live PR head still matches the event head, and no review has an outstanding
`CHANGES_REQUESTED` decision. The label's persistent state is not authority;
each new head needs a fresh label event or exact-head review. Prepare merge
posts `merge-gate=success` and leaves the merge to a maintainer; Actions never
enables auto-merge. PRs labeled
`batched-changes` must be rebase-merged, while other PRs must be squash-merged.
The exact merge method is part of `candidate.json` and a different method fails
closed during activation. This is repository process policy, not tamper-proof
two-person authorization: same-repository writers are trusted to change the
workflow and helper code through the normal review process.

The write-authorized merge gate executes candidate lifecycle helpers from the
exact prepared base commit, not from the pull request head. The pull request is
candidate data to validate and seal; it is not an authority for code that can
write release assets or publish the `merge-gate` status. This also lets an older
pull request use lifecycle helpers added to the base after its branch was
created, as long as that same base was synthesized and tested with the pull
request.

`activate-merge-candidate.yml` checks out the current default branch and runs
after a merged PR emits `pull_request:closed`. That event is only a fast path:
the workflow also scans for recoverable candidates every 30 minutes and can be
run manually as a full sweep or for one PR/candidate. The release scan is
explicitly paginated and bounded; reaching its bound fails visibly rather than
silently omitting old candidates, which remain available to a targeted manual
run. Each run also caps its activation batch; later schedules drain successful
batches from any remaining backlog. Reconciliation ignores candidates without
`ready.json`, candidates with `activated.json` or `rejected.json`, open PRs, and
PRs closed without merging. It selects only the candidate named by the latest
successful `merge-gate` status on the merged PR head. Status and release scans
are explicitly paginated and bounded. Candidate order comes from each merge
commit's position on the checked-out default branch's first-parent history;
timestamps and PR numbers are not used as branch order. Discovery is advisory:
activation rechecks the exact latest authority while holding its PR lock.
Exhausted API retries fail the run so a later schedule can retry.

Before candidate discovery, every scheduled or manual run performs a separate
bounded sweep of managed releases whose tags exactly match
`binaries-abi-v<N>`. Historical dated releases such as
`binaries-abi-v7-2026-05-09` are excluded before their assets are queried. The
sweep skips stable marker/live/generation triples, but takes each actionable
canonical tag lock and invokes the journal recovery state machine for a
journal, missing live asset, orphan transaction asset, or incomplete state. A
runner death is therefore repaired even when no merge candidate remains.
Manual dispatch can restrict and force verification of one exact canonical
tag. Repeated release and asset inventories detect pagination drift; API
uncertainty fails closed before the sweep mutates any release.

Activation queries GitHub and fails closed unless the PR is merged with the
prepared head into the prepared target branch, the merge commit is on that
branch, and its tree exactly matches the tested synthetic tree. Squash
activation additionally requires the prepared base as the merge commit's only
parent. Rebase activation requires the prepared base and exact prepared PR
commit count. Running the protocol from the current default branch lets a
merged workflow/script change reconcile candidates it prepared without using
pre-merge activation code.

Candidate sealing/status publication, activation, and destructive cleanup use
the lock order PR authority, candidate, then canonical tag. Activation
compares immutable base, candidate, and current canonical ledgers as one
multi-package transaction. Unrelated canonical additions are preserved;
same-package drift is a conflict. Every archive and fallback referenced by a
pending changed package is verified at its final canonical destination before
visibility: candidate-owned assets are copied and verified, while retained
canonical assets are verified in place.

Every canonical index writer uses the same journaled release-asset protocol.
The stable `index.toml` is paired with a marker whose label names the committed
sha256 and an immutable generation containing those exact bytes. A replacement
uploads and verifies its generation, pending asset, and transaction journal
before renaming the old live asset aside and promoting the pending asset.
Changing the marker label is the logical commit. Recovery either finishes a
journaled transaction or restores the marker's immutable generation; a missing
live asset is never interpreted as an empty ledger. A newly empty store is
valid only when release creation recorded the v1 empty-store sentinel.

Prepare-merge takes a read-only canonical snapshot. A legacy release with a
stable `index.toml` remains readable without being migrated. Once managed
state exists, the snapshot requires the marker, committed generation, and live
asset to agree, and requires an empty marker to have no live asset. Harmless
transaction and cleanup leftovers do not invalidate an otherwise complete
committed view. Missing assets and mismatched bytes fail visibly; only
scheduled or manual post-merge reconciliation may recover or migrate that
canonical release.

GitHub Release assets do not provide an atomic rename swap. The stable URL can
briefly return 404 between the two renames, and a runner death can extend that
interval until recovery. The journal preserves both complete generations, so
recovery never publishes an empty or partial ledger. `activated.json` is
written only after the committed marker and stable bytes agree.

An exact-tree mismatch is terminal for that candidate: it was not tested on
the tree that merged and must never be activated. Exact identity mismatches and
same-package canonical drift write a `rejected.json` disposition, so scheduled
reconciliation does not repeatedly retry them. Rebuild the affected packages
from the merged target with `force-rebuild.yml`. Transient release/API failures
may retry the unchanged candidate.

### Recovering the shallow prepared-commit-count defect

`recover-rejected-merge-candidate.yml` is a manual, default-branch-only repair
for the historical case where a rebase candidate was rejected solely because
Prepare recorded its commit count from a shallow checkout. It is not a generic
rejection override. The operator supplies the rejected candidate tag; the
workflow does not build packages or rerun the runtime gate.

Before publishing anything, the recovery helper requires all of the following:

- the source has an immutable `rejected.json` whose exact reason is
  `prepared-commit-count-mismatch`, plus a successful matching Prepare run and
  its retained synthetic-merge bundle;
- the checked-out default branch has the same `ABI_VERSION` as the source, the
  merged PR is on that branch, and the prepared head, base, merge method,
  synthetic parents, tested tree, merged tree, full-history commit count, and
  linear rebase result all agree;
- the source ledger still has every current package key for that ABI, and each
  indexed archive is downloaded and verified against the snapshotted release
  size and sha256; and
- the source remains the PR's current merge-gate authority while the PR
  authority and source locks are held.

The repair creates a new run-bound prerelease instead of editing or deleting
the rejected source. It copies the exact base ledger, tested candidate ledger,
and complete verified archive set; only `candidate.json` changes, recording the
full-history count and source recovery provenance. The tested index sha256 is
bound into the new ready marker. With the PR authority lock held, sealing is
followed by fresh default-tip and source-authority checks before a
compare-and-swap moves merge-gate authority to the clone. The ordinary
activation workflow carries the validated default revision forward and checks
it again under the PR authority lock before publishing the clone through the
canonical transaction path.

Recovery is resumable at the authority/activation boundary. If a runner stops
after the clone becomes authoritative, a rerun reuses that exact clone only
after revalidating its complete identity and every immutable byte. Missing,
extra, or changed assets fail closed. An existing `activated.json` is also
validated as terminal evidence for the exact ready marker and merged commit;
activation exits before replanning against later canonical package changes. A
rerun never creates a second clone merely because the workflow attempt changed.

The repair workflow must already be present on the default branch. If a stale
canonical ledger makes the package gate for the protocol repair itself fail,
the operational sequence is: audit and bootstrap-merge the protocol repair on
the evidence that only canonical materialization is stale; dispatch rejected
candidate recovery; confirm canonical activation; then return to the normal
Prepare and activation gates. For the ABI 39 incident, PR #953 is that single
bootstrap merge and the rejected source is the candidate prepared by PR #936.

The daily staging cleanup retains all candidates for open PRs and retains state
whenever a PR, asset, or status lookup is uncertain. It deletes candidates for
closed-unmerged PRs. After merge it deletes activated, unready, and superseded
attempts, retaining only the ready candidate selected by the latest successful
merge gate. Terminal rejection evidence is retained for 14 days before cleanup
deletes it.

## State-lock serialization

`scripts/index-update.sh` acquires the workflow-level state-lock
before mutating `index.toml`. The lock ref is per-subject:

```
refs/heads/github-actions/state-lock/<subject>
```

Where `<subject>` is the target release tag (`binaries-abi-v11`,
`pr-447-staging`, a run-specific merge-candidate tag, etc.). Different tags
use different subjects and independent locks, so concurrent rebuilds for the
durable release don't block per-PR staging publishes and vice versa.

The lock is recovered automatically only by the same owner token or after
GitHub reports the exact owning run completed. Lock age alone never permits
takeover: a paused owner can resume, so stealing an active but old lock would
let two unfenced writers mutate the same release assets. The lock does not infer
job identity from display names or free-form owner details.

If a lock commit has corrupt or missing owner metadata, recovery is an explicit
operator action. First prove that no workflow owns the ref, then delete that
exact observed SHA with a leased push:

```sh
git push --force-with-lease=refs/heads/github-actions/state-lock/<subject>:<sha> \
  origin :refs/heads/github-actions/state-lock/<subject>
```

If GitHub's run API is unavailable, contenders wait rather than infer that the
owner is dead.

## Release tag convention

```
binaries-abi-v<ABI_VERSION>
```

The tag is **mutable** — new packages and arches are added as new
assets over time. What's *immutable* is each archive: its filename
encodes the `cache_key_sha` of the build inputs, so a published
asset's bytes never change. Different inputs → different filename.

PR-staging releases use `pr-<NNN>-staging` (also mutable, but ephemeral;
staging cleanup deletes them immediately when the PR closes).

Prepare-merge candidates use the run-specific
`merge-candidate-abi-v<N>-pr-<PR>-run-<RUN>-attempt-<ATTEMPT>` shape. They are
mutable only until `ready.json` seals the tested index and are never configured
as the normal resolver endpoint.

Homebrew sidecars use the ABI namespace:

```text
bottles-abi-v<ABI_VERSION>
```

The Homebrew publisher commits sidecars and provenance reports to tap git and
retains generic browser-gallery output as run diagnostics. It does not create
or mutate a GitHub Release for the `bottles-abi-v<N>` namespace. An explicitly
required dependency-bearing acceptance run instead creates a separate public,
content-addressed `homebrew-vfs-sha256-<image-sha256>` release in the source tap
repository. That release contains one exact VFS image, its machine-readable
descriptor, report, and Node/browser evidence; public releases are never
clobbered. Homebrew state remains separate from package archive releases
because bottle selection is governed by Formula metadata and Homebrew bottle
tags, not by Kandelo's package resolver.

The ABI version appears in the namespace because its metadata is tied to a
specific kernel ABI. Programs from `binaries-abi-v10` cannot run
against a kernel on ABI 11 — the resolver's compatibility check
rejects them.

## Layout of a release

Flat asset namespace. Per-package archive filenames + one
`index.toml` ledger.

```
binaries-abi-v11 (release)
├── index.toml                                              ← LEDGER (the contract)
├── zlib-1.3.1-rev1-abi11-wasm32-e33c5e9a.tar.zst           ← library
├── zlib-1.3.1-rev1-abi11-wasm64-e6c7a02b.tar.zst           ← library
├── ncurses-6.5-rev1-abi11-wasm32-3ef36fae.tar.zst          ← library
├── vim-9.1.0900-rev2-abi11-wasm32-0e8b5c34.tar.zst         ← program
└── …
```

Filename schema:
`<name>-<version>-rev<N>-abi<N>-<arch>-<short-cache-key-sha>.tar.zst`,
where `short-cache-key-sha` is the first 8 chars of the cache-key
sha for that manifest. Two archives with the same `(name, version,
revision, arch)` but different transitive deps get distinct shas
and thus distinct names.

The filename is a transport label, not a parseable identity record:
package names and versions may both contain `-`, so the boundary between
them is ambiguous in the string alone. Index composition reads `name`,
`version`, `revision`, architecture, ABI compatibility, and cache key from
the archive's validated `manifest.toml`, then requires the filename to equal
the canonical string reconstructed from those fields. Archive creation and
index recovery call the same renderer so the producer and validator cannot
drift to different filename grammars.

### Archive interior layout

Each `.tar.zst` carries exactly two top-level entries:

```
manifest.toml              ← source package.toml + injected revision + [compatibility]
artifacts/                 ← cache-tree contents
    lib/libz.a
    include/zlib.h
    include/zconf.h
    lib/pkgconfig/zlib.pc
```

The consumer (`xtask build-deps resolve`, calling
`remote_fetch::fetch_and_install_direct`) flattens `artifacts/*` to
the cache root after extraction. See
[docs/package-management.md](package-management.md) "Release
archives" for the full producer/consumer round-trip and the
`[compatibility]` block.

## `index.toml`: the contract

`index.toml` is the **single source of truth** for binary resolution.
The resolver fetches it (with offline cache fallback at
`~/.cache/kandelo/indexes/`), looks up
`(name, version, arch)`, and decides which archive to install based
on the entry's `status`.

Schema (see [design §3.4](plans/2026-05-13-binary-resolution-via-index-ledger-design.md#34-indextoml--ledger-of-build-state)):

```toml
abi_version = 11
generated_at = "2026-05-13T..."
generator = "kandelo CI @ <sha>"

[[packages]]
name     = "zlib"
version  = "1.3.1"
revision = 1

[packages.binary.wasm32]
status         = "success"
archive_url    = "zlib-1.3.1-rev1-abi11-wasm32-e33c5e9a.tar.zst"
archive_sha256 = "<64-hex>"
cache_key_sha  = "<64-hex>"
built_at       = "2026-05-13T..."
built_by       = "https://github.com/.../actions/runs/<id>"

[packages.binary.wasm64]
status              = "failed"
error               = "linker: libc++abi missing for wasm64 toolchain"
last_attempt        = "2026-05-13T..."
last_attempt_by     = "https://github.com/.../actions/runs/<id>"
# Last-green fallback: the previous successful build, preserved across
# the failed rebuild.
fallback_archive_url    = "zlib-1.3.1-rev1-abi11-wasm64-87766332.tar.zst"
fallback_archive_sha256 = "<64-hex>"
fallback_cache_key_sha  = "<64-hex>"
fallback_built_at       = "2026-05-12T..."
```

### Status semantics

| Value | Meaning | Resolver behavior |
|---|---|---|
| `success` | Latest build succeeded; current archive fields are authoritative | Fetch `archive_url`, verify, install |
| `failed` | Latest build failed; `error` describes why | Use `fallback_*` if present; else fall through to source build |
| `pending` / `building` | Transient (rebuild queued or in flight) | Use `fallback_*` if present; else source build |

### ABI invariant

Each `index.toml` is single-ABI. Its top-level `abi_version` must
match every `archive_url` and `fallback_archive_url` filename segment
of the form `-abi<N>-`. Durable `binaries-abi-v<N>` releases use `N`
from the tag. Mutable `pr-<NNN>-staging` releases use the in-tree
`ABI_VERSION` from `crates/shared/src/lib.rs` at publish time.

`scripts/index-update.sh` passes the expected ABI into
`xtask index-update` on every publish. If a reused PR-staging release
still has an old `index.toml`, the top-level `abi_version` is
rewritten before the new entry is applied and old-ABI archive entries
are pruned. `xtask index-update` validates the final ledger before
upload, so mixed-ABI indexes are rejected rather than published.
Consumers also compare `index.toml`'s `abi_version` with the
resolver's requested ABI; a mismatch logs a warning and falls through
to source build.

### Last-green fallback

When a per-package rebuild for `(name, version, arch)` fails, the
prior successful `archive_url` / `archive_sha256` / `cache_key_sha`
move into the entry's `fallback_*` slots — consumers keep fetching
the last working archive while CI iterates on the rebuild. A
subsequent success clears the fallback (`update_entry_success`
overwrites current fields and clears `fallback_*`). A repeated
failure does NOT overwrite the fallback (it's the only working copy;
preserved across multiple consecutive failures).

## Per-package binary source: `build.toml`

`packages/registry/<pkg>/build.toml` declares where the resolver fetches
this package's binaries from. Typical shape:

```toml
script_path = "packages/registry/zlib/build-zlib.sh"
repo_url    = "https://github.com/brandonpayton/kandelo.git"
commit      = "<commit at last successful build>"
revision    = 1

[[git_inputs]]
name       = "homebrew_tap_core"
repository = "https://github.com/Kandelo-dev/homebrew-tap-core.git"
commit     = "<exact 40-character lowercase commit>"

[binary]
index_url = "https://github.com/Automattic/kandelo/releases/download/binaries-abi-v{abi}/index.toml"
```

- `{abi}` is substituted with the current `ABI_VERSION` at resolve
  time, so one `build.toml` survives ABI bumps.
- `revision` is the publish-time counter the resolver hashes into
  the cache-key — bump it when output bytes legitimately change.
- Each optional `[[git_inputs]]` tuple is an immutable external build input.
  The resolver hashes its exact identity, fetches it anonymously at a detached
  HEAD, exposes a sealed read-only checkout to the build, and records the same
  tuple under the archive's `[[compatibility.git_inputs]]`. Consumers require
  exact equality with the current `build.toml` before installing the archive.
- For a legacy archive that doesn't live in an index, replace the
  `index_url` line with `url = "https://..."` + `sha256 = "..."`.
  The resolver fetches that archive directly without consulting any
  `index.toml`.

A `package.toml` without a sibling `build.toml` is treated as
source-build-only (kernel, userspace, examples, source-kind
metadata packages) — the resolver source-builds via
`scripts/dev-shell.sh` instead of fetching.

## PR overlays: `package.pr.toml`

The legacy PR-overlay mechanism still exists for one-off local
swaps: a sibling `packages/registry/<pkg>/package.pr.toml` injects
`[binary.<arch>]` entries into the parsed `DepsManifest` at load
time (see `apply_pr_overlay` in `tools/xtask/src/pkg_manifest.rs`).
Gitignored.

For CI-driven PR testing, the matrix flow uses a dedicated
`pr-<NNN>-staging` release tag instead: that tag has its own
`index.toml` (separate state-lock subject from the durable
release). To consume that staging index locally, run through
`run.sh` with `--pr-staging`, or set `WASM_POSIX_USE_PR_STAGING=1`.
`run.sh` detects the current PR and repository with `gh`, verifies the
staging release has `index.toml`, and exports
`WASM_POSIX_BINARY_INDEX_URL=https://github.com/<owner>/<repo>/releases/download/pr-<NNN>-staging/index.toml`.
If `WASM_POSIX_BINARY_INDEX_URL` is already set, that manual override
remains authoritative.

## Consumer: `scripts/fetch-binaries.sh`

```bash
bash scripts/fetch-binaries.sh
```

Walks every `packages/registry/<pkg>/` that has a `build.toml` and runs:

```
cargo run -p xtask -- build-deps --arch <arch> \
    --binaries-dir <repo>/binaries resolve <pkg>
```

For each declared arch in the package's `arches = [...]` (default
`["wasm32"]`). The resolver:

1. Reads `package.toml` (recipe) + `build.toml` (project view) from
   `packages/registry/<pkg>/`. `revision` from `build.toml` overrides
   the `DepsManifest`'s default revision before cache-key
   computation.
2. Resolves `build.toml`'s `[binary]`:
   - Indexed form: fetches `index.toml` (with offline cache
     fallback), looks up `(name, version, arch)`, picks
     `archive_url` (status=success) or `fallback_archive_url`
     (status=failed/pending/building with fallback set).
   - Direct form: uses the inline `url` + `sha256`.
3. Fetches the archive into the content-addressed cache at
   `~/.cache/kandelo/...`.
4. Verifies `archive_sha256` against the file bytes.
5. Verifies the embedded `manifest.toml`'s `[compatibility]` block:
   - `target_arch` must match the requested arch.
   - `abi_versions` must contain the in-tree `ABI_VERSION`.
   - `cache_key_sha` must match the resolver's locally-computed
     cache-key sha (catches recipe drift).
6. Places each program output under `binaries/programs/<arch>/` using the
   manifest's output layout, and places declared non-Wasm runtime files under
   `binaries/programs/<arch>/<package>/<artifact>`. When the combined output
   and runtime-file count is greater than one, every member—including the sole
   executable of an executable-plus-runtime package—lives below one package
   directory. Members are symlinks into the validated cache, so browser/Node
   image builders load the same bytes without re-fetching. The host verifies
   that every link ends in its declared source-artifact suffix and that all
   links resolve into one canonical program-cache generation. It returns those
   canonical member paths instead of the mutable mirror paths.

For a multi-member package closure, the fetched materializer validates every
output and runtime file before changing the live mirror. It creates a
same-parent staging directory, renames the old live directory to a
transaction-owned backup, then renames the stage to the live name. A concurrent
path lookup can therefore see the complete old directory, a brief absence
between renames, or the complete new directory, but not a partially populated
live directory. Normal failures roll back or clean up only paths owned by that
transaction. An abrupt process crash can leave an inert stage or backup; those
orphans are not automatically scavenged because there is no lease proving that
another process is not still using them.

Direct local builds use the same public layout but different backing storage.
One build-helper session collects exact declared suffixes under
`local-binaries/.kandelo-local-generations/<arch>/<package>/<cache-key>/<session>/`.
Members are create-once regular files. Only a complete, validated tree can
claim its one publication attempt and atomically replace the live package
directory or scalar link; a claimed missing generation is never recreated. A
one-member package keeps its historical flat mirror name as a symlink to the
immutable generation member.

The stage and live directory must be on the same filesystem so rename remains
atomic. Unix uses file symlinks for mirror members. Windows uses file symlinks
too, but missing symlink privileges or open handles that prevent a rename make
the transaction abort and roll back; the implementation does not depend on
Windows overwrite semantics.

Canonical paths protect a consumer from later live-mirror swaps; they are not
open file descriptors or operating-system leases. Normal fetched cache entries
are treated as immutable, but force-source rebuild and stale-cache repair can
remove and recreate one canonical cache-key directory. Those maintenance
operations must not run concurrently with consumers of the same package or a
previously returned path may disappear or name replacement bytes. Append-only
local session generations do not have this maintenance exception unless a user
manually deletes resolver-owned state.

The no-argument form above materializes every publishable registry root. A
bounded consumer should repeat `--package` for its direct roots instead:

```bash
bash scripts/fetch-binaries.sh --fetch-only \
  --package rootfs --package bash --package dash
```

Selection is positive: only the named roots run, duplicates are removed while
preserving first-requested order, and `xtask build-deps resolve` remains
responsible for their transitive dependency closures. A selected package must
exist, have `build.toml`, and not be hidden by
`WASM_POSIX_FETCH_SKIP_PKGS`; otherwise the command fails with exit code 2.
This lets focused CI consumers declare what they actually materialize without
accepting stale unrelated artifacts or maintaining an ever-growing negative
skip list.

On any verification failure, the resolver logs a warning and falls
through to a source build (the package's build script). This
makes ABI bumps and rev bumps non-fatal: as long as the source-build
path works, missing archives just slow the first run.

## Cache eviction

The cache is content-addressed. A different `archive_url` ⇒ a
different canonical path under `~/.cache/kandelo/`. Old
entries are never overwritten; they're orphaned. Disk-pressure
cleanup is the user's responsibility — no automated GC today.

The `index.toml` cache (`~/.cache/kandelo/indexes/`) is
keyed on the sha8 of the index URL, so different sources land in
distinct files. Each successful online fetch overwrites the cached
copy.

## Reproducibility

`xtask archive-stage` requires `--build-timestamp <ISO>` and
`--build-host <s>`. Both are pinned to commit-bound values in CI
(commit author date for timestamp, `<repo>@<sha>` for host) so
re-running the same SHA at any wall-clock time produces
byte-identical archives. This is load-bearing: test-gate re-installs
the same archives that publish later uploads, and the only way that
round-trip works is if both sides are deterministic.

Ordinary `archive-stage` calls may reuse a valid resolver cache entry or
indexed archive. A producer that must prove execution of the selected source
recipe passes `--force-source-build`. The option is deliberately narrow: it
bypasses cache and index reuse for `--package` only, while dependencies retain
normal resolver behavior.

The `[compatibility]` block injected into each archive's
`manifest.toml` is also a pure function of the build inputs (no
wall-clock or worker-local fields).

`index.toml` itself is also byte-deterministic for a given input
set: `IndexToml::write()` emits packages alphabetically by
`(name, version)`, per-arch entries in canonical `wasm32`→`wasm64`
order, and fields within each entry follow the design's
success-then-failure-then-fallback grouping.

## ABI bumps

Bumping `ABI_VERSION` in `crates/shared/src/lib.rs` invalidates every
durable archive against the resolver's ABI check. The bump PR's
matrix flow rebuilds every package whose `cache_key_sha` is now
stale (the ABI is part of the sha), and each matrix entry's
`scripts/index-update.sh` invocation atomically publishes its
archive + index entry to the new `binaries-abi-v<N+1>/` release.

Because the resolver substitutes `{abi}` in `build.toml`'s
`index_url`, no in-tree edit is required for the URL pivot — the
next fetch automatically hits the new release. The v(N) release
stays as historical state.

See [`abi-versioning.md`](abi-versioning.md) for the full ABI-bump
checklist.

## Seeding an index from existing archives

When migrating a release from the legacy schema (or recovering after
a corrupted index), `scripts/compose-initial-index.sh
<target-tag> <abi>` downloads every `.tar.zst` from the release,
extracts each archive's internal `manifest.toml` as the authoritative
package identity and compatibility record, verifies that the archive's
filename is the canonical rendering of those fields, and uploads a freshly
composed `index.toml`. The script acquires the same state-lock as the
matrix-build path, so it serializes against any active CI rebuilds. It does
not infer the package name or version by splitting the archive filename. If
the downloaded inventory contains more than one archive for the same package
name and target architecture, composition fails and reports both filenames,
cache keys, and archive hashes. Recovery must select one explicit immutable
archive rather than depend on directory traversal order.

Day-to-day publishes don't use this script — they go through
`scripts/index-update.sh` per-matrix-entry. compose-initial-index is
migration scaffolding kept in-tree for reproducibility.
