# Kandelo Homebrew Packaging

This guide explains how Kandelo builds, publishes, and uses Homebrew
packages. It starts with the small number of concepts needed to follow
the system. The detailed security and file-format contracts remain in
[Homebrew Publishing](homebrew-publishing.md).

Kandelo is not Linux or macOS. A normal Homebrew bottle for those
systems cannot run in Kandelo. Kandelo Formulae build WebAssembly
programs for one Kandelo application binary interface (ABI) and
architecture. The resulting archives use Homebrew's normal bottle
format and tap layout, with extra Kandelo metadata for ABI checks, lazy
virtual file system (VFS) composition, and browser validation.

This is an implementation and operations guide. Guest `brew install`
commands are not a supported user promise until the public Node and
browser lifecycle gates described below pass for the deployed image.

## The short version

The system has four main parts:

1. A **Formula** says how to build one piece of software and names its
   dependencies.
2. A **bottle** is the prebuilt result for one Formula, Kandelo ABI, and
   WebAssembly architecture.
3. A **tap** publishes Formulae and bottle metadata. Kandelo's
   first-party tap is `kandelo-dev/tap-core`, stored in the GitHub
   repository `Kandelo-dev/homebrew-tap-core`.
4. A **VFS image** selects bottles and decides which files are present
   at boot and which bottles remain lazy until first use.

The data moves through the system like this:

```text
Formula + source + dependencies + Kandelo SDK
                       |
                       v
                 build a bottle
                       |
                       v
        public registry bottle + tap metadata
                       |
                       v
       verified eager or lazy VFS composition
                       |
                       v
             Node and browser execution
```

Each bottle that finishes the complete publication path stands on its
own for its Kandelo ABI. That path builds the bottle, publishes its child
and version index, reads the exact bytes back anonymously, verifies the
runtime, and records an immutable Formula handoff. If a batch builds ten
Formulae and two fail, the eight completed results remain valid and
usable. A named shell or prefix release may wait for a complete selected
dependency closure. That product-level wait does not invalidate an
independently completed bottle.

## Vocabulary

| Term               | Meaning in Kandelo                                                                                                                                                                                                                                                |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Formula            | Homebrew Ruby that describes a source, dependencies, build, install, and test.                                                                                                                                                                                    |
| Bottle             | A prebuilt Formula result for one ABI and architecture.                                                                                                                                                                                                           |
| Tap                | A Git repository containing Formulae and their published bottle blocks.                                                                                                                                                                                           |
| Keg                | The installed directory for one Formula version under the Homebrew Cellar.                                                                                                                                                                                        |
| Sidecar            | Kandelo metadata beside a Formula. It records ABI, architecture, hashes, provenance, VFS ownership, and validation evidence.                                                                                                                                      |
| Package generation | An immutable architecture-specific closure of Kandelo program, library, and source-package inputs admitted for one current-main consumer. Formula builds, platform tools, and browser products can use it. It is not a Homebrew bottle release.                   |
| Bottle mirror      | A content-addressed tap release containing one exact plan and copies of the lazy bottle payloads selected by an image. The plan is the allowlist; the payloads provide one closed transport for Node and browsers. The payloads are not baked into the VFS image. |
| Runtime layer      | One or more deferred bottle payloads plus a descriptor that says where their files belong.                                                                                                                                                                        |

## What each repository owns

`Automattic/kandelo` owns the platform and publisher implementation:

- the SDK, sysroot, kernel ABI, and package resolver;
- the reusable bottle workflow;
- Formula and sidecar validators;
- VFS composition and lazy-runtime support;
- Node and browser acceptance tests; and
- the documentation for these contracts.

`Kandelo-dev/homebrew-tap-core` owns the live first-party tap:

- `Formula/` source recipes;
- closed Formula-owned recipe input under `Kandelo/recipes/`;
- generated bottle blocks and sidecars;
- publication and failure records; and
- immutable VFS, runtime-layer, campaign, and handoff releases.

Bottle bytes are public GitHub Container Registry (GHCR) objects owned
by the tap repository. A conventional third-party repository named
`Example/homebrew-tools` represents the tap `Example/tools` and owns its
own Formulae, packages, and publication authority.

The directory `homebrew/homebrew-tap-core/` in the Kandelo repository is
a test fixture and template. It is not the live tap.

