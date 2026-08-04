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
Automation passes the checkout's canonical path through `--source-repo-root`
so a Cargo executable reused from another worktree cannot select that
compile-time checkout's package identity inputs.
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

The guest-prefix campaign uses two additional immutable release kinds.
One content-addressed campaign release seals the complete campaign
authority. Each Formula result then publishes as a
`homebrew-prefix-handoff-sha256-<handoff-sha256>` release after its
reserved GHCR bottle index passes anonymous readback and runtime
verification.
These releases are inert campaign inputs; they do not select a Formula
or update tap Git state. Only the final complete handoff set may produce
the atomic tap commit.

The campaign release binds the path and SHA-256 of
`homebrew/kandelo-guest-layout.json`. That digest selects
`/opt/kandelo/homebrew` and its Cellar throughout bottle build,
provenance, handoff, and runtime validation. A missing or different
digest cannot silently fall back to the still-active guest layout.

Schema-3 recovery normally rejects the same Formula and architecture in
more than one archived campaign. A committed successor scope may resolve
only the duplicates covered by its exact task graph and selected
predecessor archive. The scope, graph, and archive are canonical Git
blobs with independent SHA-256 bindings; file order and timestamps are
not authority. Other disjoint handoffs remain available, while every
unresolved duplicate still fails. The derived campaign preserves the
exact scope path and digest in `authority.successor_scope`; legacy
schema-3 releases without that optional record remain readable.

Current `Automattic/kandelo` `refs/heads/main` is the sole live mutation
authority for Homebrew and durable-package generation. The ordinary
path requires the explicit source to equal current `main` immediately
before every mutation. It builds archives after their source changes
land and records
`https://github.com/Automattic/kandelo` plus that exact main SHA.

The prefix campaign has one narrower rule for its already sealed source.
Campaign mutations may continue only while current protected `main`
contains that exact source commit. The publisher repeats the ancestry
proof immediately before each GHCR or immutable-release mutation.
Exact-main and main-contains authority are mutually exclusive, and only
the reviewed campaign caller may select the latter. A detached,
diverged, descendant, or force-pushed-away source fails closed.

This rule does not make a campaign-local tap checkout public source.
Bottle provenance retains the raw protected-history `tap_commit`. Build,
dependency, handoff, and runtime evidence additionally bind the
deterministic local `tap_checkout_commit`, whose tree contains the
sealed target source and exact dependency bottle blocks. That prepared
commit is never pushed or tagged. Campaign handoff releases target the
raw tap source and require that source to remain in the target
repository's protected history.

The versioned `kandelo-package-generation-v2` compatibility path can instead
preserve archives from one immutable producer commit `S` when trusted current
main `M` independently binds the source release's direct tag anchor `R` and
requires every selected archive to identify that same `S`.
`identical-git-tree-v1` proves complete `S^{tree} == M^{tree}` and remains the
preferred ordinary method. The bounded
`identical-package-cache-projection-v1` method permits distinct trees only when
the producer first exists as a public, application-sealed preserved closure.
V1 evidence records a PR-staging producer; v2 evidence records a completed,
successful canonical Force producer. Trusted current-main code must derive
byte-identical selected projections, expected ledgers, and canonical selected
build-input component closures from both inert trees. The component closure
binds manifests, parsed recipes, declared and Git inputs, direct dependency
cache identities, global toolchain inputs, fork-instrument inputs,
architecture, and ABI. A schema-2 source-only dependency remains bound in the
projection and direct-dependency identities without acquiring a materializable
component or archive.

Complete, non-truncated tree IDs and exact fixed regular-file identities for
the two validator sources remain in the evidence for audit. Unrelated leaves
may differ because they cannot affect the selected package closure; any
selected component change fails. This is not ancestry, payload-byte
equivalence, or a claim that a hypothetical rebuild at `M` would reproduce
`S`. The archives retain truthful producer SHA `S`; the durable generation
records and targets validated main `M`. `R` is independently rechecked
release-container identity, not archive provenance or executable authority.

The general `binaries-abi-v<N>` resolver release has a separate responsibility:
post-merge activation may copy an exact tested-tree candidate into that mutable
ledger so ordinary consumers retain the package gate's tested bytes. Such an
archive is not a Homebrew input merely because it entered the resolver ledger;
it needs either a normal exact-main rebuild or one of the v2 versioned
admission receipts above. `force-rebuild.yml`, dispatched from the live `main`
workflow SHA, source-builds the selected closure, stamps each
archive's embedded `[build]` provenance with that exact SHA, and rechecks live
main before each archive and index mutation. During that exact-main rebuild,
the canonical index transaction engine carries the admitted SHA through
recovery and publication and rechecks it immediately before every release-asset
upload, rename/label update, and delete; an advance of `main` therefore stops
the transaction before its next mutation. Durable generation validates those
embedded fields and rejects activated PR/synthetic-merge bytes that lack v2
admission. The producer
partitions the complete selected dependency graph into explicit topological
levels. Packages within one level build concurrently; every edge to a later
level must consume the earlier level's same-run producer archive, with no
fallback to an older canonical index entry or prior local cache entry. Each
archive build resolves through an empty job-local cache. Its sysroot/libcxx
toolchain cache is keyed by the exact main SHA and source-builds libcxx before
that cache can be created.

