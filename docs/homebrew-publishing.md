# Homebrew Publishing

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
or building bottles, but a PR's `pr-<N>-staging` release is never a durable
input. After coherent canonical activation has landed, dispatch
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
does not contain the target Formula's output bottle. This lane accepts only
write publication, exactly `wasm32`, and no dependency-bearing VFS acceptance.
Dry runs are rejected until the exact public generation can be materialized
without exposing a repository token to branch-selected source.

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
canonical Linuxbrew prefix while running a separate patched repository
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

The supported prefix and cellar are:

```text
/home/linuxbrew/.linuxbrew
/home/linuxbrew/.linuxbrew/Cellar
```

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
   `/home/linuxbrew/.linuxbrew` and
   `/home/linuxbrew/.linuxbrew/Cellar`.
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

The supervisor implementation is admitted only from the exact root-owned,
manifest-sealed Kandelo tooling projection. The launcher records that source's
state and digest, copies it into a separate root-owned executable inode,
compares the source and destination before the first privileged execution, and
rechecks the executable afterward. An independent checkout path is not a
second source of privileged runner code.

The host `/`, workflow checkout, credentials, and host service-manager sockets
are absent rather than merely read-only. `/etc` and `/tmp` are private service
filesystems. The supervisor tears down the complete control group, proves the
recipe UID owns no process, validates the output without following unsafe
nodes, and returns only a root-owned sealed output tree. The Linux isolation
test executes a malicious recipe that probes an unrelated host sentinel and
tries to start another systemd unit; both paths must fail while declared inputs
and output still work.

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
Putting both packages in `/home/linuxbrew/.linuxbrew/Cellar/bzip2` makes
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
`4ead8619231cb15cbe15e8e8188081e347d6f7cd` through the dedicated
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

The Node.js and Chromium lifecycle runners use the same generated guest
scripts and host-neutral phase runner. They tap exact first- and third-party
revisions, prove each tap remains discoverable as untrusted, and retain only
the Formula-level trust that stock Homebrew creates for fully qualified
operations or grants through `brew trust --formula`. The six-Formula image
base is direct-composed rather than poured: its Bzip2, first-party M4, and Dash
receipts must remain `built_as_bottle: true` and
`poured_from_bottle: false`. The lifecycle explicitly trusts the already-pinned
first-party Dash dependency without trusting its tap, then installs and
reinstalls first-party Bzip2 and independent canary M4 through stock Homebrew.
Both M4 receipts must bind Dash while Dash retains its truthful precomposed
receipt.

After exporting and rebooting the rootfs, both hosts recheck that narrow trust
before any Formula-evaluating operation can recreate it. They execute the
persisted packages, prove the pinned upgrade is a no-op, uninstall, revoke the
selected item trust, untap, and verify no selected-tap authority remains. A
browser fixture only supplies host transport identities; it cannot replace or
weaken those guest assertions.

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
`main`. The caller pins one reviewed Kandelo `Mpre` SHA in both `uses:` and the
`kandelo-ref` input and supplies exact final bottle-catalog `TF` and canary `C`
identities. The caller's own `${{ github.sha }}` is the later tap publication
authority `TA`; event data cannot select it. The reusable workflow anonymously
rechecks Kandelo `Mpre`, tap `TA`, and canary `C` as the three public main
heads, proves `TF` is an ancestor of `TA`, and requires the shell revision,
structured package Git input, catalog locks, runtime-support cohort, and sealed
artifact lock to agree with `TF` before preparing any bytes.

Preparation resolves the public shell generation into a fresh cache, verifies
the main-shell artifact lock, and anonymously recovers the exact bottle set
declared by the embedded mirror plan. The only inter-job transfer is a
one-day, same-run artifact with an exact manifest, bounded inventory and byte
count, shell/bootstrap identities, publication manifest, and mirror payloads.
No PAT, GitHub App token, cross-repository workflow artifact, run ID, or
caller-selected artifact repository participates in that handoff.

