# Homebrew Publishing

For a plain-language map of the complete system, including ABI-bump
operations, lazy VFS images, guest `brew`, and third-party taps, start with
[Kandelo Homebrew Packaging](homebrew-packaging-system.md). This document is
the detailed publication and validation reference.

Kandelo's Homebrew publishing path is a bottle publication and validation
pipeline shared by the first-party tap and conventional third-party taps. The
implementation lives in the main `Automattic/kandelo` repository; the
first-party live tap repository is `kandelo-dev/homebrew-tap-core`.

Migration status, preserved scope, and the remaining execution order are
tracked in the
[Homebrew Migration Living Execution Plan](plans/2026-07-21-homebrew-migration-execution-plan.md).

This is not a general user-facing Homebrew install guide yet. Do not document
`brew tap` or guest `brew install` commands until guest Homebrew install has
been validated through Kandelo. The supported implemented path today is:

- trusted CI builds Kandelo Homebrew bottles;
- bottle bytes publish to the GHCR/Homebrew bottle URL shape;
- formula `bottle do` blocks and Kandelo sidecars are generated together;
- host tooling pours verified bottles into precomposed VFS images;
- Node and browser smoke tests decide which runtime claims are recorded;
- an explicitly required, tap-selected dependency-bearing Brewfile gate can
  boot one exact composed image in Node and Chromium before its selected
  consumer publication passes; and
- that required gate publishes the exact accepted image and evidence as a
  public content-addressed release in the source tap after tap finalization.

Homebrew formulae and bottle metadata remain Homebrew-native. Kandelo sidecar
metadata is an additional contract for VFS builders, Node validation, browser
automation, and publication audits; it is not a replacement for Formula Ruby or
Homebrew's `bottle do` block.

## Durable Kandelo Package Input

The Homebrew publisher may consume Kandelo package archives while validating
or building bottles, but a PR's run-specific staging release is never a
durable input. After coherent canonical activation has landed, dispatch
`promote-package-generation.yml` from the exact freshly queried
`refs/heads/main` SHA. The resulting append-only prerelease has a
content-derived tag such as:

```
package-generation-rootfs-wasm32-abi-v42-sha256-<full-identity-sha256>
package-generation-browser-inputs-wasm32-abi-v42-sha256-<full-identity-sha256>
```

This is a Kandelo package generation, not a Homebrew bottle release. Schema 1
contains one selected root closure. Schema 2 `browser-inputs` contains the
sorted authoritative browser roots and deterministic typed closure union.
Program and library identities have archives; source-only identities remain
bound without an invented archive. Homebrew formulae, bottle blocks, tap
commits, and GHCR objects continue through the independent bottle contract
below.

Durable generation admission is exact-main only:

- workflow authority, package source, and freshly queried
  `refs/heads/main` must be the same SHA;
- `source-tag` must be the matching `binaries-abi-v<N>` release;
- every final package archive's embedded `[build].commit` must equal that
  main SHA;
- the canonical index, selected snapshot, and exact release asset metadata
  must agree byte-for-byte;
- a later consumer must independently reproduce the same fresh projection and
  expected ledger.

An ancestor, PR head, tested merge, direct tag, reachability proof, or
same-tree commit cannot authorize final package inputs. Pre-main #1094
45-root/62-identity/61-archive values remain selection regression evidence
only; the final generation must derive new identities and accept only
main-stamped archives after activation.

For `browser-inputs`, projection equality includes the complete sorted root
list, typed source-only entries, manifests, and contextual cache keys—not only
the archive set. Current main authority runs its own browser-root scanner
against source/consumer trees as inert data and parses their manifests with
its versioned Rust reader. It never executes a historical or consumer dev
shell, npm package, Cargo invocation, xtask, or repository script.

Preparation, publication, and materialization share one strict Rust generation
validator for the exact index set, strict TOML/JSON, validated snapshot, sorted
asset inventory, hashes, archive manifests, Git inputs, and embedded main
commit. The writer requeries live main and canonical package assets immediately
before the seal and public release. The materializer anonymously downloads and
rehashes every asset, requeries immutable generation release/tag metadata, and
rechecks clean authority/consumer state immediately before exposing the
resolver index. The Homebrew publisher must consume that verified local index;
it must never reconstruct a staging or mutable canonical URL.

For a canonical bottle run, both architecture-specific `browser-inputs` tags
are explicit `package_generation_wasm32` and `package_generation_wasm64`
dispatch fields. The protected callers forward them as
`package-generation-wasm32` and `package-generation-wasm64`; a mutating publish
or maintenance rebuild rejects either missing tag. A dry run may omit either
tag because it cannot write, but any supplied tag still has to be an exact
architecture-bound content tag.

The preserved schema-1 `rootfs-wasm32` generation is a narrower migration
bridge. It supplies the fixed wasm32 Formula build/test runtime packages; the
workflow builds the current-main sysroot and SDK separately, and the generation
does not contain the target Formula's output bottle. This lane accepts exactly
`wasm32` and no dependency-bearing VFS acceptance. Ordinary dry runs are
rejected. The one exception is the prefix campaign's first-package bootstrap
phase: it uses exact protected-history commits, an exact public generation,
and sealed campaign authority rather than branch-selected source.

After cache-key planning removes already-current bottles, the publisher parses
only the Formulae that will actually build. The static parser runs with the
repository-pinned Nix Ruby, and its complete record is bounded for workflow
transport. A strict schema-2 Formula with no registry bridge and a strict
schema-3 sealed tap recipe are admitted from those exact authority records.
Transitional registry bridges carry broader main-repository recipe authority,
so each Formula-to-registry-package identity is explicitly reviewed; the
current temporary mappings are
`modeset` to `modeset` and `nethack` to `nethack`. The complete per-Formula
record is compared again at the last workflow boundary before the bottle
builder attests and executes the Formula. Adding a direct Formula or sealed tap
recipe therefore does not require another name allowlist edit, while adding a
registry bridge does.

The publisher requires each generation's embedded package source to equal its
admitted exact-main SHA and materializes it before package resolution. Formula
build/test helpers use the verified local wasm32 generation because those
helpers are wasm32 programs for both bottle architectures. Browser verification
combines both independently verified generations. Both phases export only the
resulting exact `file://` index beside the downloaded archives; neither may use
the mutable `binaries-abi-v<N>` index as a base or fallback. Matching recipes
from an ancestor, equal tree, or older main commit remain valid for ordinary
projection-compatible consumers but are not bottle-production authority.