### Durable package generations for cross-workflow publication

A Homebrew publication may need an exact Kandelo package selection after the
source change has landed. The manual `promote-package-generation.yml` workflow
runs at exact current main `M` and snapshots immutable producer bytes into an
append-only prerelease. Producer tag and commit are explicit dispatch inputs;
new generations use the v2 versioned validation evidence described below.
Their tags have this form:

```
package-generation-<selection>-<arch>-abi-v<N>-sha256-<full-identity-sha256>
```

The bounded cache-projection method begins with a separate preservation step.
`preserve-pr-package-generation.yml` retains its historical filename, but may
read either a PR-staging release/run or a completed, successful canonical
`force-rebuild.yml` release/run without release-write permission. Current-main
code derives the selected projection and expected ledger from the producer
checkout as inert data, validates every archive twice—once from the release and
once from the same workflow run—and publishes this evidence-only shape:

```
preserved-package-generation-<selection>-<arch>-abi-v<N>-source-<S>-sha256-<full-identity-sha256>
```

PR captures keep the existing
`kandelo-preserved-pr-package-generation-v1` format and direct producer tag at
`S`. Canonical Force captures use
`kandelo-preserved-package-generation-v2`, require `S` to be an ancestor of
current authority `M`, and target the preservation release and direct tag at
`M`. This avoids GitHub's historical-workflow write restriction while the
protected main ancestry keeps `S` reachable. Neither target changes the
producer recorded in the application seal.

Both manifests record `admission = "none"` and bind the observed source
release/tag, exact run ID and attempt, event, workflow path and head SHA, the
unique successful selected-root job and log, selected same-run artifacts,
projection, expected ledger, validated snapshot, minimal index, every archive,
and the exact publisher-authority commit. Release archives and workflow
artifacts must match in name, size, and SHA-256. The writer independently
reconstructs the mutable source immediately before uploading `generation.json`
and again before publishing the release. Once public, an exact retry only
verifies the application-sealed release. V1 evidence remains PR-only and
cannot be reinterpreted as canonical Force evidence.

Preservation is not package admission. Ordinary materializers reject a
`preserved-package-generation-...` tag. Only exact current-main promotion may
embed and revalidate a sealed v1 PR or v2 canonical closure, prove the
selected-input contract below, and publish a separate admitted
`package-generation-...` release.

When v2 canonical evidence is admitted, preparation and publication each
prove the complete protected-main chain: producer `S` must be an ancestor of
the preservation authority `M0`, and `M0` must be an ancestor of the current
publishing authority `M`. The writer repeats this check before every release
mutation rather than trusting the earlier preservation workflow.

`generation.json` independently binds the source release's direct tag anchor
`R`, immutable archive producer `S`, freshly queried main `M`, the complete
trees of `S` and `M`, ABI and ABI snapshot digest, selected package projection,
fresh expected ledger, validated producer snapshot, minimal index, and every
archive name, byte count, and SHA-256. Every selected archive's embedded
`[build].repo_url` must name
`https://github.com/Automattic/kandelo` and `[build].commit` must equal `S`.
New promotion normally uses complete-tree `identical-git-tree-v1`. It may use
`identical-package-cache-projection-v1` only with application-sealed v1 PR or
v2 canonical evidence and the byte-identical selected input closure described
above.
The source release tag remains a rechecked locator, not archive-provenance
evidence; its tree may differ. The new public generation release and direct
tag both target `M`. The full 64-character identity digest determines the
generation tag. Its `index.toml` names only assets under that tag and has no
fallback or mutable producer-release URL.

There are two projection schemas:

- schema 1 selects one `root_package` and its exact dependency closure;
- schema 2 names the reserved `browser-inputs` root set, records every sorted
  root for one explicit architecture, and deterministically unions their typed
  dependency closures. Publish separate schema-2 generations for `wasm32` and
  `wasm64`; neither may stand in for the other.

Every closure identity records package, architecture, kind, disposition,
manifest digest, and fresh contextual cache key. Program and library entries
require archives. Source-only entries remain content-bound without acquiring a
fictional archive.

The current main authority derives browser roots by running its own
`scripts/browser-binary-package-roots.mjs` against the source tree as inert
data, filtering owners to the selected architecture. `shell` is excluded;
the non-`@binaries` `rootfs` alias is included only in the `wasm32`
generation. Its current Rust reader
parses source `package.toml`, `build.toml`, and
`program-packages.json` bytes and freshly recomputes dependency closures and
cache identities. No source, consumer, PR, or historical checkout supplies an
executable, npm package, Cargo invocation, dev shell, or script. Unsupported
source-data formats fail closed.

Both the root list and the deduplicated
`(package, arch, kind, disposition, manifest, cache-key)` union must match.
Duplicate or reordered roots, a missing or extra root, substituted dependency,
changed kind/disposition, stale cache identity, expected-ledger drift, or an
archive-inventory difference fails closed.

Root and closure counts are derived evidence, not acceptance constants. A v1
generation consumes only its canonical release at exact main. New v2
generations use either complete-tree validation or the bounded sealed
selected-input method. Validation recomputes everything using trusted
current-main code at `M` and rejects mixed producer commits or a
wrong-architecture omission even when the same package name exists for both
architectures.