Only the publication job receives `contents: write`. It uses the tap caller's
own `GITHUB_TOKEN`, rechecks both live Kandelo and tap authority immediately
before every release, tag, or asset write, and calls
`scripts/publish-immutable-github-release.sh` with exact `Mpre` and live `TA`.
The immutable release targets `TA`. The sealed shell locks, guest manifest,
recovery report, and bounded handoff retain `TF` as the bottle catalog that
owns every recovered payload; the embedded mirror plan is intentionally a
content identity for the payload set, not a second catalog lock. Keeping these
identities separate avoids the impossible cycle in which Kandelo `Mpre` would
need to contain the SHA of a tap caller that itself pins `Mpre`.
The publisher rejects a manifest whose target commit differs from live `TA`,
publishes seal-last, and anonymously rehashes the resulting immutable release.
A dependent read-only job then resolves the public package generation again,
installs from exact product catalog `TF`, requires `TA` to remain public tap
main, and proves the public mirror in both the Node guest lifecycle and
Chromium; the closed-acceptance filesystem root must be absent.

The schema-1 tag is content-addressed from bottle payloads, while an immutable
release also records the `TA` that created it. The current publisher therefore
fails closed if a later `TA` tries to publish an already-existing collection
tag; it does not claim that the older release belongs to the new authority.
For an unchanged bottle collection, retain and consume the already-proven
public mirror rather than redispatching publication from a new tap commit.
Ancestor-checked reuse by a later authority is a separate, not-yet-implemented
workflow mode.

The tap caller intentionally carries the clearly marked
`__FINAL_KANDELO_MPRE_SHA__` and `__FINAL_TAP_CATALOG_SHA__` placeholders while
these two branches are under review. It is not dispatchable release authority
until both are replaced with the final 40-character Kandelo and catalog
commits and the tap trust contract is rerun. `TA` is then derived from the
protected caller commit rather than substituted into its own bytes. This
public-mirror lane is independent of the existing Bash bottle caller and its
frozen workflow digest.

The checked-in `9820ef5643dc50f5876e53a1bbf6a309fc62f9a7` first-party tap value is the final shell
catalog authority. The shell recipe remains `UNPUBLISHED` so archive staging
can substitute the exact landed Kandelo commit, while
`publication_state = "ready"` admits that normal exact-main path. The lazy
artifact lock independently rejects every output while its identity is pending;
final review must seal the deterministic compressed digest and size before
publication. Exact-live-main equality remains necessary authority, not
sufficient release evidence: the exact-Mpre rebuild and closed first- and
third-party lifecycle proof are still required.

Pull-request, push, and public/manual runs remain on the exact source-rootfs
acceptance path. Only a manual closed dispatch selects the bottled product
lane. Before either host creates live lifecycle evidence, that lane requires
the candidate's bootstrap recipe and composition report to bind the exact
atomic runtime-support cohort; the six-Formula base alone is not accepted as a
`brew` runtime. It then invokes the Node lifecycle runner and creates the
Chromium fixture from the same candidate image, bootstrap
spec/archive/environment, and recovered bottle mirror.

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

After those checks, the publisher makes the complete native prefix root-owned
and read-only. The target build can read that sealed prefix, but only each
planned direct dependency's selected keg is copied into a root-owned, read-only
proxy under the canonical target Cellar. Its target `opt` link points to that
real target keg. Homebrew requires a keg's grandparent to resolve to the active
Cellar, so a rack symlink into the native prefix is not a valid substitute.
If that direct keg contains a relative link into its recursive native closure,
the publisher rewrites the copied link to the exact resolved path in the sealed
native prefix. This preserves host tools whose launchers are supplied by another
keg without copying or exposing that transitive keg in the target Cellar.
Unselected keg versions and native transitive dependencies stay in the native
prefix and cannot claim target Cellar names. Native install logs remain
separate from Kandelo bottle dependency provenance.

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
the target tap repository. Non-dry calls may come from `publish-bottles.yml` or
`maintain-bottles.yml`; dry calls must come from `dry-run-bottles.yml`. The
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

Kandelo has a stricter source rule: `kandelo_sha` must equal the commit named by
`Automattic/kandelo`'s live `refs/heads/main`, not merely an ancestor, an
equal-tree commit, a tag target, or a pull-request head. The planner queries
that ref before checkout and verifies the resulting checkout. Every
credentialed bottle, version-index, tap-state, failure-report, and immutable
VFS mutation queries the ref again immediately before writing. If `main`
advances during a run, the next mutation fails closed; run-scoped build
handoffs do not authorize publication from the now-stale source.