See
[Binary releases: durable package generations](binary-releases.md#durable-package-generations-for-cross-workflow-publication)
for dispatch, recovery, seal-last publication, and mutation handling.

## Guest Homebrew Bootstrap Package

The patched Homebrew Ruby tree used by a guest is a dedicated Kandelo program
package named `homebrew-bootstrap`; it is not a Formula bottle. The package
atomically emits `homebrew-bootstrap.zip` from a sealed exact Homebrew checkout
and the reviewed guest-platform patch plus `homebrew-brew.env`, which owns the
matching architecture and system-environment policy. Its source lock at
`homebrew/homebrew-bootstrap-source-lock.json` binds all source, patch,
prepared-tree, portable-Ruby, archive-producing Git, and final-archive
identities. The program-package generation binds both declared members to one
recipe, dependency closure, cache identity, and immutable release archive;
consumers must resolve the canonical nested member paths together rather than
recreating `brew.env` or resolving a mutable flat fallback.

## Native Homebrew API Admission

The Linux publisher uses upstream Homebrew to install native build and
test tools such as Git, Ruby, CMake, and `ca-certificates`. Homebrew
resolves those tools from two signed API feeds. The public feed supplies
Formula and bottle metadata; the internal feed supplies the install plan
that Homebrew executes. Both feeds are rolling inputs even when the
Homebrew source checkout is pinned.

That distinction caused the failure this contract prevents. The internal
`ca-certificates` record gained a `run` postinstall step. The older
pinned Homebrew source did not understand that current install-plan
shape, so a normal native bottle installation failed before Kandelo
could build its target bottle. Pinning only the Homebrew Git commit
therefore did not freeze the executable native-tool input.

Each nonempty publisher realm now freezes its own signed API view before
any untrusted Formula code runs. Exact pinned Homebrew performs the
network fetch, verifies both JSON Web Signatures (JWS), and materializes
the lazy name, alias, and executable indexes. The workflow then makes
the complete API cache root-owned and read-only. Later, the same exact
Homebrew resolves aliases, implicit Linux dependencies, variations, and
bottles inside the isolated realm against that sealed cache. Kandelo
admits the resulting selected records before installation.

The build realm admits `.build_and_test`; the independently created
verifier realm admits `.runtime_and_test`. They cannot share mutable
Homebrew state or assume that two fetches made at different times
returned identical bytes.

The public and internal feeds in one realm must each identify one exact
`homebrew/core` Git head and must agree with each other. The head and
complete frozen-file inventory are recorded as run evidence. They are
deliberately not committed as a whole-feed compatibility pin: an
unrelated Formula can change without changing the native tools selected
by this publisher.

Instead,
`homebrew/homebrew-native-compatibility-lock.json` records Homebrew's
exact x86_64 Linux projection for every Formula in the allowed native
closure. Admission compares only the records Homebrew actually selected
for the current roots. A change to an unused Formula passes. A change to
a selected Formula's x86_64 Linux compatibility projection, full
internal install plan, Linux variation, or bottle fails before
installation. Prefix-expanded caveat and service presentation fields
are intentionally excluded.

The reviewed lock deliberately uses Homebrew's forced libc and compiler
compatibility switches while deriving that closure. Exact Homebrew otherwise
decides whether `glibc` and `gcc` are implicit dependencies by comparing the
runner's system glibc and libstdc++ with Homebrew's CI versions.
GitHub can roll `ubuntu-latest` between two such capability states. The
forced lock therefore contains the conservative GCC/glibc bootstrap tree,
while each publisher admits and installs only the subset Homebrew selects for
its actual host. This is a compatibility superset, not permission to
install an undeclared native tool.

After every direct root, the publisher audits the native Cellar. Every
installed keg must remain inside the admitted closure, every requested
root must exist, and every receipt must identify a poured
`homebrew/core` bottle loaded from the signed internal API.

A publisher job with no native roots does not fetch the API or create
an invented empty admission. This keeps zero-root jobs offline and
prevents a network dependency from appearing where no native Formula
can execute.

When a selected native Formula legitimately changes, regenerate the
lock only in a fresh Linux x86_64 publisher-equivalent realm using the
exact Homebrew commit in
`homebrew/homebrew-native-compatibility-roots.json`. The updater derives
the repository from the Brew executable and rejects a wrong commit or
any staged, unstaged, untracked, or source-affecting Git index/config
state. It disables and rejects Git replacement objects, rejects legacy
grafts and checkout transformations, and compares every tracked file's
raw bytes, executable meaning, and symlink target with the reviewed Git
tree. Homebrew may create only its checksum-pinned portable Ruby under
the one ignored vendor directory. The updater inventories that complete
runtime after bootstrap and requires the tracked checkout and ignored
runtime to remain byte-for-byte unchanged through lock generation.

```bash
brew_commit="$(
  jq -er '.homebrew_commit' \
    homebrew/homebrew-native-compatibility-roots.json
)"
brew_source="$(mktemp -d /tmp/kandelo-reviewed-brew.XXXXXX)"
git -C "$brew_source" init
git -C "$brew_source" remote add origin \
  https://github.com/Homebrew/brew.git
git -C "$brew_source" fetch --depth=1 origin "$brew_commit"
git -C "$brew_source" checkout --detach FETCH_HEAD
KANDELO_HOMEBREW_SUDO_BIN=/usr/bin/sudo \
  scripts/dev-shell.sh bash \
    scripts/update-homebrew-native-compatibility-lock.sh \
      "$brew_source/bin/brew" \
      homebrew/homebrew-native-compatibility-lock.json
```

The source must be a fresh, unbootstrapped checkout. The updater creates
its own disposable native prefix so Homebrew's mutable locks and Cellar
state cannot enter the reviewed source. Native publisher host paths are
not Kandelo guest paths and must never enter a bottle, VFS image, or
guest-visible link.

Review the resulting selected-record diff. Confirm that the two signed
feeds still agree, inspect the upstream `homebrew/core` change, and
verify every changed Formula, bottle, and install-plan step is expected.
Then rerun the native `ca-certificates` lifecycle and the complete
build/verifier publisher test. Do not hand-edit the lock, accept a
partial API cache, disable signature verification, or refresh the lock
automatically during publication.

The path-scoped
`homebrew-native-publisher-compatibility.yml` pull-request workflow owns
that Linux evidence. It runs the updater with poisoned caller Homebrew,
Git, Ruby, and Bundler settings, uploads the generated lock even when it
differs from the reviewed file, and then requires byte-for-byte
equality.
It pours Ruby's admitted native closure to exercise the signed
`ca-certificates` postinstall step, proves OpenSSL's certificate link
and a verified TLS connection, and retains the resulting evidence. The
generated lock is uploaded last as diagnostic evidence, including when
an earlier substantive check fails, so an artifact-service failure
cannot prevent the lifecycle checks from starting.

The general publisher regression suite also runs a real patched
Homebrew build-and-test lifecycle. Staging preflight checks out the
same exact reviewed Homebrew commit and passes that path only to the
suite invocation. CI refuses to substitute Homebrew from the runner
image when the declared checkout is absent or invalid. Local runs may
reuse a known clone, but still verify the exact commit and the two
lifecycle-sensitive source blobs before creating a disposable
worktree.

After that preflight is green, merge the publisher change, rotate the
tap's immutable Kandelo workflow pin, and dispatch the trusted tap-main
dry-run for one fixed `bzip2`/wasm32 lane. That lane runs independently
frozen build and verifier realms without uploading packages, writing an
index or tap, or publishing a release.

Do not call the complete publisher from merge-candidate pull-request
code. GitHub validates every permission requested by the reusable
workflow, including write-capable jobs that dry-run conditions skip.
Granting those permissions to the pull request would let changed
workflow bytes make a write job reachable. The exact Linux input and
TLS proof is therefore the read-only pre-merge gate; the complete
publisher-realm dry-run is the immediate post-merge gate from reviewed
tap-main workflow bytes.

Those two checks are deliberately compositional. The pre-merge Ruby
lifecycle proves the signed install plan and certificate output in the
exact, bounded Homebrew environment. The post-merge `bzip2` dry-run
separately proves the real systemd-isolated build and verifier realms
with their nonempty native tool closures. It does not claim that Ruby
and `ca-certificates` ran inside that systemd lane. A future integrated
lane may select a cheap Formula whose native closure includes Ruby, but
the current retained gates keep the two claims distinct.

## Repositories And Ownership

| Repository                      | Owns                                                                                                                                   |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `Automattic/kandelo`            | Schemas, validators, reusable workflows, package build scripts, VFS planner/builder, Node/browser smoke tests, and this documentation. |
| `kandelo-dev/homebrew-tap-core` | Tap state: `Formula/`, generated `Kandelo/` sidecars, bottle blocks, and provenance reports.                                           |
| `<owner>/homebrew-<name>`       | A third-party tap's Formulae, generated state, GHCR bottle packages, and caller-scoped publication authority.                          |

The checked-in `homebrew/homebrew-tap-core/` directory is a reviewable template
and test fixture for the tap shape. Live generated tap state belongs in
`kandelo-dev/homebrew-tap-core`, not in the main repository template.

Repository identity and Homebrew tap identity are separate inputs. Every tap,
including Kandelo's default tap, uses the conventional repository shape. A
conventional repository `<owner>/homebrew-<name>` has canonical Homebrew tap
name `<owner>/<name>`. Repository identity owns GitHub checkout, source links,
the caller token, and the GHCR bottle namespace; tap identity owns `brew`
references, installed Formula paths, receipts, OCI titles, and Kandelo
sidecars. Therefore the default repository `kandelo-dev/homebrew-tap-core` is
the canonical tap `kandelo-dev/tap-core`; its GitHub Container Registry (GHCR)
root is
`https://ghcr.io/v2/kandelo-dev/homebrew-tap-core`. Tooling may omit the tap
name only for this protected default, and derives `kandelo-dev/tap-core` through
the same conventional rule. Other repositories must state the derived tap name
explicitly so an omitted input cannot silently change publication identity.

## Immutable Dependency Taps

A tap may depend on public Kandelo bottles owned by another tap, but the source
set is tap-owned and immutable. The primary tap commits
`Kandelo/dependency-taps.json` with this exact schema:

```json
{
  "schema": 1,
  "taps": [
    {
      "tap_name": "kandelo-dev/tap-core",
      "tap_repository": "kandelo-dev/homebrew-tap-core",
      "tap_commit": "0123456789abcdef0123456789abcdef01234567"
    }
  ]
}
```

Entries are uniquely sorted by normalized `owner/tap`, repositories must use
the matching conventional `owner/homebrew-tap` identity, and commits must be
exact lowercase 40-character SHAs. Branches, tags, workflow inputs, dispatch
payloads, and free-form repository JSON cannot add or replace dependency taps.
The current reviewed policy intentionally permits only the public
`kandelo-dev/tap-core` repository; adding another source repository requires a
Kandelo code change and review.

Every workflow role independently checks out each dependency tap at the locked
SHA without a GitHub token, verifies its clean Git identity, and materializes a
bounded read-only resolved map for the static resolver. Before Formula code
runs, Homebrew clones the locked taps into its isolated target prefix. The
original dependency checkouts are then inaccessible to both target and native
Formula processes. Fresh post-execution checkouts reconstruct the map and
revalidate all later provenance, sidecar, and VFS work. Bottle reads use each
source repository's public repository-rooted GHCR namespace; no dependency-tap
package credential is accepted or required.

Every tap in one Formula closure must carry the same byte-identical, explicitly
versioned Kandelo Formula support runtime tree. That tree is the support Ruby
module plus every publisher-consumable top-level file beside it; the tap-local
`test/` directory is intentionally excluded. The static resolver verifies the
API version, support-module SHA-256, and deterministic runtime-tree SHA-256 of
every copy before Ruby runs. Whichever identical copy Ruby loads first owns
`KandeloFormulaSupport`; a later copy checks its own module hash against that
frozen runtime authority and performs no definition work. Binding the whole
tree matters because support methods dispatch neighboring TypeScript, shell,
Perl, HTML, and configuration files through their lexical `__dir__`.

Formula support API version 1 always includes that canonical runtime authority;
there is no valid inert or module-only version-1 shape. A tap that omits the
runtime initializer or assignment is rejected even when its Formula does not
use the Tier-2 registry bridge.

The publisher carries both hashes through the Tier-2 plan and attestation. The
bottle builder and anonymous-pour verifier each select and validate an exact
clean primary tap clone, materialize the selected Formula, and bind that clone
to `HOMEBREW_KANDELO_PRIMARY_TAP_ROOT` before isolation. The launcher then makes
the whole Homebrew tap store read-only. That store is rooted under the active
reviewed Homebrew repository worktree, where Homebrew actually clones taps,
rather than under `HOMEBREW_PREFIX`; the publisher deliberately keeps the
canonical Kandelo prefix while running a separate patched repository
worktree. Active
Tier-2 evaluation therefore resolves and attests the selected Formula under the
primary tap root regardless of whether Homebrew loaded primary or dependency
support first. A missing root, changed module or runtime helper, different
support API version, or Formula/support drift fails before Formula installation.

Adding the runtime-tree digest changed the exact Tier-2 control-document shape.
Registry-bridge and inert Formula plans therefore use schema 2. Formula-owned
tap recipes use schema 3 so the publisher and runtime can distinguish them
without inferring authority from optional fields. Schema 3 carries exactly one
`tap_recipe` and a null `tier2_bridge`; schema 2 never carries `tap_recipe`.
Schema 1 is rejected rather than interpreted as if it carried either newer
runtime contract.

The protected publisher plan repeats every target tap as a sorted immutable
identity record containing its normalized tap name, conventional repository,
and exact commit. The plan must equal the root-generated resolved map. Homebrew
suppresses Linux-native global dependency injection only for those exact taps;
an undeclared tap retains normal Homebrew behavior, while a mutable revision or
mismatched repository fails before Formula evaluation.

Runtime dependencies crossing a tap boundary must use a fully qualified
literal such as `depends_on "kandelo-dev/tap-core/dash"`. Unqualified runtime
dependencies remain native host Formulae and are rejected unless their tags
place them exclusively in the reviewed build/test realm. To update a locked
dependency, first publish and validate its public bottle and sidecars, then
review a primary-tap commit that changes only the exact SHA in this file.

For a third-party tap, the complete operator sequence is:

1. Choose a `kandelo-dev/homebrew-tap-core` commit whose required Formula,
   bottle block, and generated `Kandelo/` sidecars are already public and
   validated. Record the commit's full 40-character SHA; do not record
   `main`, a tag, or an abbreviated SHA.
2. Add or update `Kandelo/dependency-taps.json` in the third-party tap so its
   core entry names that exact commit. Keep the entries sorted by `tap_name`.
3. Declare a new dependency in the consuming Formula with its canonical full
   name, for example `depends_on "kandelo-dev/tap-core/dash"`. Commit a new
   Formula dependency and its lock together so publication cannot observe the
   dependency without its source authorization.
4. Pin the tap's caller workflow to a reviewed immutable Kandelo commit that
   implements this lock schema, then dispatch the normal bottle publisher.
   Do not pass a dependency repository or revision in the dispatch payload.
5. Review the publication result and its Node/browser VFS acceptance evidence.
   A later core update repeats steps 1 and 2 in a normal tap pull request; the
   publisher never advances the lock automatically.

The reusable workflow checks out the public core repository and reads its GHCR
bottles anonymously. The third-party tap therefore needs no core-repository
token and no core-package secret. Its own caller keeps only the normal scoped
publication permissions for its own tap and package namespace.

## Artifact Model

Homebrew publishing is a sibling to Kandelo package archive publishing:

| Artifact                                                               | Storage                                                                   | Consumer                                                                      |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Formula source and `bottle do` blocks                                  | Tap git repository                                                        | Homebrew.                                                                     |
| Bottle tarballs                                                        | GHCR/Homebrew bottle URL shape                                            | Homebrew and Kandelo VFS builder.                                             |
| `Kandelo/metadata.json`                                                | Tap git repository                                                        | VFS planner, validator, audit tooling.                                        |
| `Kandelo/formula/*.json`                                               | Same as metadata                                                          | Formula-level Kandelo sidecar.                                                |
| `Kandelo/link/*.json`                                                  | Same as metadata                                                          | VFS builder pour/link plan.                                                   |
| `Kandelo/reports/*.provenance.json`                                    | Same as metadata                                                          | Durable publication and validation evidence.                                  |
| `Kandelo/vfs-acceptance.json` and its Brewfile                         | Tap git repository                                                        | Optional tap-owned dependency-bearing acceptance selection.                   |
| `Kandelo/dependency-taps.json`                                         | Primary tap git repository                                                | Exact reviewed public tap source lock.                                        |
| Required-gate VFS image, descriptor, report, and Node/browser evidence | Source tap GitHub Release `homebrew-vfs-sha256-<image-sha256>`            | Kandelo browser direct-`vfs` launch, acceptance audit tooling, and operators. |
| Closed lazy runtime-layer descriptor and payload                       | Source tap GitHub Release `homebrew-runtime-layer-sha256-<bundle-sha256>` | Bottle-backed lazy shell composition and host consumers.                      |
| Browser gallery assets                                                 | Run-scoped diagnostic artifact                                            | Review evidence only; not a durable public gallery.                           |

Do not publish Homebrew bottles into Kandelo's `binaries-abi-v<N>` package
release, and do not use a Kandelo package-source `index.toml` as a substitute
for Homebrew bottle metadata. A package-source-shaped `gallery.json` and
`index.toml` may be generated only for browser-smoked precomposed VFS images.

## Kandelo Bottle Tags

Kandelo bottles use the Homebrew platform tags `wasm32_kandelo` and
`wasm64_kandelo`. The tag names intentionally keep the Kandelo ABI out of the
Homebrew tag. ABI compatibility belongs in Kandelo sidecar metadata, namespaces
such as `bottles-abi-v<N>`, and cache-key checks.

Homebrew's current bottle tag parser treats the token before the final
underscore as a CPU architecture only when it is listed in
`Hardware::CPU::ALL_ARCHS`. Without a patch, `wasm32_kandelo` is parsed as an
`x86_64` bottle for a synthetic `wasm32_kandelo` system and serializes back as
`x86_64_wasm32_kandelo`.

The carried platform patch is:

```text
homebrew/patches/0001-add-kandelo-wasm-bottle-tags.patch
```

It teaches Homebrew's parser that `wasm32` and `wasm64` are CPU architectures
for `system: :kandelo`, maps the supported prefix and cellar, and makes the
exact `/usr/bin/brew` guest alias retain the canonical prefix after resolving
its direct symlink. It also preserves an explicitly supplied GHCR repository
path. Upstream Homebrew normally removes a repository's conventional
`homebrew-` prefix even from an explicit `root_url`; that would silently turn
the public `homebrew-tap-core/*` transport back into the private legacy
`tap-core/*` namespace during bottle creation and guest Formula loading.
Generated upstream roots retain their ordinary short-name behavior; only the
explicit repository-rooted URL remains intact.

Homebrew's upstream package uploader still derives its destination through the
short-name helper. This patch protects bottle metadata creation and guest
loading; production publication continues to use Kandelo's independently
validated, credential-isolated OCI/ORAS transport described below.

The guest-prefix campaign targets:

```text
/opt/kandelo/homebrew
/opt/kandelo/homebrew/Cellar
```

These are Kandelo guest paths, not Linuxbrew paths. They become the
supported product layout only when the atomic guest-prefix campaign and
shell cutover land. The currently deployed bottle-backed shell and the
diagnostic bootstrap still use the transitional
`/home/linuxbrew/.linuxbrew` prefix. Do not describe that transitional
layout as the campaign endpoint.

The target guest uses the existing `/home/user` account for writable
cache and configuration state and exposes `/usr/bin/brew` as the stable
command. After cutover, new images must not create a `linuxbrew` user,
install below `/home/linuxbrew`, or add a compatibility symlink for the
retired guest prefix.

The machine-readable contract is
`homebrew/kandelo-guest-layout.json`. Bottle admission scans every regular
archive member for the contract's retired prefixes. This byte scan is
intentional: some bottles marked `:any_skip_relocation` still contain
functional compiled paths, so Homebrew's relocation metadata cannot by itself
prove that an old-prefix bottle is safe to reuse.

Trusted CI applies this patch to a temporary Homebrew worktree. A short-lived
root-owned launcher under the selected Homebrew prefix loads that worktree
while preserving the selected Kandelo prefix and Cellar. Native host tools use
a separate ephemeral Homebrew prefix, as described in
[Native And Target Dependency Realms](#native-and-target-dependency-realms).
The prefix `bin` directory is root-owned and sticky during isolated execution:
the Formula identity may add ordinary keg links there, but it cannot replace
the root-owned launcher whose invocation path selects the target prefix.
Formulae execute as a dedicated unprivileged OS identity in one transient
systemd service per Brew invocation.
`KillMode=control-group` binds double-forked and session-detached descendants to
that invocation, while `NoNewPrivileges=yes` prevents Formula processes from
using set-user-ID or set-group-ID helpers to delegate later execution. The
identity cannot write the patched worktree, its Git metadata, Kandelo source,
tap source, or publication output. Before any bottle file is read, the builder
tears down the service slice and proves through a privileged process-table read
that the dedicated UID owns no live process. CI removes the dedicated account
before fresh validator checkouts or handoff processing. The launcher and
worktree are removed when the bottle build exits. Do not patch a developer's
host Homebrew checkout in place.

The bottle builder and verifier also apply a second patch only to their
temporary publisher worktrees:

```text
homebrew/patches/0002-support-isolated-publisher.patch
```

They trust the reviewed tap before isolation, then seal the patched Homebrew
repository and build-local XDG configuration against Formula writes. The
configuration uses root-owned directories with mode `0555` and readable
regular files with mode `0444`. Pinned Homebrew normally requires its repository
to be writable and tries to persist a redundant Formula entry for every fully
qualified install even when that tap is already trusted. The publisher-only
patch excludes only the protected repository from Homebrew's preinstall
writability diagnostic and skips that automatic trust persistence. It also
lets a `--ignore-dependencies` source build activate only the direct native
build dependencies authorized by the root-owned static plan. Homebrew still
does not fetch or install their recursive native closure into the target
Cellar. On Linux, the patch also suppresses Homebrew's implicit global host
dependencies only when that protected plan identifies the selected Kandelo
target Formula. Native Homebrew and every unrelated Formula retain normal Linux
global dependency resolution. Every other required Homebrew path keeps the
normal writability check.
Explicit `brew trust` still fails under the isolated identity because the trust
store is immutable.
Before that identity starts, the trusted workflow installs Homebrew's locked
`formula_test` and `bottle` Bundler groups into the temporary overlay and
verifies their state files. Gem archives can carry writable filesystem modes,
so the launcher normalizes every overlay directory and regular file to a
read-only mode before it activates the Formula identity. The complete overlay
is then verified as sealed, so later
`brew test` and `brew bottle` commands use the reviewed gem set without writing
Homebrew source or downloading executable code during Formula evaluation.
The production overlay is a linked Git worktree. Its `.git` file points back
into workflow-owned worktree metadata under the original Homebrew checkout,
whose private ancestors the isolated build identity cannot traverse. A
`safe.directory` exception can suppress Git's cross-owner protection, but it
cannot grant that missing filesystem access, so even an exception for the
exact overlay cannot verify its commit from inside the isolated realm.

Before isolation, the trusted launcher instead uses protected Git to record
the overlay's exact base commit and tree. After sealing, it binds those values,
the canonical overlay path, and the exact sealed overlay-state digest into a
root-owned, read-only, single-linked attestation. The isolated `admit` and
`audit-cellar` operations validate that record and the expected commit without
invoking Git. Trusted outer `prime`, `recheck`, and `generate-lock` operations
retain their protected-Git checks because they run where the workflow-owned
metadata is traversable. General native Homebrew commands receive neither Git
metadata access nor a `safe.directory` exception.
The bootstrap and guest Homebrew apply only the platform patch above, so their
repository and trust behaviors are unchanged.

The transient-service containment above is the current official publisher's
Linux security backend, not a Kandelo bottle target requirement. Local
credentialless builds continue to use the ordinary POSIX path when no CI build
identity is requested, and the produced Wasm bottles target Kandelo rather than
the build host. Publishing from macOS, another POSIX host, or WSL is not yet a
validated release path; it requires an isolation backend with the same source,
process, account, and credential boundaries rather than a weaker fallback.

Verify the platform patch against a Homebrew checkout and exercise the
publisher-overlay semantics with:

```bash
scripts/dev-shell.sh bash scripts/verify-homebrew-kandelo-platform-tags.sh
scripts/dev-shell.sh bash scripts/test-homebrew-publisher-overlay-patch.sh
```

## Formula Authoring

Formulae live under the tap's `Formula/` directory and should use normal
Homebrew DSL: `depends_on`, `resource`, `patch`, `revision`, `bottle do`,
`rebuild`, and `test do`.

Keep Kandelo-specific VFS planning data out of Formula Ruby. Link plans,
runtime support, browser compatibility, cache keys, and validation evidence
belong in generated `Kandelo/` sidecars.

For formulae that build Kandelo Wasm artifacts:

1. Build through Kandelo's normal SDK. Prefer idiomatic Formula steps for small
   ports and a Formula-owned tap recipe for build logic that needs a script.
   Calling an existing `packages/registry/<name>/build-*.sh` is the
   transitional registry bridge, not the destination architecture.
2. Install only the produced Wasm artifacts into the Homebrew keg.
3. Preserve Homebrew's prefix and cellar model:
   `/opt/kandelo/homebrew` and
   `/opt/kandelo/homebrew/Cellar`.
4. Put runtime validation in `test do`, but execute Wasm through Kandelo
   rather than as a host Linux binary.
5. Update Homebrew `revision` or bottle `rebuild` when bottle bytes should move
   for Homebrew bottle selection. Update Kandelo `build.toml` `revision` only
   when the underlying Kandelo package output bytes legitimately change.

### Formula-owned tap recipes

A non-idiomatic source build can keep its reviewed build logic in the tap
without retaining a Kandelo registry recipe. The fixed layout is:

```text
Formula/<formula>.rb
Kandelo/recipes/<formula>/recipe.json
Kandelo/recipes/<formula>/build.sh
Kandelo/recipes/<formula>/<other declared inputs>
```

`recipe.json` is the complete input manifest:

```json
{
  "schema": 1,
  "dependencies": ["kandelo-dev/tap-core/zlib"],
  "entrypoint": "build.sh",
  "files": [
    {
      "bytes": 367,
      "mode": "0644",
      "path": "build.sh",
      "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    }
  ]
}
```

Paths are sorted, unique, canonical ASCII relative paths. Every file below the
recipe root except `recipe.json` must appear once; undeclared files, missing or
empty directories, special nodes, symlinks, hard links, traversal, changed
bytes, changed sizes, and changed modes fail closed. Files use only `0644` or
`0755`; directories and the recipe root use `0755`; `recipe.json` uses `0644`.
The manifest is limited to 512 files, 16 MiB per file, and 64 MiB in total.

The Formula binds that complete tree with one literal manifest digest:

```ruby
class Example < Formula
  include KandeloFormulaSupport

  KANDELO_TAP_RECIPE = true

  url "https://example.test/example-1.0.tar.gz"
  version "1.0"
  sha256 "..."

  resource "fixture-data" do
    url "https://example.test/fixture-data-1.0.tar.gz"
    sha256 "..."
  end

  depends_on "kandelo-dev/tap-core/zlib"

  def install
    out_dir = kandelo_build_tap_recipe(
      manifest_sha256: "...",
      resources: ["fixture-data"],
      script_env: {
        "EXAMPLE_FEATURE" => "enabled",
      },
    )
    prefix.install out_dir.children
  end
end
```

The call must be the direct right-hand side of one local assignment in
`install`; the marker, literal manifest SHA-256, sorted literal resource-name
array, literal environment keys, source URL/version/SHA-256, and target
dependency declarations are parsed without evaluating Formula Ruby. Every
selected resource must have one canonical literal `resource` block with an
HTTPS URL and SHA-256. Resources declared only for `test do` remain unselected
and are not exposed to the build. The manifest dependency list must exactly
equal the Formula's selected direct target dependency list. Environment keys
are bounded, Formula-namespaced, and may not replace helper-owned source,
recipe, dependency, resource, work, or output values.

Before Formula evaluation, the Rust preflight independently reads the exact
tap root, validates every manifest entry and filesystem node, and emits a
schema-3 attestation. Homebrew supplies and verifies the upstream source; the
helper moves that staged source below `WASM_POSIX_DEP_SOURCE_DIR`. It derives
each `WASM_POSIX_DEP_<NAME>_DIR` from the exact poured Homebrew keg and exposes
separate caller-owned `WASM_POSIX_DEP_WORK_DIR` and
`WASM_POSIX_DEP_OUT_DIR` roots. `WASM_POSIX_DEP_RECIPE_DIR` is read-only.

Selected Homebrew resources use the same closed authority path. The publisher
binds each resource's literal URL and SHA-256 into the schema-3 attestation.
The Formula helper verifies that identity against Homebrew's selected resource,
stages it only below the fixed
`kandelo-package-resources/<resource-name>` layout, and sends no
Formula-selected absolute path to the privileged runner. The runner requires
the exact attested set, rejects missing or extra children, snapshots each tree
while checking directory and file identity, and mounts the copy read-only at
`/kandelo/resources/<resource-name>`. The recipe receives that path through
`WASM_POSIX_DEP_RESOURCE_<NORMALIZED_NAME>_DIR`.

A recipe may select at most 32 resources. Resource names are at most 128 ASCII
characters, URLs are at most 1 KiB, and the combined staged trees are limited
to 65,536 entries and 1 GiB, with a 256 MiB per-file and 4 KiB path limit.
Contained relative symlinks are preserved; a symlink that escapes its resource
tree, source replacement, concurrent mutation, or name-to-environment
collision fails publication. These projections exist only during the bottle
build and do not change Node or browser runtime semantics.

The attestation records content provenance, not licensing policy. The Formula's
`license` declaration must still accurately describe the distributed payload.
When resource code or data is incorporated into that payload, its license must
be represented and required license or notice files must be installed as the
upstream terms require. A build-only resource that contributes no distributed
bytes still needs reviewable provenance and compliant build use. Do not use a
resource projection to hide generated or vendored inputs whose origin and
license are not reviewable.

Tap recipes retain the Kandelo SDK, sysroot, and fork instrumenter as platform
tooling, but they do not receive registry authority. The isolated publisher
omits the checker environment and makes the old `packages/registry`,
`local-binaries`, transported binary cache, release `xtask`, and
`scripts/install-local-binary.sh` paths inaccessible. A copied registry script
that still calls `build-deps` or `install_local_binary` therefore fails rather
than silently falling back to the old package system.

Formula execution and Formula validation use different read authorities.
Builds receive only the schema-3 platform projection described above. For the
exact top-level `brew test` command, the launcher instead mounts a separate
root-owned Formula-test runtime at the same `HOMEBREW_KANDELO_ROOT` alias. A
privileged, admitted copy of the recipe runner constructs that runtime from a
closed allowlist: the platform projection; `host/src`; the built
`host/wasm` kernel inputs; the three `examples/run-example*.ts` entry files;
the exact `tsx`, `esbuild`, `fflate`, `fzstd`, and Vite installations; the
portable `binaries/` and `.ci-test-binary-cache/` pair; and the reviewed
release `xtask`. Root `Cargo.toml` and `package.json` provide the resolver's
Kandelo-root identity. The npm portion is not a fixed list of today's
transitive package names. The privileged stager parses the committed
package-lock v3 document, starts from those five runtime packages, and follows
each required dependency plus each installed optional dependency using Node's
package-root lookup. Every selected package must be an ordinary canonical
directory whose manifest name and version match a lock entry carrying SHA-512
integrity. This includes the installed platform-specific esbuild, Rolldown,
and Lightning CSS bindings while omitting unrelated top-level packages. A
missing required package, an unlocked nested package that copying a selected
tree would expose, a replaceable link, or lockfile mutation fails before
publication.

The publisher's clean `npm ci` verifies fetched package tarballs against the
package-lock integrity records before this selection. The stager then hashes
the installed source bytes, rechecks their filesystem identities after
copying, and seals only the resulting runtime closure. It does not copy
`package-lock.json`; the lock is selection authority, not Formula-readable
repository metadata. Vite is launched with the protected Node executable and
the exact sealed `node_modules/vite/bin/vite.js` path, so browser Formula tests
do not run `npx`, consult `PATH` for Vite, or fetch missing tooling from the
network.

`host/wasm/program-packages.json` is generated from the exact source
checkout for only `dash`, `coreutils`, `grep`, `sed`, and `rootfs`: the
physical package generations transported into this runtime. It carries
those package projections and every contextual dependency identity they
name, so a fetched generation remains bound to its package name,
architecture, manifest, outputs, and cache key. Unrelated repository
index rows are not copied. The repository-wide index remains an independently
checked, current source projection; the smaller file is a least-authority
runtime input, not a substitute for that repository contract. Workspace
members, the source/build registry, local binaries, unrelated package
identities, Cargo output, source-build helpers, and the mutable checkout
remain absent.

The stager snapshots and hashes every selected source before copying, checks
the source identities again after copying, validates symlinks against the
combined projection so `binaries/` may reach only its transported sibling
cache, seals every output node, and atomically publishes the complete tree.
An npm install may hard-link `esbuild/bin/esbuild` to the selected
`@esbuild` executable. The stager accepts that layout only when every link to
the inode is present in the declared projection; it then copies each selected
path into a separate single-link sealed inode. An undeclared hard-link path
therefore fails closed instead of retaining mutation authority.
The launcher independently hashes the full sealed manifest before and after
Formula execution. Ordinary `brew build`, dependency, bottle, and audit
commands continue to mount the smaller platform projection; the broader test
runtime is also hidden at its owner path. The Node loader resolves modules
through the sealed root's ordinary package lookup. `NODE_PATH`, the workflow's
ambient `node_modules`, and any Formula-selected module root are not accepted.

The privileged recipe runner also derives
`WASM_POSIX_SDK_CONFIG_SITE` from the sealed platform projection. A recipe that
needs package-specific Autoconf cache answers may point `CONFIG_SITE` at its
own attested recipe file and source this runner-owned path from that file.
Formula Ruby and recipe requests cannot choose or override the shared path;
reusable target facts therefore continue to come from the exact
`sdk/config.site` associated with the publisher's Kandelo revision.

Those legacy paths are intentionally absent from a schema-3 platform
projection. Their `InaccessiblePaths=` entries therefore use systemd's
optional `-` prefix: an absent path remains an accepted closed-root state, and
a path that unexpectedly appears remains masked. The protected startup audit
still verifies that none of those paths grants recipe authority. Unlike normal
Formula commands, the audit retains a failed transient unit just long enough
to print a bounded `systemctl status` diagnostic before resetting it; namespace
setup errors are therefore observable without permitting the command to
continue or leaving failed service state behind.

The helper revalidates the complete recipe tree immediately before and after
the script, rejects direct writes to the Formula staging prefix, and validates
the returned output tree. Output directories and ordinary files must stay
inside the dedicated output root; hard-linked files, special nodes, absolute
symlinks, and relative symlinks that escape that root are rejected. The
Formula then installs only that returned tree into its keg.

The Formula process does not run the recipe directly. It sends one bounded,
canonical request to a root-owned supervisor that authenticates the Formula
user through Unix-socket peer credentials. The supervisor copies verified
source and selected resources into fresh immutable trees and starts the recipe
as a third, recipe-only user. That transient service uses `RootDirectory=` with
an empty root-owned skeleton: only the copied source, closed recipe, projected
Kandelo tooling, selected resource snapshots, sysroot, complete sealed dependency
closure, exact immutable Nix runtime closure, ordinary system runtime
directories, and private work/output roots are mounted into it. The Nix
closure is queried before service entry and projected as individual
content-addressed store roots; the whole Nix store is not exposed.

Before any privileged recipe entry point runs, its workflow job seals the
fixed host `/usr` and `/etc` projection ancestors. GitHub-hosted Ubuntu images
historically supplied both directories as `root:root` mode `0755`; the
2026-07-26 Ubuntu 22.04 and 24.04 images instead supplied their inodes as the
current workflow identity (UID 1001 and GID 1001 in the observed jobs) while
selected children remained root-owned. The recipe boundary projects ordinary
tools below `/usr` and the exact alternatives and loader-cache sources below
`/etc`. An owner of either ancestor could replace a projected child between
validation and privileged service use.

The preparer first requires both fixed ancestors to be either in the
historical sealed state or exact mode-`0755` directories owned by the current
non-root workflow UID and GID. It makes no change unless the complete set
passes. It then changes only the evidenced runner-owned ancestor inodes to
`root:root`, verifies that each device and inode stayed the same, and rechecks
both complete final states. The ownership operation is conditional on each
inode still having the authenticated workflow UID and GID; an ownership race
therefore changes nothing and the post-check fails closed. The fixed path set
is not caller-selectable, and the preparer never changes descendants
recursively because conventional host tools can have intentional ownership
and mode differences. Every other owner, group, mode, type, path resolution,
tool state, or post-change identity fails closed. The recipe supervisor
retains its independent requirement that every projected host source and safe
ancestor be root-owned and not replaceable.

The workflow trust checker discovers jobs from their privileged recipe
entry-point calls. It currently requires this preparation before both the
reusable publisher's `build-and-test` and `verify-bottle` jobs, and before
staging-build's publisher preflight. Adding another job that enters any recipe
boundary without the same unconditional, failure-enforcing preparation fails
the central contract check. Both `.yml` and `.yaml` workflow files are scanned.
The checker intentionally names the current outer build, verification, and
test entry points rather than inferring arbitrary shell call graphs. A new
wrapper around the privileged launcher must extend that marker set in the same
change; deriving indirect wrappers automatically remains a bounded hardening
follow-up.

The supervisor implementation is admitted only from the exact root-owned,
manifest-sealed Kandelo tooling projection. The launcher records that source's
state and digest, copies it into a separate root-owned executable inode,
compares the source and destination before the first privileged execution, and
rechecks the executable afterward. An independent checkout path is not a
second source of privileged runner code.

The host `/`, workflow checkout, credentials, and host service-manager sockets
are absent rather than merely read-only. `/etc` is the private sealed directory
from the empty `RootDirectory=` skeleton, populated only through exact file and
directory binds; `/tmp` is a private size-bounded tmpfs. A second empty `/etc`
tmpfs would hide those prepared bind destinations, so the Linux isolation test
executes this real mount topology under systemd rather than treating it as a
portable unit-test claim. The supervisor tears down the complete control group,
proves the recipe UID owns no process, validates the output without following
unsafe nodes, and returns only a root-owned sealed output tree. That isolation
test also executes a malicious recipe that probes an unrelated host sentinel
and tries to start another systemd unit; both paths must fail while declared
inputs and output still work.

Files below copied source, resource, dependency, and output trees retain normal
POSIX pathname rules, including `:` in names such as Perl manual pages.
Only absolute host paths used as operands in systemd's colon-delimited bind
syntax reject that character.

The service bounds execution time, process count, descriptors, private
`/tmp`, and captured diagnostics. Its host-backed private work and output
directories do not yet have a per-recipe filesystem quota, and the cgroup does
not yet set an explicit memory or CPU quota. A hostile recipe can therefore
exhaust one ephemeral CI runner before publication fails closed; the workflow
job remains the current outer availability boundary.

The manifest SHA-256 is a Formula literal, so the Formula SHA-256 transitively
binds the full recipe closure. Bottle sidecars already record the exact Formula
SHA-256 and tap commit. Matrix reuse additionally requires the current Formula
SHA-256, so changing one recipe rebuilds its Formula without invalidating
unrelated Formulae in the same tap commit.

Use a tap recipe only after its build script has been converted to consume
Homebrew-verified source and exact Homebrew dependency prefixes. Do not copy a
registry resolver call into `Kandelo/recipes/` and treat the new location as a
migration.

### Transitional registry bridge

The transitional Tier-2 bridge keeps the Homebrew Formula identity and the
Kandelo registry package identity separate. When they have the same name, use
the default mapping:

```ruby
out_dir = kandelo_build_package(script_env: {})
```

When the public Formula name intentionally differs from the registry directory,
declare the registry package as one literal keyword before `script_env`:

```ruby
out_dir = kandelo_build_package(
  package: "cpython",
  script_env: {},
)
```

Here `python` can remain the Formula, bottle, sidecar, and GHCR package name,
while `cpython` selects `packages/registry/cpython`. The static Formula parser
rejects dynamic, interpolated, reordered, duplicated, or malformed mappings.
The publisher attests both identities and then validates the selected registry
directory, manifest name and version, source, build script, and hashes. The
runtime helper defaults an omitted `package` to the Formula name and requires
the resulting value to equal the publisher attestation before it runs the
script. A mapping is therefore an explicit identity binding, not a path escape
or a way to bypass the registry contract.

Formula Ruby should read these `HOMEBREW_KANDELO_*` variables for values that
must survive Homebrew environment handling:

```text
HOMEBREW_KANDELO_ROOT
HOMEBREW_KANDELO_ARCH
HOMEBREW_KANDELO_NODE
HOMEBREW_KANDELO_LLVM_BIN
```

Workflow-facing scripts use `KANDELO_HOMEBREW_*` variables outside Formula
Ruby.

## Dependency-First Bottles

Publish every locked runtime dependency before its consumers. The bottle
builder resolves the selected Formula's recursive immutable-tap runtime closure
in topological order and installs each dependency separately with
`--force-bottle --as-dependency
--ignore-dependencies`. A missing Kandelo bottle therefore fails before the
consumer source build; Homebrew is not allowed to silently replace a prior
library bottle with a dependency source build.

### Native And Target Dependency Realms

A Kandelo target Formula and a package in its native host-tool closure can have
the same short Homebrew name. For example, the Kandelo `bzip2` build can require
native WABT, whose host-side dependency closure can itself contain native `bzip2`.
Putting both packages in `/opt/kandelo/homebrew/Cellar/bzip2` makes
Homebrew treat the host package as a recursive dependency of the target
Formula. Dependency ordering cannot fix that namespace collision.

The publisher therefore gives the target and native realms separate Homebrew
prefixes (installation roots), caches, temporary directories, configuration
stores, and home directories. The two services cannot access each other's
mutable cache, temporary, configuration, or home state. The native service also
cannot access the target prefix; the target service sees the native prefix only
through a read-only mount. Both use the same reviewed Homebrew overlay as
read-only source.

Homebrew's control plane always uses a protected host Git, even after a Kandelo
`git` bottle installs a target executable under the canonical prefix. The
launcher discards an inherited `HOMEBREW_GIT_PATH`, selects a regular,
non-writable Git executable from the immutable Nix store, verifies its minimum
supported version, and preserves that exact path in both isolated realms. A
target Git can therefore remain ordinary bottle payload without shadowing the
native Git that Homebrew uses to resolve and inspect taps.

Before any Formula Ruby executes, the static Formula parser derives a bounded
plan from the selected Formula's direct `depends_on` declarations. An
unqualified external dependency must be explicitly tagged `:build`, `:test`,
or both. Untagged and `:recommended` external runtime dependencies fail because
portable runtime dependencies must come from the primary tap or an exact
dependency-tap lock; `:optional` dependencies are not selected. Qualified
locked-tap dependencies remain in the target plan. The resulting control data
also carries the sorted immutable target-tap set plus three native lists:

- `build` contains only direct native dependencies tagged `:build` (including
  `[:build, :test]`). The isolated Homebrew overlay uses this root-owned list
  to populate the selected Formula's build environment without resolving or
  installing a recursive dependency closure in the target prefix.
- `build_and_test` is used by the bottle builder and includes native tools
  needed to build or test the Formula.
- `runtime_and_test` is used by the bottle verifier and excludes dependencies
  that are only tagged `:build`.

### Publisher-Only Native Requirements

Publisher-only tools are represented by three closed, tap-local Homebrew
`Requirement` classes rather than ordinary guest Formula dependencies:
`BinaryenRequirement`, `PkgconfRequirement`, and `WabtRequirement`. Each class
has one canonical definition under `KandeloFormulaSupport`: it is fatal, binds
one fixed `KANDELO_NATIVE_FORMULA` and `KANDELO_NATIVE_SENTINEL`, and checks
that same sentinel with `satisfy(build_env: false)`. Formulae may refer to
those classes only through the canonical support require and a literal
`depends_on KandeloFormulaSupport::<Class> => :build` or
`[:build, :test]` declaration. Unknown classes, dynamic constant lookup,
changed metadata or predicates, and `:test`-only native Requirements fail
closed.

The bottle source-closure layer recognizes those literal Requirement lines as
references to the already-bound Formula support tree; it does not treat every
additional `KandeloFormulaSupport` token as a second source loader. Its line
allowlist rejects other module references, while the Ripper-based Formula
parser remains authoritative for the closed class and tag allowlists.

The static Formula parser recognizes that exact source shape without
evaluating Formula Ruby. Schema 4 of the protected host-dependency plan binds
the Requirement class, native Formula identity, sentinel executable, and
sorted tags in addition to the existing native dependency lists and immutable
target-tap map. The bottle builder and pour verifier run the same closed-schema
validator before staging the plan. The publisher overlay then compares the
evaluated Requirement objects with those sealed records before reconstructing
only the matching build-only dependencies for Homebrew's normal Superenv path.
For a Requirement also tagged `:test`, the Formula test process receives only
the planned proxy keg's standard tool and metadata paths after the exact
sentinel has been found executable. A missing proxy, omitted evaluated object,
forged class, changed constant, changed tag, or legacy ambiguous schema fails
instead of widening the host-tool graph.

The publisher lifecycle and guest lifecycle deliberately use different
artifacts. Trusted Linux publication runs the reviewed publisher-side Homebrew
commit pinned by the reusable workflow and proves a real install and test
offline after its disposable Ruby dependencies have been provisioned and
sealed. Kandelo guests instead receive upstream Homebrew commit
`d6c1be418446eec7de09fc72441ba4462282a142` through the dedicated
`homebrew-bootstrap` program package. Guest acceptance must materialize that
package through the canonical ABI release index and verify its complete
two-member generation, package-output receipt, archive identity, cache key,
and locked inner ZIP before booting it.
The PR staging release is evidence for the package build, not a durable
consumer URL. Until the package is activated in the canonical ABI index and
the tap has adopted these Requirement declarations under a compatible pinned
publisher, the full guest install lifecycle remains a rollout gate rather than
a supported user-facing contract.

#### Exact Chromium guest-lifecycle fixture

The Node.js and Chromium runners share one generated guest contract. Both tap
exact first- and third-party revisions, prove each tap remains discoverable as
untrusted, and retain only Formula-level trust. Stock Homebrew creates that
trust for fully qualified operations or receives it through
`brew trust --formula`.

The required Node release gate uses two bounded shipping scopes. Each starts
in a fresh operating-system Node process from the same exact original image.
Each scope also owns a distinct workflow step, so cancelled job metadata shows
whether the core or canary proof had begun even when final logs and telemetry
cannot be uploaded. Each step has a 20-minute workflow bound around the
15-minute in-process deadline. The guest-process deadline also bounds
best-effort process termination. Once that deadline expires, control returns
to machine teardown, whose worker-termination fallback remains responsible
for releasing the host.
The core scope removes the direct-composed Bzip2 receipt, pours first-party
Bzip2 through stock Homebrew, executes it, and exits. The canary scope taps
both repositories, removes the direct-composed M4 receipt, pours and executes
independent-canary M4, verifies its first-party Dash dependency, and exits.
Reinstall, upgrade, cleanup, export, and reboot do not change whether a user
can perform those first installs.

The comprehensive lifecycle retains the additional maintenance and durability
assertions. It reinstalls both bottles, exports and reboots the rootfs, checks
that narrow trust survived, executes the persisted packages, proves that
`brew upgrade` is a same-version no-op, uninstalls, revokes selected item
trust, untaps, and verifies no selected-tap authority remains. This checks the
no-op upgrade path; it is not evidence for upgrading from an older bottle. A
browser fixture supplies host transport identities only. It cannot replace or
weaken the guest assertions.

The comprehensive Node lifecycle is not a required release gate yet. A single
long-lived Node.js process can retain collectible WebAssembly memory long
enough for the repeated Homebrew fork and exec workload to exhaust a standard
hosted runner. Restoring it as a required gate needs fresh operating-system
Node processes with digest-bound rootfs handoffs: first-party installation,
third-party installation, and maintenance plus cleanup must run in separate
processes. Splitting only at the existing reboot is insufficient because the
memory peak begins during the first phase.

The live Playwright proof is disabled unless
`KANDELO_HOMEBREW_GUEST_BROWSER_LIFECYCLE_LIVE=1` and
`KANDELO_HOMEBREW_GUEST_BROWSER_LIFECYCLE_FIXTURE_PATH` are both set. The JSON
file uses schema 1 and declares:

- `allowLiveNetwork: true`, an explicit opt-in checked before any fixture
  request;
- `transportMode`, either `closed` or `public`;
- exact `url`, `sha256`, and `bytes` records for the main-shell image and the
  bootstrap spec, archive, and environment;
- an exact bottle-mirror plan record; closed transport also requires one exact
  payload record for every plan asset, while public transport forbids local
  payload bytes;
- exact 40-character `coreRevision` and `canaryRevision` values; and
- one bounded `timeoutMs` from 1,000 through 1,800,000 for fixture loading,
  both guest phases, export, reboot, and teardown together.

All artifact URLs are canonical HTTPS locations without URL userinfo or
fragments. Query parameters are allowed, so the fixture does not claim that
every location is credential-free or immutable. Loader requests omit browser
credentials and referrers, and fetch-source query strings are redacted from
response diagnostics. Exact byte length and SHA-256 are the authority even if
a location changes. Chromium may retrieve those locations through the
same-origin test proxy while the VFS retains the original URL identity. The
downloaded mirror plan has the stronger content-addressed release contract: it
must be byte-identical to the plan embedded in the image and must derive its
release tag and every payload URL from its complete collection digest.
Closed payload requests begin only after that plan authorizes their complete
URL, digest, size, and asset-name set. The verified payloads are then handed to
the worker as an exhaustive transport: an undeclared request fails instead of
falling back to ambient network.

Generic staging and prepare-merge browser suites always use that closed
transport for the shell image they received. A shell package can already be
current in Kandelo's canonical package index while its independently published
content-addressed bottle-mirror release does not exist yet; canonical package
identity therefore does not authorize ambient public mirror requests in those
suites. The dedicated mirror-publication proof owns anonymous public transport
validation after publication.

The product workflow's live lane is a manual, closed-transport cutover proof.
It requires three exact lowercase 40-character inputs: Kandelo's live
default-branch commit `M`, the final first-party tap commit `TF`, and the
independent canary tap commit `C`. The workflow requires its checkout and a
fresh anonymous read of Kandelo `refs/heads/main` to equal `M`. It separately
requires an anonymous read of the first-party tap `refs/heads/main`, the image
catalog, migration lock, and exact candidate checkout all to equal `TF`.
Operator input `C` must equal both the separately reviewed independent-canary
product lock and an anonymous read of the canary tap `refs/heads/main`. All
checked-in TF/C agreement is validated before any of the three anonymous
live-head reads or any candidate construction.

The product lock is agreement evidence; it does not replace the operator's
mandatory `C` input.

After the closed cutover proof admits the exact product, the protected
first-party tap owns a separate public-mirror publication lane. Its
`publish-main-shell-mirror.yml` caller may invoke
`reusable-homebrew-main-shell-mirror-publish.yml` only from the tap's live
`main`. The initial caller pins one reviewed Kandelo `Mpre` SHA in both `uses:`
and the `kandelo-ref` input and supplies exact final bottle-catalog `TF` and
canary `C` identities. It selects `publication-mode: create-mirror` and leaves
`mirror-authority-ref` empty. The reusable workflow derives its own
`${{ github.sha }}` as `TA0`, requires `TF -> TA0`, publishes the newly
recovered immutable bottle mirror, and anonymously re-reads every release
asset. It does not prepare or publish lifecycle inputs in this mode.

A later caller selects `publication-mode: publish-lifecycle`, pins the exact
`TA0` as `mirror-authority-ref`, and derives its own `${{ github.sha }}` as
`TA1`. This mode re-derives and verifies the existing mirror, then publishes
only the direct lifecycle inputs and runs the complete public Node and browser
proofs. Event data cannot select either authority. The workflow anonymously
rechecks Kandelo `Mpre`, tap `TA1`, and canary `C` as the three public main
heads, proves the complete `TF -> TA0 -> TA1` ancestry chain, and requires the
shell revision, structured package Git input, catalog locks, runtime-support
cohort, and sealed artifact lock to agree with `TF` before preparing any
bytes.

Both modes resolve the public shell generation into a fresh cache, verify
the main-shell artifact lock, and anonymously recover the exact bottle set
declared by the embedded mirror plan. The mirror is derived from that plan, so
the publication code has no Formula-specific or Ruby-specific digest. Its
one-day, same-run handoff has an exact manifest and bounded inventory. In
`create-mirror` mode it is the only handoff and supplies the new TA0 release.
In `publish-lifecycle` mode it is verification evidence for the already-public
TA0 release, and a separate bounded handoff owns only the fixed lifecycle
inputs: the exact shell image, bootstrap tree specification, bootstrap ZIP,
and bootstrap environment. No personal access token (PAT), GitHub App token,
cross-repository workflow artifact, run ID, or caller-selected artifact
repository participates in either handoff.

The fixed lifecycle inputs use a separate content-addressed immutable
release in the first-party tap. The shell image is a member of its package
archive,
while the bootstrap ZIP and environment still come from the transitional
Kandelo registry package named `homebrew-bootstrap`. The deployed lifecycle
still uses `/home/linuxbrew/.linuxbrew` and keeps `/usr/bin/brew` as the
stable entry point. The guest-prefix campaign replaces that layout with
`/opt/kandelo/homebrew`; it has not done so merely because the target
contract exists. The lifecycle does not claim those bootstrap bytes are
Formula-owned.

The browser's lazy Homebrew bootstrap requires direct asset URLs, and the
exact source-tree specification must stay bound to the same proof. Publishing
direct assets avoids adding archive-member extraction to the browser and
keeps lifecycle-input ownership separate from the bottle mirror. The handoff
records the transitional package, guest prefix, and stable entry point. The
lifecycle collection identity binds that ownership, all four asset hashes and
sizes, Kandelo, catalog, mirror-authority, caller-authority, and canary
revisions, and the exact public mirror-plan URL, hash, and size. Its temporary
handoff expires after one day; its immutable release is durable
content-addressed evidence and is not a temporary release to delete after the
run.

Only the publication job receives `contents: write`. Both of its write paths
are guarded by the admitted publication mode. `create-mirror` calls
`publish-immutable-github-release.sh` once for the mirror manifest targeting
the live TA0 caller; the publisher then anonymously re-reads and rehashes the
public release. It has no lifecycle handoff to publish.

`publish-lifecycle` uses the tap caller's own `GITHUB_TOKEN`, but the existing
mirror path calls the separate `verify-existing-immutable-github-release.sh`
verifier. That verifier exposes no write mode: it performs GET-only metadata
reads, requires the release and its direct lightweight tag to target `TA0`,
requires GitHub release immutability and the exact asset inventory, and
anonymously rehashes every re-derived payload. It emits a receipt whose
operation is `verified-existing`; it never calls the release publisher.

The same job rechecks live Kandelo and `TA1` immediately before using
`publish-immutable-github-release.sh` to write only four lifecycle assets:
the shell image, bootstrap tree specification, bootstrap ZIP, and bootstrap
environment. That release targets `TA1`. The sealed shell locks, guest
manifest, recovery report, and bounded handoffs retain `TF` as the bottle
catalog that owns every recovered payload; the mirror release retains `TA0` as
its truthful write authority. The embedded mirror plan remains a content
identity for the payload set, not a second catalog lock.

A dependent read-only job resolves the public package generation again and
anonymously re-reads all four fixed lifecycle assets. Node uses those verified
local bytes while every tap and bottle request uses public transport. Its two
fresh-process scopes pour and execute one first-party and one independent
third-party bottle, including the cross-tap dependency. Chromium loads the
same four fixed inputs anonymously and uses public transport for the complete
two-phase lifecycle. Both hosts install from exact product catalog `TF`,
require `TA1` to remain public tap main, and forbid closed-acceptance
filesystem roots.

The schema-1 mirror tag is content-addressed from bottle payloads, while its
immutable release records the `TA0` that created it. A later `TA1` therefore
must not redispatch the publisher for the same collection or claim that the
older release belongs to the new authority. The consume-only path retains
`TA0`, re-derives and anonymously verifies the exact collection, and admits
reuse only when `TF -> TA0 -> TA1` holds.

A tap caller is not dispatchable release authority until its `uses:` target
and every revision input contain the reviewed final 40-character commits and
the tap trust contract has passed. `TA0` is the first protected live caller:
it publishes the immutable bottle mirror. `TA1` is a later protected-main
descendant that pins `TA0`, verifies that mirror without rewriting it, and
publishes only the four lifecycle assets. Both authority values come from each
caller's `${{ github.sha }}` rather than being substituted into its own bytes.
This public-mirror lane is independent of the existing Bash bottle caller and
its frozen workflow digest.

Refresh the shell release locks with
`scripts/finalize-homebrew-main-shell-release.py` from one clean
checkout of the final live tap commit. Its default preview is read-only.
`--apply` without an artifact advances the catalog, Formula identities,
metadata/provenance digests, Git input, and bound artifact inputs
together while changing the shell to `publication_state = "pending"`.
The review-only `--review-pending-artifact` composer option can then
measure the deterministic candidate. The exact pull-request and
protected-main checks may also use that option to run a candidate while
the lock is pending. Those checks cannot publish it. The package recipe,
manual lifecycle checks, Pages deployment, and public mirror publisher
still require a sealed identity. Rerun the finalizer with
`--artifact <shell.vfs.zst> --apply`, reproduce the same image through
the ordinary sealed path, and only then return the recipe to
`publication_state = "ready"`.

The checked-in `6ad0e3dbc60e5572c4288c86919238f71c1bc110` first-party tap value is the final shell
catalog authority. The shell recipe remains `UNPUBLISHED` so archive staging
can substitute the exact landed Kandelo commit, while
`publication_state = "ready"` admits that normal exact-main path. The lazy
artifact lock independently binds every deterministic input plus the compressed
digest and size; any input drift rejects the output until final review measures
and reseals it. Exact-live-main equality remains necessary authority, not
sufficient release evidence: the exact-Mpre rebuild and closed first- and
third-party lifecycle proof are still required.

Pull-request, push, and manual runs all select the bottled product lane.
Pull requests reach this lane through `staging-build.yml`, after that
exact workflow attempt has sealed its package release. Push and manual
runs invoke the workflow directly. The source-rootfs bridge remains
separate internal comparison plumbing and cannot satisfy this cutover
gate. Before either host creates live lifecycle evidence,
the candidate's bootstrap recipe and composition report must bind the exact
atomic runtime-support cohort; the shell bottle closure alone is not accepted
as a `brew` runtime. A manual closed dispatch additionally invokes the
comprehensive Node lifecycle and creates the Chromium fixture from the same
candidate image, bootstrap spec/archive/environment, and recovered bottle
mirror. That manual Node result is diagnostic evidence until the phases use
fresh process boundaries; it does not block the public first-install shipping
claim.

Dispatch the live lane only after recording the three observed live commits:

```bash
gh workflow run homebrew-main-shell-ci.yml --ref main \
  -f transport_mode=closed \
  -f kandelo_main_revision=<M> \
  -f core_tap_final_revision=<TF> \
  -f canary_tap_revision=<C>
```

Before the Chromium reboot, the runner records the exported image's size and
digest, then transfers its whole `ArrayBuffer` to the VFS-owning worker and
confirms the main-thread view is detached. Phase two re-reads the small
`/etc/kandelo/shell.json` contract through the worker and launches that VFS
path; it does not reconstruct the exported filesystem or copy Bash on the
browser main thread.

Run an exact reviewed fixture with:

```bash
cd apps/browser-demos
bash ../../scripts/dev-shell.sh env \
  KANDELO_HOMEBREW_GUEST_BROWSER_LIFECYCLE_LIVE=1 \
  KANDELO_HOMEBREW_GUEST_BROWSER_LIFECYCLE_FIXTURE_PATH=/absolute/path/to/fixture.json \
  npx playwright test test/homebrew-guest-lifecycle.spec.ts --project=chromium
```

Without those two variables, CI still runs the browser admission test proving
that a fixture without live-network opt-in makes no external request. A skipped
live test is preparation evidence only; it is not evidence that a bottle was
published, poured, or executed.

The native launcher installs each selected direct dependency as an explicit
`homebrew/core/<name>` reference under an ephemeral native prefix. Each install
uses Homebrew's normal dependency resolution and completes its full transitive
closure before the next direct dependency starts. Separate invocations avoid a
combined install holding a top-level lock for a tool while another selected
Formula's dependency closure needs that same tool. The publisher then uses the
isolated native Homebrew to verify that each planned direct name resolves to
exactly one installed `homebrew/core` Formula with the expected canonical name.
`brew missing` must also report no missing dependencies before the native tree
can be used.

The native prefix has exactly the same byte length as the fixed
`/home/linuxbrew/.linuxbrew` strings stored in official host-tool bottles.
Homebrew pads a shorter replacement with NUL bytes when it relocates binary
files. Some runtimes expose that padding through compiled path arrays such as
Perl's `@INC`, making otherwise valid relocated tools unusable. Native Brew
alone receives `HOMEBREW_RELOCATE_BUILD_PREFIX=1`, so Homebrew can pour those
bottles and rewrite their build prefix into the exact-length isolated native
realm without padding or truncation. The target Brew and target Formula never
receive that setting. These Linuxbrew bottles provide CI executables such as
CMake or WABT; they are not Kandelo package dependencies, target bottle
contents, or VFS inputs. Kandelo bottles are still built from the upstream
sources declared by the tap Formulae.

The exact Linux compatibility proof uses the same bounded native-client
setting. Its API oracle and conservative-lock generator do not receive the
relocation switch, and adversarial tests prove that inherited caller values
cannot cross either boundary.

The recipe supervisor starts before native Homebrew runs and reserves one exact
manifest path below its root-owned build directory. That path must still be
absent when the supervisor loads its static direct-tool plan. After the native
installs finish, the publisher makes the complete native prefix root-owned and
read-only. Directories become mode `0555`; regular files that carried any
executable bit become `0555`, and every other regular file becomes `0444`.
This preserves executable meaning while ensuring that a bottle's original
owner-only mode cannot make a root-owned build input unreadable to the recipe
identity. The same admitted root runner then writes, with exclusive creation,
a mode-`0400` inventory of every Formula name and exact keg path it found in
that sealed Cellar. It also records the runner-selected prefix `lib` and
`share` runtime roots and each root's type/mode/content manifest digest when
present. Relocated native executables can name `<prefix>/lib/ld.so` directly,
while interpreted tools such as Automake can name modules below
`<prefix>/share`. Cellar and `opt` projections alone are therefore not an
executable closure. The runner admits only those two fixed runtime roots, not
the whole prefix. Every symlink in every projected keg and runtime tree is
resolved component by component in the exact mount namespace the recipe will
receive. `<prefix>/opt/<formula>` is modeled as the exact selected-keg bind,
and conventional system targets are allowed only when that same host runtime
root is projected. A chain that visits `/tmp`, another prefix directory, an
unknown `opt` alias, or any other unmounted host path fails even if its
host-side final `realpath` re-enters a sealed keg. Runtime fingerprints
include indirect link hops and the terminal identity, so changing an
intermediate alias cannot preserve the authenticated digest. When the recipe
request arrives, the supervisor rescans every root-owned, read-only tree,
rehashes the runtime trees, and requires exact equality with that inventory.
A late extra rack, removed or replaced keg, mutable tree, duplicate name,
changed loader chain, changed runtime root, or missing planned direct tool
fails closed.

The manifest authenticates the complete transitive execution closure, while
the earlier static plan still decides which tools are direct Formula inputs.
Those direct tools enter through their target-Cellar proxies. Executable
precedence is explicit: publisher-only Requirements, direct proxies,
authenticated transitive helpers, then fixed SDK and system paths. Thus a
transitive keg cannot shadow a declared direct tool with a same-named command.
The runner derives child-tool directories from all remaining authenticated
native kegs without accepting paths from the Formula request.
This lets a planned tool start its legitimate interpreter or helper, such as
Automake starting relocated Perl or a build starting Bison, Flex, or Python.
It does not make those transitive tools target dependencies, copy them into
the target Cellar, or give the caller authority to select their versions.

The target build can read that sealed prefix, but only each planned direct
dependency's selected keg is copied into a root-owned, read-only proxy under the
canonical target Cellar. Its target `opt` link points to that real target keg.
Homebrew requires a keg's grandparent to resolve to the active Cellar, so a rack
symlink into the native prefix is not a valid substitute.
Formula support therefore records the exact target-Cellar proxy paths it put on
`PATH`, while the root-owned runner plan selects their Formula names and the
authenticated native closure selects their only permitted versions. The runner
rejects a missing, substituted, version-mismatched, or target-dependency-
colliding proxy before executing recipe code.
If that direct keg contains a relative link into its recursive native closure,
the publisher rewrites the copied link to the exact resolved path in the sealed
native prefix. This preserves host tools whose launchers are supplied by another
keg without copying or exposing that transitive keg in the target Cellar. The
component-safe audit runs before sealing, again before the bridge copy, and on
the copied proxy before its `opt` alias is exposed; `realpath` is therefore only
canonicalization of an already-admitted immutable chain, not the confinement
decision.
Unselected keg versions and native transitive dependencies stay in the native
prefix and cannot claim target Cellar names. Native install logs remain
separate from Kandelo bottle dependency provenance.

The publisher stops GitHub Actions workflow-command parsing before any
unprivileged Formula code runs. Native Homebrew dependency resolution,
signed API admission, Cellar receipt audit, and installed-Formula
metadata checks can still fail before a bottle exists. Those commands
keep a private aggregate log under the build control directory, but
cleanup deletes that directory and the workflow deliberately uploads
only bottle outputs. Each otherwise-silent native command therefore
also captures at most the final 16 KiB of its own output. On failure,
the builder prints the command stage and original exit status, then
renders at most 200 prefixed lines. It escapes terminal control bytes
and redacts recognizable credentials, so upstream text remains inert
even while workflow commands are disabled. Missing, linked,
non-private, or replaced log files are never followed; the builder
reports that the diagnostic is unavailable without replacing the
native command's exit status.

Before that detailed capture is active, small start/completion markers
identify the Tier-2 execution rescan, execution preflight, attestation
staging, and Formula-realm isolation boundaries. They surround direct
calls rather than executing those stateful functions through a wrapper.
A starting marker without matching completion therefore identifies the
failing boundary while normal shell behavior preserves its exit status
and state. Isolation also names failures of its final native prefix and
repository probes, so a build that never entered the signed-API contract
is distinguishable from one rejected by that contract. Markers around
the whole signed native contract also cover its control-file staging
before dependency resolution begins.

Pinned Homebrew normally tries to install Bubblewrap into its active prefix
before `brew test`. The publisher overlay suppresses that automatic install
while a protected Kandelo target plan is active. A usable Bubblewrap already
provided by the host can still be detected and used, but Homebrew cannot fetch
unplanned native code into the target Cellar after isolation begins. Native
Homebrew has no target plan and retains its normal sandbox dependency behavior.
The publisher also suppresses Homebrew's Linux-only global dependencies while
it loads any Formula from the selected immutable Kandelo tap set. Homebrew
recursively loads locked-tap dependencies when it writes the target receipt;
without this guard, native Bubblewrap or libcap could be recorded as a Kandelo
guest runtime dependency. Formulae outside the exact target-tap set and the
separate native Homebrew prefix retain Homebrew's normal Linux dependency
behavior.
The dedicated build identity, transient systemd service, `NoNewPrivileges`,
immutable inputs, and teardown checks remain the publisher's primary process
boundary when the host cannot create a rootless Bubblewrap sandbox. The builder
also snapshots the planned target Cellar after installation and rejects any
Formula test or bottle command that adds or removes a rack or keg.

The publisher force-pours the planned immutable-tap Kandelo bottles into the target
prefix. It then runs the selected target install with
`--ignore-dependencies`: the builder combines that flag with `--build-bottle`,
while the verifier combines it with `--force-bottle`. Homebrew therefore uses
the already provisioned target bottles and exact native proxy kegs instead of
resolving both package realms into one Cellar. The verifier still runs the
Formula's `test do` block after pouring the target bottle.
Dependency racks and kegs are sealed read-only, while the root-owned sticky
`Cellar` and `opt` insertion directories remain writable to the Formula group;
sealing a dependency cannot disable installation of the selected Formula.

### Retained-receipt bottle repeatability

Homebrew's general reproducible-bottle path uses `brew bottle
--only-json-tab`: it omits `INSTALL_RECEIPT.json` from the archive and carries
the Tab separately in bottle metadata. Kandelo deliberately does not use that
mode. The static VFS composer does not run Homebrew's install/pour transaction;
it extracts the bottle directly, validates the link-manifest receipts, and
preserves `.brew/<formula>.rb` plus `INSTALL_RECEIPT.json` in the staged keg.
Removing the embedded receipt would therefore break the current static image
composition contract.

The publisher-only Homebrew overlay makes this retained-receipt path repeatable
for retries in the same build environment. `flake.nix` declares GNU tar, the
builder accepts only the immutable Nix-store `gnutar` executable, and the
isolated launcher proves that neither the dedicated Formula identity nor any
writable ancestor can replace it. The overlay captures that validated path
before Formula evaluation and passes it to Homebrew's existing
`reproducible_gnutar_args`; Kandelo does not maintain a second set of tar
flags. Those upstream arguments fix entry order, owner/group identity, PAX
header naming, and entry mtimes to the receipt's stable source-modified time.
The completed gzip file is assigned that same stable mtime, which also makes
Homebrew's raw bottle-JSON `bottle.date` stable.

Bottle rebuild identity is reviewed tap state, not a value chosen from the
runner's mutable Git history. Before Formula evaluation, the publisher parses
the exact Formula statically: no `bottle do` block means rebuild zero, while a
canonical positive `rebuild N` is preserved. It then invokes `brew bottle
--keep-old` and requires Homebrew's raw bottle JSON to report that exact value.
The publisher does not use Homebrew's automatic increment, and it does not use
`--no-rebuild`, which would reset an explicit rebuild to zero. A maintainer who
must replace bytes already published under an immutable reference first
commits the next positive rebuild to the Formula, then dispatches publication;
a changed root URL or a different emitted rebuild fails before handoff.
That rule applies whenever the tap records the Formula in either aggregate or
formula-level Kandelo sidecars; a normal successful finalization records both,
and a one-sided state fails closed. A registry index left behind by an earlier
attempt that reached neither sidecar is incomplete publication state, not a
last-green bottle identity; the bounded force-recovery path described below may
replace that unfinalized index without making it selectable as accepted
metadata.

Before archiving, the overlay requires the receipt's `source.tap` and exact
lowercase 40-character `source.tap_git_head` to match the selected tap name and
revision already resolved by `brew bottle`. It then assigns the temporary Tab a
fresh copy of its `source` object and removes only `tap_git_head` from that
copy. This assignment is important because Homebrew's saved Tab copy is
shallow: deleting from the original object would also erase the provenance
that its `ensure` block restores. On both success and failure, upstream
Homebrew rewrites the installed build receipt from the saved Tab, retaining
the exact selected tap head. A normal later Homebrew pour likewise writes a
fresh installed receipt for the selected Formula and its exact current tap
head.

Homebrew also removes an existing `bottle do` block when it copies Formula
source into the keg's `.brew/<formula>.rb` receipt. That difference first
appears when a later architecture is built after an earlier architecture has
already added a bottle block to the tap. The verifier accepts either exact
Formula bytes or the one structurally validated result of removing that
canonical block and its composer-owned separator blank line. This is a
one-way normalization: a receipt with a replacement bottle block, changed
comments or whitespace, added Ruby, or any other non-bottle drift is rejected.
The comparison does not rely only on a bottle-excluded digest.
The bounded inspector records the exact archived Formula digest after that
comparison. Sidecar generation carries both identities independently: the
selected tap Formula digest identifies the reviewed build source, while the
inspector's archived digest is rechecked against the bottle when the sidecars
are written. This prevents a later architecture's normal bottle-block removal
from weakening the archive's byte-for-byte binding.

The archived receipt used by static VFS composition intentionally has no
`source.tap_git_head`. The VFS builder preserves those receipt bytes instead of
pretending that it performed a Homebrew pour; the separately generated
`/etc/kandelo/homebrew-vfs.json` binds the exact canonical tap name and planned
tap commit for the composed image. Consumers must use that composition
metadata—not infer a pour event from the sanitized embedded receipt—for the
static image's tap provenance.

This is a bounded repeatability guarantee, not universal cross-runner
reproducibility. For the same package source, Formula/support closure,
dependencies, target outputs, pinned Homebrew, and build environment, a retry
whose only change is a later tap failure/finalizer commit produces the same
bottle archive SHA. The retained Tab still includes environment-derived fields
such as `built_on` and `compiler`, while raw `.bottle.json` truthfully retains
`formula.tap_git_revision`; raw JSON can therefore differ when the planned tap
head changes even though the bottle layer does not. Runner-image, compiler,
CPU, dependency, or other build-environment changes require a new supported
bottle identity (a bottle rebuild or Formula revision), not reuse of an
existing immutable package reference.

The native/target realm separation changes publisher orchestration, not
Kandelo's process ABI or a package's target build inputs. The retained-receipt
normalization likewise does not change the target payload, but it does change
the packaging bytes of a bottle previously archived with the default tar path
and mutable tap head. An affected bottle that is already public must be
republished under a new supported immutable bottle identity; its existing
registry reference must never be overwritten. Neither publisher change by
itself requires an ABI version bump or a `build.toml` package revision change.

After building the consumer, the builder checks every immutable-tap dependency in
its `INSTALL_RECEIPT.json`. The installed dependency receipt must say
`built_as_bottle: true`, `poured_from_bottle: true`, and
`installed_on_request: false`, and its source tap commit must match that
dependency's exact locked tap. The selected Formula's `wasm32_kandelo` or
`wasm64_kandelo`
bottle digest and bounded fetch/pour log lines are recorded alongside those
receipt facts. Raw logs do not cross the runner boundary. Fresh verifier and
finalizer runners rehash each dependency Formula from that dependency's exact
planned tap before accepting the bounded provenance. For dependencies in the
selected primary tap, the finalizer materializes that same planned commit
beside refreshed tap `main`, rebinds the recorded digest to the planned
Formula, and compares the two Formulae. Dependencies from external taps remain
bound to their exact immutable checkouts in the resolved tap map and are never
looked up in the primary tap.

Homebrew can omit `bottle_rebuild` from a runtime-dependency record because the
installed dependency Formula receipt has had its bottle block removed. This can
happen for a nonzero rebuild, so the publisher treats an absent field as
unknown rather than as rebuild zero. The exact dependency Formula still
provides the selected rebuild, digest, and URL, and bounded install-log evidence
must show the matching rebuild-specific manifest reference and poured bottle
filename. A present receipt value must be a non-negative integer and must equal
the exact Formula rebuild; `null`, strings, booleans, negative values, and
explicit stale rebuilds fail closed.

Homebrew's `brew info --json=v2` can serialize the Ruby cellar symbols as
`:any` or `:any_skip_relocation`. The provenance collector normalizes only
those two known spellings to the canonical `any` and `any_skip_relocation`
values used by the static Formula resolver. Unknown symbolic spellings and all
other unsupported cellar values fail closed.

When Homebrew pours an immutable-tap dependency from GHCR, its install log can name
the exact version/rebuild manifest instead of the selected layer's digest URL.
The collector accepts only that exact manifest endpoint or the exact
digest-bound blob URL as fetch evidence. It still independently requires the
exact Formula to select the recorded digest, the installed receipt to prove a
bottle pour, and the log to name the exact canonical bottle filename. A
different version, rebuild, package, or suffixed URL fails closed.

While holding the tap state lock, the finalizer repeats the complete static
dependency-closure derivation against refreshed `main`. Every recorded
dependency Formula digest must match the exact planned commit, and every
selected-architecture bottle tuple must still match refreshed `main`. A
concurrent finalizer may have added or updated only a dependency Formula's
canonical `bottle do` block—for example, by adding a `wasm64_kandelo` sibling
to a Formula whose `wasm32_kandelo` bottle the consumer used. The finalizer
accepts that bounded case only when the existing structural Formula comparator
proves that every byte outside the canonical bottle block is unchanged and the
selected bottle tuple still matches. Recipe text, dependency declarations,
comments, and whitespace outside the composer-owned block remain
provenance-bearing and fail closed. A real dependency Formula or selected
bottle change after planning therefore causes a truthful stale-build failure
instead of publishing a consumer against a newer dependency graph.

The exact immutable-tap closure resolved before installation must equal the closure
recorded in the target receipt. A missing or unexpected receipt entry fails the
build before any publication handoff is created. A target receipt entry outside
the resolved tap set is rejected rather than omitted from provenance: native tools
belong only to the sealed host realm, and a Linux executable must never become a
Kandelo bottle's declared runtime dependency.

Fresh verifier and finalizer validation independently derive that closure from
the exact tap set without evaluating Formula Ruby. Runtime dependencies must
use direct Formula class-body tap-qualified literals such as `depends_on
"kandelo-dev/tap-core/zlib"`. The static resolver includes untagged and
`:recommended` dependencies, excludes the canonical `:build`, `:test`, and
`:optional` forms, and recursively resolves references across the locked taps.
Conditional, interpolated, helper-hidden, unknown-tag, duplicate, and cyclic
dependency declarations fail closed. The submitted provenance dependency set
must exactly equal this independently derived closure, including for an empty
root-package closure.

The finalizer also independently derives the root Formula's direct immutable-tap
runtime dependencies. Each provenance record's `declared_directly` value must
match that source-derived set, and the composition handoff's
`{name, full_name, version}` dependency array must exactly equal the direct
provenance records. Missing,
extra, duplicate, wrong-version, or forged-directness entries fail before
sidecars are generated.

For every closure member, the resolver also reads the canonical static
`bottle do` block and derives the selected architecture's cellar, rebuild,
digest, tag, and digest-bound URL. Fresh validation requires the submitted
prior-bottle record to equal that exact tap data; a closure member with no
selected-architecture bottle fails validation.
Required or recommended dependencies outside the immutable resolved tap set are
not portable runtime inputs and fail validation anywhere in the closure.
Optional external declarations may remain static Formula metadata, but
selecting one in an installed bottle receipt also fails closed.

This non-evaluating boundary permits normal static Formula structure without
executing it. `patch do` and `resource do` are limited to canonical literal
metadata, the Formula top level permits only the approved `digest` and
`shellwords` standard-library loads plus the canonical shared-support load,
class constants must be static data, and private instance helpers use a
structural lowercase-name, uniqueness, and visibility policy. Ruby
initialization and Homebrew dependency hooks remain forbidden, while new
package-private helper names do not require a Kandelo platform change. The
shared `KandeloFormulaSupport` file is accepted only when its top level is the
three standard-library requires plus a module containing static `KANDELO_`
constants and unique `kandelo_` or `formula_opt_` instance methods. Load-time
hooks, arbitrary class methods, dependency metaprogramming, and other
executable class/module structures fail closed. Formula and support method ASTs
also reject `require`, `load`, `require_relative`, `Tap` lookups, and
`__dir__`/`__FILE__` discovery that could load tap-local bytes outside the
source closure. A support method may bind exactly one regular, non-symlink
direct child of the bound `Kandelo/formula_support` tree with the canonical
`runner = Pathname(__dir__)/"literal-direct-child"` form. It must consume that
binding exactly once through one of the runner command constructions validated
by the publisher. Dynamic names, direct aliases, subdirectories, traversal,
reassignment, reflection, and other direct path operations on the bound
`runner` local remain forbidden. The exact real top-level
`formula_support/test/` directory is reserved for validation source and is
excluded from bottle source-closure identity. Before any Formula, dependency,
or test command runs, the publisher removes that exact directory from every
disposable Homebrew tap clone, so a direct runner cannot load it transitively.
Every other support path remains a recursive identity input. A non-directory
top-level path or a nested directory named `test` is not excluded.

## Trusted Publish Flow

The reusable publisher is:

```text
.github/workflows/reusable-homebrew-bottle-publish.yml
```

The first-party tap may call it with:

```yaml
jobs:
  publish:
    permissions:
      contents: write
      packages: write
      actions: read
    uses: Automattic/kandelo/.github/workflows/reusable-homebrew-bottle-publish.yml@<trusted-ref>
    with:
      kandelo-ref: ${{ github.event.client_payload.kandelo_sha }}
      tap-repository: kandelo-dev/homebrew-tap-core
      tap-name: kandelo-dev/tap-core
      tap-ref: ${{ github.event.client_payload.tap_sha }}
      formulae: file-formula
      arches: wasm32
```

A conventional third-party tap repository such as `Example/homebrew-tools`
uses the same caller shape with `tap-repository: Example/homebrew-tools` and
`tap-name: Example/tools`. The repository and tap name pair is validated before
any checkout or dry-run exit.

The caller grants the maximum permission ceiling. A write-capable publication
caller must grant `contents: write`, `packages: write`, and `actions: read`, but
the reusable workflow explicitly downgrades each job to its required subset.
The build and verification jobs receive only read permissions, the uploader
receives `packages: write` but not `contents: write`, and the tap finalizer
receives `contents: write` but not `packages: write`. A nested workflow cannot
elevate above its caller's ceiling. Because the reusable graph statically
contains write-capable jobs, the reviewed dry-run caller grants the same maximum
ceiling; those write-capable jobs do not schedule, and every job that does
schedule explicitly narrows itself to read scopes. PRs from untrusted forks must
not receive this caller ceiling; they can run schema and local build checks but
cannot invoke the trusted publisher.

Every call is fixed to a reviewed `repository_dispatch` workflow on the target
tap repository's `main` branch, and the caller repository must exactly equal
the target tap repository. Ordinary non-dry calls may come from
`publish-bottles.yml` or `maintain-bottles.yml`; dry calls must come
from `dry-run-bottles.yml`. The guest-prefix campaign has one additional
reviewed caller, `prefix-campaign-bottles.yml`, described below. The
first-party normal caller is displayed as
**Publish Kandelo bottles**; do not restore the narrower retired single-Formula
workflow name. The three dispatch events are `publish-kandelo-bottles`,
`dry-run-kandelo-bottles`, and `maintain-kandelo-bottles`. Publish and dry-run
payloads must select at least one Formula and architecture; an absent or empty
selection is an error, not a successful no-op.
Write publication is fixed to exact `kandelo_sha` and `tap_sha` values in the
dispatch payload. The caller passes them as `kandelo-ref` and `tap-ref` without
fallbacks. A missing value, mutable ref, abbreviated SHA, or uppercase SHA is
rejected before checkout. The tap checkout must equal the requested tap SHA,
which must remain the current protected tap `main` commit or its ancestor.

Ordinary Kandelo publication has a stricter source rule:
`kandelo_sha` must equal the commit named by `Automattic/kandelo`'s
live `refs/heads/main`, not merely an ancestor, an equal-tree commit, a
tag target, or a pull-request head. The planner queries that ref before
checkout and verifies the resulting checkout. Every credentialed
bottle, version-index, tap-state, failure-report, and immutable VFS
mutation queries the ref again immediately before writing. If `main`
advances during an ordinary run, the next mutation fails closed;
run-scoped build handoffs do not authorize publication from the
now-stale source.

GHCR child and version-index writes also re-read the target tap's
public protected `main` immediately before `oras cp`. The exact target
repository and authority commit come from the already validated OCI
layout receipt. The uploader requires its independently supplied
target-authority SHA to equal that receipt value. A force-push that
removes the authorized tap commit therefore stops the write even when
the job passed its earlier planning check.

The payload SHA is intentionally distinct from `github.sha`.
`repository_dispatch` may be admitted while protected `main` is at one commit
but instantiated after another publication advances it. Recording the source
commit in the request keeps the older dispatch reproducible without
authorizing a detached or force-pushed source. Maintenance rebuild dispatches
use the same exact source contract. Rollback does not consume `tap_sha`; it
refreshes and mutates the current protected branch under the tap-wide state
lock.

### Prefix Campaign Publisher Mode

The guest-prefix campaign is a narrow mode of the same reusable
publisher. It exists so a long-running, sealed campaign can finish
without exposing a tap whose Formulae use two guest prefixes. Only the
exact `prefix-campaign-bottles.yml` caller on the target repository's
protected `main` branch may select it. Each call must:

- publish exactly one Formula;
- publish exactly one architecture;
- use a forced rebuild;
- set `defer-tap-finalization: true`;
- disable ordinary VFS acceptance; and
- provide one content-addressed campaign tag plus the exact, canonical
  dependency-handoff request.

Ordinary, maintenance, dry-run, and third-party workflow names cannot
pass campaign authority or defer tap finalization.

Most campaign calls use write mode. A Formula whose destination was
anonymously proven absent follows that ordinary path. A newly reviewed
Formula may instead carry the exact destination admission
`first-package-namespace-bootstrap-required`. That admission is valid only
when the anonymous probe returned `auth-required` and every variant is a
reviewed new entrant requiring a build. An existing, reused, or ordinary
Formula cannot opt into this lane.

The bootstrap lane has four phases:

1. The ordinary reusable publisher runs once in dry-run mode. It builds and
   validates the exact bottle but performs no package write.
2. The first-child reusable validates the campaign admission, strict build
   handoff, and deterministic OCI child. It may publish only that child.
3. The ordinary publisher runs again in write mode. It creates or verifies
   the normal version index, runs the normal runtime checks, and emits the
   normal publication handoff.
4. The tap controller seals only the ordinary handoff. The bootstrap-only
   evidence never substitutes for Formula finalization.

All Actions artifacts produced by phase 1 use the fixed prefix
`prefix-campaign-bootstrap-dry-run-`. The caller cannot choose this prefix.
The later write run uses the original artifact names in the same workflow
run, so the two invocations cannot collide or cause the tap controller to
download bootstrap evidence as a normal handoff.

The first-child reusable is:

```text
.github/workflows/reusable-homebrew-prefix-first-child-publish.yml
```

It uses the same Formula-scoped GHCR concurrency group as normal child,
index, canary, and maintenance writers. Before credentials can reach ORAS,
it binds both prefixed artifacts to the current workflow run, re-materializes
the sealed campaign source, and validates the build handoff and OCI child
against the exact Kandelo commit, tap commit, Formula, architecture, ABI,
bottle bytes, and campaign guest-layout digest.

The destination preflight has only two successful outcomes. If the exact
child digest is already anonymously public, the workflow resumes read-only:
it does not log in or copy bytes. Otherwise, authenticated inspection must
prove both the selected child reference and the whole package repository are
absent immediately before the single child upload. A different public digest,
an existing private reference or package, an ambiguous transport response,
or a private post-upload result fails closed. This reusable never publishes
an index, edits a Formula, generates sidecars, emits the normal publication
handoff, or finalizes the tap.

The campaign keeps public source identity separate from local execution
identity:

- `tap_commit` is the raw, reviewed commit in the public tap's protected
  history. Public bottle provenance and immutable release targets
  continue to name this SHA.
- `tap_checkout_commit` is a deterministic local commit whose tree
  contains the sealed target Formula source and, for an architecture
  build, the exact dependency bottle blocks fetched from earlier
  campaign handoffs.

The publisher begins with a clean checkout of `tap_commit`. It verifies
the campaign's sealed target-source tree, creates a deterministic local
descendant, and then creates an architecture-specific descendant when
dependency bottle blocks are needed. Plan, build, upload,
version-index, and verification jobs derive and verify the same
identities independently. Build, dependency, handoff, and runtime
evidence bind both SHAs. The prepared commit is never pushed, tagged,
or substituted for public tap provenance.

The campaign also binds the path and SHA-256 of
`homebrew/kandelo-guest-layout.json`. The publisher first verifies those
exact bytes in its Kandelo checkout. It then carries the digest through
Formula closure, bottle build, dependency provenance, build and upload
handoffs, bottle verification, sidecar preparation, and final handoff
validation. Both ordinary publication and campaign publication use the
canonical `/opt/kandelo/homebrew` prefix and its `Cellar`. Supplying the
campaign digest does not select different paths; it proves that an
already-sealed campaign still names the exact committed layout bytes. A
campaign with a missing or different required digest fails.

`homebrew/guest-prefix-campaign-inputs.json` classifies each Formula that
exists in the candidate source but has no selected sidecar yet. A required
build has one exact, discriminated `build_input` shape:

- `formula-source` means the conventional Formula source is the complete
  package-owned build entry point. The campaign still binds its raw Formula
  digest, exact native Homebrew `pkg_version`, architecture, qualified guest
  dependencies, and absent destination. It does not fabricate a recipe lock.
- `homebrew-bootstrap-recipe-lock` is reserved for
  `homebrew-bootstrap`. In addition to the Formula source, derivation validates
  its exact recipe manifest, source archive, patch, prepared tree, license
  evidence, and declared outputs. The bootstrap Formula cannot select the
  simpler `formula-source` shape.

Only a dependency named exactly
`kandelo-dev/tap-core/<formula>` enters the guest campaign graph. Unqualified
build and test dependencies remain native tools even when the tap has a Formula
with the same short name. Required and recommended guest dependencies must use
the exact tap-qualified identity and name a Formula in the campaign inventory.
This keeps host tooling out of bottle handoffs while preventing an incomplete
guest closure from appearing usable.

Current protected `main` remains the live mutation authority. An
ordinary publication requires exact equality. The campaign instead may
use its sealed Kandelo source only while that SHA remains an ancestor of
current protected `main`. This is an explicit, mutually exclusive
authority mode, not a fallback from an exact-main failure. Immediately
before each GHCR or immutable-release mutation, the mutation primitive
fetches protected `main` and repeats the ancestry proof. A detached,
descendant, diverged, or force-pushed-away source fails closed.

An immutable campaign or Formula-handoff release applies the same rule
to its target repository. Its direct tag points to the raw public tap
source commit, not to a prepared checkout. The two repositories
therefore retain truthful review and release history even though
package jobs execute a complete campaign-local Formula tree.

The campaign still runs bottle build, upload, anonymous index readback,
and runtime verification for every selected Formula/architecture. A
failed sibling invocation does not prevent a successful variant from
extending the public version index or completing verification. It does
not schedule `finalize-tap` or `publish-vfs-release`. The campaign
executor seals each verified result as
`homebrew-prefix-handoff-sha256-<handoff-sha256>`.

Full live-tap and named-product activation remain atomic, but bottle
availability does not. `homebrew-prefix-campaign-executor.py
prepare-selection` can materialize an ordinary tap-shaped candidate
intended for Brew and the VFS builder as soon as one root's exact
same-architecture dependency closure has verified handoffs. Its
content-bound manifest records every handoff and bottle digest.
Failures outside the selected closure are irrelevant; a missing
dependency produces no candidate.

For example, this prepares the prospective consumer input at `out/tap`:

```sh
bash scripts/dev-shell.sh python3 \
  scripts/homebrew-prefix-campaign-executor.py prepare-selection \
  --campaign campaign.json \
  --source-tap-root target-tap \
  --root-formula zlib \
  --arch wasm32 \
  --handoff handoffs/zlib \
  --out out
```

The caller supplies exactly the selected transitive closure. Extra
handoffs are rejected rather than silently widening the product, and
unselected Formulae are omitted from the prepared tap. The generated
`selection.json` binds the campaign, prepared tap tree, handoff
manifests, and bottle archives. The normal whole-tap validator must also
accept the generated Formula blocks and sidecars. `out/tap` is a local
candidate; this command does not publish it or move a product pointer.

Product activation requires a separate transaction that publishes the
exact candidate at an immutable locator, proves that the resolver and
VFS builder can read that locator, and then compare-and-swap updates the
named product pointer. Until that transaction exists, the local
candidate must not be described as an activated or durable product.

The ordinary dependency-bearing VFS acceptance attached to an
individual campaign publisher call is still skipped. That call has only
one Formula/architecture and cannot claim a product closure. Product
Node-and-Chromium acceptance must consume an immutable readback of the
closed selection before activation. The
independent `file-formula` browser smoke continues to run with the
campaign layout and remains the per-bottle Chromium proof. After all
migration handoffs are present, the campaign separately composes and
validates the complete live tap, then updates `main` once under the
tap-wide state lock.

`prepare-final-tap` performs the composition without changing Git state.
It requires the sealed campaign source, one complete handoff for every
Formula and architecture, and an exact clean live-tap parent commit and
tree. The live parent must contain the campaign's exact source commit
and tree. Changes after that source commit are limited to the explicit
campaign controller, trust-test, workflow, and campaign-documentation
paths reviewed for activation. A changed or newly added Formula,
recipe, Formula helper, or any other path fails closed even when
today's complete-tap validator would not discover it.

Composition starts from an immutable snapshot of the exact live tree.
The finalizer verifies that every overlay path still has its sealed
preimage (or is still absent), then replays only the listed target
files. This preserves the reviewed activation changes instead of
replacing the live tree with the overlay's older base. It regenerates
bottle blocks and current sidecars, preserves historical failure and
rollback evidence, validates the complete tap, and only then removes
the four paths listed in
`CAMPAIGN_RETIREMENT_PATHS`. The schema-2 completion and finalization
receipts bind the base, complete source commit and tree, overlay
payload, historical sealed target, replayed source tree, replayed live
tree, exact live parent, and final candidate tree. The candidate
records completion at
`Kandelo/campaigns/prefix-v1/completion.json`; a separate canonical
finalization receipt binds its tree to the expected live parent.

`create-final-tap-commit` consumes that candidate and receipt. It stages
the candidate through a private Git index, reproduces one deterministic
single-parent commit, and atomically creates a previously absent local
`refs/heads/...` ref. It does not change the live checkout, move `main`,
push, or call GitHub. If receipt creation fails, it removes the new ref.
The candidate and receipt are paired local outputs of
`prepare-final-tap`. They are not downloadable or independently
delegated authority. The commit step rechecks the exact live parent,
source and base trees, ancestry, allowed live drift, and candidate tree
from local Git. It does not rerun campaign composition without the
campaign and handoff inputs. Both commands therefore run in the same
trusted controller workspace; crossing a trust boundary requires
running `prepare-final-tap` again.
The tap controller must still hold the tap-wide state lock, recheck the
same live parent, push the prepared commit with compare-and-swap
semantics, and publish the commit receipt.

```sh
bash scripts/dev-shell.sh python3 \
  scripts/homebrew-prefix-campaign-executor.py prepare-final-tap \
  --campaign campaign.json \
  --source-tap-root target-tap \
  --live-tap-root live-tap \
  --handoff handoffs/zlib \
  --expected-live-commit "$LIVE_COMMIT" \
  --expected-live-tree-git-oid "$LIVE_TREE" \
  --out final-tap \
  --finalization-out finalization.json

bash scripts/dev-shell.sh python3 \
  scripts/homebrew-prefix-campaign-executor.py create-final-tap-commit \
  --candidate-tap-root final-tap \
  --finalization finalization.json \
  --live-tap-root live-tap \
  --output-ref refs/heads/prefix-v1-final \
  --commit-receipt-out final-commit.json
```

Repeat `--handoff` for every campaign Formula/architecture variant. The
finalizer expands every input handoff into a variant-keyed inventory, so
separate `wasm32` and `wasm64` handoffs for the same Formula are expected.
A handoff may contain more than one architecture only when its dependency
evidence is valid for every included architecture. Missing, extra,
duplicated, wrong-architecture, or dependency-inconsistent variants fail
before either output appears. Each dependency must resolve to the handoff
for the same architecture; a valid `wasm32` dependency cannot authorize a
`wasm64` consumer.

An ABI transition lands its coherent source and package changes through the
ordinary Kandelo merge process first. The normal path then rebuilds final
package archives and canonical bottles from exact resulting `main`. When an
already-built immutable producer `S` has the complete Git tree of current main
`M`, a v2 durable generation may preserve those archive bytes and their
truthful `S` provenance under complete-tree validation. The retired #1097
cache-projection experiment also recorded both trees, the ABI snapshot,
producer release, projection/ledger, selected build-input component evidence,
and assets. Later declared rootfs inputs invalidated even its narrow selection,
so the production workflow no longer exposes that method. Build a fresh
generation from exact `M`.
Merely making `S` reachable, preserving its SHA with a special merge, or
joining it to history is still insufficient.

Normal post-merge package preparation uses `force-rebuild.yml` from the exact
live main SHA. That workflow source-builds each selected target and embeds
`[build].repo_url = "https://github.com/Automattic/kandelo"` plus
`[build].commit = "<exact-main-sha>"` in its archive manifest. The durable
generation revalidates both fields for every selected archive. Under v2, the
same validation requires the archive commit to equal immutable producer `S`
and the content-bound receipt to prove complete `S^{tree} == M^{tree}`.
Historical readers retain support for the non-admitted #1097 evidence, but it
cannot produce a supported bottle input.
An archive that entered the mutable resolver ledger through ordinary
merge-candidate activation without that complete-tree proof remains useful to
general consumers but is not a bottle input.
The rebuild expands selected roots to their transitive buildable dependencies
and executes explicit topological levels. Members of a level remain parallel;
each later member consumes only the prior levels' same-run producer
artifacts. A missing producer artifact fails the run instead of falling back
to an older cache-equivalent archive; an empty job-local resolver cache also
prevents prior runner state from satisfying that edge. The commit-keyed
toolchain source-builds libcxx before it can be reused.

Incremental bottle planning must keep bottle-production provenance distinct
from package-generation input provenance. A new target Formula is recompiled
by the admitted checkout `M` (`brew install --build-bottle`, or the attested
Tier-2 script with the `M` SDK/sysroot/instrumenter), so that bottle's
`built_from.kandelo_repository` and `built_from.kandelo_commit` truthfully name
`M`. A generation producer `S` supplied resolver/test programs; it belongs only
in the separate digest-bound package-generation input receipt and must not
replace `built_from`.

A matching cache key, ABI, release tag, and bottle URL are still not enough to
reuse an older bottle. The prefix campaign admits historical bytes only when
its sealed manifest classifies that exact Formula/architecture as
`byte-clean-reuse-candidate`. The classification binds the old selected
record, full archive inspection, historical Formula source, Formula/link
sidecars, provenance report, candidate Formula identity, current ABI, and
guest-layout digest.

The old tap checkout is an object database as well as the current catalog.
The campaign finds the newest reachable commit that wrote the exact selected
`Kandelo/metadata.json` bytes and reads old bottle blocks from that commit. It
records this as `old_catalog_commit`. A bottle's `built_from.tap_commit` and
the metadata's `tap_commit` instead identify earlier publisher inputs; they
cannot identify the commit that embeds the final metadata because a Git commit
cannot contain its own eventual SHA. Current tap source may already contain
the next unpublished Formula, while an extra stale sidecar may predate the
selected catalog. Using any of those as the old bottle-block authority would
mix package generations or reuse a reserved rebuild number.

An older-ABI bottle is never passed through the current ABI's executable
validator. It is already an unconditional rebuild, and obsolete fork
instrumentation must continue to fail current-ABI admission. The campaign
still verifies its anonymous bytes, safe bounded TAR structure, complete path
scan, retired prefixes, archived Formula receipt, and declared dependency
closure. Its inspection records `not-inspected-incompatible-abi`, making clear
that archive evidence is not an executable compatibility claim.

A candidate Formula may advance its Homebrew `pkg_version` during the
campaign. The manifest keeps the old version on the historical bottle,
requires a bottleless candidate Formula, and reserves rebuild zero in the new
version's independently probed registry namespace. The old bytes always
require a build in this case; the campaign never relabels them as the new
version. An unchanged `pkg_version` continues to reserve a rebuild above the
selected bottle block instead.

Campaign manifest schema 2 gives every Formula a versioned
`destination.admission` record. Admission schema 1 contains exactly the
anonymous manifest probe, its method, and one of two states:

- `anonymous-absence` means the credential-free probe returned `missing`.
  This is the ordinary build or reuse-publication path.
- `first-package-namespace-bootstrap-required` means the credential-free
  probe returned `auth-required`. GHCR uses that response both for a new
  package namespace and for an existing private package, so it is not proof
  of absence. This state only permits a Formula classified by the reviewed
  campaign inputs as a source-only `required-build` entrant. The protected
  first-package publisher must later authenticate, prove that the repository
  namespace is missing, create the first public child, and complete anonymous
  readback.

A sidecar-backed Formula, a reuse candidate, or any Formula whose manifest is
already present cannot use the bootstrap state. Those cases fail during
campaign derivation. The executor repeats the same eligibility checks so a
rewritten campaign manifest cannot route an existing or reused package through
first-package publication.

Candidate dependency versions come from the same exact Homebrew metadata
resolution. When that closure differs from the historical Formula sidecar,
the dependent bottle also requires a build. This prevents a campaign from
publishing new dependency metadata beside bytes built for the old closure.

`homebrew-prefix-campaign-executor.py derive-reuse` consumes that authority.
It requires the sealed candidate source tree and a clean old-tap checkout at
the campaign's exact `old_tap_commit`. It rechecks every referenced sidecar
and historical Formula blob, then uses the existing bearer-aware public-bottle
reader with every package credential removed. The reader and executor verify
the content-addressed GHCR blob's byte count and SHA-256 again. A private
bottle, mutable checkout, changed evidence file, ambiguous record, non-empty
retired-prefix scan, or substituted producer fails before a handoff appears.

```sh
bash scripts/dev-shell.sh python3 \
  scripts/homebrew-prefix-campaign-executor.py derive-reuse \
  --campaign campaign.json \
  --source-tap-root target-tap \
  --old-tap-root old-tap \
  --formula zlib \
  --arch wasm32 \
  --out handoffs/zlib-wasm32
```

Repeat `--dependency-handoff <dir>` for the exact same-architecture
dependency closure. Extra, missing, or wrong-architecture handoffs fail.

Formula handoff schema 2 discriminates `build` and `reuse` publications. A
reuse publication contains only canonical bottle JSON, the unchanged bottle
archive, a sidecar-composition input, and a reuse evidence receipt. The normal
release, readback, dependency staging, and closed-selection commands consume
either kind. The tap controller invokes this Kandelo-owned command; it must
not implement a second reuse-admission authority.

The sidecar composition input names current campaign and tap state at its top
level, but carries the historical bottle's exact `built_from` record. The
sidecar generator verifies that the archived Formula receipt matches that
historical record and preserves the same repository and commit identities in
the generated bottle sidecar and provenance report. The old sidecar and
provenance retain their historical rebuild number; the new Formula uses the
campaign's strictly newer, collision-free destination rebuild. Current
metadata can make the already-admitted bytes selectable; it cannot make them
appear newly built.

A dry run keeps those repository identities fixed, but may select a reviewed,
valid Git branch name or an exact lowercase 40-character commit SHA from each
repository. The trust step normalizes branch names under `refs/heads/`, and the
planning job resolves both selections to immutable commits before any matrix
job starts. Dry-run outputs are validation evidence only and cannot be
promoted into canonical bottle, index, tap, or VFS state. These source
selections are data passed to the already-reviewed caller and reusable workflow
definitions; they do not select either workflow definition. The bottle root is
never caller-selected:
the workflow rejects a non-empty `bottle-root-url` and derives
`https://ghcr.io/v2/<lowercase-owner>/<lowercase-homebrew-repository>` from the
validated tap repository. The separate reusable maintenance workflow remains first-party
specific because its rollback and deletion paths own default-tap state. A
third-party `maintain-bottles.yml` on the protected default branch may call the
generic publisher for rebuilds, but generic rollback and deletion orchestration
are not provided by this change. Third-party actions in the privileged path are
pinned by commit. The reusable workflow uses only the caller's scoped built-in
`GITHUB_TOKEN` (`github.token`) for child and version-index transport. It
accepts no package PAT input or secret and cannot publish another repository's
tap state or GHCR packages because caller and target repository identities must
match.

The `force` input normally means only "include this Formula in the build
matrix even when its current cache key matches." It is not a general overwrite
switch. When a forced run encounters a version index left by a partial
publication, the credential-free composer may recover either a stale source
identity or different child bytes at the same semantic identity. Recovery is
allowed only if the exact, clean planned tap commit contains neither
`Kandelo/formula/<formula>.json` nor that Formula in `Kandelo/metadata.json`.
The composer first validates the complete old index and every child under their
own identity, requires the ABI, Formula, version, Formula revision, bottle
rebuild, and repository identities to match the new children, and then discards
every old child instead of retaining a sibling architecture. Its receipt keeps
the previous top digest and records either
`unfinalized-stale-source-identity` or the distinct
`unfinalized-same-identity-child-replacement` transition reason. A finalized
Formula, dirty or different tap checkout, fixed-identity mismatch, malformed
old index, or ordinary non-forced run still fails; a finalized bottle with
changed bytes requires a new Formula bottle `rebuild`.

#### Legacy one-shot visibility canary

The original repository-namespace visibility canary is a separate, one-shot
transport path used to select the production bottle-root contract. Its exact
reviewed caller on `Kandelo-dev/homebrew-tap-core@main` received only the caller
repository's `github.token` and passed no package PAT secret. It downloaded the
immutable zlib OCI child produced by Actions run `29628202419`, artifact
`homebrew-oci-child-zlib-wasm32-attempt-1`, and revalidated its pinned source,
bottle, and manifest digests. Run `29652866481` created
`homebrew-tap-core/zlib` as a public package linked to the public source
repository, and its credential-free readback matched the pinned manifest
digest. Earlier `GITHUB_TOKEN` and PAT uploads under `tap-core/*` both created
private packages. Normal publication therefore uses the exact
repository-rooted namespace and the scoped `github.token`; no visibility
mutation or PAT is part of the production path.

That legacy reusable workflow exposes a bounded first-child publication API
for a real Formula whose repository-rooted package does not yet exist. This is
not a marker upload and is not a weaker mode of campaign admission. The
protected tap caller fixes the Formula and architecture, then passes one exact
successful dry-run run ID and attempt, the immutable Actions artifact digest of
`homebrew-oci-child-<formula>-<arch>-attempt-<N>`, and its expected child
manifest digest. It also binds the exact caller tap commit and the immutable
Kandelo workflow commit.

Before reading child bytes, the reusable workflow re-reads both protected
`main` refs, requires the dry-run workflow path, repository-dispatch event,
`main` head, exact head SHA and attempt, completed-success result, and exactly
one unexpired artifact with the admitted archive digest. Without registry
credentials it then validates the complete OCI child layout and requires the
Formula, architecture, ABI, tap commit, Kandelo commit, and content-derived
manifest reference to equal that evidence. The credentialed uploader rechecks
tap `main`, rechecks Kandelo `main` at the final transport boundary, and uses
repository-canary mode: both the exact descriptor and the package repository
must be authentically absent before it copies the child. It retires its ORAS
credential state and requires anonymous readback of the exact manifest digest.
An expired or ambiguous artifact, a failed or different run, an advanced
source ref, a pre-existing public or private package, PAT authentication, or a
non-public readback fails before acceptance.

GitHub concurrency groups are repository-scoped. The first-child workflow
holds `kandelo-homebrew-ghcr-<formula>` from admission through public readback;
ordinary child and version-index jobs use that exact group for their mutation,
including rebuilds delegated by the maintenance workflow. Maintenance rollback
has only package-read authority and does not write GHCR. This keeps the absence
probe stable against every supported writer in the protected tap repository.
It cannot lock an administrator's registry client, a workflow in another
repository, or any future writer that bypasses the reviewed group. GHCR has no
atomic create-if-absent operation, so those uncontrolled writers are outside
the first-publication proof and must be excluded operationally; anonymous
exact-digest readback still proves the child bytes that became public, not
exclusive authorship against an external race.

Legacy canary publication deliberately stops after that immutable child upload.
It does not publish the mutable version index, edit Formulae, generate
sidecars, finalize tap state, or constitute post-publication acceptance. Once
the package exists, replay of this path must fail; the normal publisher must
later publish and verify the complete index and finalize the Formula. Keeping
this as a separately dispatched protected caller lets an absent namespace be
created from actual dry-run bottle bytes without changing any anonymous-only
campaign selection or reuse rule.

After a read-only planning job resolves the immutable Kandelo commit, tap
commit, ABI namespace, derived bottle root, and formula matrix, each
`(formula, arch)` entry crosses five separate runner roles. OCI child uploads
for different Formulae remain parallel. Every supported GHCR mutation for one
Formula is serialized by one repository-wide lock, while architecture builds
and all unrelated Formulae retain parallel throughput:

1. `build-and-test` is read-only. It checks out the exact inputs and reviewed
   Homebrew/brew commit, and exposes the patched temporary Homebrew worktree
   through a root-owned launcher under the canonical
   `/opt/kandelo/homebrew` target prefix. Native host dependencies use a
   separate ephemeral prefix, preventing their Cellar racks from colliding
   with Kandelo target Formulae. Within that read-only build, all
   Formula-evaluating Homebrew commands run as a distinct
   unprivileged user. The original Kandelo, primary-tap, and dependency-tap
   checkouts remain hidden from that identity. Each transient service receives
   root-created, read-only bind aliases for the Kandelo and primary-tap trees,
   and the Kandelo SDK environment points only at the alias. The locked
   dependency taps have already been cloned into Homebrew's isolated prefix.
   The patched Homebrew source is recursively non-writable and
   non-replaceable; only a root-provisioned shared temporary root, Homebrew
   cache/temp, prefix, and build home are writable. Dependency lists and install
   logs used by the workflow identity live in a separate mode-0700 control
   directory under the protected output root; Formula processes cannot preplant
   or replace those paths. The wrapper
   uses an explicit host `sudo` boundary, a fixed
   environment allowlist, and a transient systemd service with control-group
   kill semantics and `NoNewPrivileges=yes` for every Brew invocation. A final
   slice stop, UID-scoped termination, and privileged zero-process check occur
   before bottle artifacts are read. CI then deletes the dedicated account
   before fresh validator checkouts begin. Homebrew uses a build-local,
   read-only XDG configuration store and trusts only the reviewed immutable taps
   before evaluating its dependency Formulae. Root owns the store; directories
   are mode `0555`, and its JSON and lock files are mode `0444` so the isolated
   identity can read but cannot mutate them. The publisher-only Homebrew patch
   suppresses automatic redundant item persistence for that already-trusted
   tap. Explicit trust mutations retain stock behavior and fail against the
   sealed store. The store is removed with the build work directory; the
   publisher does not disable tap-trust enforcement or reuse persistent account
   state. The GitHub workflow-command parser is
   suspended around the complete builder invocation with a per-run 256-bit
   token that is never exported into the dev shell or Formula environment; an
   exit trap always restores parsing while preserving the builder status.
   The job then builds the required Kandelo pieces. This includes the exact
   reviewed `wasm-fork-instrument` host tool, so fork-using Formulae never depend
   on Cargo or Rust being present in Homebrew's filtered build environment.
   Before Formula execution it uses the authoritative package resolver in
   fetch-only mode to materialize a wasm32 base shell-script test runtime: Dash,
   Coreutils, Grep, and Sed. The host resolver intentionally maps
   unqualified `programs/<tool>.wasm` paths to wasm32 even for a wasm64 bottle
   matrix entry, so this runtime does not vary with the Formula's target
   architecture. These binaries are Kandelo
   base-system prerequisites, not Formula dependencies or evidence for the
   migrated package; source-build fallback is disabled. Sysroot setup likewise
   always builds the wasm32 base sysroot, then additionally builds `sysroot64`
   for a wasm64 matrix entry. Formula builds use the selected target sysroot,
   and generated sidecars fingerprint that target's `libc.a`. The job executes the
   Formula build and test without publisher credentials. The Kandelo bottle tag
   is scoped to immutable-tap dependency pours and final bottle creation.
   Homebrew resolves both the runtime-only immutable-tap closure used for
   provenance and the complete immutable-tap build/test closure. A static
   direct-host plan separately
   selects native build and test tools. Native Homebrew installs their full
   closure in its own state realm, the publisher validates their canonical
   `homebrew/core` identities, and each sealed direct tool receives a canonical
   read-only proxy keg in the target prefix. Plain-name `brew list` must
   recognize every proxy before the target build starts. The bounded
   immutable-tap union is then force-poured as Kandelo
   bottles, and the target Formula is built with dependency resolution
   disabled. Native tools therefore do not inherit a Kandelo target tag, and no
   locked dependency can fall back to a source build. The workflow also
   fetches the Dash, coreutils, grep, and sed test-runtime archives without
   source fallback. The resolver normally links those outputs to its
   workflow-user cache, which the isolated Formula identity cannot access, so
   the publisher transactionally copies each complete content-addressed
   generation into `.ci-test-binary-cache/` and rewrites `binaries/` as
   contained relative symlinks before it exposes the Kandelo checkout through
   a read-only source alias. This is the same portable-generation transport
   used by prepared conformance workspaces. It deliberately does not flatten
   package mirrors into regular files, because doing so would discard the
   single-generation identity that prevents a package closure from mixing
   unrelated builds. The Formula support loader derives the portable cache
   from its frozen Kandelo root and gives every Node or Chromium resolver child
   that exact `WASM_POSIX_BINARY_CACHE_ROOT`; caller-provided cache paths cannot
   replace it. The launcher copies the already-validated `xtask` bytes into
   one root-owned, single-link, exact-`0555` inode and includes a second exact
   copy only in the closed Formula-test runtime at
   `target/<host>/release/xtask`. Because Homebrew reconstructs the ordinary
   environment when it re-enters a Formula test, the launcher carries this
   fixed alias across that boundary as `HOMEBREW_KANDELO_XTASK_BIN`. Tap
   support validates the checker and sibling portable cache while loading its
   trusted support module, freezes both identities, and translates only those
   values to the resolver child.

   The Formula-test runtime is intentionally not a complete Kandelo source
   checkout: it has no `tools/xtask` source, `scripts/dev-shell.sh`, Cargo
   output, package registry, or local-binary tree. The host resolver therefore
   consumes the already-generated, cache-keyed package projection without
   running source-context regeneration. Source builds retain their separate
   protected checker path and normal freshness contract before isolation.
   Caller-selected checker paths, ambient repository-root overrides, and
   ambient Node module lookup are neither preserved nor trusted.
   The workflow also
   materializes the exact `formula_test` and `bottle` groups from pinned
   Homebrew's frozen Gemfile into the temporary overlay, validates their group
   and vendor-version state, normalizes archive-provided modes, and seals those
   bytes before Formula evaluation.
   Missing gems therefore fail during trusted preparation instead of causing a
   later `brew test` or `brew bottle` process to mutate protected source. Before
   Formula execution, the workflow uses the repository's Nix dev shell and declared Node
   to install Playwright Chromium into the location Formula test helpers derive
   from `HOMEBREW_CACHE`, then makes that browser tree root-owned, read-only, and
   executable by the isolated Formula identity. Browser tests therefore use the
   reviewed JavaScript dependency and cannot replace the provisioned executable.
   Its strict handoff
   contains only `manifest.json`, Homebrew's bottle JSON, one gzip bottle
   archive, and bounded `dependency-provenance.json`. It contains no Formula
   source, scripts, environment files, raw logs, or credentials. Before the
   handoff is created, the job checks out fresh exact Kandelo validator source
   and a fresh exact reviewed tap. It compares the Formula and required local
   source closure against those checkouts, independently of Git state exposed
   during Formula execution, and creates the handoff with the fresh validator.
   The build step never writes a `bottle do` block into the tap. Source digests
   hash every raw Formula byte except the structurally validated existing
   bottle-block lines, so comments, magic pragmas, whitespace, heredocs, and
   `__END__` data remain provenance-bearing. The pairwise source-closure check
   separately recognizes only an exact canonical bottle-block insertion or
   removal, including the separator blank line owned by the composer. This lets
   the first architecture add the block without invalidating an already-built
   sibling while continuing to compare every other byte exactly. Separate
   checks reject Formula mode changes and any tracked, untracked, ignored,
   mode, symlink, or special-file drift in the publisher-consumable
   `Kandelo/formula_support` closure. That closure conservatively includes the
   support module and every path outside its exact real top-level `test/`
   directory. The whole support tree, including `test/`, must contain only
   bounded regular files and directories. Test-only changes do not invalidate
   already-built bottles because the publisher removes the reserved subtree
   from each disposable execution clone before Homebrew loads Formula code.

   The handoff remains explicitly bounded while supporting complete large
   packages: Homebrew bottle JSON is capped at 16 MiB, dependency provenance at
   1 MiB, the inert sidecar-composition input at 8 MiB, the compressed bottle at
   2 GiB, and its expanded tar stream at 16 GiB. Generated formula and link
   sidecars are each capped at 16 MiB. The 8 MiB composition bound is the
   smallest binary power-of-two boundary above the observed TeX Live inventory:
   its 24,577 links produce a 4,599,594-byte generated link manifest, while the
   previous 4 MiB input cap rejected the same already-validated inventory.
   Raising this one byte bound does not relax the exact handoff layout, file
   count, path, JSON schema, or aggregate validation. Artifact
   transport uses compression level zero because the bottle is already a gzip
   stream. Validators reject the first byte beyond each bound; large packages
   are not made publishable by truncating their file inventories or installed
   payloads.
   `scripts/homebrew-publication-limits.sh` owns these byte limits; creators,
   validators, and the final refreshed-tap publisher consume the same values.
   The archive inspector also streams every byte of every regular member and
   rejects any exact local build root supplied by the trusted workflow. The
   build job supplies its GitHub workspace, runner-workspace parent, runner
   temp, isolated shared/Homebrew temp roots, exact ephemeral native Homebrew
   root, and dedicated build home while those randomized paths are still known.
   The reviewed builder records that canonical native root in its local
   `build.env`; the post-build validator uses it as trusted control data and
   never includes the environment file in the handoff. Fresh uploader, verifier,
   and finalizer jobs repeat the check with their trusted workspace, runner temp,
   and build-home facts. Roots never come from the artifact handoff, and a
   missing, relative, non-normalized, duplicate, or excessive root list fails
   closed. Matching is streaming and includes chunk-boundary matches; it does
   not weaken the declared archive-byte limit or buffer whole installed files.
   The canonical Homebrew prefix and `opt` paths are deliberately not forbidden,
   because bottle metadata may legitimately contain those relocation identities.
   After source-closure validation, the same credential-free job composes a
   deterministic Homebrew-native OCI child. The bottle is the gzip layer, its
   uncompressed digest is the image config `diff_id`, and the manifest carries
   Homebrew's exact bottle annotations plus the truthful
   `wasm32/kandelo` or `wasm64/kandelo` platform. The immutable child transport
   tag is derived from the manifest digest. Formula source identity excludes
   only the structurally validated bottle block; the separate source-closure
   identity still binds the Formula mode and every allowed support file,
   directory, mode, and byte digest.

2. `upload-bottle` runs only for a write publication and receives only
   `packages: write`. It holds the same repository-scoped, Formula-keyed GHCR
   writer lock as first publication and version-index publication. On a fresh
   runner it validates the strict build handoff
   and deterministic OCI child against the plan before exposing the caller
   repository's scoped `github.token` to an isolated ORAS transport. This
   includes bounded tar
   structure, link safety, receipt identity, local-build-root absence across all
   regular members, and every Wasm member's role-appropriate ABI/import
   contract, memory width, object kind, and fork instrumentation. The
   credentialed step cannot evaluate
   Formula Ruby or construct OCI metadata. GHCR returns the same anonymous
   authorization failure for a missing package namespace and an existing private
   reference. At that boundary, write mode uses the isolated credentials to fetch
   the exact destination descriptor. The probe bounds both output streams and
   accepts only structured descriptors or exact known ORAS errors; oversized or
   unclassified responses fail closed. When anonymous authorization hides whether
   the package exists, an authenticated missing descriptor must be followed by an
   authenticated repository probe. That probe requests the single JSON page after
   the lexicographically greatest legal OCI tag, so repository existence does not
   require enumerating an unbounded tag set. On this authorization-hidden path,
   only a missing repository permits the first upload; an existing repository, an
   existing descriptor, an unclassified response, or an authorization failure
   stops before transport. A directly anonymous missing response is already
   public evidence that the destination tag is absent and does not need that
   private-state disambiguation during ordinary publication. The bounded
   first-child publication path is stricter: it always requires an authenticated
   missing-repository result so an existing public package with a new tag cannot
   produce a false positive. The uploader copies only the validated child
   layout to its content-derived tag. Immediately before that credentialed
   `oras cp`, the transport itself re-reads both `Automattic/kandelo`'s
   protected `main` and the receipt-bound target tap's public protected
   `main`. An ordinary Kandelo call requires equality with the explicit
   publication SHA. A prefix-campaign call requires that its explicit
   sealed source remain an ancestor. The receipt's tap authority must
   remain an ancestor of target `main`. These checks prevent an earlier
   workflow check from authorizing a copy after either protected history
   diverges. The uploader retires the
   isolated ORAS authentication state and requires an anonymous
   exact-digest readback. Its only output is a
   strict data receipt binding the canonical layout receipt to that public
   readback.
3. `publish-bottle-index` receives `packages: write` once per Formula. The
   official caller-repository workflow uses the exact same formula-scoped
   concurrency lock as child and first publication. Under that lock it
   validates every requested
   child layout and public child receipt, anonymously imports the current
   Homebrew top reference, and preserves a compatible sibling architecture. The
   pinned artifact downloader extracts a single pattern match directly into the
   requested directory but gives multiple matches separate artifact-name
   directories. Index input discovery accepts exactly those flat-single and
   nested-multiple layouts while keeping artifact merging disabled so wasm32 and
   wasm64 `layout/` and `receipt.json` paths cannot collide. Mixed, unexpected,
   symlinked, duplicate, or unmatched child/publication layouts fail closed.
   Child validation occurs before the receipt architecture is trusted. The
   anonymous importer
   validates bounded top, child, config, and layer descriptors by digest before
   it starts the layer copy, confirms the mutable tag did not change during that
   validation, and pins the copy to the validated top digest. ORAS exposes the
   copied top index and its children as local OCI layout entry points, removing
   only each child's local reference-name annotation. The importer requires
   that exact expanded set and then canonicalizes the validated layout back to
   its single tagged top entry before composition. It then composes one complete
   OCI image index at Homebrew's version/rebuild reference. Only the final
   layout copy receives registry credentials; Formula Ruby and OCI composition
   remain credential-free. A conflicting same-reference child or a stale
   Formula/support closure fails instead of overwriting accepted bytes. The
   sole exception is an explicitly forced retry of an unfinalized partial
   index: the composer proves the exact planned tap has no formula-level or
   aggregate sidecar entry, requires every fixed identity field to match,
   validates the complete old index under its own identity, and discards all
   old children. This applies both to stale source identity and to different
   child bytes under the same semantic identity. It never carries a sibling
   architecture across either transition.
   A schema-3 top-index receipt keeps mutation authority separate from
   child provenance. Its `authority` object records the current target
   tap repository and commit that may publish the aggregate. This field
   does not rewrite the producer provenance carried by historical child
   handoffs and sidecars. The receipt also records the previous digest.
   The transport rechecks that digest and both protected-main
   authorities immediately before its copy, and an anonymous readback
   verifies the result.
   GitHub Container Registry (GHCR) does not provide this path with a documented
   conditional tag update, so an authorized writer outside the official workflow
   lock must not publish the same Formula concurrently. New packages created by
   the public tap repository's scoped `github.token` under that exact
   repository-rooted namespace inherit public access. Automation never changes
   package visibility, and a package that is not anonymously readable fails
   before tap finalization.
4. `verify-bottle` is read-only and starts from fresh exact source
   checkouts. In campaign mode it deterministically reconstructs the
   prepared checkout and requires its separately recorded raw source and
   local checkout identities. It revalidates the build handoff and
   receipt, fetches only the declared Kandelo platform runtime for
   Formula tests, builds the VFS image, and runs the runtime and browser
   gates. The `file-formula` browser-gallery smoke separately prepares
   the supported interactive-demo graph. That graph contains owned
   wasm32 and wasm64 process fixtures, so the verifier builds both
   sysroots in
   its isolated sysroot checkout and copies both exact outputs into the fresh
   browser checkout before running the supported preparation command. Packages
   supplied by the external software gallery are not verifier prerequisites.
   Its isolated Homebrew process receives the same selected-tap trust as the
   build process, sealed into a readable, immutable build-local XDG store and
   using the same publisher-only redundant-persistence exception.
   It uses the locally built bottle in dry-run mode. In write mode it discards
   that bottle as runtime evidence, anonymously imports and validates the exact
   public top-index-to-child-to-layer graph, and rechecks the selected layer's
   SHA-256 and byte count. The preliminary layer readback uses the same GHCR
   bearer-authentication path as runtime fetching, but it does not collect the
   response in memory. It streams into a newly created output file while
   incrementally counting and hashing bytes. The verifier loads the 2 GiB
   compressed-bottle bound from `scripts/homebrew-publication-limits.sh`,
   rejects the first byte beyond either the declared size or that bound, and
   removes its partial file before a retry. Exclusive creation prevents a
   retry or concurrent process from replacing a file already at the output
   path. This keeps a valid 816,992,281-byte TeX Live bottle under the archive
   policy instead of incorrectly applying the unrelated 64 MiB JSON limit.
   Runtime callers retain the existing in-memory byte API; only publication
   readback selects the response-stream API.
   ORAS may expose the copied top index and its child
   manifests as separate local OCI layout entry points. The verifier selects
   exactly one receipt-matched top entry and accepts additional entries only
   when they are the complete, exact descriptor set declared by that top index;
   partial, duplicate, ambiguous, or unrelated roots fail closed. It statically
   composes the selected bottle block from reconstructed canonical metadata.
   In an isolated identity it then runs the reviewed pinned Homebrew
   implementation with the Kandelo platform patch. The
   verifier independently resolves the runtime-only immutable-tap closure and the
   complete runtime/test closure. Its static direct-host plan excludes pure
   build tools, then native Homebrew installs the remaining runtime/test tools
   and their complete closure under the separate native state realm. After
   canonical core validation, only the sealed direct tools receive read-only
   proxy kegs in the target prefix, and plain-name `brew list` must recognize
   them there. The verifier then force-pours the immutable-tap portion from prior
   Kandelo bottles and pours the target bottle with dependency resolution
   disabled. It also
   provisions a separate protected Playwright Chromium
   tree for the verifier identity. Runtime provenance remains limited to the
   runtime-only closure. The builder and verifier pour that dependency closure
   independently, so each records its own exact provenance and install-receipt
   digests. Those evidence digests are validated and retained independently;
   the handoff comparison requires the same ordered dependency names, versions,
   bottle digests, and architecture tags rather than incorrectly requiring two
   independent pours to produce byte-identical receipts. The target cache then
   starts empty, source fallback is
   forbidden, and Homebrew itself must fetch, force-pour, inspect, and test the
   exact public bottle. An executable Formula uses the default bottle-test
   contract: its `brew test` must emit a receipt proving execution through the
   Kandelo Node launcher. A Formula whose payload is only support data may
   instead contain this one exact static declaration:

   ```ruby
   KANDELO_BOTTLE_TEST_CONTRACT = "support-data".freeze
   ```

   The verifier reads that declaration without evaluating Formula Ruby. Its
   `brew test` must complete the reviewed installed-byte assertions and must
   not emit an incidental Node receipt. Runtime-evidence schema 3 records the
   selected Formula source digest and the exact typed test contract. The
   resulting bottle sidecar has no declared Node or browser runtime support;
   the support-data test cannot be used as executable compatibility evidence.
   For `homebrew-bootstrap`, real execution with Ruby remains the separate
   Node and Chromium guest-lifecycle gate before in-guest `brew` is exposed.
   This narrow declaration describes the bottle test only; it does not weaken
   that later product acceptance.

   For a GitHub Container Registry (GHCR) bottle, Homebrew
   normally logs the version/rebuild manifest endpoint that it fetches, such as
   `.../zlib/manifests/1.3.1_3`, rather than the selected layer's digest URL.
   Runtime evidence accepts a fetch action for either that exact expected
   manifest endpoint or the exact bottle blob URL. A manifest log line is not
   sufficient by itself: the verifier has already anonymously validated the
   top-index-to-child-to-layer graph, and it still requires the Formula metadata
   to select the exact blob, exactly one cached archive to match the expected
   SHA-256 and byte count, the exact bottle filename to be poured, and
   Homebrew's install receipt to report a bottle install. Formula and
   support source are checked out fresh again before sidecar generation, which
   does not execute Formula Ruby. A bounded
   archive inspector independently derives the keg file inventory, executable
   links, target receipt dependencies, archived Formula digest, and
   fork-instrumentation state from the selected bottle bytes. Every regular
   member beginning with Wasm magic is decoded independent of its filename or
   mode. A module with exactly one leading `dylink.0` section is a dynamic-link
   side module: it must import the one architecture-matching process memory,
   use only the namespaces supplied by Kandelo's dynamic linker, avoid direct
   process-only kernel imports, and carry complete side-module fork
   instrumentation when needed. Every other Wasm member is a process
   executable and must carry the exact release ABI in addition to the common
   memory, object-kind, and fork checks. Homebrew `bin/` and `sbin/` links
   declare process entrypoints, so they may not resolve to a side module.
   Neither a `.so` suffix nor a non-executable mode exempts an ordinary Wasm
   member from process validation. A future bottle that ships plugin or browser
   Wasm as inert data still needs an explicit typed payload contract. The static
   Formula declaration parser then cross-checks dependency categories and
   directness against the validated build provenance and receipt. The verifier
   generates the selected package's candidate sidecars, then validates the
   strict build files, upload receipt, selected runtime bottle bytes, Formula
   composition, and one package-scoped `composition/sidecars-input.json`.
   Whole-tap validation is deliberately deferred because another Formula in
   the same coordinated rollout may already describe its new bottle while
   aggregate metadata still describes the previous bottle. Downstream jobs
   never execute artifact-provided scripts, Formulae, or environment files.
5. `finalize-tap` runs only for a write publication that did not request
   deferred finalization, and receives only `contents: write`. A
   prefix-campaign Formula call therefore cannot mutate tap Git state.
   On another fresh runner for an ordinary publication, the job
   downloads exactly one handoff for every planned Formula/architecture
   pair. The pinned artifact downloader may flatten one matched handoff
   directly into the requested directory or retain artifact-name
   directories, so the finalizer normalizes either exact topology into
   one NUL-delimited plan-ordered path manifest. Correctly named
   nested single- and multi-handoff layouts are also accepted for compatibility
   with downloader topology changes. Mixed layouts, missing or extra entries,
   duplicate identities, symlinks, and special files fail closed. Each
   normalized handoff is then validated as inert package-scoped data against
   the exact base tap before checking out with push credentials.
   The publisher then acquires the tap state lock once for the entire planned
   set, refreshes `main`, verifies that the planned tap commit is still an
   ancestor, and creates two detached worktrees at that exact refreshed commit:
   one clean, immutable source snapshot and one mutable transaction candidate.
   For every entry it first proves that the source snapshot is still at the
   exact refreshed commit with no tracked, untracked, or ignored changes. It
   rechecks the Formula's bottle-excluded source digest and any
   required publisher-input closure under `Kandelo/formula_support` against a
   detached checkout of that exact planned commit. It also rederives and
   revalidates the complete dependency Formula and bottle closure against the
   clean refreshed source snapshot while the lock is held. Formulae and
   sidecars generated for an earlier package in the same batch exist only in
   the separate transaction candidate, so they cannot be mistaken for dirty
   source input by a later package. For each dependency, a detached
   checkout of the exact planned tap binds the recorded raw Formula digest;
   refreshed Formula bytes may differ only by the structurally canonical
   bottle block, and the selected architecture's bottle metadata must remain
   exact. It statically composes each selected bottle tag and regenerates
   aggregate sidecars after each package input, carrying the preceding
   candidate metadata forward. This supports multiple packages and both
   architectures without copying or splicing generated provenance files. A
   sibling-architecture tag is retained only when the refreshed
   metadata proves the same ABI, version, formula revision, and bottle rebuild.
   A stale handoff cannot move the tap to an older ABI or, for the same package
   identity and ABI, to a lower bottle rebuild.
   The unchanged whole-tap semantic validator then checks the complete detached
   candidate and the exact staged attached-`main` tree. Only after both checks
   pass does one purpose-prefixed commit push all Formulae, sidecars, and
   recomputed provenance together. Immediately before `git push`, the tap
   writer itself re-reads `Automattic/kandelo`'s protected `main` ref and
   requires it to equal the commit recorded by the publication; this closes a
   race after the workflow's earlier check and after potentially long
   composition. It does not load Formula Ruby or run Homebrew in the
   credentialed role.
6. `publish-vfs-release` runs only when finalization was not deferred,
   `require-vfs-acceptance: true`, every verifier matrix entry
   succeeded, and the atomic tap finalizer succeeded. A prefix-campaign
   Formula call cannot publish this release. For an ordinary accepted
   publication, the verifier exports only the selected wasm32 image, its
   deterministic lazy shell ZIP, both descriptors, its VFS report, and
   the exact Node and Chromium evidence. A fresh job
   checks out the exact planned Kandelo and tap commits, revalidates that inert
   bundle without a token in its environment, compares its ABI and bottle
   release tag to the trusted plan outputs, and only then exposes the scoped
   `github.token` to one release-write step.
   That step publishes two independently content-addressed releases. The eager
   acceptance release has five assets under
   `homebrew-vfs-sha256-<image-sha256>`; the closed runtime layer has its
   payload and descriptor under
   `homebrew-runtime-layer-sha256-<bundle-sha256>`. Each release serializes on
   its own content tag, creates or resumes an exact draft, rejects duplicate,
   unexpected, partial, missing-public, or byte-mismatched assets, and becomes
   public only after authenticated byte checks succeed. The publisher then
   reads all five and two public URLs respectively with token variables removed
   and verifies every SHA-256 and byte count. It requires both published API
   records to set `immutable: true` before emitting success. A public release
   retry is read-only and idempotent.

Ordinary tap writes use a tap-wide state lock, an attached `main`
checkout, an explicit remote-main refresh, and an explicit
`HEAD:refs/heads/main` push. The workflow uses a separate clean checkout
for failure reports so a partially generated or locally committed
success attempt cannot enter a last-green failure commit. Maintenance
rollback resolves its freshly checked-out Kandelo `main` commit and
passes that same identity as both report provenance and push authority.
Prefix-campaign Formula/architecture calls do not write Git tap state.
Each successful bottle upload and Formula index update is nevertheless
independently public and usable after anonymous verification. A consumer
selects one exact same-architecture dependency closure, so that selected
closure is the atomic unit for composition. Only the named full-tap or
prefix activation waits for the complete candidate and its final pointer
update.

Use `dry-run: true` for local or CI validation that must not push GHCR blobs or
tap commits. Dry runs still build bottles and validate the generated metadata
shape. The verifier carries that trusted mode explicitly into final handoff
validation; write-mode validation and the credentialed finalizer reject a
non-public dry-run receipt. An anonymous GHCR authorization failure remains a
non-public dry-run result; dry-run upload planning neither loads registry
credentials nor attempts to distinguish a missing namespace from a private
reference. Dry runs seed the
VFS builder from the current local bottle. Non-dry runs seed it only with bytes
returned by the anonymous GHCR readback. The publisher deliberately does not
restore GitHub
Actions dependency caches: selected tap and Kandelo refs are executable code,
and a manually dispatched dry run can write Actions storage in the same
repository scope as a later privileged publish. Run-scoped diagnostic artifacts
remain available, but cached build output is not an input to bottle publication.

The repository-dispatch API does not return the workflow run ID, and concurrent
dispatches can appear in the run list in a different order from the requests.
Treat the newest run only as a candidate. Before cancelling, rerunning,
watching, or downloading artifacts from a manually dispatched run, wait for
its `plan` job and read that job's logged inputs. Match the Formula selection,
architectures, Kandelo ref, and exact caller/source tap SHA. If those facts are
not yet available, do not mutate the run; another operator or rollout may own
it.

`bottles-abi-v<N>` is a bottle metadata namespace, not a promise that a GitHub
Release with that tag contains sidecars or gallery archives. Browser-proven VFS
images use their own immutable `homebrew-vfs-sha256-<image-sha256>` releases;
serialized gallery release publication remains deferred. Do not restore the
old mutable `gh release upload --clobber` path.

## Sidecar Metadata

Generate sidecars with:

```bash
scripts/dev-shell.sh cargo xtask homebrew-sidecars \
  --tap-root /path/to/kandelo-homebrew \
  --input /path/to/sidecars-input.json \
  --previous-metadata /path/to/previous/Kandelo/metadata.json
```

Validate generated tap metadata with:

```bash
scripts/dev-shell.sh cargo xtask homebrew-validate \
  --tap-root /path/to/kandelo-homebrew
```

`homebrew-validate` checks JSON schema shape plus cross-file facts:

- metadata ABI matches the `bottles-abi-v<N>` namespace;
- formula sidecars agree with `metadata.json`;
- bottle arch and `bottle_tag` agree;
- link manifests stay inside the Homebrew prefix;
- link sources and receipts are declared;
- provenance and metadata shas agree;
- browser-compatible bottles include browser validation evidence.

Bottle status follows Kandelo's last-green model:

- `success`: current bottle fields are authoritative.
- `failed`: latest rebuild failed; complete fallback fields may point at the
  previous successful bottle.
- `pending` or `building`: rebuild is queued or running; consumers may use a
  complete fallback.

Failure reporting must not replace last-green metadata. The workflow's failure
path checks out a fresh tap, refreshes it to `origin/main` under the tap-wide
lock, and calls `scripts/homebrew-publish-sidecars.sh --status failed`. The
report records the resolved Kandelo and tap source commits plus the workflow run
URL. It also records the exact captured stderr from the first failed local
finalizer stage—handoff validation first, otherwise atomic tap publication—when
that file is a regular non-symlink, NUL-free UTF-8 file within the shared byte
limit. An oversized or non-text diagnostic is replaced by a fixed omission
marker, and an artifact-download failure remains outcome-only because it has no
trusted local error file. The previous successful bottle remains selectable
when its fallback fields are complete. Maintenance exposes only `rebuild` and
`rollback`; there is no workflow-level `repair-only` mode.

## VFS Planning And Building

Homebrew-derived VFS images are built from sidecars and verified bottle bytes,
not from Formula Ruby.

The guest Homebrew bootstrap image is a separate diagnostic and integration
artifact. Build it from the pinned upstream Homebrew revision, Kandelo's
reviewed platform patch, and ABI-current Kandelo package artifacts with:

```bash
./scripts/dev-shell.sh scripts/build-homebrew-bootstrap.sh
```

The script writes `target/homebrew-bootstrap/homebrew-bootstrap.vfs`. It derives
the ABI from `crates/shared`, resolves the Node kernel, canonical rootfs package
set, and Homebrew bootstrap programs through `xtask build-deps`, and calls
`scripts/prepare-homebrew-bootstrap-source.sh` to prepare Homebrew. The current
`homebrew-bootstrap` registry package uses that same preparer and records
the source ZIP and `homebrew-brew.env` as one transitional package
generation. The product shell resolves both members from that exact
package generation, embeds the small environment policy, and registers
the source ZIP as a lazy tree
behind `/usr/bin/brew`. Today that tree is mounted at the transitional
`/home/linuxbrew/.linuxbrew` prefix. The atomic campaign changes both the
Formula-owned software and bootstrap to `/opt/kandelo/homebrew`; the
stable `/usr/bin/brew` entry point lets that cutover and a later
Formula-owned bootstrap happen without changing the guest command. The
separate diagnostic bootstrap image above remains an eager integration
artifact. Source
preparation verifies the reviewed patch SHA-256, refuses an upstream revision
where the patch does not apply, limits the patch to its declared Homebrew
files, and archives the patched Git tree with a fixed timestamp and UTC
timezone.

`/etc/kandelo/homebrew-image.json` records the exact upstream Homebrew commit,
patch SHA-256, patched-tree Git object and normalized-tree SHA-256, patched ZIP
SHA-256, and selected bottle architecture and tag. `/etc/homebrew/brew.env`
selects `wasm32_kandelo` for the current wasm32 bootstrap and sets
`HOMEBREW_SYSTEM_ENV_TAKES_PRIORITY=1`, so prefix and user configuration cannot
select a bottle for a different guest architecture. Homebrew's own `bin/brew`
reads that supported system environment file; `/usr/bin/brew` stays a direct
symlink to the selected bootstrap prefix's `bin/brew`, with no Kandelo
launcher or install fallback. The target campaign resolves it to
`/opt/kandelo/homebrew/bin/brew`; the current transitional image resolves it
under `/home/linuxbrew/.linuxbrew`. The patch recognizes that exact
alias/repository pair so
Homebrew does not derive the forbidden `/usr` prefix from `$0`. The same source
preparer emits `wasm64_kandelo` when a future bootstrap builder selects wasm64.
The system environment also selects Homebrew's paired no-API mode:
`HOMEBREW_NO_INSTALL_FROM_API=1` keeps explicit tap Formulae authoritative, and
`HOMEBREW_AUTOMATICALLY_SET_NO_INSTALL_FROM_API=1` matches
`Homebrew.with_no_api_env` so Homebrew does not clone the complete
`homebrew/core` repository for unavailable core metadata. Kandelo has no
`formulae.brew.sh` internal-package endpoint for its effective platform; normal
first- and third-party use therefore names and pins Git taps instead.

The default 768 MiB VFS capacity leaves writable space for real guest Homebrew
operations; use `--sab-size` and `--max-size` when a specific integration test
needs a different capacity.

The bootstrap manifest explicitly trusts executable bits from the pinned
`git archive` ZIP. `mkrootfs` imports only those Unix `0111` bits; ownership,
directory modes, non-executable file modes, and all other permission bits stay
normalized by the manifest.

Run the focused source and selection contract with:

```bash
./scripts/dev-shell.sh scripts/test-homebrew-bootstrap-source.sh
```

That test prepares the source under multiple builder timezones, compares
archive and tree identities, checks wasm32 and wasm64 environment selection,
and proves the system architecture tag overrides conflicting prefix and user
configuration. It executes archived Homebrew through a real symlink and proves
that the guest alias retains the canonical prefix. It also exercises both tag
parser round-trips and loads a pinned real tap formula to verify that Homebrew
selects its exact `wasm32_kandelo` bottle digest. It proves that changed upstream
patch context fails closed. Formula selection is not evidence that the GHCR
manifest exists or that a bottle downloaded, poured, or ran; those remain
trusted publisher and guest integration claims.

After building the bootstrap image, verify that Homebrew's canonical archived
`bin/brew` reads the system environment file rather than relying on a launcher
or parent-process tag:

```bash
rm -rf host/dist
./scripts/dev-shell.sh npx tsx homebrew/test/homebrew_bootstrap_guest_env.ts \
  --image target/homebrew-bootstrap/homebrew-bootstrap.vfs \
  --bash binaries/programs/wasm32/bash.wasm
```

This probe starts guest Bash with the canonical real script path and xtrace. It
requires `brew --version` to succeed after proving that Homebrew consumed
`/etc/homebrew/brew.env`; a fork-save-buffer diagnostic is a failure. It does
not prove shebang dispatch, `/usr/bin/brew` alias execution, an install, or a
bottle download.

ABI 41 raised every fork continuation reserve from 16 KiB to 60 KiB. The
earlier ABI 39 dispatcher, `/usr/bin/brew` alias-launcher, and recursive Bash
measurements needed 20,012, 29,212, and 49,232 bytes respectively, so the
shallow source/bootstrap probe above fits. The complete main-shell proof found
that Ruby-backed Homebrew startup can require 64,256 and 66,092 bytes. ABI 41
therefore does not support the full guest Homebrew lifecycle; the truthful
overrun is a platform failure, not a package defect. Full support waits for the
reviewed dynamic continuation design, allocation-failure recovery, ABI-current
bottle rebuild, and exact Node/browser proof. Do not increase a package-local
limit, bypass command substitution, or accept the diagnostic as success.
Repeat the shallow source probe with
`--brew-script /usr/bin/brew` when validating the alias path; `$0` must remain
`/usr/bin/brew`, the launcher must recognize the symlink, and the command must
print the Homebrew version rather than silently falling back to `/Library`.

For a package or ABI change, Prepare Merge runs both entry-point probes against
the exact synthetic merge candidate before it can publish merge authority. The
job materializes the candidate index first and builds the bootstrap image with
`--skip-package-resolve`, so a green result cannot come from an older canonical
package release. Both probes clear `host/dist` before loading the TypeScript
host runtime, preventing stale compiled host code from shadowing the tested
source.

`--skip-package-resolve` is only for a worktree whose `binaries/` tree has
already been materialized. It still validates every required output and fails
if any artifact is absent, has a stale ABI marker, lacks executable exports, or
contains retired Asyncify instrumentation. The bootstrap image does not prove
that a formula was built from, published as, or poured from a Homebrew bottle;
those claims require the trusted publish and bottle validation paths below.

The shared planner provides `planHomebrewVfs()` for one metadata document and
`planFederatedHomebrewVfs()` for an explicit immutable tap set in
`host/src/homebrew-vfs-planner.ts`. Both consume `Kandelo/metadata.json` plus a
caller-provided link-manifest loader and reject bad ABI, unsupported arch,
tap-identity drift, duplicate roots or metadata, cache-key drift, missing
packages, dependency cycles, unsafe paths, and link-manifest bottle drift
before any bottle bytes are extracted. The federated planner keys packages and
edges by canonical `owner/tap/formula`, requires each package's bottle URL and
`built_from` repositories to match its metadata document, validates the exact
package-specific build commits independently of the document-generation
commits, rejects duplicate Cellar short names across taps, and resolves the
closure in deterministic dependency-first order.
Guest-relative link-manifest paths admit literal square brackets and commas so
standard POSIX utility names such as `bin/[` and upstream payload filenames
such as TeX Live's comma-delimited examples remain representable. They still
reject absolute paths, empty and `.`/`..` segments, backslashes, and whitespace.
Tap metadata references use a separate, narrower path grammar and do not
inherit the guest filename allowances.

The Node-side builder is `buildHomebrewVfs()` in
`host/src/homebrew-vfs-builder.ts`. It verifies bottle byte count and sha256,
extracts supported tar entries, stages kegs under the declared prefix,
validates receipts, applies link manifests, and creates the canonical
`opt/<formula>` symlink for every selected package. The `opt` link is
builder-owned rather than a link-manifest entry: its relative target is derived
from the package's validated prefix and exact keg, and any pre-existing path at
that package's `opt` location fails composition instead of being overwritten.
The builder writes `/etc/kandelo/homebrew-vfs.json` and emits a build report;
both record each `opt_link` path and target. Each package record retains its
full Formula name, tap repository, tap name, and exact tap commit.

The main shell keeps its reviewed base closure and its Homebrew runtime-support
delta as separate materialization-policy cohorts. They are not separate
package inventories: the build report, `/etc/kandelo/homebrew-vfs.json`, and
outer VFS metadata each list the exact ordered union of both cohorts. This lets
mirror recovery authenticate every deferred bottle while preserving which
Formulae belong to the base shell and which activate atomically on first use
of `/usr/bin/brew`.

Bottle tar hardlinks are supported only between regular files inside the same
validated keg. The extractor resolves forward hardlinks after ordinary files,
preserves their shared inode identity, and rejects unsafe paths, cross-keg
Cellar entries or targets, targets not staged by the same bottle, non-regular
targets, missing or cyclic targets, and hardlink headers with payload bytes.
Device nodes and FIFOs remain unsupported.

The CLI starts with an empty VFS by default. Pass `--base-image` to overlay the
same verified bottle plan onto an explicit platform-only `.vfs` or `.vfs.zst`
base image. The base must declare the same kernel ABI as the bottle metadata
and must not already carry Homebrew composition metadata or
`/etc/kandelo/homebrew-vfs.json`; merging independently composed Homebrew
prefixes would lose package provenance, so it fails closed. Existing files
remain unchanged except for requested bottle/link paths and the builder-owned
Homebrew manifest (plus the optional profile and default-shell files); path
collisions fail through the normal staging checks.

The output image metadata binds the exact base input with a bounded object:
SHA-256, byte count, and declared kernel ABI. It also records the primary tap
and each package's source-tap identity. The JSON report carries the same
binding plus the base's full source metadata for auditing. Base signatures,
attestations, and other metadata are not copied onto the mutated output, and
large source metadata is not nested into each new image.

When `--max-bytes` is omitted, the builder restores the base with its recorded
filesystem maximum and does not rebuild existing inodes. Supplying a different
`--max-bytes` explicitly rebases the filesystem to that exact maximum, so
allocation and `statfs` agree with the requested capacity. Explicit maxima
must be multiples of the 4096-byte SharedFS block size.

For reproducible image composition, use the builder's static Brewfile subset.
For example:

```ruby
tap "kandelo-dev/tap-core"
brew "sqlite"
brew "kandelo-dev/tap-core/xz"
```

The subset accepts blank lines, comments, exactly one literal canonical
lowercase `tap "owner/tap"`, and between 1 and 128 literal `brew` entries.
Entries may use a bare formula name or a fully qualified name from that exact
primary tap. Bare and qualified forms normalize to the same root, so duplicates
fail. The selected tap must exactly match the primary `metadata.json`, and the
complete resolved closure is limited to 128 packages.

The parser uses Ripper to inspect the syntax tree and never evaluates the file.
Options, interpolation, conditionals, variables, nested Ruby, `cask`, `mas`,
`service`, and every other Homebrew Bundle entry are rejected. Full Bundle DSL
belongs to real Homebrew running inside a Kandelo guest; it is not a safe or
deterministic host-side image specification. The Brewfile intentionally selects
roots from one primary tap. Cross-tap closure edges come only from
`full_name`-qualified sidecars and separately supplied immutable dependency-tap
metadata; the Brewfile cannot add an undeclared tap.

This path does not read `Brewfile.lock.json`; Homebrew Bundle does not define a
lock-file contract. Reproducibility instead comes from the exact Brewfile
SHA-256 and byte count, ordered normalized roots, tap commit, base-image digest,
and verified bottle digests recorded in the report and image manifest. The
root digest is SHA-256 over the UTF-8 JSON array of normalized roots in declared
order. The bounded top-level VFS metadata records only root count and digest
rather than embedding arbitrary source text.

Build a precomposed image with:

```bash
scripts/dev-shell.sh npx tsx images/vfs/scripts/build-homebrew-vfs-image.ts \
  --metadata /path/to/homebrew-tools/Kandelo/metadata.json \
  --tap-root /path/to/homebrew-tools \
  --dependency-tap-root \
    kandelo-dev/tap-core=/path/to/homebrew-tap-core \
  --brewfile /path/to/Brewfile \
  --arch wasm32 \
  --runtime node \
  --base-image target/platform-base.vfs.zst \
  --out target/homebrew-tools.vfs.zst \
  --report target/homebrew-tools.vfs-report.json
```

The required-acceptance publisher also passes `--lazy-layer-out`,
`--lazy-layer-descriptor`, `--lazy-layer-base-image`,
`--lazy-layer-base-package-source`, an exact `--runtime-layer-id`, and the
checked-in `--runtime-layer-policy`. Lazy output is fail-closed unless that id
is a reviewed policy entry whose package name is the id. The producer projects
the verified plan to that one root and its dependency closure, and the emitted
descriptor must contain exactly one requested package equal to the layer id.
The eager acceptance image still uses the platform-only base described above.
The deferred layer has a different lower filesystem: the exact bottle-built
`shell.vfs.zst` declared by the canonical `shell` package, materialized without
credentials or source fallback from the package's current index and immutable
archive. The package-output receipt binds the fetched index snapshot, exact
recipe cache key, immutable archive, and declared output bytes. The archive
digest also transitively binds the producer's archived external Git inputs.

The lazy composer restores that exact shell image, verifies the receipt against
its bytes and ABI, and reads its Homebrew composition manifest. A selected
package is reused from the lower image only when its full artifact identity
matches the dependency-first plan, including tap repository, tap name, tap
commit, bottle digest, cache key, and build provenance. This applies equally to
a package from the root tap or an exact dependency tap; a mismatched dependency
tap lock or bottle identity fails instead of silently reusing similarly named
files. The federated tap lock binds the current catalogs separately; a bottle's
package-specific `built_from` commit remains its historical build identity and
need not equal the catalog commit that now selects it. The remaining packages
are poured into a fresh filesystem with a
256 MiB ceiling. A directory already present in the lower image may be shared,
but any file, symlink, or type collision fails composition.

The direct collection producer resolves the complete selected plan once so
collision ownership and link suppression are global, then emits one tree for
every selected Formula. Each payload is that Formula's exact finalized
Homebrew bottle `.tar.gz`; the producer does not recompress or combine dependency
bottles. A complete source inventory records every validated TAR member. Its
guest projection records ownership, POSIX modes, logical sizes, link targets,
source member paths, regular-inode groups, the package keg and `opt` link, and
whether a path is an archive member, a link-manifest copy, an explicitly
mode-overridden copy, or descriptor-created structure. The image builder still
does not duplicate the lower shell image, `/etc` metadata, a gallery profile,
or a language-specific VFS image into any bottle tree. The product composer,
not this collection primitive, chooses which trees are embedded and which
remain independently lazy.

The exact bottle is transport truth, but installed Homebrew text is not always
byte-identical to the archive member. Homebrew records the files it changed
while replacing install paths with placeholders in
`INSTALL_RECEIPT.json.changed_files`. Kandelo treats that bounded canonical
list as authoritative. The producer reads it from the already verified bottle,
computes the final logical sizes, and marks only those regular files or
hardlink aliases for `@@HOMEBREW_PREFIX@@`, `@@HOMEBREW_CELLAR@@`,
`@@HOMEBREW_REPOSITORY@@`, `@@HOMEBREW_LIBRARY@@`, `@@HOMEBREW_PERL@@`, and
receipt-selected `@@HOMEBREW_JAVA@@` replacement. The eager composer uses the
same browser-safe relocation implementation.

First use still fetches and verifies the complete unmodified `.tar.gz`; the
content digest and byte count never describe relocated or recompressed bytes.
After decoding and complete source-inventory validation, the runtime requires
its relocation markers to equal the exact receipt list, relocates the shared
regular inode once, preserves every hardlink alias, and only then atomically
commits the group. A missing changed file, unsafe or duplicate receipt path,
retained supported placeholder, unresolved Java dependency, marker mismatch,
or final-size mismatch leaves the whole group pending and retryable. Upstream
receipts may represent an empty `changed_files` list as either `null` or `[]`;
both mean that no archive member is relocated.

The image builder emits an inert schema-5 draft because exact Node and Chromium
evidence does not exist until the eager image has run. The credential-free
release preparer validates that draft, every exact bottle payload, the eager
descriptor, report, and both host evidence files, then closes the public
schema-5 descriptor. Its `deferred_trees[]` contract names a Formula identity,
immutable SHA-256 and byte count, decoder and media type, ordered transport
locations, activation policy, complete source inventory, and complete guest
projection. The closed descriptor also binds
the complete federated tap lock, base and layer package orders, exact
lower-image package receipt and composition, and the separately browser-proven
eager acceptance image and evidence identities. Its own canonical bundle
digest excludes its self-derived tag and release URLs, while retaining release
asset names and any external immutable transport records. A changed base
receipt, package/tap provenance field, tree payload or inventory, or evidence
asset therefore produces a different runtime-layer tag even when the eager VFS
bytes are unchanged.

`--dependency-tap-root owner/tap=/exact/checkout` is repeatable for lower-level
federated planning. The publisher derives these arguments only from the
committed dependency-tap lock and its exact checkouts; callers must not use the
flag to broaden the reviewed source set.

`--shell-config` is optional and is intended for an image whose interactive
shell comes from the selected Homebrew closure. It accepts the bounded,
versioned `/etc/kandelo/shell.json` shape documented in
[Browser Support](browser-support.md#image-owned-default-shells), verifies that
the declared path is an executable regular file no larger than 64 MiB after
composition, and copies the exact reviewed config into the image. The report
binds its SHA-256, byte count, path, and argv; the bounded image metadata
records the same shell
selection and config digest. The option requires `--write-profile`, because a
Homebrew login shell must source the builder-generated
`/etc/profile.d/kandelo-homebrew.sh` rather than start with a browser-hardcoded
Homebrew prefix. The platform base `/etc/profile` sources readable profile
fragments through ordinary POSIX shell syntax.

For example, a Dash shell image can use:

```json
{
  "version": 1,
  "path": "/opt/kandelo/homebrew/bin/dash",
  "argv": ["dash", "-l", "-i"]
}
```

The config is image policy, not package inference: the composer must name the
executable and startup arguments explicitly. The browser remains independent
of the selected Formula and executes the declared VFS path normally. Add
`--write-profile --shell-config /path/to/shell.json` to the builder command
when the Brewfile actually includes that declared shell.

`--demo-config` likewise copies reviewed, image-owned presentation metadata to
`/etc/kandelo/demo.json`; it does not infer UI behavior from Formula names. The
input must be a regular, non-symlink file no larger than 256 KiB, valid UTF-8,
valid JSON, and version 1. The builder validates every profile, including ones
not selected by the current page, refuses to replace an existing image path,
and records the exact byte count and SHA-256 in both the report and bounded
image metadata. This is an exact-byte copy: callers that need a canonical
configuration should track one JSON source rather than regenerate equivalent
JSON in each image builder.

### Dormant Exact-Main Source Bridge

The source bridge described below was activation scaffolding. The canonical
Homebrew shell CI now selects the bottled product, and the Pages publisher
fetches only admitted canonical archives. The implementation remains
temporarily for diagnosis and historical comparison, but no production
workflow invokes it and it cannot satisfy the artifact-lock or public-mirror
gates.

During the ABI 42 activation window, required CI could not consume bottles built
from a pull-request checkout and then call them main-built merely because that
checkout later became an ancestor of `main`. Reachability is useful review
evidence, but it is not producer provenance.

The canonical `packages/registry/shell` recipe is already the strict,
bottle-backed product package. The provisional source lane instead stages the
distinct `homebrew/source-rootfs-shell-package` recipe. It lives outside the
published registry so it cannot silently replace the product package, and its
package name is `source-rootfs-shell` so archive inspection can prove which
recipe ran.

That bridge has one declarative direct dependency contract in
`homebrew/source-rootfs-shell-dependencies.json`; its package manifest,
wrapper, composer, and CI checker consume or validate that same contract
rather than maintaining parallel package lists. Its build script consumes only
resolver-owned dependency directories. The package resolver may download each
dependency's checksum-pinned upstream source through the normal verified-source
path, but the image composer has no tap, OCI, bottle-registry, binary-mirror,
or ambient network fallback.

The composer eagerly replaces the complete `/bin/bash` and `/usr/bin/bash`
lazy hardlink identity with the exact resolved Bash bytes because every shell
boot needs that executable. It preserves rootfs ABI, capacity, and existing
lazy-file/tree identities; adds the required demo executables and complete
shared shell product surface; registers package-owned, integrity-bound Vim and
NetHack archive trees; copies the exact tracked
`homebrew/source-rootfs-shell-default.json` shell selection into
`/etc/kandelo`; and composes the lean
`homebrew/main-shell-demo.json` base with
`homebrew/source-rootfs-shell-demo-profiles.json`. That source-only overlay
repeats the canonical Doom and modeset profiles byte-for-byte for compatibility
with this temporary image, which installs their executables eagerly. The
bottled product instead keeps those same profiles in the canonical demo
configuration and resolves their executable trees lazily. Its browser gate
therefore exercises modeset from the same profile contract as the source
comparison lane.

The rootfs build-time archive recipes migrated by this bridge bind their
direct-build defaults and resolver inputs to package-manifest versions, URLs,
and SHA-256 values, stage through the shared verified-source helper, and keep
mutable work below the caller-owned work root. `posix-utils-lite` selects the
reviewed checkout itself rather than an upstream archive. The rootfs and shell
composers consume only explicit resolver outputs; the resolver graph and the
JSON direct-dependency contract determine the exact closure without another
documentation-maintained list. This closure rule does not imply that every
unrelated registry recipe has already been migrated.

This is activation scaffolding, not the Homebrew endpoint. After producer
changes are on the default branch, rebuild every final bottle from a job whose
actual Kandelo checkout is that exact default-branch `main` SHA and publish
those new identities. The pull-request/rehearsal bottles remain test evidence
only. The canonical shell stays on the strict bottle closure throughout; only
the provisional CI lane uses the source bridge.

The `.github/workflows/homebrew-main-shell-ci.yml` gate is reusable by
package staging and retains the historical branch needed to inspect this
implementation. When
`SHELL_ACTIVATION_MODE` is `source-rootfs`, it
explicitly stages `homebrew/source-rootfs-shell-package`, uses an empty index
and fresh cache, and force-source-builds every buildable node in the exact
current shell closure. It inspects the resulting archive for the distinct
`source-rootfs-shell` identity, installs that exact output, and boots it in
both Node and Chromium. This provisional lane does not relax or skip the
canonical shell's lazy-artifact lock. The separate `bottles` branch also
requires an anonymous live tap-main match and therefore cannot turn a reachable
historical commit into cutover evidence. Its browser materialization traverses
the HTML-owned graphs for the real root shell and private lifecycle pages, then
fetch-only resolves the verified Kandelo package archives those graphs need.
The graph separately binds the locally built kernel and the package-owned
rootfs virtual modules, so neither Vite alias can silently escape the package
projection. Optional `import.meta.glob()` gallery images remain lazy and cannot
trigger an unrelated source build in the shell proof. A missing or stale
required package instead fails immediately as a publication gap. Unrelated
browser-gallery roots can still use the separately verified package generation,
but a before/after regular-file-and-symlink manifest proves they did not replace
any exact-source shell closure bytes. The sealed Chromium proof executes eager
Bash, rootfs-owned lazy `grep`, extended lazy `less`, and integrity-bound Vim
and NetHack lazy archives. In parallel, the general prepare-merge browser shard
uses its already materialized package inputs to run an ordinary optimized
Pages-shaped build before it exposes any closed test mirror. That build keeps
the complete gallery entry set and the `/kandelo/` production base. It catches
production bundling failures without putting the gallery on the focused shell
proof's critical path. This pre-merge shard compiles but never deploys; pull
requests still cannot invoke the Pages publisher.

The Pages publisher remains the full-gallery build gate, but its browser boot
checks the shell route rather than booting every gallery entry. It consumes the
canonical bottled product from a fresh package cache with source fallback
disabled, binds the exact public shell, bootstrap, and mirror plan, and proves
first-use `brew` materialization in Chromium before deployment. It deliberately
does not invoke the internal source bridge or provide that bridge's exact event
repository and SHA, `pages-exact-main-v1` isolation attestation, empty
current-ABI file index, or unmaterialized resolver workspace.

The lane stages and inspects only the distinct bridge recipe before beginning
canonical installation. Before any mutation it verifies the exact GitHub
Actions workflow/job, main checkout, repository, commit, workspace, run
identity, the `${{ runner.environment }}` value `github-hosted`, Linux host,
file index, cache path, and absent materialization paths. Staging uses only
transaction-unique storage under `RUNNER_TEMP`. The public copy uses a verified
same-directory temporary file and atomic rename. A temporary supported
`local-libs` override feeds the pinned generation to transitive image recipes
without invoking the canonical shell recipe. After final closure verification,
the lane removes that override and any exact transient fetched link, rechecks
the published canonical/public bytes, and releases its temporary staging
directory.

This is deliberately not a durable local activation protocol. If preparation
fails or is cancelled, normal GitHub Actions step ordering prevents the build,
Chromium seal, freshness check, and deployment from running, and the failed
GitHub-hosted runner is discarded. The workflow checker rejects self-hosted
runners, `continue-on-error`, command suffixes that swallow preparation
failure, and later failure-status overrides. Cleanup therefore owns only
transaction-unique temporary paths and exact runtime links; it does not
recursively roll back or reinterpret canonical package state. `SIGKILL` or
runner loss can prevent cleanup, but cannot let later deployment steps consume
that partial runner. Ordinary `prepare-browser` remains the independent
bottle-backed path.

Pages intentionally continues to run for every `main` push without a path
filter. The canonical browser package projection and shared inputs can grow;
filtering by a maintained list would allow a new input to change without
superseding the deployed product. The Homebrew main-shell workflow also runs
for every `main` push. For pull requests, staging calls it after the
producer gate. The call passes the exact pull-request identity, whether
package staging was required, and that run's exact release tag. Required
staging validates the public immutable prerelease, its inventory seal,
direct tag, and complete current ledger before freezing the index
locally. It never probes for a latest release or falls back to canonical
bytes. The caller retains the historical required aggregate check and
turns producer failures or unexpected skips into failures. Marking a
draft pull request ready reruns the same ordered path without invoking
close-time staging cleanup.

Pages uses a fresh resolver cache and
`./run.sh --fetch-only prepare-browser`. It verifies the selected shell against
the sealed artifact lock, reads the embedded immutable mirror plan without
eagerly downloading its payloads, and boots the assembled `/kandelo/` tree
through the existing public-transport Chromium acceptance. Missing canonical
archives, a missing public mirror, or any shell/bootstrap/plan identity drift
stops deployment. The source-rootfs bridge cannot stand in for that product
artifact and can be deleted in a later cleanup. The first cutover deliberately
does not wait for the complete public lifecycle. Its Pages job is the
publication gate: it must anonymously recover the canonical product, boot the
exact assembled site in Chromium, keep `brew` deferred until first use, and run
a real in-guest `brew` command. Tap/install/upgrade/remove/reboot and memory-soak
coverage remain independent follow-up work.

### Strict Main-Shell Bottle Closure

`homebrew/main-shell.Brewfile` is the reviewed direct-root contract for the
complete current shell surface. Its 32 roots resolve to an exact 38-Formula
dependency-first closure. `homebrew/main-shell-migration-lock.json` maps every
registry `name@version` to its Formula identity, version, revision, and bottle
rebuild and records every reviewed identity or version substitution. `libcxx`,
Ncurses, and Bash are embedded because every shell boot needs them. The other
35 Formula trees remain independent lazy bottle projections, including
programs with supporting data such as Vim, NetHack, and `file`/libmagic.

The same lock owns the observable compatibility surface rather than relying on
whatever links happen to appear in a bottle. It declares the exact `/bin`,
`/usr/bin`, and `/usr/local/bin` command names, compatibility aliases,
supporting data paths, and image-owned state such as Git defaults and NetHack's
writable playground. The post-archive Node smoke follows every command path,
requires an executable regular file, verifies supporting data and ownership,
and compares all state bytes and metadata. This makes a missing lazy reference
or stale compatibility link fail before browser acceptance.

The shell closure does not by itself claim that `/usr/bin/brew` can run.
`homebrew/main-shell-homebrew-runtime-support.json` declares a second,
first-use atomic layer. It binds the lazy `homebrew-bootstrap` source and
launcher outputs to seven reviewed runtime roots—Ruby, Git, curl, Findutils,
Gawk, Tar, and `posix-utils-lite`—and to their exact 21-Formula
dependency-first closure derived from tap metadata. The complete shell already
supplies 20 of those Formulae, so activation adds only Ruby as an atomic lazy
bottle tree. The complete declared image inventory is therefore 39 Formulae:
three embedded base Formulae, 35 deferred base Formulae, and one deferred
runtime-support Formula. The public bottle mirror transports those 36 deferred
payloads; the three embedded Formulae already reside in the sealed shell image.

The availability audit covers all 25 Formulae considered during the runtime
rollout. Every one now has an admitted public wasm32 ABI-42 identity, including
`libmagic` and `file-formula`; none remains deferred. Bzip2 and Xz are ordinary
members of the complete shell closure even when a narrower `brew` lifecycle
does not touch them.

The audit binds the exact aggregate metadata digest, ABI, release, and catalog
publication commits separately from the immutable bottles' producer commits.
`runtime_bottle_provenance_sha256` hashes an ordered projection of all 25
admitted Formula identities. Each projection entry contains the Formula's full
name, version, revision, rebuild, selected architecture, bottle tag, ABI, URL,
digest, size, cache identity, and complete `built_from` record. This permits an
incremental catalog to reuse unchanged bottles without falsely rewriting their
historical Kandelo commit, while still making the exact mixed-producer cohort a
reviewed value. The v1 hash input is the UTF-8 domain
`kandelo-homebrew-runtime-bottle-provenance-v1` plus one NUL byte, followed by
the compact JSON array in declared cohort order. Compute the candidate digest
with:

```bash
node scripts/check-homebrew-main-shell-brewfile.mjs \
  --print-runtime-bottle-provenance-sha256 \
  /path/to/tap/Kandelo/metadata.json \
  homebrew/main-shell-homebrew-runtime-support.json
```

For every admitted tree the checker requires one successful wasm32 ABI-42
bottle with an exact size, digest, canonical public GHCR URL, and complete
source-provenance identity. An unknown or duplicate cohort member, duplicate
architecture identity, or projection drift fails closed before composition.
The aggregate metadata commits and digest remain independently exact, so the
projection cannot excuse catalog-authority drift. An optional Formula cannot
leak into activation merely because a legacy sidecar exists. The base image
keeps this layer deferred; a derived main-demo image may pre-materialize the
same declared bytes. It may not maintain a second recipe or partial runtime.
The independent canary M4 is intentionally absent from both trusted image
closures and is installed only by the live guest lifecycle.

CI materialization uses the exact public tap checkout pinned in the migration
lock. An explicit SHA is optional, but when supplied it must match the lock:

```bash
scripts/dev-shell.sh bash scripts/build-homebrew-main-shell-closure.sh \
  --tap-root /path/to/exact/homebrew-tap-core \
  --expected-tap-sha <full-sha> \
  --work-dir /path/to/new-exclusive-work-dir
```

The strict composer is the active canonical shell package recipe and remains
directly testable with the exact tap checkout pinned in the migration lock.
The dedicated candidate workflow retains its post-build Node and Chromium
gates. The source bridge above is a separate non-published validation package;
it does not mutate the canonical recipe or its tap binding. Composition scratch
files and downloaded bottles stay in a resolver-owned workspace, only the
declared `shell.vfs.zst` is published, and the post-archive exact-byte runtime
gates remain required. There is no legacy ambient registry-composition
fallback.

The wider browser application also imports service and profile artifacts that
are not part of the shell closure. The workflow derives that supporting set
from browser imports and resolves it with normal package semantics. Those
artifacts remain explicit profile inputs rather than hidden shell-composer
prerequisites.

For local use, `./run.sh build shell-vfs` takes the ordinary resolver path and
materializes the declared output under `local-binaries`. It may reuse a valid
public package archive; before allowing normal source fallback, it prepares
the root `tsx` and `tools/mkrootfs` dependency trees from their committed npm
lockfiles. The explicit `--fetch-only` mode skips those build prerequisites
and continues to refuse source fallback.

Downstream jobs that need those released bytes use the package system rather
than a parallel VFS download convention:

```bash
scripts/dev-shell.sh cargo run --release -p xtask -- \
  materialize-package-output \
  --package packages/registry/shell \
  --arch wasm32 \
  --output-name shell \
  --out target/shell.vfs.zst \
  --receipt target/shell-package-output.json
```

The command computes the exact local recipe cache key, fetches the canonical
index configured by `build.toml`, requires a successful matching ABI, package,
version, revision, architecture, and cache key, then installs the indexed
immutable archive through the normal strict package validator. It extracts only
the declared regular output and emits its verification receipt. It never falls
back to a source build.

The wrapper first builds a platform-only VFS from `MANIFEST` and
`images/rootfs`. It deliberately does not generate or add the
`images/rootfs/PACKAGES.toml` fragment, so legacy package-registry executables
cannot remain as a hidden fallback. It then composes the Brewfile with
`--no-fallback`, a 512 MiB filesystem, the image-owned Homebrew Bash config,
and a verified bottle cache. The catalog lock, public tap checkout, and every
bottle fetch run with GitHub and Homebrew package-token variables removed.
Missing package metadata, unsuccessful bottle
status, missing link sidecars, dependency gaps, digest drift, or a tap checkout
different from the expected SHA fail the build. The tap checkout must also be
clean, including no untracked files, and its metadata must name the canonical
`kandelo-dev/homebrew-tap-core` repository and `kandelo-dev/tap-core` tap.

The selected consumer catalog and each selected bottle have distinct
provenance. The report and image metadata bind the clean catalog checkout's
repository, tap name, and full Git SHA. In strict single-tap mode, every bottle
must independently carry a complete `built_from` record: tap repository and
commit, Kandelo repository and commit, and Formula SHA-256. Those per-bottle
commits are authoritative for historical bottles and need not equal the
aggregate metadata document's last publication commits. Reporting the
aggregate commits as if they built every bottle is rejected. The artifact and
report also bind the exact migration-lock SHA-256 and byte length.

The 512 MiB limit is a consumer contract, not merely builder headroom. It is
recorded in the migration lock, VFS superblock, image metadata, and composition
report. The browser's main-shell and custom-VFS profiles allocate that same
capacity and reject a metadata/superblock mismatch or an image larger than the
profile. Other built-in profiles retain their smaller default unless they use
the shell image.

Homebrew bottles own commands under the Homebrew prefix. To preserve the base
shell's POSIX path surface, the migration lock permits the composer to mirror
only direct `bin/<name>` entries from each verified bottle link manifest into
`/bin` and `/usr/bin`. Reviewed aliases provide `/bin/sh` and `/usr/bin/sh`
from Dash plus the Bzip2 aliases. The reduced closure has no link-conflict
exceptions. The composer does not scan arbitrary bottle files, and it rejects
unowned alias sources, duplicate targets, non-executable sources, or any
collision with a platform/base-image path. The optional runtime-support layer
must apply its own complete reviewed link set atomically when `brew` activates;
its commands cannot appear piecemeal in the base.

The same lock can declare small pieces of consumer-owned runtime state under
`compatibility.runtime_state`. Each entry is guarded by an exact
`requires_package` Formula identity and explicitly declares a normalized
absolute path, `directory`, `empty_file`, or `text_file` kind, mode, uid, gid,
and reviewed reason. Text is limited to 64 KiB. These declarations may not
write under `/etc/kandelo`, under a bottle prefix, or over any platform,
bottle, link, profile, or earlier runtime-state path. Parents must already be
real directories or be declared as directories in the same policy. The report,
guest Homebrew manifest, and bounded image metadata bind every applied entry;
file entries additionally bind their content SHA-256 and byte count. This
mechanism preserves package-conditioned machine state without assigning that
state to a bottle or adding package-name branches to the image builder.
Partial bottle collections own only their package trees and reviewed link
conflict selection. After the base and optional runtime-support trees are
registered, the composer validates and applies aliases, profile links, and
runtime state exactly once against the complete merged package plan. A
base-owned declaration therefore remains valid beside a runtime-support-only
delta, while an owner missing from the final plan still fails closed.

The main-shell composer copies the exact tracked
`homebrew/main-shell-demo.json` bytes into the image. That canonical
configuration contains the shell, Doom, and modeset profiles. The shell reaches
embedded Bash without a download; the Doom and modeset profiles name
independently lazy executable trees, so retaining their presentation metadata
does not materialize either program at boot. The migration lock separately
owns Git defaults and NetHack's writable game state. Additional language
runtimes remain explicit optional layers rather than default-shell contents.
The platform base intentionally does not serialize `/dev`: Node and browser
hosts both mount the authoritative `DeviceFileSystem` at `/dev` and a
shared-memory filesystem at `/dev/shm` during boot.

The wrapper currently selects sidecars with `--runtime node` because older
finalized sidecars predate truthful browser-compatibility recording. That is a
selection compatibility boundary, not browser evidence. A produced image is
not ready to replace the browser main shell until the exact emitted bytes have
booted and exercised the closure in both Node and Chromium. Prefer
`--runtime browser` once every selected bottle sidecar records browser support
from exact-byte browser acceptance.

The base Node and Chromium gates boot the same emitted bytes, reach the
embedded Bash without a download, and fetch selected Formula trees only on
first use. The exact public namespace, supporting data, NetHack state, and
Doom/modeset launch profiles are part of that shell acceptance contract. A
separate lifecycle gate must activate the complete runtime-support layer
before invoking stock `brew`; it then installs first-party Bzip2 and
independent-tap M4 from declared public bytes. Booting the bottle-composed shell
alone is not evidence for the Homebrew lifecycle.

Repeatable `--package <name>` remains available for lower-level tooling and
focused tests. It preserves the provided root order and uses the same planner,
limits, and provenance report. `--package` and `--brewfile` are mutually
exclusive.

The bottle fetcher follows GHCR `WWW-Authenticate` bearer challenges. Public
bottle materializers do not need a GitHub token merely to read public GHCR
blobs.

## Node And Browser Claims

Node and browser support are explicit metadata claims.

The trusted publisher implements an opt-in, tap-selected, dependency-bearing
Brewfile acceptance gate. The tap owns both `Kandelo/vfs-acceptance.json` and
the referenced Brewfile because formula choice and the dependency graph are tap
policy, not Kandelo platform policy. A minimal configuration has this shape:

```json
{
  "schema": 1,
  "formula": "consumer",
  "brewfile": "Kandelo/vfs-acceptance.Brewfile",
  "executable": "/opt/kandelo/homebrew/bin/consumer",
  "argv": ["consumer", "--version"],
  "expected_stdout": "consumer"
}
```

Schema 1 proves the selected executable and dependency closure. Schema 2 adds
one reviewed `shell_config` path inside the same tap:

```json
{
  "schema": 2,
  "formula": "consumer",
  "brewfile": "Kandelo/vfs-acceptance.Brewfile",
  "executable": "/opt/kandelo/homebrew/bin/consumer",
  "argv": ["consumer", "--version"],
  "expected_stdout": "consumer",
  "shell_config": "Kandelo/vfs-acceptance-shell.json"
}
```

The referenced file uses the bounded `/etc/kandelo/shell.json` contract. The
planner requires a regular, non-symlink tap file and a canonical Homebrew
`bin` or `sbin` path. The verifier copies those exact reviewed bytes into the
image, binds the config in the report and image metadata, and requires exactly
one bottle in the selected Brewfile closure to own the linked shell
executable. A base-image shell therefore cannot satisfy this acceptance rung.

After the exact-byte Node and Chromium executable probes, schema 2 also boots
the same composed image through the full browser machine UI. The interactive
shell must start from its VFS path, source the Homebrew profile fragment, and
resolve itself from the Homebrew prefix without downloading the legacy Bash or
Dash assets. The retained browser evidence names the shell path and argv and
records zero legacy-shell downloads.

The acceptance gate parses the static Brewfile, requires at least one real
dependency edge reachable from the selected Formula, and resolves the same
dependency-first plan for Node and browser. Every package must select a current
`success` bottle at the exact public URL
`https://ghcr.io/v2/<repository-owner>/<homebrew-repository>/<formula>/blobs/sha256:<digest>`.
The repository segment retains its `homebrew-` prefix; the canonical Homebrew
tap name used by the Brewfile and sidecars does not.
Last-green fallback, source builds, local bottle substitutions, and Kandelo
package-registry archives are not accepted as package evidence.

The reviewed stdout substring is bounded and single-line so transporting it
through the workflow cannot change the criterion.

This evidence is optional for an ordinary publisher invocation. When the tap
does not contain `Kandelo/vfs-acceptance.json`, the workflow records that no
dependency-closure acceptance evidence was produced and continues with normal
bottle validation. That outcome must not be reported as a green acceptance
rung. A malformed configuration or referenced Brewfile still fails planning
because the tap explicitly opted into an invalid policy file.

A reviewed caller turns the evidence into a required acceptance rung with the
sealed `require-vfs-acceptance: true` workflow input. A required invocation must
be non-dry-run and its actual post-cache matrix must contain the configured
Formula on `wasm32`. If the bottle is already current, the caller must also use
`force: true` so the acceptance target is not filtered out. Planning fails
before build or upload when any of those conditions is missing. The default tap
should enable this input only in the intended acceptance caller after adding
the configuration and Brewfile and after the complete dependency closure is
anonymously readable from GitHub Container Registry (GHCR). Adding this input
does not broaden the current workflow's first-party caller trust boundary.

The gate is not runtime evidence merely because this workflow support exists:
the tap must complete the required Node and Chromium run before the project can
claim that dependency-closure acceptance rung.

This closure-level gate may be the first browser evidence for the selected
bottles. The verifier therefore makes only that in-memory plan provisionally
browser-eligible, records the bottles' original runtime flags, and then requires
the exact composed bytes to run successfully in Chromium. It does not edit the
tap checkout or publish provisional `browser_compatible` claims. The ordinary
builder command uses the declared Node-compatible plan; the Chromium execution,
not a pre-existing metadata flag, is the browser evidence for this acceptance
rung.

The package and platform evidence lanes are intentionally separate during the
migration:

- **Homebrew package inputs:** all Brewfile roots and their dependency closure
  come only from verified tap sidecars and public GHCR bottle bytes.
- **Kandelo platform inputs:** the platform-only base VFS may temporarily come
  from Kandelo's ABI-matched package release, and the verification kernel comes
  from the exact Kandelo workflow source. Their origin, digest, byte count, and
  ABI are recorded separately and never count as migrated package evidence.
- **Lazy lower filesystem:** the exact bottle-built main-shell VFS comes from
  the canonical `shell` package index and verified immutable archive. Its
  package-output receipt and composition are bound into the lazy descriptor.
  It is not the eager acceptance image and is not treated as independent
  evidence for that image's Node or Chromium run.

The Node runner boots the exact composed image bytes and records their digest.
The Chromium runner fetches the same file and passes those bytes directly to
`BrowserKernel.initFromImage`; it does not use the interactive demo setup path,
which may stage utilities and serialize a new image before boot. The browser
test independently checks the composed-image and kernel digests before it
accepts the command result. Formulae other than the selected consumer continue
to publish dependency-first. Publishing the selected consumer fails until its
complete dependency closure is already public; existing single-bottle tests do
not become dependency acceptance evidence.

The Chromium gate captures the Playwright JSON reporter from the inner
`npx playwright` process only. Dev-shell and Nix setup output remains ordinary
workflow log output and never shares the report file. The workflow parses the
complete JSON document and checks its exact pass/fail statistics; it does not
filter mixed stdout or discard setup lines to manufacture a parseable report.

The Node smoke for the published `file-formula` bottle:

```bash
scripts/dev-shell.sh npx tsx packages/registry/file/test/homebrew-node-smoke.ts \
  --result-dir test-runs/homebrew-node-smoke \
  --tap-repository kandelo-dev/homebrew-tap-core
```

It clones or reads the tap, builds a Homebrew VFS from published sidecars, runs
`/opt/kandelo/homebrew/bin/file --version` through `NodeKernelHost`, and
checks negative ABI-mismatch and missing-bottle cases.

Browser compatibility requires a separate browser smoke. For the current
`file-formula` path, the trusted publisher builds a precomposed wasm32 VFS image,
serves it through the browser demo, runs Chromium Playwright against
`apps/browser-demos/test/kandelo-homebrew.spec.ts`, and executes:

```bash
/opt/kandelo/homebrew/bin/file --version
```

Only after that smoke passes may sidecars record
`runtime_support = ["node", "browser"]` and `browser_compatible = true`.
Packages without a successful browser smoke remain Node-only.

The `file-formula` package bytes in this smoke come from the current Homebrew bottle:
from the local build in dry-run mode, or from the anonymously fetched GHCR blob
in write mode. The browser demo still resolves Kandelo-owned ABI platform
prerequisites such as `node.wasm` and `node-vfs.vfs.zst` through Kandelo's normal
binary release. Generic Formula and schema 1 dependency-bearing VFS verification
fetch only the base command set and `rootfs`; their focused Vite input does not
scan the interactive demo. Schema 2 acceptance also boots the image-owned
default shell through the full machine UI, so the selected acceptance matrix
entry materializes the supported interactive graph through
`./run.sh --fetch-only prepare-browser` before that smoke. The `file-formula` gallery
smoke materializes the same graph. Browser preparation excludes packages whose
demos are provided by the external software gallery. Those platform assets are
not the migrated package under test, and unrelated gallery packages are not
bottle verification prerequisites.

## Durable Browser-Proven VFS Releases

A non-dry-run publication with the sealed `require-vfs-acceptance: true` input
promotes the exact accepted wasm32 image and closes its runtime-layer draft only
after the complete verifier matrix and the atomic tap finalizer are green.
Ordinary optional acceptance runs do not publish either release. Both releases
belong to the source tap repository. The eager acceptance release has the
content-addressed tag:

```text
homebrew-vfs-sha256-<full lowercase image SHA-256>
```

Before the first required-acceptance dispatch, a repository administrator must
enable **Settings → Releases → Enable release immutability** for the source tap.
GitHub applies that setting only to future releases. The publisher deliberately
keeps only `contents: write` and cannot preflight the administration-only
setting. Instead, it requires both published release API records to report
`immutable: true` before it emits a success receipt or launch URL. If the
setting was omitted, the run fails loudly and leaves the exact release states
as diagnostic evidence; it does not delete or relabel either release
automatically. Such a release is not an accepted Kandelo product and needs
explicit operator recovery before its content tag can be reused.

The eager acceptance release has exactly these five assets:

```text
kandelo-homebrew.vfs.zst
kandelo-homebrew-vfs.json
kandelo-homebrew-vfs-report.json
kandelo-homebrew-node-evidence.json
kandelo-homebrew-browser-evidence.json
```

The independently identified runtime-layer release has the tag
`homebrew-runtime-layer-sha256-<bundle-sha256>`. It contains one descriptor and
one byte-identical payload asset per deferred bottle:

```text
kandelo-homebrew-<runtime-id>-layer.json
kandelo-homebrew-<tree-id-1>-layer.bin
...
kandelo-homebrew-<tree-id-N>-layer.bin
```

`kandelo-homebrew-vfs.json` is the stable machine-readable entry point. It
binds the exact tap and Kandelo commits, ABI, bottle release tag, selected
Brewfile roots and dependency edges, accepted command, optional image-owned
default shell, and the image and evidence assets' public URLs, SHA-256 digests,
and byte counts. Its
`launch` object has `query_parameter: "vfs"` and a `value` containing the
public image URL. Pass that value through the browser's normal direct-image
path:

```text
?vfs=https://github.com/<owner>/homebrew-<tap>/releases/download/homebrew-vfs-sha256-<sha256>/kandelo-homebrew.vfs.zst
```

`kandelo-homebrew-<runtime-id>-layer.json` is a separate closed schema-5 entry
point for direct bottle content. Keeping it separate preserves the stable
whole-image descriptor contract and gives the runtime layer an identity that
cannot alias a changed base, payload, or inventory merely because the eager VFS
bytes stayed the same. It records mount prefix `/`, the complete federated tap
lock, dependency-first base and layer package orders, exact bottle and
link-manifest provenance, the canonical shell package-output receipt, lower
composition identity, separately browser-proven eager VFS and evidence
identities, and one or more closed `deferred_trees`. Each tree binds activation,
immutable content, ordered transports, and complete inventory independently of
its payload filename.

The canonical runtime bundle hash covers those semantic fields plus the exact
five eager asset identities and every deferred release-asset identity. It omits
only its own digest, derived tag, and self-derived release URLs, so closure is
non-circular. An external immutable HTTPS transport remains in the identity.
The public descriptor is therefore a deterministic envelope around the hash,
and both the credential-free Python validator and the browser-safe TypeScript
consumer recompute it before accepting the layer.
Its `descriptor_encoding` is `canonical-json-v1`: UTF-8 JSON whose object keys
are recursively ordered lexicographically by Unicode scalar value, with compact
`,` and `:` separators, no ASCII-only escaping, and exactly one trailing LF.
Lone UTF-16 surrogates are invalid rather than replacement-encoded. The
publisher and consumer reject any other bytes even
when they parse to the same JSON value. A representation change must introduce
a new encoding identifier, which is itself covered by the bundle hash; this
prevents a serializer upgrade from producing different immutable asset bytes
under an existing runtime tag.

The publisher copies every finalized bottle payload without recompression and
derives the exact asset set from the descriptor. Its release validator opens
every gzip/TAR, validates the complete source inventory, checks every guest
path, type, ownership, materialization provenance, mode, logical size, symlink
target, package/keg/activation binding, and inode group, and verifies TAR hard
links and the complete expanded-byte identity. It rejects an incomplete or
extra package/tree/asset set, undeclared or missing members, cross-keg archive
mappings, ordinary copies whose mode differs from their source, and a shared
lower path unless that path is a directory. The descriptor and every payload
receive authenticated and anonymous digest-and-size readback. The validator
retains the historical one-tree `zip-v1` path so already-published schema-4
layers remain consumable.

The browser host can consume a selected layer through the normal boot
descriptor and VFS path. A `package-layer` mount targets `/` and carries a
bounded descriptor URL, exact descriptor byte count, and lowercase SHA-256
reference. Boot eagerly fetches and validates only those descriptor bytes. It
then restores the exact compressed shell package output into a private
filesystem, binds the schema-5 descriptor to that base, its ABI, and
`/etc/kandelo/homebrew-vfs.json` composition, and rejects base or pairwise
package/path collisions. Only a completely registered selection whose required
boot-prefetch trees have succeeded is returned to boot, so a failed composition
cannot publish a partial namespace. A `first-use` tree remains unfetched through
registration and `stat`. Its first ordinary open/read or executable
resolution starts one deduplicated preparation through the owning VFS mount.
The host tries byte-identical transports in descriptor order, checks the same
declared compressed identity for each attempt, decodes and validates the
entire source inventory, and commits every still-matching regular inode in one
batch. One transport is attempted at most three times. Only HTTP 408, 429, and
5xx responses or recognized fetch/body network interruptions repeat its URL;
the default waits are 250 and 500 milliseconds, and `Retry-After` is honored
up to five seconds. A fetcher may register an `AbortSignal` that is passed into
every attempt; retry waits, mirror fallback, and VFS commit all rethrow its
exact reason. Existing one-argument fetchers retain standard
`AbortError`/`ABORT_ERR` compatibility. Permanent HTTP, integrity, and decoder
failures do not repeat the same URL. Failure leaves all stubs unchanged and
retryable; hard-link names retain one inode and link count. A `boot-prefetch`
tree uses the same path but must
finish successfully before boot returns. Metadata-only directory/symlink trees
retain a group-level activation identity, so serialization cannot silently turn
boot-prefetch into an unverified no-op merely because no regular stub exists.
Materialization fetches the complete declared bottle object; it does not issue
per-file or byte-range requests inside an archive. `stat` and `readdir` use the
trusted inventory without fetching. The first content read, mapping, or exec in
one bottle downloads, verifies, decodes, and atomically materializes that whole
bottle, while every unrelated bottle remains independently deferred.

The direct source inventory and `archive-copy-mode` provenance are additive
deferred-tree metadata. New hosts still accept existing schema-4 ZIP layers and
serialized legacy deferred trees. Older hosts reject a direct descriptor at
its closed-object validation boundary instead of interpreting it under the
legacy one-source-per-guest-entry contract. No syscall, channel, process-memory,
kernel-export, or Wasm program ABI changes as part of this metadata extension;
VFS images remain bound to the same explicit kernel ABI.
Every tree declares one bundle-release transport for its browser-readable
asset and may declare up to seven additional immutable HTTPS locations. This
keeps canonical bottle identity in `content` while allowing Node.js to use a
public GHCR bottle directly and browsers to fall back to a byte-identical
release or same-origin mirror. The direct producer uses one tree per bottle, so
first use fetches that complete bottle without pulling an unrelated runtime or
the rest of the selected closure.

The consumer accepts at most eight selected layers and 512 aggregate
layer-owned packages. Their descriptor byte counts may total at most 16 MiB.
The base image's pending deferred groups plus newly selected trees may total at
most 512 groups, 512 MiB of compressed payloads, 512 MiB of expanded payloads,
512 MiB of guest file payload, and 100,000 combined source-and-guest inventory
entries. Those image-wide budgets are separate from the bounds on one deferred
tree: a single tree may declare at most 256 MiB compressed, 256 MiB expanded,
256 MiB of guest file payload, and 100,000 combined source-and-guest inventory
entries. Every pending group consumes the group budget. A pending generic
deferred tree also consumes the byte and entry budgets declared by its
serialized content and inventories; legacy ZIP metadata does not retain those
aggregate resource claims. The producer, runtime-layer consumer, and MemoryFS
save/import paths use the same typed collection contract, so a composed image
cannot be emitted in a form that its loader would reject. Boot-prefetch
transport uses at most two concurrent workers.
Package names, repository identities, paths, and symlink targets have
independent bounds. Every layer package must own the indexed directory for its
declared keg and the exact indexed symlink for its declared `opt` link.
Schema-5 trees explicitly declare every structural ancestor at or below
`/opt/kandelo/homebrew` as a directory. Keg and in-keg directories are
package-owned `layer` entries; cross-package structural ancestors are
`mergeable-directory` entries. The complete aggregate descriptor may satisfy
an ancestor through any selected bottle tree. An absent mergeable directory is
created once; an existing lower-image directory is reused without changing its
inode or mode, but its permission bits must equal every claim. A file, symlink,
unequal-mode directory claim, or undeclared ancestor fails composition. Legacy
schema-4 `shared-base-directory` entries remain valid only when the directory
already exists in the lower image. Two layers cannot reuse one content digest
or transport URL as separate ownership domains.

An ordinary main-shell descriptor contains no `package-layer` mounts, so it
does not fetch a language descriptor or payload and does not add a default VFS
per language. Selection is explicit machine state, not package-specific UI or
an alternate loader. Malformed paths, oversized descriptors, duplicate layer
identities, ABI/base mismatches, and conflicting layers fail the boot instead
of being skipped. Each runtime-layer reference currently names exactly one
requested root equal to its layer ID; the shared 128-request parser/planner
bound is not a promise that this boot mount composes a multi-root descriptor.
The canonical shell builds its multi-root closure through the
bottle-collection primitive. The bounded collection producer derives
independently lazy, byte-identical bottle trees for a complete reviewed package
closure. The accelerated base-shell policy embeds `libcxx`, `ncurses`, and
Bash and retains the other 35 members of the complete current-shell Formula
closure as independently deferred trees. Additional language runtimes remain
available for optional layers; they are not silently serialized into the
base.

The lazy build keeps materialization code behind its own entrypoint.
`build-homebrew-vfs-image.ts` owns the shared eager planning, metadata, and
serialization path but has no runtime import of the materialization composer.
Only `build-homebrew-materialized-vfs-image.ts` imports and injects that
composer, and `build-homebrew-main-shell-closure.sh` selects this entrypoint
only for an explicit `--lazy-shell` run. The canonical shell wrapper selects
that mode and its `build.toml` declares the complete materialization import
closure. Other eager-image consumers therefore do not acquire lazy-shell code
or cache dependencies merely because they share the planner and serializer.

`homebrew/main-shell-lazy-artifact-lock.json` makes the canonical lazy shell's
outer image identity reviewable rather than merely reporting whatever one
runner produced. Schema 2 has an explicit `pending` state that binds the exact
Brewfile, Homebrew bootstrap source lock and tree recipe, migration lock,
materialization policy, demo configuration, and runtime-support declaration
while refusing every output artifact. The composer also verifies that the
supplied bootstrap ZIP has the exact digest and byte count authorized by that
source lock before it derives the deferred-tree descriptor. Publication may
change the artifact lock to `sealed` only after recording the new compressed
SHA-256 and byte count. The strict composer pins `SOURCE_DATE_EPOCH` to Unix
epoch zero and will not publish while the reviewed identity remains pending.

`homebrew/runtime-layer-policy.json` is the reviewed planning contract for
runtime derivation. It names the canonical `shell` package-output receipt as
the lower image and defines independent `perl`, `python`, and `erlang` package
roots. A per-runtime producer walks only the selected root's verified
dependency closure, excludes package names already owned by the verified lower
shell composition, and requires the root itself to remain layer-owned. The
lazy-layer builder still verifies exact bottle identities before reuse. The
selector rejects an empty delta instead of publishing a no-op layer. When a
federated plan contains all reviewed roots, the all-runtime selector also
rejects any non-base package shared by two runtime deltas; such a dependency
must move into the common base or into an explicit shared-layer design before
the layers have disjoint package ownership.

This selection policy does not add concrete language selections to a default
or gallery descriptor. Language-layer publication and user selection remain
separate follow-ups. Bash and its complete required closure are physically
embedded in the shell artifact rather than deferred or boot-prefetched; Dash
uses first-use delivery, and a `/bin/sh` change requires its own POSIX audit. The
publisher must additionally prove pairwise content-path disjointness; the
consumer independently checks selected descriptors at boot because distinct
package closures alone do not make filesystem overlays safe to mix.

The release publisher never uses `--clobber`. A content-tag state lock
serializes writers. An absent release starts as a draft; an interrupted exact
draft may be completed, while unexpected assets or existing bytes with a
different digest fail closed. GitHub's release-by-tag and Git-ref endpoints do
not expose a draft, so recovery discovers the unique pending tag through the
authenticated, paginated release list and refreshes that draft by its database
ID. Release assets are inventoried through their separately paginated endpoint,
not the release object's potentially truncated embedded list. Once public, the
release is never mutated. Publication creates the tag,
after which it must be a direct commit reference to the exact tap source
commit. Success requires GitHub-enforced release immutability plus anonymous
digest-and-size readback of the acceptance release's exact five assets and the
runtime release's descriptor plus every declared deferred-bottle asset. A new
schema-3 publication receipt records both tags and both independently verified
asset lists. Schema 2 is retained only for the historical one-tree receipt
shape.

`scripts/publish-immutable-github-release.sh` owns that release lifecycle for
both VFS releases and larger bottle mirrors. Its schema-1 inert manifest binds
one canonical lowercase repository, content tag, exact 40-hex tap commit,
title, body, preferred asset-name set, optional complete historical sets, and
one lowercase SHA-256 and byte count per asset. Asset names are unique,
conservative basenames, and the asset directory contains their exact source
files. The validator runs with `GH_TOKEN` and `GITHUB_TOKEN` removed and copies
the verified inputs into a private staging directory before the publisher
checks a credential. The publisher then holds the tag state lock while it
reconciles create, upload, and publish responses, authentically downloads every
complete draft asset immediately before publication, and verifies the
immutable release, direct tag, and every anonymous download afterward. A
caller must pass exactly one Kandelo authority: the exact current
`main` SHA for an ordinary release, or the explicitly contained sealed
source SHA for the prefix campaign. Passing both or neither fails. A
campaign handoff also passes its raw tap source as contained
target-repository authority; the manifest target must equal that source.
Exact and contained target authority are also mutually exclusive.

The credentialed primitive re-reads protected `main` immediately before
each release creation, individual asset upload, direct-tag creation,
and draft-to-public transition. Exact mode fails if `main` advances.
Contained mode fails if the source leaves protected history. In either
case a complete draft may remain for a later authorized run to inspect,
but it is not made public under stale authority. A
failed attempt leaves any older receipt untouched. Success atomically replaces
the receipt with the release ID and every asset's ID, URL, digest, and size.
This same bounded 256-asset contract can carry the production shell mirror's
36 bottle payloads plus its canonical plan without adding a second publication
protocol.

An immutable schema-3 acceptance release may already contain the five eager
assets plus its two historical lazy assets. That exact complete seven-name set
is the only legacy exception: reconciliation verifies all seven current handoff
files byte-for-byte. A partial legacy set, an unknown name, or a mismatched
legacy payload fails; the publisher never fills or rewrites an immutable legacy
release. New acceptance releases always use five assets, and every new closed
schema-5 direct layer uses an independent runtime release containing its
descriptor and exactly one payload per deferred bottle. Historical schema-4
one-tree layers retain their two-asset release shape. The Actions receipt is
only a receipt; release assets are the durable public product.

This promotion proves only the configured dependency-bearing acceptance image.
It does not rewrite bottle `browser_compatible` flags and does not create a
generic software-gallery entry. Promoting arbitrary browser-compatible
Formulae through a durable gallery remains a separate evidence-gated step.

## Browser Gallery Assets

Generate browser gallery assets only from browser-smoked wasm32 metadata:

```bash
scripts/dev-shell.sh bash scripts/homebrew-create-browser-gallery.sh \
  --metadata /path/to/kandelo-homebrew/Kandelo/metadata.json \
  --image target/homebrew-file-formula.vfs.zst \
  --report target/homebrew-file-formula.vfs-report.json \
  --out target/homebrew-gallery \
  --formula file-formula
```

The script writes `gallery.json`, `index.toml`, and a package-source-shaped
`.tar.zst` whose payload is the precomposed `.vfs.zst` image. It refuses
metadata where the wasm32 bottle is not `status = "success"` and
`browser_compatible = true`.

`scripts/validate-software-gallery.mjs` verifies that every gallery entry has
wasm32 success metadata, an `archive_url`, and `browser_compatible = true`.
Launch-time archive failures must remain visible in the Kandelo UI. The trusted
publisher retains these generated files as run diagnostics only. Durable public
gallery publication remains separate from the direct, content-addressed
required-acceptance VFS release above.

## Operational Boundaries

- Do not evaluate Formula Ruby in host or browser VFS tooling.
- Use a disposable Homebrew prefix for local bottle builds. The trusted CI
  runner is disposable; a local run installs the target formula and ordinary
  host build dependencies into the prefix selected by `HOMEBREW_BREW_FILE`.
  Same-tap runtime dependencies must already have matching Kandelo bottles.
- Do not treat a successful bottle build as browser support.
- Do not mark `browser_compatible = true` without browser smoke evidence.
- Do not use Homebrew sidecars to weaken Kandelo ABI or cache-key checks.
- Do not publish user-facing `brew install` instructions until guest Homebrew
  install is validated.
- Do not delete GHCR bottle blobs as the normal recovery path. Prefer marking a
  failed attempt and preserving last-green fallback metadata.
- Publication must compose peer packages and same-identity sibling-architecture
  bottle tags from refreshed tap state while holding the tap lock. Stale-source
  and same-identity child-replacement transitions for explicitly forced,
  unfinalized partial indexes discard all old sibling tags before publishing
  the selected architecture. Accepted identities require a bottle rebuild
  instead. Formula source changes after
  planning, noncanonical bottle
  blocks, required shared Formula-support changes, Formula root/tag/digest
  disagreement with the tap sidecars, or symlinks in refreshed `Formula/` and
  `Kandelo/` state must fail publication; a global lock alone does not make
  stale aggregate sidecars safe.
- Do not publish a new formula's tap metadata until its repository-rooted GHCR
  package passes anonymous digest readback. Production package writes use only
  the caller repository's scoped built-in `GITHUB_TOKEN` (`github.token`); the
  workflow accepts no package PAT and performs no visibility mutation.
- Do not bump `build.toml` revisions for docs-only changes.

## Public Package Creation And Legacy Namespace Retirement

### Normal public publication

The canonical Homebrew tap name and the GitHub repository name are deliberately
different identities:

- Formula references, OCI titles, and sidecar tap fields use the canonical tap
  name `kandelo-dev/tap-core`.
- GHCR transport uses the exact public repository name, including its
  `homebrew-` prefix:
  `ghcr.io/kandelo-dev/homebrew-tap-core/<formula>`.

This is a repository rule, not a first-party naming exception. A public
third-party repository `<owner>/homebrew-<repo>` has canonical tap name
`<owner>/<repo>`, while its bottles publish below
`ghcr.io/<owner>/homebrew-<repo>/<formula>`. For example, tap
`brandonpayton/kandelo-canary` publishes `m4` as registry repository
`ghcr.io/brandonpayton/homebrew-kandelo-canary/m4`.

GitHub's package page may render only the final component, such as `zlib` or
`m4`. That short display label does not change the package API name
`<homebrew-repository>/<formula>` or its registry path. The first-party
`zlib` API name is `homebrew-tap-core/zlib`; the third-party example's `m4`
API name is `homebrew-kandelo-canary/m4`.

Do not derive the GHCR path from the canonical tap name. The earlier
`ghcr.io/kandelo-dev/tap-core/<formula>` destination created private packages
even when the package was linked to the public `kandelo-dev/homebrew-tap-core`
repository.

Normal production publication has the following contract:

1. The caller runs from the public tap repository's protected default branch
   with `packages: write` and passes its built-in `GITHUB_TOKEN` to the reviewed
   reusable publisher. For the first-party tap that repository is
   `Kandelo-dev/homebrew-tap-core@main`. A PAT is not a production input.
2. The publisher derives, rather than accepts, the repository-rooted GHCR
   destination.
3. Before the first push, the OCI index records
   `org.opencontainers.image.source=https://github.com/<owner>/<repository>`
   for that exact public caller repository. That connects the package to the
   source repository at creation time.
4. An organization owner permits members to create public packages and keeps
   **Inherit access from source repository** enabled. The separate **Private**
   package-creation checkbox may remain enabled; it grants permission to create
   private packages and does not force this publisher's packages to be private.
   A user-owned tap has no organization package-creation policy to configure,
   but still needs the same public source repository, repository-rooted
   destination, and exact source annotation.
5. A write publication anonymously reads the exact uploaded digest and verifies
   its SHA-256 and byte count before Formula or sidecar state can be finalized.
   A private package therefore fails publication instead of becoming live tap
   state.

[GitHub documents repository inheritance](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility#about-inheritance-of-access-permissions)
primarily as an access-permission contract and does not promise that repository
visibility is inherited in every GHCR creation path. Repository-rooted public
creation is therefore an observed Kandelo transport dependency, not an
unchecked assumption. The one-shot
[canary run 29652866481](https://github.com/Kandelo-dev/homebrew-tap-core/actions/runs/29652866481)
created public, repository-linked package `homebrew-tap-core/zlib`; earlier
`tap-core/*` controls created with both a `GITHUB_TOKEN` and a package PAT
remained private. The production anonymous readback is the continuing guard
against a GitHub behavior or organization policy change.

The independent, user-owned
[third-party canary run 29783196350](https://github.com/brandonpayton/homebrew-kandelo-canary/actions/runs/29783196350)
used the same built-in-token path and created public, repository-linked package
`homebrew-kandelo-canary/m4` (GitHub package ID `13494393`). Its anonymous
bottle verification, tap finalization, Node and Chromium VFS acceptance, and
immutable VFS release publication all passed. This demonstrates that
public-by-default creation does not depend on a `Kandelo-dev`-specific policy
exception.

### New tap bootstrap checklist

Use this checklist once for each new public tap repository:

1. Name the public GitHub repository `homebrew-<repo>` and protect its default
   branch. Record its canonical Homebrew name as `<owner>/<repo>`.
2. For an organization-owned repository, allow public package creation and
   enable source-repository access inheritance. It is not necessary to disable
   permission to create private packages.
3. Install the reviewed dispatch caller on the protected branch. Grant the
   caller `actions: read`, `contents: write`, and `packages: write`; the reusable
   publisher narrows those permissions per job.
4. Pass the exact caller repository as `tap-repository` and the canonical tap
   name as `tap-name`. Every write dispatch must record both the exact current
   Kandelo `main` commit as lowercase `kandelo_sha` and the reviewed protected
   tap-main commit as lowercase `tap_sha`. Do not pass a bottle root: the
   publisher must derive
   `https://ghcr.io/v2/<owner>/<homebrew-repository>`.
5. Use only the caller's built-in `GITHUB_TOKEN`. Do not configure
   `HOMEBREW_GITHUB_PACKAGES_TOKEN`, a package PAT, or a package-visibility API
   call for the production publisher.
6. Publish one Formula, then require the complete post-publication acceptance
   below. In particular, inspect the package API record and anonymously import
   the exact public index before treating the tap as ready for a wider rollout.

For an organization-owned package, query
`orgs/<owner>/packages/container/<url-encoded-package-name>`. For a user-owned
package, query
`users/<owner>/packages/container/<url-encoded-package-name>`. In both cases the
record must say `visibility: public` and link to the exact source repository;
the registry readback must still run without GitHub credentials.

### Post-publication acceptance

Apply this acceptance gate to every normal production rollout dispatched with
`publish-kandelo-bottles`. Maintenance rebuilds have a separate caller and job
prefix. For a single-formula wasm32 publication, every instance in this exact
normal-publication job set must conclude successfully:

- `publish / plan`
- `publish / build-and-test (<formula>, wasm32)`
- `publish / upload-bottle (<formula>, wasm32)`
- `publish / publish-bottle-index (<formula>)`
- `publish / verify-bottle (<formula>, wasm32)`
- `publish / finalize-tap`

For a multi-architecture publication, require every architecture-specific
build, upload, and verifier matrix instance as well as each Formula-level index
job and the single atomic finalizer. A finalizer that
successfully writes a failure report still concludes as a failed job and does
not satisfy this gate.

Use two acceptance levels for a prefix campaign. Each Formula and
architecture deliberately omits `finalize-tap` and
`publish-vfs-release`. Its bottle becomes independently usable after
build, upload, anonymous index readback, and verification all succeed.
The immutable `homebrew-prefix-handoff-sha256-<handoff-sha256>` release
must also exist. A failed sibling does not invalidate that successful
bottle.

A consumer must still select one complete same-architecture dependency
closure. That selected closure is the atomic composition unit: a missing
dependency makes the selection fail without hiding unrelated successful
bottles. The separate named full-tap or prefix activation waits for the
complete campaign candidate and one atomic final pointer update.

The workflow pins Kandelo source at planning time, while browser-graph package
resolution reads the canonical ABI package index later in the run. If another
merged change activates package archives between those steps, fetch-only
resolution can reject the new index against the older pinned source. Treat that
as a failed run and retry after activation settles. Do not use `--allow-stale`
or omit browser verification to turn the mixed snapshot into an acceptance.

Then validate a clean checkout of live tap `main`, verify the GitHub package is
public and linked to the exact public repository, and anonymously import the
complete live Homebrew index. Run the following from the Kandelo repository
root, selecting the Formula being accepted. The package-record query uses the
operator's GitHub CLI identity; the index import explicitly removes those
credentials:

```bash
set -euo pipefail

formula=zlib
acceptance_root="$(mktemp -d)"
trap 'rm -rf "$acceptance_root"' EXIT

git clone --branch main --single-branch \
  https://github.com/Kandelo-dev/homebrew-tap-core.git \
  "$acceptance_root/tap"

bash scripts/dev-shell.sh cargo xtask homebrew-validate \
  --tap-root "$acceptance_root/tap"

gh api \
  "orgs/Kandelo-dev/packages/container/homebrew-tap-core%2F${formula}" |
  jq -e '
    .visibility == "public" and
    (.repository.full_name | ascii_downcase) ==
      "kandelo-dev/homebrew-tap-core"
  '

formula_metadata="$acceptance_root/tap/Kandelo/formula/${formula}.json"
top_reference="$(
  jq -er '
    if .bottle_rebuild == 0 then
      .version
    else
      "\(.version)-\(.bottle_rebuild)"
    end
  ' "$formula_metadata"
)"
printf '{"auths":{}}\n' >"$acceptance_root/anonymous-registry.json"

env -u GH_TOKEN -u GITHUB_TOKEN -u HOMEBREW_GITHUB_API_TOKEN \
  -u HOMEBREW_GITHUB_PACKAGES_TOKEN \
  -u HOMEBREW_DOCKER_REGISTRY_TOKEN \
  bash scripts/dev-shell.sh python3 \
    scripts/homebrew-oci-layout.py import-public-index \
    --remote "ghcr.io/kandelo-dev/homebrew-tap-core/${formula}" \
    --reference "$top_reference" \
    --registry-config "$acceptance_root/anonymous-registry.json" \
    --out-layout "$acceptance_root/public-index" \
    --out-result "$acceptance_root/public-index-result.json"

jq -e --arg layout "$acceptance_root/public-index" '
  keys == ["digest", "layout", "schema", "status"] and
  .schema == 1 and
  .status == "present" and
  .layout == $layout and
  (.digest | test("^sha256:[0-9a-f]{64}$"))
' "$acceptance_root/public-index-result.json"
```

`import-public-index` validates the bounded top index, child manifests,
configuration, and bottle layers by digest before reporting `present`. The
empty registry configuration plus removed credential variables ensures this is
public-read evidence rather than an authenticated package fetch. Repeat the
gate independently for every Formula selected by a rollout.

### One-time retirement of `tap-core/*`

The two legacy private controls are not production bottle locations:

| Package API name          | State on 2026-07-18                                                          | Purpose                                                                |
| ------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `tap-core/zlib`           | private; last updated `2026-07-18T03:46:46Z`                                 | old-root creation control                                              |
| `tap-core/bzip2`          | private; last updated `2026-07-18T05:20:07Z`                                 | old-root creation control                                              |
| `homebrew-tap-core/zlib`  | public; created by canary run `29652866481`                                  | repository-rooted positive control and production destination          |
| `homebrew-tap-core/bzip2` | public and repository-linked; created by failed production run `29660666019` | fresh-package child-upload proof; full production pilot still required |

[Run `29660666019`](https://github.com/Kandelo-dev/homebrew-tap-core/actions/runs/29660666019)
was a partial success, not a completed bzip2 pilot. Its `plan`,
`build-and-test`, and `upload-bottle` jobs succeeded. The upload created the
previously absent package with public, source-repository-linked access and
completed anonymous readback of the immutable child. The
`publish-bottle-index` job then failed because its downloaded artifact layout
was not discovered, so `verify-bottle` was skipped and `finalize-tap` recorded
a failed attempt. That run proves fresh public child-package creation through
the normal production credential path, but it does not prove the complete
publication path. A later bzip2 pilot is therefore a retry against an existing
public package, not another fresh-package test.

Do not delete the two private controls merely because the public zlib canary
passed. Keep them until all of these cutover gates are satisfied:

1. The repository-rooted publisher is merged to `Automattic/kandelo@main`, and
   the matching caller and trust-generation changes are merged to
   `Kandelo-dev/homebrew-tap-core@main`.
2. A zlib production pilot completes the full path against the existing public
   `homebrew-tap-core/zlib` package.
3. A separate bzip2 production pilot completes the full path against the public
   `homebrew-tap-core/bzip2` package created by the partial run above. The
   earlier child upload is the fresh-package creation proof; the retry must
   prove index publication, verification, and tap finalization.
4. Both package records report `visibility: public` and repository
   `kandelo-dev/homebrew-tap-core`, and both successful workflow receipts contain
   the exact credential-free digest readback evidence.
5. The live Formulae and generated sidecars validate and contain only the
   repository-rooted GHCR destination. Historical failure and rollback reports
   may retain old URLs as audit evidence.
6. The two legacy package `updated_at` values still equal the baselines in the
   table. A changed timestamp means some writer still targets the old namespace
   and must be investigated before deletion.

Dispatch the pilots concurrently as two separate calls through the reviewed
tap caller. Their builds and package writes are independent, and the tap-wide
lock serializes their final tap updates. Do not open the broader rollout gate
until both pilots have completed the post-publication acceptance above.

```bash
gh api --method POST \
  'repos/Kandelo-dev/homebrew-tap-core/dispatches' --input - <<'JSON'
{
  "event_type": "publish-kandelo-bottles",
  "client_payload": {
    "kandelo_sha": "<exact-current-Automattic-kandelo-main-sha>",
    "tap_sha": "<exact-reviewed-protected-main-sha>",
    "formulae": "zlib",
    "arches": "wasm32"
  }
}
JSON

gh api --method POST \
  'repos/Kandelo-dev/homebrew-tap-core/dispatches' --input - <<'JSON'
{
  "event_type": "publish-kandelo-bottles",
  "client_payload": {
    "kandelo_sha": "<the-same-exact-current-Automattic-kandelo-main-sha>",
    "tap_sha": "<the-same-exact-reviewed-protected-main-sha>",
    "formulae": "bzip2",
    "arches": "wasm32"
  }
}
JSON
```

Inventory the four exact package objects with an organization/package-admin
GitHub CLI identity. A slash inside a package name is `%2F`-encoded in the REST
path:

```bash
gh api 'orgs/Kandelo-dev/packages/container/tap-core%2Fzlib' \
  --jq '{name,visibility,repository:(.repository.full_name // null),created_at,updated_at,version_count}'
gh api 'orgs/Kandelo-dev/packages/container/tap-core%2Fbzip2' \
  --jq '{name,visibility,repository:(.repository.full_name // null),created_at,updated_at,version_count}'
gh api 'orgs/Kandelo-dev/packages/container/homebrew-tap-core%2Fzlib' \
  --jq '{name,visibility,repository:(.repository.full_name // null),created_at,updated_at,version_count}'
gh api 'orgs/Kandelo-dev/packages/container/homebrew-tap-core%2Fbzip2' \
  --jq '{name,visibility,repository:(.repository.full_name // null),created_at,updated_at,version_count}'
```

Before deletion, attach those records, the legacy version inventory, and the
two successful production run URLs to the cleanup issue:

```bash
gh api --paginate \
  'orgs/Kandelo-dev/packages/container/tap-core%2Fzlib/versions?per_page=100'
gh api --paginate \
  'orgs/Kandelo-dev/packages/container/tap-core%2Fbzip2/versions?per_page=100'
```

In a clean checkout of live tap `main`, require no active old-root matches and
validate the repository-rooted Formula and sidecar state:

```bash
rg -n 'ghcr\.io(?:/v2)?/kandelo-dev/tap-core' \
  Formula Kandelo .github -g '!Kandelo/reports/**'
# Expected: no matches.

rg -n 'https://ghcr\.io/v2/kandelo-dev/homebrew-tap-core' \
  Formula Kandelo -g '!Kandelo/reports/**'
# Expected: the successful zlib and bzip2 Formula/sidecar references.

/path/to/kandelo/scripts/dev-shell.sh cargo xtask homebrew-validate \
  --tap-root "$PWD"
```

Once every gate passes, delete only the two exact legacy package objects. This
is destructive and requires package-admin access. A classic PAT used by `gh`
needs `read:packages` and `delete:packages`; the package settings **Danger
Zone** is the UI alternative.

```bash
gh api --method DELETE \
  'orgs/Kandelo-dev/packages/container/tap-core%2Fzlib'
gh api --method DELETE \
  'orgs/Kandelo-dev/packages/container/tap-core%2Fbzip2'
```

Do not delete either `homebrew-tap-core/*` package. Re-run the inventory after
deletion: both `tap-core/*` requests must return `404 Package not found`, both
`homebrew-tap-core/*` records must still be public and repository-linked, and
the live tap validator must still pass. Preserve historical tap reports; they
are audit records and do not depend on the package objects remaining present.

[GitHub permits restoration for 30 days](https://docs.github.com/en/packages/learn-github-packages/deleting-and-restoring-a-package#restoring-packages)
only while the deleted package namespace and versions have not been reused. If
cleanup was mistaken, first stop any stale old-root publisher and restore
immediately with an organization/package admin identity. A classic PAT needs
`read:packages` and `write:packages` for the
[restore endpoint](https://docs.github.com/en/rest/packages/packages#restore-a-package-for-an-organization):

```bash
gh api --method POST \
  'orgs/Kandelo-dev/packages/container/tap-core%2Fzlib/restore'
gh api --method POST \
  'orgs/Kandelo-dev/packages/container/tap-core%2Fbzip2/restore'
```

Deleting these never-live migration controls is a one-time namespace cleanup,
not the normal rollback mechanism. For a package represented by current or
last-green tap state, retain the immutable bottle and use the maintenance
rollback path instead.

## Current Gaps

The implemented path covers a trusted bottle build, public repository-rooted
GHCR package creation plus anonymous readback, sidecar validation, verified VFS
image building, exact canonical package materialization of the bottle-built
main shell, per-Formula original-bottle deferred-tree production, Node and
synthetic direct-TAR Chromium first-use validation, immutable multi-payload
runtime-layer publication, receipt-owned Homebrew text relocation without
changing original-bottle identity, diagnostic gallery gating, and lossless
under-lock tap composition with Formula source-closure drift rejection. The
optional language-layer fixtures define isolated normal-path acceptance cases
for Python, Perl, Erlang, and Ruby, but they are not members of the default
main-shell image and do not by themselves constitute public release evidence.
Cutting over and republishing the production main shell with its Bash closure
embedded and the remaining closure deferred, live public-release browser
retrieval through the service-worker transport, durable generic gallery
publication, broader package coverage, general guest `brew install`, and
broader release/gallery operator runbooks remain separate work.