The authority relationships are:

1. Workflow and mutation authority is exact clean `M`, freshly read from
   `refs/heads/main`.
2. The source release is a direct tag at anchor `R`; its release/tag/assets are
   rechecked, but the tag does not stand in for archive provenance.
3. Every selected archive embeds the same immutable producer `S`; mixed or
   stale archive producers are rejected.
4. `validated_against_main` binds `M`, `M^{tree}`, ABI version, ABI snapshot
   digest, and the selected versioned method. Exact-tree publication requires
   `S^{tree} == M^{tree}`. Cache-projection publication instead binds equal
   projection/ledger digests, the byte-identical canonical selected build-input
   closure, both complete trees, and the exact fixed regular-file identities of
   the validator sources.
5. A later consumer may have another SHA only when current authority freshly
   derives a byte-identical projection and expected ledger from that checkout.

Preparation has read-only repository permission and no persisted credentials.
It records and later rechecks the main ref, producer release/tag/assets,
producer and main commits/trees, local HEAD/tree/clean state, ABI snapshot, and
every materialized byte. One
strict current Rust `staging-reuse validate-generation` command validates the
exact index package/arch set, strict TOML/JSON, snapshot, sorted asset
inventory, digests, archive manifests, immutable Git inputs, and embedded
producer commit. The producer snapshot's source tag is bound separately before
the validator substitutes only the new content-addressed destination tag and
requires full snapshot equality. This permits intentional re-homing without
treating the source locator or any archive identity as interchangeable.
Preparation, publication, and materialization all use that validator. Existing
v1 manifests remain materializable; new preparation emits v2.

The writer binds every dispatch input to `generation.json`, independently
rederives the architecture-scoped source projection and expected ledger from
its own exact-main checkout, reacquires its state lock, requeries live main and
producer package assets, and repeats local rehashing and semantic validation
before uploading `generation.json` as the application seal and before
publishing the release. For admitted generations, it also records a canonical
source-authority snapshot before and after semantic validation and compares a
fresh release, direct tag, main ref, commit, and asset snapshot to that baseline
immediately before every remote mutation. The materializer anonymously
downloads every asset, requeries
release/tag/asset metadata, reruns the same semantic validator, recomputes the
consumer projection, and rechecks both clean checkouts immediately before
exposing a local resolver index.

Projection-compatible consumers may deliberately use a generation produced by
another exact-main commit. Canonical Homebrew production is stricter:
`.github/scripts/materialize-exact-package-generations.sh` requires each
generation to have been admitted against the exact consumer checkout. For a
legacy v1 generation, its sole `package_source_sha` must equal that checkout.
For v2, `validated_against_main.commit` must equal it, while the separately
verified archive producer may truthfully remain an earlier commit such as `H`.
The script materializes the independent wasm32 and wasm64 `browser-inputs`
generations, composes only their verified local indexes, and exposes one
`file://` resolver index beside the exact downloaded archives. It never uses
the mutable `binaries-abi-v<N>` index as a base or fallback.

The protected Homebrew publish and maintenance callers must carry both exact
content tags. The reusable publisher validates their architecture in its first
trust step, admits the current exact Kandelo `main` SHA, and then materializes
the wasm32 generation before Formula build/test package resolution. Its browser
verifier materializes and combines both architectures before any browser
package resolution. The workflow accepts a resolver activation only when the
reported URL exactly names the regular, non-symlink local index it just
materialized. Dry runs may omit generation tags because they cannot mutate
canonical state; supplied dry-run tags are still validated.

Repository-wide GitHub Release immutability is enabled. Every new package
release is created as a draft, populated under its existing state lock, sealed
with `kandelo-package-release-seal-v1.json`, and published once. A retry may
resume the exact draft or verify an already immutable release, but it cannot
change public bytes. GitHub did not apply the setting retroactively, so the
existing `binaries-abi-v42` release remains the one explicitly grandfathered
mutable ledger while the conventional registry is retired.

This changes the future canonical contract. A new `binaries-abi-v<N>` must be
initialized from the complete admitted package ledger before publication. It
cannot receive later same-tag package updates. A writer that reaches a public
immutable canonical release with new bytes fails loudly; a content-addressed
generation or Homebrew bottle release must carry those bytes instead of
weakening release immutability.

This is the fail-closed rule for the transitional conventional registry, not a
new long-lived package-distribution design. The broader question of how to
name evolving conventional package sets within one unchanged ABI is deferred;
Homebrew bottles and content-addressed generations already avoid that mutable
same-tag requirement.

`.github/scripts/package-release-lifecycle.sh` owns this boundary. Its
`ensure-draft` operation reconciles a lost create response and accepts only an
exact release identity. Its `seal-publish` operation snapshots the unique
uploaded asset names, sizes, and GitHub sha256 digests into the seal, verifies
the exact direct tag, and then makes the release public. If publication fails,
the sealed draft remains resumable. If a retry finds a public immutable
release, it verifies the same identity, seal, asset inventory, and direct tag
without writing. An unexpected mutable public release is rejected unless it
is the exact Automattic/kandelo ABI 42 exception.

