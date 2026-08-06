# Homebrew Per-Bottle Fast Lane And Campaign Quarantine

- Status: proposed implementation design
- Date: 2026-08-06
- Repositories: `Automattic/kandelo` and
  `Kandelo-dev/homebrew-tap-core`
- Initial target: Kandelo ABI 42, wasm32

## Decision

Ship an explicitly experimental ABI-42 Homebrew image through a small,
per-bottle publication lane. The first image reuses the 40 already public
bottles by URL and SHA-256, builds and publishes Ruby once, composes one flat
dependency-checked bottle selection, builds the VFS from that selection, and
executes the exact public bytes in Node.js and Chromium.

The first release is not the default Kandelo shell and does not gate on GitHub
Pages. Its public name must include `experimental` and `abi42`. It proves only
that the listed bottles and VFS execute on the tested hosts.

Campaign-wide provenance and promotion machinery is not part of this lane.
After the replacement lane is live, that machinery moves out of the active
implementation into `deferred/homebrew-campaign-trust/` in both repositories.

## Problem

The current Homebrew path couples independently usable bottles to a global
campaign identity and a sequence of exact-tree authorities, handoffs,
selections, mirrors, and promotion proofs. Any authority change can invalidate
the campaign even when most bottle bytes are unchanged. This has made
bookkeeping and repeated publication proof the dominant migration cost.

The active source tree also interleaves the bottle/VFS product implementation
with a substantially larger campaign/trust implementation. A maintainer cannot
read the current publication path without repeatedly deciding whether each
workflow, script, test, lock, or authority record is relevant.

The immediate product requirement is smaller:

1. Build one real Formula through the normal Kandelo toolchain.
2. Publish its bottle independently.
3. Select a complete, compatible dependency closure.
4. Build a safe VFS image from the selected bottle bytes.
5. Execute those exact bytes in Kandelo.

## Goals

- Make each bottle independently publishable and reusable.
- Reuse the 40 public ABI-42 shell bottles without resealing them.
- Rebuild and publish the missing Ruby bottle once.
- Represent the selected closure in one small, human-readable manifest.
- Reject ABI, architecture, dependency, digest, archive, and VFS layout errors.
- Exercise the exact public bottle and VFS bytes in Node.js and Chromium.
- Keep Formula build code away from publication credentials.
- Make the active Homebrew implementation small enough to read end to end.
- Preserve the deferred campaign/trust implementation in Git history and in an
  explicitly inert source folder.
- Provide the primitive needed for later ABI candidate namespaces without
  designing the complete ABI staging policy now.

## Non-Goals

- Provenance, attestation, signature, SBOM, or reproducible-build claims.
- Exact Kandelo/rootfs/tap authority tuples.
- Campaign identity, resealing, predecessor admission, or campaign rotation.
- A globally closed catalog or proof that every tap Formula is migrated.
- Promotion from a PR synthetic merge to a default-branch release.
- Default-shell or Pages activation in the first shipment.
- Full install/upgrade/remove/reboot lifecycle coverage.
- wasm64, Firefox, WebKit, or complete third-party tap coverage.
- Immediate deletion of historical campaign/trust source.
- Compatibility wrappers for deferred workflow or script paths.
- Deletion or rewriting of already public campaign, handoff, or bottle assets.

## Active Architecture

### Per-Bottle Descriptor

Each successfully published bottle produces one descriptor containing only
runtime and materialization facts:

```json
{
  "schema": 1,
  "name": "ruby",
  "fullName": "kandelo-dev/tap-core/ruby",
  "version": "3.x",
  "revision": 0,
  "bottleRebuild": 0,
  "arch": "wasm32",
  "kandeloAbi": 42,
  "bottleTag": "wasm32_kandelo",
  "layout": "kandelo-homebrew-v1",
  "prefix": "/opt/kandelo/homebrew",
  "cellar": "/opt/kandelo/homebrew/Cellar",
  "dependencies": [
    {
      "fullName": "kandelo-dev/tap-core/libyaml",
      "version": "0.2.5",
      "revision": 0,
      "bottleRebuild": 1,
      "bottleSha256": "..."
    }
  ],
  "url": "https://...",
  "sha256": "...",
  "bytes": 123,
  "compression": "gzip"
}
```