### What comes from upstream Homebrew

Kandelo uses upstream Homebrew for the parts that make a tap a Homebrew
tap:

- Formula Ruby and dependency resolution;
- source and resource checksum handling;
- build and test lifecycle hooks;
- keg and Cellar layout;
- bottle archive creation, `bottle do` metadata, and pouring; and
- the `brew tap`, `brew install`, and receipt model.

Kandelo does not reimplement those parts as a parallel package manager.
It adds a reviewed platform patch for Kandelo bottle tags and the
Kandelo guest prefix, plus isolation, provenance, public Open Container
Initiative (OCI) transport, ABI validation, sidecars, and VFS
composition around upstream Homebrew. The publisher pins an exact
upstream Homebrew commit so a later Homebrew change cannot silently
alter a reviewed run.

### Tap names, Formula names, and GHCR paths

These three names are related, but they are not interchangeable:

- the repository is `Kandelo-dev/homebrew-tap-core`;
- the Homebrew tap is `kandelo-dev/tap-core`; and
- a Formula keeps its ordinary name, for example `zlib`.

The corresponding OCI repository is under
`ghcr.io/kandelo-dev/homebrew-tap-core/zlib`. GitHub may display the
package name simply as `zlib`. Do not add `tap-core/` to the Formula
name to imitate the tap name.

## What identifies a bottle

A bottle is not selected by its filename alone. Its identity includes at
least:

- the tap and Formula;
- the Formula version, revision, and bottle rebuild number;
- the Kandelo ABI;
- `wasm32` or `wasm64`;
- the Formula and closed recipe input;
- the exact dependency bottles;
- the SDK, sysroot, and build-policy inputs; and
- the archive digest and public OCI manifest digest.

Changing the ABI starts a new Kandelo bottle epoch, recorded in metadata
under a name such as `bottles-abi-v43`. The GHCR repository may stay the
same, but Kandelo metadata and cache identities prevent consumers from
mixing ABI epochs. Changing a kernel without changing the ABI does not,
by itself, require rebuilding unrelated bottles. Rebuild only when the
ABI, Formula output, dependency closure, or a declared build input
changed.

An unchanged bottle keeps the producer commit that actually built it. A
later catalog, tap, or VFS release may select that bottle, but it must
not rewrite the historical provenance to make the bytes look newly
built.

Kandelo records the same bottle in two compatible ways:

- Homebrew's `bottle do` block lets `brew` find and verify it; and
- the Kandelo sidecar lets the VFS builder and host verify its ABI,
  provenance, owned paths, lazy size, and runtime evidence.

The sidecar adds checks; it does not replace Homebrew's metadata.

## The normal publication path

### 1. Review the Formula

Put first-party Formulae in the live core tap. Prefer Homebrew's normal
Formula domain-specific language (DSL). When a larger script is needed,
place it in a checksummed, Formula-owned
`Kandelo/recipes/<formula>/` tree. A Formula may temporarily call an old
`packages/registry/` build, but that is migration debt and must be
recorded.

The Formula must build through Kandelo's normal software development kit
(SDK) and libc path. A package patch may adapt to a documented
WebAssembly boundary, but it must not hide a Kandelo Portable Operating
System Interface (POSIX) or kernel bug.

### 2. Select exact Kandelo inputs

Canonical publication starts from the exact current commit `M` of
`Automattic/kandelo` `main`. The workflow records `M` and checks that it
is still current immediately before every registry, release, or tap
write. A commit that is merely an ancestor of `main` is not ordinary
publication authority.

Some Formulae still need Kandelo package archives as build tools or
migration inputs. Those archives come from a content-addressed package
generation admitted against exact current `main`. Each archive retains
the producer `S` that actually built it. Usually `S` and `M` are the
same commit. After an ABI candidate is merged, activation may instead
prove that the complete tree at tested producer `S` is identical to the
tree at final main commit `M`.

The publisher downloads and verifies the whole generation locally. It
never treats a mutable staging URL as authority. It also never rewrites
`built_from` to make old bytes appear newly built: `S` remains the
archive producer, while `M` is recorded separately as the commit that
admitted those bytes for publication. Later validation, public
transport, and VFS selection are separate evidence.

### 3. Run a dry build