The payload SHA is intentionally distinct from `github.sha`.
`repository_dispatch` may be admitted while protected `main` is at one commit
but instantiated after another publication advances it. Recording the source
commit in the request keeps the older dispatch reproducible without
authorizing a detached or force-pushed source. Maintenance rebuild dispatches
use the same exact source contract. Rollback does not consume `tap_sha`; it
refreshes and mutates the current protected branch under the tap-wide state
lock.

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
reuse an older bottle. Historical reuse needs its own content-bound
`validated_against_main` evidence proving that historical build producer
remains admissible for current `M`; top-level metadata from a newer run cannot
make an older architecture current. That broader historical-reuse receipt is a
follow-up and does not change the actual producer of a newly compiled bottle.

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

The repository-namespace visibility canary was a separate, one-shot transport
path used to select the production bottle-root contract. Its exact reviewed caller
on `Kandelo-dev/homebrew-tap-core@main` receives only the caller repository's
`github.token` and passes no package PAT secret. The canary downloads the
immutable zlib OCI child produced by Actions run `29628202419`, artifact
`homebrew-oci-child-zlib-wasm32-attempt-1`, and revalidates its pinned source,
bottle, and manifest digests. That layout retains the canonical Homebrew tap
identity and the original control bytes; only its registry transport
destination changed from `ghcr.io/kandelo-dev/tap-core/zlib` to
`ghcr.io/kandelo-dev/homebrew-tap-core/zlib`. The uploader derives that
alternate destination from the already validated tap repository rather than
accepting a URL.

To prove first-package creation rather than reuse of existing public state, the
canary authenticates only long enough to require that the destination package
repository itself is absent before copying the child. It then retires the
credential state and requires an anonymous readback of the exact manifest
digest. PAT or automatic auth, dry-run or index uploads, third-party tap
repositories, pre-existing destination packages, and non-public readback all
fail closed. The canary stops after the immutable child upload: it does not
publish the mutable version index, verify a release, edit Formulae, generate
sidecars, or record a tap failure report. Run `29652866481` created
`homebrew-tap-core/zlib` as a public package linked to the public
`kandelo-dev/homebrew-tap-core` source repository, and its credential-free
readback matched the pinned manifest digest. Earlier `GITHUB_TOKEN` and PAT
uploads under `tap-core/*` both created private packages. Normal publication
therefore uses the exact repository-rooted namespace and the scoped
`github.token`; no visibility mutation or PAT is part of the production path.

After a read-only planning job resolves the immutable Kandelo commit, tap
commit, ABI namespace, derived bottle root, and formula matrix, each
`(formula, arch)` entry crosses five separate runner roles. OCI child uploads
remain architecture-parallel. The mutable Homebrew version index is serialized
only per `(tap, formula)`, so unrelated Formulae retain parallel throughput:

1. `build-and-test` is read-only. It checks out the exact inputs and reviewed
   Homebrew/brew commit, and exposes the patched temporary Homebrew worktree
   through a root-owned launcher under the canonical
   `/home/linuxbrew/.linuxbrew` target prefix. Native host dependencies use a
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
   one root-owned, single-link, exact-`0555` inode, rechecks the source and
   copy, bind-mounts that inode over the checkout's release path, and verifies
   its exact inode and bytes both at each command entry and at final isolation
   verification. Because Homebrew reconstructs the ordinary
   environment when it re-enters a Formula test, the launcher carries this
   exact path across that boundary as `HOMEBREW_KANDELO_XTASK_BIN`. Tap support
   validates and freezes the value while loading the trusted support module,
   then translates only that frozen value to `WASM_POSIX_XTASK_BIN` for the
   Node or Chromium resolver child. The resolver invokes that checker with the
   authenticated read-only Kandelo alias as the narrowly scoped
   `build-deps program-index-context-check --source-repo-root` argument. This
   matters because a relocated executable still contains its compile-time
   checkout path: the explicit root makes global toolchain files, fork-tool
   Cargo metadata, and repo-relative package inputs all come from the same
   protected source projection. The option rejects relative, noncanonical, or
   incomplete roots and is invalid for every other `build-deps` subcommand.
   Global and fork-tool digest memoization is keyed by that exact root; the
   publisher's read-only alias and one-shot checker process keep a selected
   root immutable for the command.
   Caller-selected checker paths and ambient repository-root overrides are
   neither preserved nor trusted.
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
   `packages: write`. On a fresh runner it validates the strict build handoff
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
   private-state disambiguation during ordinary publication. The one-shot
   repository-namespace canary is stricter: it always requires an authenticated
   missing-repository result so an existing public package with a new tag cannot
   produce a false positive. The uploader copies only the validated child
   layout to its content-derived tag. Immediately before that credentialed
   `oras cp`, the transport itself re-reads `Automattic/kandelo`'s protected
   `main` ref and requires it to equal the explicit publication SHA; an earlier
   workflow check cannot authorize a copy after `main` advances. The uploader
   retires the isolated ORAS authentication state and requires an anonymous
   exact-digest readback. Its only output is a
   strict data receipt binding the canonical layout receipt to that public
   readback.