Consumers that must never hold release-write authority use
`verify-immutable` with the same tag, target commit, title, body, and
prerelease inputs. That operation performs only release, asset, asset-byte,
and direct-tag reads. It requires an immutable release and an existing seal;
it has no branch that creates, uploads, tags, or publishes release state.

#### Preserving a completed closure without admitting it

Sometimes a completed package closure must survive while its source release is
still mutable or its producer differs from current main. Do not treat that
release as durable input. Use `preserve-pr-package-generation.yml`; its
historical filename now covers both PR staging and completed canonical Force
rebuilds. Preservation accepts one schema-1 program root and architecture, and
derives the closure and archive count rather than accepting a fixed count.

Apply `retain-package-staging` before merging when this capture cannot finish
before the PR closes. For a merged same-repository PR, that label temporarily
retains both the staging release and producer branch; it does not admit either
as main. Closed-unmerged PRs are never retained by the label. Durable promotion
does not delete or relabel its source; the content-addressed preserved release
remains independent evidence after admission. Any later retirement of temporary
PR staging belongs to the separate staging lifecycle, after every source use is
complete. Retaining or restoring pre-main staging is exclusively an evidence
preservation operation; it is not recovery for an admitted durable generation.

For PR staging, unrelated matrix jobs need not finish. The source must be a
`pull_request` run of `staging-build.yml`, and the preserved manifest remains
v1. A canonical source must be a completed, successful `workflow_dispatch`
run of `force-rebuild.yml`, and the preserved manifest is v2. In both cases the
selected root job must be unique, complete, and successful; every selected
workflow artifact must exist in that same run; and each extracted workflow
archive must byte-match its selected release archive. The preserved root-job
log must contain the exact expected dependency-artifact block, one successful
download per selected dependency, and no selected-dependency fallback. The
workflow derives a new minimal index from those archives; it neither trusts
nor preserves the mutable release's full index.

Before sealing, preparation re-reads the source release/tag anchor, every
selected release asset identity and digest, every selected workflow artifact,
and the selected root job/log. Unrelated asset uploads and, for PR staging,
unrelated job progress are deliberately ignored. A selected change fails
closed.

The source tag is only an observed locator. The capture records and
race-rechecks its anchor without treating the tag as producer authority.
Producer authority comes from the exact workflow-run head, selected artifact
identities and bytes from that run, byte equality with selected release assets,
and each archive's embedded repository and producer commit.

Preserved tags have this form:

```
preserved-package-generation-<root>-<arch>-abi-v<N>-source-<full-producer-sha>-sha256-<full-identity-sha256>
```

For v1 PR evidence, the direct tag targets exact producer `S` so that source
object stays reachable after a temporary PR ref moves or disappears. For v2
canonical evidence, `S` must already be an ancestor of current authority `M`,
and the preservation release and tag target `M`; protected main retains `S`
without asking GitHub to publish from a historical workflow commit.
`generation.json` independently binds the producer, current default-branch
publisher authority, source run and release evidence, and
`admission: "none"`. Neither tag claims selected-input compatibility. The
ordinary durable materializer rejects both formats.

Unlike ordinary durable promotion, preservation never executes tooling from
the producer. It treats that checkout's registry, ABI declaration, and
`program-packages.json` as inert data and uses only current default-branch
authority to derive identities, parse archives, seal evidence, and publish.

Preservation preparation, preservation publication, promotion preparation, and
promotion publication each use the same current-authority validator
preparation helper in their independent jobs. The helper creates a new private
Cargo home, runs `cargo fetch --locked` against the absolute trusted-authority
`Cargo.toml` and lockfile before building `xtask`, and records that exact Cargo
home beside the validator. The trust phase then passes the recorded home to
every producer-tree revalidation. This makes every current-authority
checksum-bound registry package available to the later offline metadata scan
even when building `xtask` alone did not need it; lock drift or a checksum
mismatch fails before producer inspection. Fetch and build both run from the
current-authority root. They never read the producer manifest, lockfile, Cargo
configuration, wrappers, or credentials, and producer metadata remains an
offline, token-free current-authority operation.

Cache-key derivation then treats the producer's Cargo manifests and lockfile as
declarative data: current-authority `xtask` invokes the current Cargo binary
with `metadata --locked --offline`, the same isolated Cargo home, a
current-authority working directory, and credential/network/wrapper variables
removed. A producer whose external locked dependencies are not already in the
trusted current-authority lock cannot expand this fetch boundary; preservation
fails offline instead. Every local package returned by Cargo must remain
beneath the producer checkout, and `fork-instrument` must resolve from its exact
expected manifest; no producer binary, build script, test, or repository helper
is run.

The reusable Homebrew bottle publisher has the same cache-completeness
boundary when it activates an exact package generation. Its build and
verification jobs run one shared helper through the declared dev shell. The
helper fetches the authority workspace's exact locked host dependency
projection before building `xtask`, then the generation materializer may read
inert-source Cargo metadata offline. This covers every checksum-bound host
crate admitted by `Cargo.lock`, including dependencies not used by `xtask`
itself, without adding package-specific prefetch exceptions.