The tap's reviewed `dry-run-bottles.yml` caller invokes Kandelo's
reusable publisher without write jobs. A dry run proves the real
isolated builder and verifier paths, but it does not upload a package,
edit the tap, or publish a release.

Pull-request code must not call the complete reusable publisher. GitHub
checks the permissions of every job in a reusable workflow, including
write jobs that a dry-run condition would skip. Giving that permission
ceiling to untrusted PR code would cross the publication boundary.

### 4. Build and upload independently

The trusted tap caller invokes:

```text
.github/workflows/reusable-homebrew-bottle-publish.yml
```

The workflow plans the dependency graph, then builds every ready Formula
and architecture with as much concurrency as the graph permits. Build
jobs do not receive package or tap write credentials.

Separate jobs validate a bounded handoff and upload only the
already-checked OCI layout. The publisher first writes an
architecture-specific child, then a Homebrew version index. It
immediately reads the object back anonymously by digest. A package that
is private, missing, changed, or not anonymously readable cannot reach
tap finalization.

New packages are created under the public tap repository's GHCR
namespace. The proven path uses the repository-scoped `GITHUB_TOKEN`, a
source annotation for that public repository, organization permission
for public package creation, and inherited repository access. New
packages have been public at creation on that path, so the normal
publisher does not need a package personal access token (PAT). GitHub's
settings are not treated as proof by themselves: every publication must
still pass anonymous exact-digest readback before tap finalization. The
publisher does not repair visibility after upload.

### 5. Bootstrap from a dry build when needed

A Formula's first bottle is different from later publications because
its GHCR package repository does not exist yet. The normal publisher can
create that repository while publishing the bottle. The core tap also
has a bounded, one-time first-child workflow for the prefix campaign. It
accepts only the dry-build artifacts produced earlier in that same
protected workflow run and attempt. This helper is not required for
every new Formula. It publishes actual bottle bytes, not an empty marker
package.

First run the normal credential-free dry build. The protected tap
workflow then accepts exactly one successful dry-run child artifact. It
binds the run, attempt, artifact digest, bottle manifest digest,
protected caller, and exact admitted tap and Kandelo source commits. It
also checks the required protected-`main` ancestry and proves through an
authenticated query that neither a public nor a private package already
owns the destination.

The workflow uploads only that immutable architecture-specific child
with the tap repository's `GITHUB_TOKEN`, removes its credentials, and
reads the exact digest back anonymously. It does not publish the
Formula's version index, edit the tap, generate sidecars, or claim that
the Formula is ready. A retry never uploads the child twice. It may
re-prove the exact already-public child without credentials; a different
or private existing object fails closed.

After this bootstrap, run the normal publisher. That publisher creates
the version index, verifies the bottle through Kandelo, and finalizes
the Formula and sidecars. A failure in that later work does not erase
the already public child, but normal `brew install` selection is not
complete until the version index and tap metadata are finalized.

This dedicated first-child caller is currently implemented for the
protected first-party tap. A new third-party tap must provide an
equivalently reviewed protected caller or use its normal publication
path and pass the same public package and anonymous-readback acceptance
checks. Do not copy the first-party workflow and describe it as a
generic facility without adapting its explicit repository checks.

### 6. Verify the public bytes

The verifier starts from fresh source checkouts. In write mode it
ignores the builder's private bottle copy and downloads the public
bottle by its exact digest. It pours the bottle, runs the Formula test
through Kandelo, and checks the ABI and runtime contract.

Browser-compatible claims require browser evidence. A Node-only pass
cannot mark a bottle as browser compatible.

### 7. Finalize tap metadata

Only after public readback and runtime verification does the finalizer
write the Formula bottle block, Kandelo sidecar, and provenance report.
Related Formulae in one requested batch are finalized together when the
selected operation requires one coherent tap commit.

After index publication and anonymous readback, the bottle object is
immutable and independently usable by exact digest. Tap finalization
makes normal Homebrew Formula resolution select it.

## Why tap `main` is append-only

The tap's `main` branch is part of the package trust chain. It names the
reviewed Formula, the workflow caller, and the metadata that selects
public bottle bytes. An ancestry check is useful only while the history
remains append-only: a commit that authorized a bottle must not later
disappear through branch deletion or a non-fast-forward rewrite.

The intended repository rules are:

- block branch deletion and non-fast-forward updates;
- require pull requests for human-authored changes;
- allow rebase merges only;
- require the current-base `publisher-trust` check; and
- provide one explicit automation path for generated Formula and sidecar
  fast-forward commits.

Do not give every workflow or repository writer an unrestricted bypass.
The current publisher writes generated tap state directly with the
repository's `GITHUB_TOKEN`, while GitHub rulesets do not allow the
platform-owned GitHub Actions integration to be selected as this
repository's bypass actor. Until the publisher uses a dedicated app,
deploy key, or reviewed PR finalization path, this remains a known
protection gap. Keep the exact-main rechecks, pinned callers, read-only
PR token policy, and publication locks enabled; do not describe them as
a substitute for complete branch protection.

As of 2026-08-01, the live tap enforces that append-only history
property through the `Protect tap main history` ruleset: `main` cannot
be deleted or moved with a non-fast-forward push. This prevents an
accepted commit from being removed. It does not prevent an authorized
actor from adding a direct fast-forward commit, so it is not complete
branch protection. The ruleset deliberately does not yet require a pull
request or status check. Enabling either requirement without a valid
automation identity would stop the bottle finalizer.

## ABI changes and candidate pull requests

An ABI bump changes the contract between Kandelo programs and the
kernel. Every bottle for the new ABI must therefore be rebuilt, even
when the upstream software version did not change.

### Transitional pre-merge candidate bottles

Kandelo has a narrow candidate lane for building a bottle before its
producer pull request merges. It exists to move ABI testing earlier
without letting pull-request code publish a canonical package.

As of 2026-08-01, this repository contains the implementation and
caller templates. The lane is not live until a coordinated tap commit
installs rendered exact-SHA callers. Do not dispatch the candidate
events while the live tap lacks those rendered files.

The first version supports one leaf Formula for `wasm32`. A leaf has no
Homebrew runtime dependencies in the selected campaign. Dependency
Formulae and `wasm64` need a later version of the protocol.

The protocol gives each commit one role:

- `B` is the protected Kandelo `main` commit used as the pull request's
  base;
- `S` is the exact pull-request head that produces the candidate bottle;
- `A` is the protected Kandelo workflow and validator authority, which
  must equal `B` in version 1;
- `C` is the exact protected tap commit that owns a caller run;
- `T` is the protected tap source used to prepare the Formula; and
- `M` is the later merge commit that may admit the candidate.

The candidate caller lives on protected tap `main`. Its build jobs have
read-only permissions. Candidate Formula and Kandelo code can run there,
but no registry or tap write credential is present. After that execution
has stopped, code from `A` validates the results and seals them in one
immutable, run-bound candidate release. The release tag says that it is
a candidate. It is not a Homebrew version tag, a Formula update, or a
canonical bottle reference.

Before a bottle is built, a separate candidate-campaign run binds `B`,
`S`, `C`, `T`, the native Homebrew source, ABI snapshot, guest layout,
package catalog, and complete Formula plan. Its immutable release uses
the noncanonical
`homebrew-prefix-campaign-candidate-pr-...-sha256-...` namespace. The
release contains only `campaign.json` and
`candidate-campaign.json`. Neither asset selects a public Formula.

The candidate campaign may use a package catalog from the same ABI or
an older ABI. It must reject a catalog from a newer ABI. When the
catalog is older, every catalog variant is marked for rebuild because
an older-ABI archive cannot be reused under the candidate ABI. This
lets an ABI pull request plan its first bottles without pretending that
old archives are compatible.

The bottle candidate then binds that campaign, `B`, `S`, protected
validator authority `A`, `C`, `T`, the prepared tap tree, Formula,
package input ledger, build handoff, OCI child, workflow run, and
artifact identities. Version 1 also binds an empty dependency list. A
rerun gets a distinct tag and cannot replace an earlier candidate.

The successful sealer also uploads one small release receipt for 90
days. The receipt binds the public release ID, tag, target commit,
immutability, and the complete asset inventory by ID, name, size, URL,
and SHA-256. This receipt is the durable proof that protected code
accepted the release. The larger derivation and build artifacts may
expire after two days because the immutable public release retains the
bytes needed for promotion.