The descriptor deliberately excludes campaign identity, workflow identity,
Kandelo and tap ancestry, package-generation authority, signatures, source
closure seals, and promotion state.

The publisher derives direct runtime dependencies from the exact Formula
evaluated by Homebrew and verifies them against the built bottle's receipt. It
must not infer them only from unrelated legacy package metadata. Each edge
names the exact selected dependency bottle. Later Formula edits do not
invalidate an already published descriptor, and selection never consults a
historical Formula snapshot. A compatible dependency update may produce a new
descriptor for the unchanged parent bottle after runtime validation; it does
not require rebuilding the parent bottle bytes.

`layout` selects a versioned, code-owned guest layout. `prefix`, `cellar`, keg
paths, receipts, links, and `PATH` entries are observations that must equal that
layout's constants; a manifest cannot choose arbitrary absolute destinations.
The real schema includes the bottle payload root and the receipt, link, and
`PATH` plan needed to materialize that keg safely; those fields are omitted
from the abbreviated example.

Every reused bottle must pass the active `kandelo-homebrew-v1` verifier. It
rejects unresolved runtime-visible `/home/linuxbrew/.linuxbrew` paths and
requires the canonical `/opt/kandelo/homebrew` layout. Keg, receipt, and link
plans are validated against layout-owned derivation rules; they are not trusted
merely because a descriptor listed them.

### Build And Publication

One manual tap workflow accepts a Formula name and architecture. Its build job:

1. checks out an exact reviewed tap commit and an explicit ABI-compatible
   Kandelo revision;
2. enters Kandelo's declared development shell;
3. verifies Formula source URLs/checksums and invokes the existing Homebrew
   bottle builder;
4. runs the Formula's meaningful `test do` behavior through Kandelo;
5. verifies bottle tag, prefix, cellar, Wasm exports, ABI, and fork
   instrumentation;
6. emits the bottle, Homebrew bottle JSON, and per-bottle descriptor; and
7. uploads those outputs as an ordinary temporary workflow artifact.

The build job has no package or release write credential. A small publication
job runs only for the history-protected default branch with minimal package and
contents permissions. It downloads a fixed-name artifact from the same
workflow run, checks its expected file inventory, treats every file as data,
and never executes artifact content. It independently parses and verifies the
bottle, SHA-256, size, and descriptor before uploading to the existing public
GHCR namespace. Uploads are content-addressed and no-clobber. This split
protects repository credentials; it is not a provenance or promotion system.

Bottle and descriptor locators are content-addressed. Publishing one Formula
does not rewrite a shared catalog or select it for a product. A separate,
trusted tap update writes that Formula's bottle block only after the public
bottle and descriptor can be fetched and verified. A later explicit product
selection chooses descriptor digests but never edits Formula bottle blocks.
Concurrent unrelated Formula builds therefore cannot overwrite or invalidate
each other.

The initial Tier-2 Ruby build may use an explicit `experimental` Formula helper
path. That path must be opt-in, must not weaken the existing hardened helper,
and must remain unavailable to an ordinary untrusted pull-request workflow.

### Flat Selection

A selection is one JSON document containing:

- selection name and schema;
- architecture and Kandelo ABI;
- the ordered bottle descriptors; and
- the requested VFS filename and consumer-owned resource-policy identifier.

Selection validation requires:

- one descriptor per selected Formula;
- matching architecture, ABI, bottle tag, prefix, and cellar;
- complete direct and transitive dependency closure;
- no dependency cycles;
- one version/revision per Formula;
- dependency-first ordering;
- valid public URL, byte count, and SHA-256; and
- exact agreement between dependency edges, selected descriptor identities,
  and the receipts fetched from the selected bottle bytes.

