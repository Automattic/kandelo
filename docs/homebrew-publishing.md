# Homebrew Publishing

Kandelo's Homebrew publishing path is a bottle publication and validation
pipeline shared by the first-party tap and conventional third-party taps. The
implementation lives in the main `Automattic/kandelo` repository; the
first-party live tap repository is `kandelo-dev/homebrew-tap-core`.

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

## Repositories And Ownership

| Repository | Owns |
|---|---|
| `Automattic/kandelo` | Schemas, validators, reusable workflows, package build scripts, VFS planner/builder, Node/browser smoke tests, and this documentation. |
| `kandelo-dev/homebrew-tap-core` | Tap state: `Formula/`, generated `Kandelo/` sidecars, bottle blocks, and provenance reports. |
| `<owner>/homebrew-<name>` | A third-party tap's Formulae, generated state, GHCR bottle packages, and caller-scoped publication authority. |

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

| Artifact | Storage | Consumer |
|---|---|---|
| Formula source and `bottle do` blocks | Tap git repository | Homebrew. |
| Bottle tarballs | GHCR/Homebrew bottle URL shape | Homebrew and Kandelo VFS builder. |
| `Kandelo/metadata.json` | Tap git repository | VFS planner, validator, audit tooling. |
| `Kandelo/formula/*.json` | Same as metadata | Formula-level Kandelo sidecar. |
| `Kandelo/link/*.json` | Same as metadata | VFS builder pour/link plan. |
| `Kandelo/reports/*.provenance.json` | Same as metadata | Durable publication and validation evidence. |
| `Kandelo/vfs-acceptance.json` and its Brewfile | Tap git repository | Optional tap-owned dependency-bearing acceptance selection. |
| `Kandelo/dependency-taps.json` | Primary tap git repository | Exact reviewed public tap source lock. |
| Required-gate VFS image, descriptor, report, and Node/browser evidence | Source tap GitHub Release `homebrew-vfs-sha256-<image-sha256>` | Kandelo browser direct-`vfs` launch, audit tooling, and operators. |
| Browser gallery assets | Run-scoped diagnostic artifact | Review evidence only; not a durable public gallery. |

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

1. Build through Kandelo's normal SDK and package scripts. Source
   `sdk/activate.sh` or call an existing `packages/registry/<name>/build-*.sh`
   path through the trusted workflow environment.
2. Install only the produced Wasm artifacts into the Homebrew keg.
3. Preserve Homebrew's prefix and cellar model:
   `/home/linuxbrew/.linuxbrew` and
   `/home/linuxbrew/.linuxbrew/Cellar`.
4. Put runtime validation in `test do`, but execute Wasm through Kandelo
   rather than as a host Linux binary.
5. Update Homebrew `revision` or bottle `rebuild` when bottle bytes should move
   for Homebrew bottle selection. Update Kandelo `build.toml` `revision` only
   when the underlying Kandelo package output bytes legitimately change.

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
`runner` local remain forbidden.

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
      tap-repository: kandelo-dev/homebrew-tap-core
      tap-name: kandelo-dev/tap-core
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
Write publication is additionally fixed to `Automattic/kandelo@main` and the
caller tap's `main` branch. A dry run keeps those repository identities fixed,
but may select a reviewed, valid Git branch name or an exact lowercase
40-character commit SHA from each repository. The trust step normalizes branch
names under `refs/heads/`, and the planning job resolves both selections to
immutable commits before any matrix job starts. These source selections are
data passed to the already-reviewed caller and reusable workflow definitions;
they do not select either workflow definition. The bottle root is never
caller-selected:
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
switch. When a forced run encounters a stale version index left by a partial
publication, the credential-free composer may recover it only if the exact,
clean planned tap commit contains neither `Kandelo/formula/<formula>.json` nor
that Formula in `Kandelo/metadata.json`. The composer first validates the old
index and children under their own source identity, requires the ABI, Formula,
version, Formula revision, bottle rebuild, and repository identities to match
the new children, and then discards every old child instead of mixing source
closures. Its receipt retains the previous top digest and records the
`unfinalized-stale-source-identity` transition reason. A finalized Formula,
dirty or different tap checkout, fixed-identity mismatch, malformed old index,
or ordinary non-forced run still fails; a finalized bottle with changed bytes
requires a new Formula bottle `rebuild`.

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
   the publisher transactionally replaces that link tree with self-contained
   regular files before it exposes the Kandelo checkout through a read-only
   source alias.
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
   checks reject Formula mode changes and any
   tracked, untracked, ignored, mode, symlink, or special-file drift under
   `Kandelo/formula_support`.

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
   regular members, and every Wasm member's ABI, memory width, object kind, and
   fork instrumentation. The credentialed step cannot evaluate
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
   layout to its content-derived tag, retires the isolated ORAS authentication
   state, and requires an anonymous exact-digest readback. Its only output is a
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
   identity: the composer proves the exact planned tap has no formula-level or
   aggregate sidecar entry, requires every fixed identity field to match,
   validates the old index under its own identity, and discards all old
   children. It never carries a sibling architecture across that transition.
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
   member beginning with Wasm magic is treated as a Kandelo process module,
   independent of filename, mode, or wrapper layout. It must carry the exact
   release ABI, one memory matching the bottle architecture, no relocatable
   object marker, and complete fork exports when needed. A future bottle that
   ships plugin or browser Wasm as data needs an explicit typed payload contract;
   modes and paths are not trusted exemptions. The static
   Formula declaration parser then cross-checks dependency categories and
   directness against the validated build provenance and receipt. The verifier
   generates a full candidate tap for validation, but the publication handoff
   contains only the strict build files, upload receipt, selected runtime
   bottle bytes, and one package-scoped `composition/sidecars-input.json`.
   Downstream jobs never execute artifact-provided scripts, Formulae, or
   environment files.