The package input currently comes from Kandelo's immutable pull-request
staging release. This is an explicit migration bridge, not the final
Homebrew ownership model. It is read as inert data by protected
validator code. The bridge must be removed once the tap-owned candidate
builder can derive every build input from Formulae and immutable
bottles. At that point the Formula build, seal, and candidate artifacts
should all be owned by the tap.

### Exact merge and promotion

A candidate can be promoted only after GitHub reports the pull request
as merged and all of these statements are true:

```text
parents(M) = [B, S]
tree(M) = tree(S)
M and S are in protected main history
```

This requires a merge commit that preserves the exact pull-request head.
A squash merge, rebase merge, conflict resolution, changed pull-request
head, or changed base invalidates the candidate. Build another candidate
instead of claiming that different source produced the old bytes.

The trusted workflow at `M` then regenerates the complete package
ledger and compares it byte for byte with the candidate input. It also
rederives the campaign from `S`, `T`, and the native Homebrew source.
Public registry observations recorded while the candidate was sealed
are replayed because unrelated bottles may have been published since
then. The exact bottle being promoted still receives a live collision
check before every public write.

The workflow locates the exact original run and attempt recorded in the
candidate. The run must be complete and successful, and every job in
that attempt must have completed successfully or been skipped. Exactly
one live 90-day sealer-receipt artifact must match the recorded run and
caller commit. Promotion validates that artifact's ID, name, size,
digest, and workflow-run identity before downloading it by artifact ID.

Protected code then exact-key validates the receipt and compares it
with the live immutable release. The repository, tag, target commit,
release ID, immutability flag, and complete asset inventory must all
match. Every release asset is downloaded anonymously and rehashed. The
workflow reconstructs the prepared tap and the exact build and OCI
handoffs from those release bytes. It does not rebuild the bottle and
does not depend on the two-day build artifacts still existing.

Promotion is available only while both 90-day receipt artifacts remain
live. If a candidate workflow needs another attempt, use **Re-run all
jobs**. Do not use a partial rerun or combine evidence from different
attempts. The new complete attempt receives its own candidate tag and
receipts.

The canonical publisher receives the reconstructed bytes only after
those checks. Bottle provenance continues to say `built_from = S`.
Separate admission evidence records `validated_against_main = M`. This
is more accurate than rewriting the producer to `M`, which never built
the archive.

Successful promotion publishes the exact OCI bytes and an immutable
Formula handoff for the campaign. The bottle is then durable and can be
selected by its immutable digest. The campaign's later tap finalization
still updates the public Formula bottle block and normal `brew`
selection. An unrelated failed Formula does not invalidate a promoted
bottle. The candidate release itself remains candidate evidence; it is
never renamed or treated as the canonical package.

### Installing exact candidate callers

The three caller files stored under
`homebrew/homebrew-tap-core/.github/workflows/` are templates. They
contain deliberate placeholders and must not be copied directly into
the live tap. GitHub does not allow an expression in a reusable
workflow `uses:` reference, so the caller files must contain literal
Kandelo commit SHAs.

Before a pre-merge candidate build, render the callers with `B` as both
inputs:

```sh
python3 scripts/homebrew-candidate-caller-pins.py render \
  --template-root homebrew/homebrew-tap-core \
  --base-sha "$B" \
  --merge-sha "$B" \
  --out rendered-candidate-callers
```

Install the three files from
`rendered-candidate-callers/.github/workflows/` in one protected tap
commit. The campaign and bottle callers now execute reusable workflows
from exact `B`. The promotion caller is intentionally pinned to `B`, so
it cannot admit a later merge accidentally.

After the exact merge creates `M`, render again with `--base-sha "$B"`
and `--merge-sha "$M"`. Install all three files in one new protected tap
commit. The campaign and bottle callers remain pinned to `B`; the
promotion caller now executes the materializer and publisher from exact
`M`. Each reusable workflow checks the literal pins in the exact tap
caller commit `C` that GitHub reports for that run. A mutable `@main`
reference, an unresolved placeholder, or a different SHA fails closed.

### Supported ABI-bump sequence

Use this sequence for an ABI candidate:

1. Update `ABI_VERSION`, `abi/snapshot.json`, and the ABI-bound
   generated bindings, locks, or manifests required by validation. Do
   not mass-edit package URLs: `{abi}` substitution and package cache
   identity select the new ABI automatically.