3. `publish-bottle-index` receives `packages: write` once per Formula. The
   official caller-repository workflow uses a formula-scoped concurrency lock to
   serialize supported writers. Under that lock it validates every requested
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
   The top
   index receipt records the previous digest, transport rechecks that digest
   immediately before its copy, and an anonymous readback verifies the result.
   GitHub Container Registry (GHCR) does not provide this path with a documented
   conditional tag update, so an authorized writer outside the official workflow
   lock must not publish the same Formula concurrently. New packages created by
   the public tap repository's scoped `github.token` under that exact
   repository-rooted namespace inherit public access. Automation never changes
   package visibility, and a package that is not anonymously readable fails
   before tap finalization.
4. `verify-bottle` is read-only and starts from fresh exact source checkouts. It
   revalidates the build handoff and receipt, fetches only the declared Kandelo
   platform runtime for Formula tests, builds the VFS image, and runs the
   runtime and browser gates. The `file-formula` browser-gallery smoke separately
   prepares the supported interactive-demo graph. That graph contains owned
   wasm32 and wasm64 process fixtures, so the verifier builds both sysroots in
   its isolated sysroot checkout and copies both exact outputs into the fresh
   browser checkout before running the supported preparation command. Packages
   supplied by the external software gallery are not verifier prerequisites.
   Its isolated Homebrew process receives the same selected-tap trust as the
   build process, sealed into a readable, immutable build-local XDG store and
   using the same publisher-only redundant-persistence exception.
   It uses the locally built bottle in dry-run mode. In write mode it discards
   that bottle as runtime evidence, anonymously imports and validates the exact
   public top-index-to-child-to-layer graph, and rechecks the selected layer's
   SHA-256 and byte count. ORAS may expose the copied top index and its child
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
   exact public bottle. For a GitHub Container Registry (GHCR) bottle, Homebrew
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
5. `finalize-tap` runs only for a write publication and receives only
   `contents: write`. On another fresh runner it downloads exactly one handoff
   for every planned Formula/architecture pair. The pinned artifact downloader
   may flatten one matched handoff directly into the requested directory or
   retain artifact-name directories, so the finalizer normalizes either exact
   topology into one NUL-delimited plan-ordered path manifest. Correctly named
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
6. `publish-vfs-release` runs only when `require-vfs-acceptance: true`, every
   verifier matrix entry succeeded, and the atomic tap finalizer succeeded. The
   verifier exports only the selected wasm32 image, its deterministic lazy
   shell ZIP, both descriptors, its VFS report, and the exact Node and Chromium
   evidence. A fresh job
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

Tap writes use a tap-wide state lock, an attached `main` checkout, an explicit
remote-main refresh, and an explicit `HEAD:refs/heads/main` push. The workflow
uses a separate clean checkout for failure reports so a partially generated or
locally committed success attempt cannot enter a last-green failure commit.
Maintenance rollback resolves its freshly checked-out Kandelo `main` commit and
passes that same identity as both report provenance and push authority.

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
`scripts/prepare-homebrew-bootstrap-source.sh` to prepare Homebrew. The
dedicated `homebrew-bootstrap` package uses that same preparer and records
the source ZIP and `homebrew-brew.env` as one package generation. The main
shell resolves that exact generation, embeds the small environment policy, and
registers the source ZIP as a package-level lazy tree behind `/usr/bin/brew`;
the separate diagnostic bootstrap image above remains an eager integration
artifact. Source preparation verifies
the reviewed patch SHA-256, refuses an upstream revision where the patch does
not apply, limits the patch to its declared Homebrew files, and archives the
patched Git tree with a fixed timestamp and UTC timezone.

`/etc/kandelo/homebrew-image.json` records the exact upstream Homebrew commit,
patch SHA-256, patched-tree Git object and normalized-tree SHA-256, patched ZIP
SHA-256, and selected bottle architecture and tag. `/etc/homebrew/brew.env`
selects `wasm32_kandelo` for the current wasm32 bootstrap and sets
`HOMEBREW_SYSTEM_ENV_TAKES_PRIORITY=1`, so prefix and user configuration cannot
select a bottle for a different guest architecture. Homebrew's own `bin/brew`
reads that supported system environment file; `/usr/bin/brew` stays a direct
symlink to `/home/linuxbrew/.linuxbrew/bin/brew`, with no Kandelo launcher or
install fallback. The patch recognizes that exact alias/repository pair so
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
  "path": "/home/linuxbrew/.linuxbrew/bin/dash",
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