5. `finalize-tap` runs only for a write publication and receives only
   `contents: write`. On another fresh runner it validates the complete
   publication handoff as inert data against the exact base tap before checking
   out with push credentials. The publisher then acquires the tap state lock,
   refreshes `main`, verifies that the planned tap commit is still an ancestor,
   and rechecks both the Formula's bottle-excluded source digest and any required
   `Kandelo/formula_support` tree against that commit. It also rederives and
   revalidates the complete dependency Formula and bottle closure against the
   refreshed tap while the lock is held. For each dependency, a detached
   checkout of the exact planned tap binds the recorded raw Formula digest;
   refreshed Formula bytes may differ only by the structurally canonical
   bottle block, and the selected architecture's bottle metadata must remain
   exact. It then statically composes the
   selected bottle tag and regenerates aggregate sidecars from refreshed tap
   metadata. A sibling-architecture tag is retained only when the refreshed
   metadata proves the same ABI, version, formula revision, and bottle rebuild.
   A stale handoff cannot move the tap to an older ABI or, for the same package
   identity and ABI, to a lower bottle rebuild.
   It does not load Formula Ruby or run Homebrew in the credentialed role. Only
   the composed and fully validated Formula update, sidecars, and provenance are
   pushed.
6. `publish-vfs-release` runs only when `require-vfs-acceptance: true`, every
   verifier matrix entry succeeded, and every tap finalizer succeeded. The
   verifier exports only the selected wasm32 image, its VFS report, the exact
   Node and Chromium evidence, and a deterministic descriptor. A fresh job
   checks out the exact planned Kandelo and tap commits, revalidates that inert
   bundle without a token in its environment, compares its ABI and bottle
   release tag to the trusted plan outputs, and only then exposes the scoped
   `github.token` to one release-write step.
   That step serializes on the content tag, creates or resumes an exact draft,
   rejects duplicate, unexpected, missing-public, or byte-mismatched assets,
   and publishes only after authenticated byte checks succeed. It finally
   reads all five public URLs with token variables removed and verifies every
   SHA-256 and byte count. It requires the published release API record to set
   `immutable: true` before emitting success. A public release retry is
   read-only and idempotent.