2. Run Prepare Merge. It builds the complete stale package closure for
   the synthetic merge, creates an isolated candidate index, and runs
   the relevant kernel, libc, POSIX, Node, and browser suites. Fix the
   platform before adding package-specific workarounds.
3. Render and install the pre-merge callers with exact `B` as described
   above. For an early bottle test, dispatch the protected tap's
   `prepare-kandelo-candidate-campaign` event with exact `S`, `T`, and
   pull-request number. It creates the noncanonical candidate-campaign
   tag. Keep `B`, `S`, and `T` unchanged while it derives and seals.
4. Dispatch `build-kandelo-bottle-candidate` with exact `S`, `T`,
   Formula, candidate-campaign tag, pull-request number, and staging
   tag. Independent version-1 leaf Formulae may run in parallel. Skip
   this step for Formulae outside the `wasm32` leaf scope.
5. Merge the exact prepared tree. The post-merge
   `activate-merge-candidate.yml` workflow verifies that the tested
   producer tree equals the resulting `main` tree, creates the new
   `binaries-abi-v<N>` release, copies the complete tested closure,
   commits one canonical index transaction, and publishes the release
   once. `force-rebuild.yml` is not the initializer for a new ABI
   release.
6. Read the final `main` commit `M` and the immutable archive producer
   `S` from activation evidence. Promote the required roots with
   `promote-package-generation.yml`, using `identical-git-tree-v1` to
   prove that the complete `S` tree equals `M`. The archives keep
   truthful `S` provenance even when `S` and `M` are different commit
   identities.
7. Render the callers again with exact `B` and `M`, then install that
   coordinated tap commit. If step 4 created a candidate, dispatch
   `promote-kandelo-bottle-candidate` with `S`, `M`, its candidate tag,
   Formula, and exact `M`-bound rootfs generation. Otherwise run a
   no-write bottle canary.
8. Publish Formulae in dependency order. Run independent branches in
   parallel. Each anonymously verified bottle becomes usable
   immediately; do not wait for unrelated failures before consuming it
   by immutable digest.
9. Recompose and validate the selected VFS image. Deploy only the image
   and guest lifecycle claims that passed both Node and browser
   evidence.

An ABI bump does not require one all-or-nothing full-catalog bottle
transaction. The dependency graph imposes ordering, but independent
leaves can publish at the same time and successful results remain
useful.

### Why candidates stay noncanonical before merge

Publishing directly from `S` would make unmerged code a package
authority. The candidate lane instead separates three actions:

1. untrusted source produces bytes without write credentials;
2. protected code seals those bytes under a candidate-only identity;
3. protected post-merge code may publish the same bytes after proving
   the exact merge and every bound input.

The third action is what makes the bottle canonical. A public immutable
candidate release is only quarantined evidence; public readability does
not grant package authority.

## VFS images and lazy bottles

A VFS image chooses policy; it is not another package format.

Files that are always needed, such as the shell used to boot the shell
image, can be materialized into the image. Less common programs remain
lazy. Their directory metadata is present so `stat` and `readdir` work,
but the first file content access downloads and verifies the complete
owning bottle, then materializes its selected tree atomically.

Lazy access currently downloads a whole bottle archive. It does not
fetch one TAR member or use HTTP range requests. Each dependency remains
a separate immutable bottle transport. A sealed atomic runtime cohort
may activate its selected dependency members together so the program
never observes a partial closure; unrelated bottles remain lazy.

Small, independent command binaries from a bundle such as
`posix-utils-lite` may later use per-program lazy references. A program
such as Vim needs runtime data beside its executable and should normally
activate its complete bottle tree.

The VFS image embeds the exact bottle-mirror plan. A separate immutable
tap release contains that plan and one verified copy of every deferred
payload. The plan records each URL, digest, and size. Browser code must
not turn an arbitrary URL in VFS metadata into network authority.

## `brew` inside a Kandelo guest

Guest Homebrew has two separate inputs:

1. `homebrew-bootstrap` contains one reviewed upstream Homebrew source
   tree plus Kandelo's guest-platform patch and environment policy.
2. A bottle-backed runtime-support closure supplies Ruby and the
   ordinary tools that Homebrew needs.

The base shell can expose `/usr/bin/brew` as a lazy activation
reference. A user who never runs `brew` does not pay the bootstrap and
Ruby download cost. An opt-in demo image may materialize the same layer
in advance.