The shared publisher uploads archives and the fresh index before uploading
`generation.json` as the application seal. V1 PR bundles retain their original
`rootfs-job.log` field and filename; v2 canonical bundles use
`root-package-job.log`. The root-job log is bounded to 16 MiB.
Before uploading that seal and again before making its draft public, the
writer independently re-queries the selected release, tag, run, jobs, and
artifacts using only current-authority code. It redownloads both release and
same-run copies of every selected archive, compares them to the bundle,
reparses the root-job log, and requires the reconstructed canonical capture to
equal `generation.json`. Unrelated jobs and assets remain outside that
comparison.

For preserved generations the writer also requires
`identity.authority_sha`, the workflow's exact `github.sha`, and the clean
publisher checkout's `HEAD` to be identical. It rechecks that clean authority
tree at both publication boundaries, and requires GitHub's direct
`refs/heads/main` to still name that exact SHA immediately before direct-tag
creation, draft creation, every asset upload, and the public transition. An
already-public exact retry is read-only and does not require an old publisher
SHA to remain main. The publisher supports exact resumable drafts and performs
authenticated plus anonymous readback. The contract does not call the GitHub
release immutable; it detects later mutation on validation.

`preserve-pr-package-generation.yml` remains an evidence writer, not an
admission workflow. Its release never becomes a resolver input. A later exact
current-main promotion may embed and revalidate its public v1 or v2 seal,
prove selected-input equivalence, and publish a separate admitted generation.

#### Promotion and recovery

Dispatch only from exact current `main` commit `M` after the selected source
release is complete. `validated-main-sha` must equal both workflow authority
and freshly queried `refs/heads/main`. `producer-sha` names the one `S`
embedded by every selected archive. Prefer `identical-git-tree-v1`; the
complete trees must match. `source-tag` names independently rechecked release
anchor `R`; the normal exact-main path uses the matching canonical ABI release
with `S == M`:

```bash
main_sha="$(gh api repos/Automattic/kandelo/git/ref/heads/main --jq .object.sha)"
for arch in wasm32 wasm64; do
  gh workflow run promote-package-generation.yml \
    --repo Automattic/kandelo \
    --ref main \
    -f source-tag=binaries-abi-v42 \
    -f producer-sha="$main_sha" \
    -f validated-main-sha="$main_sha" \
    -f validation-method=identical-git-tree-v1 \
    -f expected-abi=42 \
    -f selection-kind=browser-inputs \
    -f root-package=rootfs \
    -f arch="$arch"
done
```

For a distinct-tree producer, first dispatch
`preserve-pr-package-generation.yml` with the original source tag, exact
successful source run, producer `S`, ABI, root package, and architecture. A PR
source produces v1 evidence. A canonical Force source produces v2 evidence and
requires `S` to be an ancestor of exact current `M`. Wait for the public
`preserved-package-generation-...` tag and anonymous readback. Then dispatch
`promote-package-generation.yml` with that preserved tag, producer `S`, exact
current `M`, and `identical-package-cache-projection-v1`. Current-main code
revalidates the application seal and independently derives both selected
closures. A source/schema mismatch, a mutable source release, a failed or
incomplete Force run, or any selected-input difference is not eligible.

Use `selection-kind=root-package` for one named root closure. The
`root-package=rootfs` default remains present for a `browser-inputs`
dispatch but is not its selection authority. The scanner adds the rootfs alias
only to the wasm32 root set. The current checkout installs
only its own pinned root npm dependencies with lifecycle scripts disabled;
historical or source checkout dependencies are never installed.

Do not replace derivation with a count gate and do not dispatch
cache-projection admission directly from a mutable PR or canonical release. A
selection becomes eligible only when its freshly derived identities match
archives stamped with the canonical repository and one coherent producer
commit. That producer must either satisfy exact-tree validation or arrive
through the public application-sealed v1 PR or v2 canonical preservation path.

If a runner stops while the generation release is a draft, repeat the
identical dispatch with the same producer `S`, validated main `M`, source tag,
validation method, and selection. The writer accepts only an exact verified
subset, uploads missing non-seal assets, uploads `generation.json` last, and
publishes. It never deletes or overwrites a draft asset. If `main`, producer
package assets, local authority state, or any input changes, prepare a new
generation from the newly validated state instead.

If a public generation fails validation, do not repair it in place. Preserve
the evidence and publish a new generation validated by current main under its
naturally different content-derived tag. Pre-main staging retention and
restoration apply only to the evidence-preservation workflow described above.
Admitted recovery either resumes the same exact draft from the same `S`/`M`
inputs or publishes a new generation from a newly validated current-main
state; it never substitutes another commit's similarly named archives.

These content-addressed releases share one manifest-driven immutable-release
publisher. Before using a credential it stages and verifies the manifest's
bounded duplicate-free JSON, safe unique basenames, exact sizes, and SHA-256
digests. Under a tag-specific state lock it can resume an exact partial draft,
but rejects unknown, duplicate, or changed assets. It verifies every complete
draft asset through the authenticated API and establishes an exact lightweight
tag at the generation's declared release target—validated main `M` for
v2—before publishing. It performs exact anonymous readback before atomically
emitting a machine-readable receipt and does not rely on repository-wide
release immutability. Release and asset discovery are paginated, so the same
protocol covers the production shell mirror's 35 bottle objects and canonical
plan rather than relying on the small embedded asset list in a release
response.