### Temporary Exact-Main Source Bridge

During the ABI 42 activation window, required CI must not consume bottles built
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
owns the Doom and modeset profiles because this temporary image also installs
their executables eagerly. The final bottled base deliberately omits both.
Its browser gate therefore does not run the modeset demo; an optional bottled
layer that later owns that executable and profile must carry its own acceptance
proof.

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

The required `.github/workflows/homebrew-main-shell-ci.yml` gate follows the
same activation boundary. While `SHELL_ACTIVATION_MODE` is `source-rootfs`, it
explicitly stages `homebrew/source-rootfs-shell-package`, uses an empty index
and fresh cache, and force-source-builds every buildable node in the exact
current shell closure. It inspects the resulting archive for the distinct
`source-rootfs-shell` identity, installs that exact output, and boots it in
both Node and Chromium. This provisional lane does not relax or skip the
canonical shell's lazy-artifact lock. The separate `bottles` branch also
requires an anonymous live tap-main match and therefore cannot turn a reachable
historical commit into cutover evidence. Unrelated browser-gallery roots can
still use the separately verified package generation, but a before/after
regular-file-and-symlink manifest proves they did not replace any exact-source
shell closure bytes. The sealed Chromium
proof executes eager Bash, rootfs-owned lazy `grep`, extended lazy `less`, and
integrity-bound Vim and NetHack lazy archives. The Pages publisher builds the
current sysroot and invokes the internal
`./run.sh prepare-browser --source-rootfs-shell` lane with the exact event
repository and SHA, `pages-exact-main-v1` isolation attestation, exact empty
current-ABI file index, fresh cache, and unmaterialized resolver workspace.
This is workflow plumbing, not a supported direct developer mode.

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

Until the source bridge is retired, Pages intentionally runs for every `main`
push without a path filter. Its transitive package closure and shared tool
inputs can grow; filtering by a maintained list would allow a new build input
to change without superseding the deployed product. The temporary Homebrew
main-shell workflow also runs for every pull request and `main` push so its
exact Node/Chromium source-product gate cannot be bypassed by the same
allowlist drift.

Pages then assembles the actual product tree and boots that sealed `/kandelo/`
tree before deployment. Flip the gate back to `bottles` only in the strict
exact-main bottle cutover.

### Strict Main-Shell Bottle Closure

`homebrew/main-shell.Brewfile` is the reviewed direct-root contract for the
small base shell. Its four roots are Bash, Dash, Bzip2, and first-party M4.
`homebrew/main-shell-migration-lock.json` maps every exact registry
`name@version` to its Formula identity, version, revision, and bottle rebuild;
it also records every reviewed identity or version substitution. Its
`formula_closure` is the separately reviewed distribution contract: `libcxx`,
Ncurses, and Bash are dependency-first and embedded, while Dash, Bzip2, and
first-party M4 remain three independent lazy bottle trees. The checker derives
this exact six-Formula base closure again from the pinned tap metadata. The
composer and CI keep that base as the selection and materialization policy,
while the package inventory records the ordered union of those six Formulae
and the 18 additional runtime-support Formulae. This makes every mirrored
bottle visible to recovery without pretending that all 24 Formulae are part of
the always-needed base; root inclusion alone is not sufficient evidence.

The base does not claim that those six Formulae can run Homebrew.
`homebrew/main-shell-homebrew-runtime-support.json` declares a second,
first-use atomic layer. It binds the lazy `homebrew-bootstrap` source and
launcher outputs to seven reviewed runtime roots—Ruby, Git, curl, Findutils,
Gawk, Tar, and `posix-utils-lite`—and to their exact 21-Formula
dependency-first closure derived from tap metadata. Three dependencies already
belong to the base, so activation adds 18 bottle trees.

The availability audit covers the original 25-Formula support candidate. At final
catalog `9820ef5643dc50f5876e53a1bbf6a309fc62f9a7`, 23 Formulae have admitted
public wasm32 ABI-42 identities. `libmagic` and `file-formula` have only
public ABI-41 identities and remain explicitly deferred. Pinned Homebrew
`34c40c18ffa2029b611b61c73273e32c003d0842` skips text-file classification
when `file` is unavailable, and Kandelo bottles already use their final
prefix, so neither tree is required by the fixed-prefix first-/third-party
lifecycle. Bzip2 is already in the base, while Xz is no longer pulled by the
active roots.