The selection is immutable input. VFS construction emits a separate result
manifest containing the selection SHA-256, VFS URL, VFS SHA-256, byte count,
and build report. The VFS never causes its input selection to be rewritten.

The initial selection is derived from the 40 public bottle records and a fresh
Ruby descriptor. Existing campaign records may be used as input data for this
one derivation, but no campaign identity or handoff is copied into the active
selection contract.

### VFS Construction

The active VFS planner and builder fetch each public bottle by its descriptor,
verify size and SHA-256 before extraction, and retain their existing safety
checks:

- tar header validation;
- rejection of absolute paths and traversal;
- rejection of escaping symlinks and hard links;
- rejection of device and unsupported archive members;
- receipt and keg containment;
- executable mode preservation;
- path conflict detection;
- dependency-first pouring and link construction;
- correct shell `PATH`; and
- `/etc/kandelo/homebrew-vfs.json` plus image `kernelAbi` metadata.

The active fetcher also enforces generous, documented per-bottle limits on
compressed bytes, decompressed bytes, archive entries, individual entry size,
and path length, plus aggregate decompressed-byte, entry-count, and final-image
limits. All accounting is streaming. Limits come from a consumer-controlled
resource policy with hard implementation ceilings, never from the untrusted
selection or tap. They are resource-safety bounds, not a small ordinary
package-tree quota, and they need no package-specific exception.

The initial lane uses the bottle compression already supported end to end. It
does not broaden archive-format support merely to complete the migration.

### Runtime Proof

The exact public VFS bytes must pass:

- Node.js boot;
- `brew --version`;
- one normal in-guest `brew install` of a small test Formula that is
  intentionally absent from the base selection;
- execution of the installed command with an expected result;
- Chromium boot using the same VFS digest; and
- the same command behavior in Chromium.

The 41-bottle base selection includes Ruby and the Brew runtime. The install
proof uses a separate public bottle, initially `what`, so success cannot be a
no-op caused by the target keg already being present. Node.js and Chromium each
start from the unchanged published base VFS and perform the install in their
own mutable guest state.

The first release does not require upgrade, remove, reboot, Pages deployment,
Firefox, or WebKit. Reports must state those omissions.

## Deferred Campaign And Trust Tree

Both repositories gain this inert structure:

```text
deferred/homebrew-campaign-trust/
  README.md
  workflows/
  scripts/
  tests/
  docs/
  records/
```

The reference audit at Kandelo `af80a443a` reviewed 302 paths: 299 selected by
Homebrew/campaign names plus three active referrers found through dependency
tracing. Ninety-two are quarantine candidates after active replacements are
installed: ten workflows, 46 scripts or data inputs, 30 tests, and six
documents. Fifty-six paths combine active product behavior with selection,
provenance, immutable-release, or mirror policy and require replacement or
splitting before the candidates can move. The remaining 154 reviewed paths
stay active.

The live tap audit at `d98a00a0` found ten campaign-era workflows plus campaign
records, controllers, and tests. Its effective `main` rules only prevent
deletion and non-fast-forward updates; there are no required status checks.
The `publisher-trust` checks are advisory and therefore do not require a
ruleset migration.

The exact move manifest is produced from a reference audit before the
quarantine change. A file moves when its primary purpose is one or more of:

- campaign derivation, sealing, authority, rotation, or retirement;
- exact-rootfs package-generation promotion;
- predecessor reuse admission or resealing;
- scheduler intent, journal, freeze, resume, or run correlation;
- immutable handoff creation or validation;
- source-closure, provenance, attestation, or workflow identity proof;
- closed-selection publication;
- TA0/TA1 mirror promotion;
- synthetic-merge artifact promotion;
- repeated anonymous readback or immutable-release lifecycle proof;
- native Homebrew API authority locks; or
- catalog-wide retired-prefix and completion ledgers.

Files stay active when their primary purpose is one or more of:

- Formula build and `brew test`;
- Kandelo Wasm artifact, ABI, tag, prefix, or cellar validation;
- dependency closure;
- bottle inspection, hashing, and safe publication;
- VFS planning, fetching, extraction, linking, and image construction; or
- Node.js or browser execution of selected public bytes.

Ambiguous files may remain active only until the first experimental shipment.
The implementation plan lists each temporary exception and the campaign branch
that must be removed or made unreachable. Quarantine is complete only after
every retained file has been split or retargeted so no active execution path
can enter campaign/trust behavior. This cleanup does not gate the first VFS,
but it is a committed follow-up rather than an indefinite exception.

In particular, the current Homebrew schema and validator combine provenance
checks with required ABI, dependency, receipt, link, and path checks. They must
be split before quarantine; moving either module wholesale would discard
functional correctness with the provenance layer. The same applies to the
current publisher while it remains the only owner of the real browser smoke.

### Quarantine Invariants

- No file under `.github/workflows/` calls a deferred workflow or script.
- Deferred workflows do not remain under `.github/workflows/`, so GitHub cannot
  discover or execute them.
- No active script, library, test, or workflow imports or executes a path under
  `deferred/homebrew-campaign-trust/`.
- No wrapper, symlink, or compatibility entry point is left at an old path.
- Active documentation describes only the per-bottle lane and points to the
  deferred README for historical context.
- The deferred README states that the code is historical, unsupported, not
  tested by active CI, and must not be used for current publication.
- Git history remains the source for original file locations and rationale.
- A small repository check rejects new active references into the deferred
  tree. It does not execute or validate deferred code.
- Deferred code may use active primitives for historical readability, but the
  active implementation never imports, executes, or discovers deferred code.

The negative-reference check has a narrow allowlist for Markdown links from
the two active Homebrew publishing documents to the deferred README. It allows
no code, workflow, shell, package, test-discovery, or configuration reference.

The existing `docs/homebrew-publishing.md` and
`docs-site/reference/homebrew-publishing.md` paths receive short replacement
documents for the active per-bottle lane. Their current campaign-era contents
move to the deferred tree. Agent guidance, reference docs, and docs-site
navigation are updated so campaign behavior is not described as supported
behavior.

### Sequencing

The quarantine is a separate change stack after the replacement lane is
merged. First split or retarget every retained caller, install the active tap
entry points, stop old dispatch sources, and verify zero active references and
runs. Only then perform the mechanical moves. This avoids mixing a large rename
with the functional implementation and ensures the repository never lacks a
working bottle publication path.

In the tap, four active workflow paths receive small replacement bodies before
their old bytes are archived:

- `.github/workflows/publish-bottles.yml`;
- `.github/workflows/dry-run-bottles.yml`;
- `.github/workflows/contract-checks.yml`; and
- `.github/workflows/base-contract-checks.yml`.

Keeping these entry-point paths preserves GitHub's workflow registration and
history. It does not preserve the old repository-dispatch payload contract.
Retire the rollout controller, README commands, and any other producers of the
old `publish-kandelo-bottles` and `dry-run-kandelo-bottles` events before the
replacement changes their triggers or inputs. Their campaign implementations
move to the deferred tree; the live files are new per-bottle build, dry-run,
and functional contract checks. They reject obsolete campaign event names and
payload fields rather than interpreting them as fast-lane inputs.

These six tap workflows have no replacement because the fast lane does not use
their concepts:

- `.github/workflows/maintain-bottles.yml`;
- `.github/workflows/prefix-campaign-bottles.yml`;
- `.github/workflows/publish-closed-selection.yml`;
- `.github/workflows/publish-main-shell-mirror.yml`;
- `.github/workflows/publish-prefix-campaign-release.yml`; and
- `.github/workflows/repository-namespace-canary.yml`.

Stop their dispatch sources, including the actively used
`publish-prefix-campaign-bottle` producer, verify that no run is active, then
move them outside `.github/workflows/`. Maintenance and namespace canary are
already manually disabled; the other four are currently registered as active.