The unprivileged Homebrew build job fetch-only materializes the wasm32 Dash,
Coreutils, Grep, and Sed artifacts from `binaries-abi-v<N>` so Formula tests can
execute installed shell scripts on Kandelo. These unqualified host-resolver
paths intentionally remain wasm32 when the bottle matrix target is wasm64.
Generic Homebrew runtime verification fetches only that base command set and
the declared rootfs needed to exercise a Formula or dependency-bearing VFS.
Before the isolated Formula identity runs, the publisher uses the same
portable-cache staging contract as prepared conformance workspaces: complete
canonical package generations are copied under `.ci-test-binary-cache/`, and
the `binaries/` mirrors remain relative symlinks into those generations. The
read-only source alias and an explicit resolver cache root therefore retain
package identity without exposing the workflow user's ambient cache.
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
  cache-keyed package/arch ledger. It may reuse an exact-head run-specific
  staging release only
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
     (pinned commit-bound `--build-timestamp` + `--build-host`, plus
     structured exact `--source-repository` + `--source-commit` provenance).
     The shared archive action first requires a clean workflow-root checkout
     whose repository identity and exact `HEAD` equal those source fields, so
     a caller cannot stamp an archive with a commit it did not build.
  3. Invoke `scripts/index-update.sh --target-tag <tag>
     --release-target-commit <head> --package <name> --version <v>
     --revision <r> --arch <a> --status success --archive-path <staged>
     --archive-name <n> --cache-key-sha <s>`.
     Every PR-staging writer, including metadata repair, passes the exact
     reviewed PR head. It never infers release identity from `GITHUB_SHA`,
     because GitHub sets that variable to a synthetic merge in
     `pull_request` workflows. Candidate and canonical writers derive their
     targets from their separate authority contracts and reject this flag.
     The script acquires the state-lock for `<tag>`, downloads the
     current `index.toml` (or bootstraps an empty one for a fresh
     tag), runs `xtask index-update` to mutate this package's entry,
     uploads the archive and publishes the new `index.toml` through the
     journaled release-index state machine described below, then releases the
     lock. Candidate and staging drafts use their isolated mutable index;
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
  parallel with this preparation. The prepared workspace retains each selected
  content-addressed program generation under `.ci-test-binary-cache/` and
  rewrites the `binaries/` mirrors as relative symlinks into that cache. It does
  not flatten package mirrors into unrelated regular files: extraction at a
  different checkout path therefore preserves the same complete, single-tier
  package identity. Local package-generation links are likewise made relative
  within `local-binaries/`, including package-owned root boot mirrors such as
  `kernel.wasm`; only scalar aliases outside the local-generation namespace
  are copied as verified regular files. `scripts/ci-run-test-suite.sh` selects
  that transported cache
  before a suite resolves an artifact. The workspace also retains the
  materialized package tree because its root filesystem refers to
  package-backed executables lazily (for example, `/bin/sh`). libc-test runs as
  functional+regression and math shards; Sortix runs as include, basic, and
  remaining-runtime shards. Browser-local assets are generated in the browser
  consumer from the already-materialized package tree, without fetching the
  index a second time.

After `test-gate` seals a PR release, the exact Homebrew shell consumer
uses a different, lazy composition contract. A PR release is expected to
contain only the package rows selected by that attempt; it does not copy
every unchanged canonical archive. The caller passes that exact selected
matrix to the consumer. The consumer re-derives the complete expected
ledger from the reviewed checkout, rejects duplicate, unknown, or
identity-mismatched matrix rows, and partitions the ledger into two
disjoint authorities:

- selected rows must exist in the exact immutable PR release and are
  fully downloaded and manifest-validated before use;
- every unchanged row must be an exact current success in the canonical
  ABI release.

The typed composer binds both validation snapshots and release tags. It
rejects fallback or failure state on successful rows, prunes packages
and architectures outside the expected ledger, and writes one local
index.
Each archive URL still names its independently verified source release.
This keeps archive retrieval lazy: the shell proof downloads only the
packages it actually resolves, while a missing selected PR row fails
instead of silently using an older canonical archive.

- **merge-gate** posts `merge-gate=success` on the PR's HEAD SHA
  once test-gate passes. No bot-PR amend step exists anymore — the
  ledger on the release IS the consumer-visible state, so there's
  nothing in-tree to amend.

`prepare-merge.yml` (triggered by the `ready-to-ship` label) reuses the
same build shape against an isolated merge-candidate prerelease. It does not
write `binaries-abi-v<N>/index.toml` before merge. See "Merge candidates and
canonical activation" below.
`force-rebuild.yml` is the maintainer-dispatched exact-main producer for
republishing selected root closures. Its package matrix remains limited to
those selected roots, but the six-suite test gate is a broader consumer:
rootfs construction and conditional package-backed tests also consume
unchanged packages. Preflight therefore preserves its already-computed full
publication-policy ledger as a run/attempt-scoped artifact. Test preparation
uses that exact artifact with `fetch-binaries.sh --fetch-only
--expected-ledger`, plus the same explicit heavy-runtime exclusions as the
other package test gates. It does not walk raw registry directories or
source-build a stale unrelated package. Runs that execute tests also require
the `rootfs` publication closure during preflight; `skip_tests=true` retains
the producer-only admission boundary. Its final test matrix retains the
existing Cargo kernel, fork-instrument, Vitest, libc-test, POSIX, and Sortix
coverage. libc-test is divided into functional+regression and math jobs, while
Sortix is divided into include, basic, and remaining-runtime jobs. These are
the same natural partitions used by staging-build and prepare-merge; their
matrix result is still aggregated by the single `test-gate` job.

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
writers refuse further package mutation. The release remains a draft until
post-merge activation records either `activated.json` or `rejected.json`.
That terminal path writes the inventory seal and publishes the candidate once;
retries then validate immutable evidence without changing it.