The audit binds the exact aggregate metadata digest, ABI, release, and catalog
publication commits separately from the immutable bottles' producer commits.
`runtime_bottle_provenance_sha256` hashes an ordered projection of all 23
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

The wider browser application also imports registry packages outside the
six-Formula base closure. The workflow derives that supporting set from
browser imports and resolves it with normal package semantics. During the
bridge, the authoritative source-shell dependency contract names every direct
input; after bottle cutover those inputs return to ordinary supporting
packages rather than hidden composer prerequisites.

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

The main-shell composer copies the exact tracked
`homebrew/main-shell-demo.json` bytes into the image. That base configuration
contains only the shell profile and uses Bash builtins plus the three declared
lazy commands; Doom, modeset, Git defaults, language runtimes, and game state
belong to optional product layers rather than this base. The platform base
intentionally does not serialize `/dev`: Node and browser hosts both mount the
authoritative `DeviceFileSystem` at `/dev` and a shared-memory filesystem at
`/dev/shm` during boot.

The wrapper currently selects sidecars with `--runtime node` because older
finalized sidecars predate truthful browser-compatibility recording. That is a
selection compatibility boundary, not browser evidence. A produced image is
not ready to replace the browser main shell until the exact emitted bytes have
booted and exercised the closure in both Node and Chromium. Prefer
`--runtime browser` once every selected bottle sidecar records browser support
from exact-byte browser acceptance.

The base Node and Chromium gates boot the same emitted bytes, reach the
embedded Bash without a download, and fetch Dash, Bzip2, and first-party M4
only on first use. A separate lifecycle gate must activate the complete
runtime-support layer before invoking stock `brew`; it then installs
first-party Bzip2 and independent-tap M4 from declared public bytes. A
six-Formula boot test is not evidence for the Homebrew lifecycle.

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
  "executable": "/home/linuxbrew/.linuxbrew/bin/consumer",
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
  "executable": "/home/linuxbrew/.linuxbrew/bin/consumer",
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
`/home/linuxbrew/.linuxbrew/bin/file --version` through `NodeKernelHost`, and
checks negative ABI-mismatch and missing-bottle cases.

Browser compatibility requires a separate browser smoke. For the current
`file-formula` path, the trusted publisher builds a precomposed wasm32 VFS image,
serves it through the browser demo, runs Chromium Playwright against
`apps/browser-demos/test/kandelo-homebrew.spec.ts`, and executes:

```bash
/home/linuxbrew/.linuxbrew/bin/file --version
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
`/home/linuxbrew/.linuxbrew` as a directory. Keg and in-keg directories are
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
Bash and retains Dash, Bzip2, and first-party M4 as independently deferred
trees. The broader language and utility catalog remains available for optional
layers; it is not silently serialized into the base.

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
Brewfile, migration lock, materialization policy, demo configuration, and
runtime-support declaration while refusing every output artifact. Publication
may change it to `sealed` only after recording the new compressed SHA-256 and
byte count. The strict composer pins `SOURCE_DATE_EPOCH` to Unix epoch zero and
will not publish while the reviewed identity remains pending.

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
caller must pass the exact Kandelo `main` SHA. The credentialed primitive
re-reads protected `main` immediately before each release creation, individual
asset upload, direct-tag creation, and draft-to-public transition. If `main`
advances during reconciliation, the next mutation fails closed; a complete
draft may remain for a later exact-main run to inspect, but it is not made
public under stale authority. A
failed attempt leaves any older receipt untouched. Success atomically replaces
the receipt with the release ID and every asset's ID, URL, digest, and size.
This same bounded 256-asset contract can carry the production shell mirror's
39 bottle payloads plus its canonical plan without adding a second publication
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
expanded 42-Formula candidate also has exact local Node and Chromium evidence
for isolated lazy Python, Perl, Erlang, and Ruby startup; that is not yet public
release evidence. Cutting over and republishing the production main shell with
its Bash closure embedded and the remaining closure deferred, live
public-release browser retrieval through the service-worker transport, durable
generic gallery publication, broader package coverage, general guest
`brew install`, and broader release/gallery operator runbooks remain separate
work.