Before moving workflows, audit GitHub rulesets and required status checks. Any
required check owned by a deferred workflow must be removed or replaced with a
focused active check in the same operational window. The quarantine must not
leave every future pull request permanently waiting for a check that no longer
exists.

The tap's existing `publisher-trust-base` check runs from the old base and
requires the complete ten-workflow campaign inventory byte-for-byte. The first
replacement PR therefore cannot make that advisory check green. Because the
tap has no required checks, merge that specifically reviewed replacement with
the advisory failure recorded, let the new base check become authoritative,
and only then open the workflow-quarantine change. The replacement base check
must permit removal of the six obsolete workflow registrations.

The tap receives the same treatment as Kandelo. Moving only Kandelo's half
would leave active tap callers coupled to inert implementation and would not
make the system legible.

Cross-repository cutover order is provider first: land the active flat schema,
validator, builder, and any small reusable workflow in Kandelo; switch the tap
callers and prove one dry run; stop campaign dispatches and archive the tap
callers and records; then archive Kandelo's old reusable campaign providers.
At each boundary, re-run the active-reference scan before the provider moves.

The current tap `publish-bottles` dispatch path and its numeric workflow ID are
hard-coded by the old rollout controller. The replacement keeps the path while
the rollout controller moves to deferred. Kandelo's pinned reusable campaign
publishers reject relocated caller paths, so the fast caller uses a new small
reusable workflow or remains standalone; it does not call a relocated campaign
publisher.

Draft tap PR #166 implements a larger campaign tombstone/finalizer lifecycle
and conflicts with this decision. It must be superseded or closed rather than
merged after the quarantine.

## Initial ABI-42 Delivery

1. Create a clean worktree at the current protected Kandelo ABI-42 main.
2. Add and locally validate the per-bottle workflow and descriptor schema.
3. Derive and validate descriptors for the 40 existing public bottles.
4. Add the explicit experimental Tier-2 helper path required by Ruby.
5. After Actions recovers, build, test, and publish Ruby once.
6. Produce the 41-bottle flat selection.
7. Build the VFS from public URLs with fallback disabled.
8. Publish the VFS, selection, and SHA-256 under an experimental ABI-42 name.
9. Re-fetch and run the Node.js and Chromium proof.
10. Land the separate campaign/trust quarantine changes in Kandelo and the tap.

Ruby's previous failed workflow retained no artifact, so it cannot be recovered
by weakening a publication check. It requires one real rebuild.

## Failure And Update Behavior

- A failed Formula build affects only that Formula.
- An already published bottle remains selectable by URL and SHA-256.
- Updating one Formula creates a new descriptor for that Formula; unrelated
  descriptors do not change.
- A Kandelo ABI bump writes to a distinct ABI namespace and cannot silently
  replace ABI-42 bottles.
- A selection update changes only when one of its bottle descriptors or its
  requested package closure changes.
- Digest mismatch, missing dependency, ABI mismatch, unsafe archive content,
  or runtime failure remains a loud error.

## Follow-Up Work

After the first experimental release:

- wire the proven VFS into the default shell through an ordinary focused PR;
- add install/upgrade/remove/reboot lifecycle coverage where it provides user
  value;
- design candidate namespaces and semantic ABI invalidation for ABI-bumping
  pull requests;
- decide whether any deferred campaign/trust idea is worth reimplementing in a
  smaller form; and
- delete the deferred tree later if it has no demonstrated consumer.

Deferred code is not a promise to restore the campaign architecture.

## Estimate

- Local per-bottle lane, descriptor, selection, and VFS work: 6-10 engineering
  hours.
- Ruby hosted build after Actions recovery: 1-4 elapsed hours.
- Final public-byte Node.js and Chromium proof: 1-3 hours.
- Campaign/trust split, move, documentation rewrite, and active-only checks:
  1-2 working days, parallelizable after the replacement lane is stable and not
  a gate for the first experimental VFS.

The best-case first experimental release is one focused working day after the
design is accepted and Actions recovers. Two working days is the safer estimate
if Ruby exposes another functional package or runtime defect.