GitHub's release-by-tag API does not return draft releases. Candidate
discovery therefore reads the authenticated, paginated release list, rejects
malformed pages or duplicate identities, and selects exactly one matching
tag. Activation then keeps the numeric release ID from that lookup and uses it
for candidate reads. This is not a fallback from a 404: treating the draft as
missing would strand every correctly prepared candidate before activation.
The same bounded lookup helper owns draft discovery for package-release
creation and reconciliation.

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
enables auto-merge. PRs labeled `batched-changes` must be rebase-merged. A PR
labeled `preserve-head-commit` must be merged with a merge commit whose ordered
parents are the prepared base and the exact PR head. That bounded mode keeps an
exact reviewed head SHA reachable from `main`; repository
merge commits may remain disabled outside its merge window. The two
history-method labels are mutually exclusive. Other PRs must be squash-merged.
The exact merge method is part of `candidate.json` and a different method fails
closed during activation. Tree equality is required for every method, so a
lookalike merge commit cannot substitute another head. This is repository
process policy, not tamper-proof two-person authorization: same-repository
writers are trusted to change the workflow and helper code through the normal
review process.

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
deletes it. Writable-release cleanup carries the discovered numeric release ID
because GitHub's get-by-tag API omits drafts. Under the publisher's per-tag
state lock, it deletes the release object and Git tag as independent resources
and removes only the exact tag object observed before release deletion through
a Git force-with-lease. A missing tag or a concurrent cleanup is idempotent,
while changed ownership, an observable resource, or uncertain API state still
fails visibly.

## State-lock serialization

`scripts/index-update.sh` acquires the workflow-level state-lock
before mutating `index.toml`. The lock ref is per-subject:

```
refs/heads/github-actions/state-lock/<subject>
```

Where `<subject>` is the target release tag (`binaries-abi-v11`,
`pr-447-staging-run-123-attempt-1`, a run-specific merge-candidate tag, etc.).
Different tags
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

The existing ABI 42 tag is a grandfathered mutable release. A new ABI tag is
draft-only while its complete initial ledger is assembled, then immutable.
Each archive filename still encodes the `cache_key_sha` of its build inputs,
so different inputs produce a different filename.

PR-staging releases use
`pr-<NNN>-staging-run-<RUN>-attempt-<ATTEMPT>`. Each workflow attempt owns a
draft, publishes it once after validation, and never reuses it for another
push or rerun. Cleanup deletes abandoned drafts; published immutable staging
evidence is retained. The old `pr-<NNN>-staging` form remains a read-only
compatibility source for releases created before this transition.

Prepare-merge candidates use the run-specific
`merge-candidate-abi-v<N>-pr-<PR>-run-<RUN>-attempt-<ATTEMPT>` shape. They are
drafts until a terminal activation or rejection seals and publishes them, and
are never configured as the normal resolver endpoint.

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

The atomic guest-prefix migration uses two other content-addressed
namespaces:

```text
homebrew-prefix-campaign-sha256-<campaign-sha256>
homebrew-prefix-handoff-sha256-<handoff-sha256>
```

The first seals the complete campaign graph and authority. The second
contains one Formula's verified publication data and exact
dependency-handoff identities. Their releases are immutable by
application contract, must pass authenticated and anonymous
digest-and-size readback, and directly tag the raw public tap source
commit. A deterministic local `tap_checkout_commit` may be recorded
inside the evidence, but it never becomes a release target.

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
from the tag. Run-specific PR staging drafts use the in-tree `ABI_VERSION`
from `crates/shared/src/lib.rs` at publish time.

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
# Optional distribution gate; omitted means "ready".
publication_state = "ready"

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
  the cache-key — bump it when output bytes legitimately change. The locked
  index writer rejects a lower revision for an already-recorded package
  version on both success and failure updates; a new upstream version may
  restart the counter.
- `publication_state` defaults to `"ready"`. A project can set it to
  `"pending"` while an exact artifact or release authority is still being
  reviewed. Pending packages and all packages that depend on them are omitted
  from staging and prepare-merge matrices; `archive-stage` enforces the same
  graph rule before side effects, and both admitted durable-generation
  boundaries independently rederive it. Exact-main and package-source
  publishers also preflight their selected roots through that ledger, so a
  policy rejection cannot become a failed canonical index entry.
  Preservation-only evidence and consumption of an existing generation do not
  publish new bytes and may still describe pending packages; marking a recipe
  pending does not revoke artifacts that were already admitted. Historical
  producer source is likewise evidence, so bytes built while pending can be
  admitted after the live authority becomes ready. The state is not part of
  cache identity, so changing it to `"ready"` re-enables publication of the
  already-reviewed recipe rather than forcing a synthetic rebuild. Unknown
  states fail parsing.