Tap writes use a tap-wide state lock, an attached `main` checkout, an explicit
remote-main refresh, and an explicit `HEAD:refs/heads/main` push. The workflow
uses a separate clean checkout for failure reports so a partially generated or
locally committed success attempt cannot enter a last-green failure commit.

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
Treat the newest run only as a candidate. Before cancelling, rerunning, watching,
or downloading artifacts from a manually dispatched run, wait for its `plan`
job and read that job's logged inputs. Match the Formula selection, architectures,
Kandelo ref, and tap ref to the exact dispatch payload. If those facts are not
yet available, do not mutate the run; another operator or rollout may own it.

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
URL, but not raw stderr. The previous successful bottle remains selectable when
its fallback fields are complete. Maintenance exposes only `rebuild` and
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
`scripts/prepare-homebrew-bootstrap-source.sh` to prepare Homebrew. Source
preparation verifies the reviewed patch SHA-256, refuses an upstream revision
where the patch does not apply, limits the patch to its four declared Homebrew
files, and archives the patched Git tree with a fixed timestamp and UTC
timezone.

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
earlier ABI 39 dispatcher and `/usr/bin/brew` alias-launcher measurements needed
20,012 and 29,212 bytes respectively. The exact candidate bootstrap also found
a 49,232-byte Bash child continuation in the recursive command evaluator,
which the 48 KiB draft reserve rejected truthfully. All three now fit without
weakening the overrun guard. Repeat the probe with
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
promotes the exact accepted wasm32 image only after both the complete verifier
and tap finalizer matrices are green. Ordinary optional acceptance runs do not
publish a VFS release. The release belongs to the source tap repository and has
the content-addressed tag:

```text
homebrew-vfs-sha256-<full lowercase image SHA-256>
```

Before the first required-acceptance dispatch, a repository administrator must
enable **Settings → Releases → Enable release immutability** for the source tap.
GitHub applies that setting only to future releases. The publisher deliberately
keeps only `contents: write` and cannot preflight the administration-only
setting. Instead, it requires the published release API record to report
`immutable: true` before it emits a success receipt or launch URL. If the
setting was omitted, the run fails loudly and leaves the exact release state as
diagnostic evidence; it does not delete or relabel the release automatically.
That release is not an accepted Kandelo VFS product and needs explicit operator
recovery before the content tag can be reused.

It has exactly these assets:

```text
kandelo-homebrew.vfs.zst
kandelo-homebrew-vfs.json
kandelo-homebrew-vfs-report.json
kandelo-homebrew-node-evidence.json
kandelo-homebrew-browser-evidence.json
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

The release publisher never uses `--clobber`. A content-tag state lock
serializes writers. An absent release starts as a draft; an interrupted exact
draft may be completed, while unexpected assets or existing bytes with a
different digest fail closed. GitHub's release-by-tag and Git-ref endpoints do
not expose a draft, so recovery discovers the unique pending tag through the
authenticated, paginated release list and refreshes that draft by its database
ID. Once public, the release is never mutated. Publication creates the tag,
after which it must be a direct commit reference to the exact tap source
commit. Success requires GitHub-enforced release immutability plus anonymous
digest-and-size readback of all five assets. The run retains a small publication
receipt with the descriptor and direct-image URLs, but that Actions artifact is
only a receipt; the release assets are the durable public product.

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
  bottle tags from refreshed tap state while holding the tap lock. Identity
  transitions for explicitly forced, unfinalized partial indexes discard all
  old sibling tags before publishing the selected architecture. Accepted
  identities require a bottle rebuild instead. Formula source changes after
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
   name as `tap-name`. Do not pass a bottle root: the publisher must derive
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
- `publish / finalize-tap (<formula>, wasm32)`

For a multi-architecture publication, require every architecture-specific
matrix instance as well as the single Formula-level index job. A finalizer that
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

| Package API name | State on 2026-07-18 | Purpose |
|---|---|---|
| `tap-core/zlib` | private; last updated `2026-07-18T03:46:46Z` | old-root creation control |
| `tap-core/bzip2` | private; last updated `2026-07-18T05:20:07Z` | old-root creation control |
| `homebrew-tap-core/zlib` | public; created by canary run `29652866481` | repository-rooted positive control and production destination |
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
  "client_payload": {"formulae": "zlib", "arches": "wasm32"}
}
JSON

gh api --method POST \
  'repos/Kandelo-dev/homebrew-tap-core/dispatches' --input - <<'JSON'
{
  "event_type": "publish-kandelo-bottles",
  "client_payload": {"formulae": "bzip2", "arches": "wasm32"}
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
image building, Node and Chromium smoke, immutable public release of the exact
required-acceptance image, diagnostic gallery gating, and lossless under-lock
tap composition with Formula source-closure drift rejection. Durable generic
gallery publication, broader package coverage, general guest `brew install`,
and broader release/gallery operator runbooks remain separate work.