A valid lifecycle test must use the real guest command to tap a separate
repository, resolve dependencies, install its public bottle, run it,
upgrade or remove it where claimed, and survive the supported reboot or
snapshot boundary. Preinstalling the third-party result into the demo
would not prove guest Homebrew.

The campaign's canonical Kandelo guest prefix is
`/opt/kandelo/homebrew`. Host Homebrew prefixes are not guest paths. The
currently deployed bottle-backed shell still uses the transitional
`/home/linuxbrew/.linuxbrew` layout. The campaign must change the
Formulae, bootstrap, and shell image together before `/opt` is described
as deployed behavior.

The first supported guest path will install prebuilt bottles. Building a
Formula entirely inside Kandelo is future work. It will use the same
Formula and tap model once the guest has a complete supported Clang/LLVM
toolchain and the remaining build-host capabilities.

## Third-party taps

A third-party tap uses the same Formula, bottle, and sidecar contracts
as the core tap. It owns its GitHub repository, GHCR namespace, workflow
caller, and visibility policy. Kandelo validates that the repository
name and tap name match Homebrew's conventional mapping.

The publication foundation is already proven for an independent
user-owned tap: public GHCR creation, anonymous readback, tap
finalization, and a Node-and-Chromium VFS canary are green. The complete
in-guest third-party `brew tap` and `brew install` lifecycle is still
rollout work. Upgrade, expected failure, reboot persistence, and
in-guest source builds must not be claimed until their own lifecycle
evidence passes.

The remaining first in-guest lifecycle proof should remain small:

- one Formula in a separate public tap;
- one public bottle built for the active Kandelo ABI;
- no hidden core-tap fallback;
- a live in-guest `brew tap` and `brew install`; and
- anonymous bottle retrieval in both Node and Chromium.

After that proof, adding more third-party Formulae is ordinary
dependency-graph work rather than a new platform exception.

## Failures and safe retries

- A failed Formula does not invalidate successful siblings.
- Never blindly repeat a first-package publication after an ambiguous
  upload. Inspect the workflow run and GHCR repository first.
- Immutable releases are content-addressed. A conflicting tag or asset
  is an error, not something to overwrite.
- Formula, source, application programming interface (API), tap, or
  `main` drift stops a write. Re-plan from the new exact source instead
  of relaxing the comparison.
- The native Homebrew compatibility lock is reviewed generated data.
  Refresh it from the exact pinned Homebrew executable on Linux, inspect
  the upstream Formula change, and require byte-for-byte equality in
  continuous integration (CI).
- Publication and finalization use locks, but locks do not replace
  digest, ancestry, or public-readback checks.

## Migration from `packages/registry`

The old Kandelo registry remains only while a Formula still calls a
registry build or while a non-Homebrew platform artifact has no proper
owner. A Formula file by itself is not proof that migration finished.

Registry retirement is separate from old container-package cleanup. Live
bottles use the `homebrew-tap-core/*` GHCR namespace. Historical private
`tap-core/*` or older canary packages are not current Formula inputs,
and removing those controls must not delete immutable live or last-green
bottle bytes used for rollback.

For each migrated package:

1. move the portable recipe into normal Formula DSL or a closed tap
   recipe;
2. publish and verify every required architecture;
3. switch VFS and consumer selection to the bottle and sidecar;
4. remove the Formula's registry bridge;
5. prove no source, build, CI, or image caller still owns the registry
   entry; and only then
6. delete the obsolete registry recipe and archive reference.

The migration ledger and current execution order live in the
[Homebrew migration plan].

[Homebrew migration plan]: plans/2026-07-21-homebrew-migration-execution-plan.md

## Where to look next

- [Homebrew Publishing](homebrew-publishing.md) is the detailed trust,
  workflow, schema, OCI, VFS, and recovery reference.
- [Porting Guide](porting-guide.md#homebrew-formula-authoring) explains
  how to author a Formula and closed recipe.
- [ABI Versioning](abi-versioning.md) defines when the ABI must change
  and how Kandelo rejects mismatched programs.
- [Binary Releases](binary-releases.md) explains Kandelo package
  generations and why they are separate from Homebrew bottles.
- [Package Management](package-management.md) documents the legacy
  resolver and the remaining bridge contract.