- Prepared CI workspaces carry the typed publication-blocker report alongside
  the authenticated binary cache. Browser validation source-builds each
  reported root with `--force-source-build` into an ephemeral local generation,
  while dependencies may reuse the prepared cache. A pending canonical shell
  is represented by the separately identified source-rootfs shell bridge, then
  pinned through the resolver's `local-libs/shell/build` dependency tier before
  reverse-dependent VFS images are built. This path exists only to test the
  exact pull-request recipes: it does not upload, index, admit, or otherwise
  turn pending bytes into release state.
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

For CI-driven PR testing, each workflow attempt uses a dedicated
`pr-<NNN>-staging-run-<RUN>-attempt-<ATTEMPT>` release tag instead: that tag has its own
`index.toml` (separate state-lock subject from the durable
release). To consume that staging index locally, run through
`run.sh` with `--pr-staging`, or set `WASM_POSIX_USE_PR_STAGING=1`.
`run.sh` detects the current PR, repository, and exact head with `gh`, selects
the newest public immutable attempt for that head, verifies the release has
`index.toml`, and exports its run-specific release URL.
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
preserving first-requested order. `xtask build-deps resolve` owns dependency
traversal, but a self-contained published program archive can satisfy
binary-materialization or fetch-only resolution before its separate dependency
archives are fetched. A consumer that directly needs one of those products
must select that package as another root even when the first package declares
it as a build dependency. This preserves lazy dependencies for consumers that
need only the self-contained program. A selected package must exist, have
`build.toml`, and not be hidden by
`WASM_POSIX_FETCH_SKIP_PKGS`; otherwise the command fails with exit code 2.
This lets focused CI consumers declare what they actually materialize without
accepting stale unrelated artifacts or maintaining an ever-growing negative
skip list.

An expected ledger is a second bounded form:

```bash
bash scripts/fetch-binaries.sh --fetch-only \
  --expected-ledger /path/to/expected.json
```

Each unique `(package, arch)` entry is handed to the resolver exactly once.
The same self-contained program fast path applies, so every independently
consumed dependency product must also appear as a ledger root. The fetcher does
not expand a ledger entry to the package's other declared architectures, does
not fall back to a raw registry walk, and rejects duplicate, unsupported, or
manifest-undeclared entries before resolving anything. This form is for
consumers that already have a Rust-generated publication projection; it does
not infer whether a narrower projection contains every artifact a test suite
may conditionally exercise.

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

`xtask archive-stage` requires `--build-timestamp <ISO>`,
`--build-host <s>`, `--source-repository <canonical-GitHub-URL>`, and
`--source-commit <40-hex>`. All are pinned to commit-bound values in CI
(commit author date for timestamp, `<repo>@<sha>` for host) so
re-running the same SHA at any wall-clock time produces
byte-identical archives. This is load-bearing: test-gate re-installs
the same archives that publish later uploads, and the only way that
round-trip works is if both sides are deterministic.

Ordinary `archive-stage` calls may reuse a valid resolver cache entry or
indexed archive. A producer that must prove execution of the selected source
recipe passes `--force-source-build`. The option is deliberately narrow: it
bypasses cache and index reuse for `--package` only, while dependencies retain
normal resolver behavior. The exact-main workflow does not broaden this flag;
instead it selects the root's complete buildable closure, schedules that graph
in dependency levels, and overlays each same-run dependency archive before
source-building its dependent.

`force-rebuild.yml` is the canonical exact-main producer, not a historical-ref
escape hatch. It must be dispatched from `refs/heads/main`; its optional legacy
`ref` input may only repeat the exact lowercase workflow SHA. The gate requires
that SHA to equal live GitHub `refs/heads/main`, every job checks out the exact
SHA, and each package target uses `--force-source-build`. If main advances
before an archive or index write, the write fails closed and the rebuild must
be redispatched at the newer main SHA. `scripts/index-update.sh` also enforces
this at the writer boundary: a case-insensitive `Automattic/kandelo`
`binaries-abi-v<N>` target is rejected unless the caller supplies the exact
main SHA. External package-source repositories may continue to own their own
canonical-shaped release tags without claiming Kandelo's publication authority.
A missing or failed same-run dependency also fails closed rather than consulting
an older cache-equivalent archive. The fixed workflow level bound is checked
during preflight, while all packages within a level retain bounded parallelism.

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
durable archive against the resolver's ABI check. The bump PR's candidate
matrix rebuilds every package whose `cache_key_sha` is now stale (the ABI is
part of the sha). Post-merge activation creates the new canonical release as a
draft, copies the complete tested closure, commits its index transaction, and
publishes it once. The exact-main `force-rebuild` path remains scoped to the
grandfathered ABI 42 ledger until a later design gives partial rebuilds an
immutable destination distinct from the complete canonical tag.

Because the resolver substitutes `{abi}` in `build.toml`'s
`index_url`, no in-tree edit is required for the URL pivot — the
next fetch automatically hits the new release. The v(N) release
stays as historical immutable state. Later package evolution under the same
ABI must use content-addressed package generations or Homebrew bottles; the
canonical tag cannot be reopened.

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
