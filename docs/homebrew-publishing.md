# Homebrew Publishing

Kandelo's Homebrew publishing path is a bottle publication and validation
pipeline shared by the first-party tap and conventional third-party taps. The
implementation lives in the main `Automattic/kandelo` repository; the
first-party live tap repository is `Automattic/kandelo-homebrew`.

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
  consumer publication passes.

Homebrew formulae and bottle metadata remain Homebrew-native. Kandelo sidecar
metadata is an additional contract for VFS builders, Node validation, browser
automation, and publication audits; it is not a replacement for Formula Ruby or
Homebrew's `bottle do` block.

## Repositories And Ownership

| Repository | Owns |
|---|---|
| `Automattic/kandelo` | Schemas, validators, reusable workflows, package build scripts, VFS planner/builder, Node/browser smoke tests, and this documentation. |
| `Automattic/kandelo-homebrew` | Tap state: `Formula/`, generated `Kandelo/` sidecars, bottle blocks, and provenance reports. |
| `<owner>/homebrew-<name>` | A third-party tap's Formulae, generated state, GHCR bottle packages, and caller-scoped publication authority. |

The checked-in `homebrew/kandelo-homebrew/` directory is a reviewable template
and test fixture for the tap shape. Live generated tap state belongs in
`Automattic/kandelo-homebrew`, not in the main repository template.

Repository identity and Homebrew tap identity are separate inputs. A
conventional repository `<owner>/homebrew-<name>` has canonical Homebrew tap
name `<owner>/<name>`. Repository identity owns GitHub checkout, GHCR paths,
and the caller token; tap identity owns `brew` references, installed Formula
paths, receipts, OCI titles, and Kandelo sidecars. The first-party repository
is an explicit exception: both its repository identity and tap name are
`Automattic/kandelo-homebrew`. No conventional repository may derive that
protected first-party tap name, so repository and tap identities remain a
one-to-one publication boundary.

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
its direct symlink:

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

Publish same-tap runtime dependencies before their consumers. The bottle
builder resolves the selected Formula's recursive runtime closure in
topological order, filters it to the selected canonical tap name, and installs
each dependency separately with `--force-bottle --as-dependency
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
read-only source. Before any Formula Ruby executes, the static Formula parser
derives a bounded plan from the selected Formula's direct `depends_on`
declarations. An unqualified external dependency must be explicitly tagged
`:build`, `:test`, or both. Untagged and `:recommended` external runtime
dependencies fail because portable runtime dependencies must come from the
selected Kandelo tap; `:optional` dependencies are not selected. Same-tap
dependencies remain in the target plan. The resulting control data has three
lists:

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

The native prefix is deliberately short enough to fit in the fixed
`/home/linuxbrew/.linuxbrew` strings stored in official host-tool bottles.
Native Brew alone receives `HOMEBREW_RELOCATE_BUILD_PREFIX=1`, so Homebrew can
pour those bottles and rewrite their build prefix into the isolated native
realm. The target Brew and target Formula never receive that setting. These
Linuxbrew bottles provide CI executables such as CMake or WABT; they are not
Kandelo package dependencies, target bottle contents, or VFS inputs. Kandelo
bottles are still built from the upstream sources declared by the tap Formulae.

After those checks, the publisher makes the complete native prefix root-owned
and read-only. The target build can read that sealed prefix, but only each
planned direct dependency's selected keg is copied into a root-owned, read-only
proxy under the canonical target Cellar. Its target `opt` link points to that
real target keg. Homebrew requires a keg's grandparent to resolve to the active
Cellar, so a rack symlink into the native prefix is not a valid substitute.
Unselected keg versions and native transitive dependencies stay in the native
prefix and cannot claim target Cellar names. Native install logs remain
separate from Kandelo bottle dependency provenance.

Pinned Homebrew normally tries to install Bubblewrap into its active prefix
before `brew test`. The publisher overlay suppresses that automatic install
while a protected Kandelo target plan is active. A usable Bubblewrap already
provided by the host can still be detected and used, but Homebrew cannot fetch
unplanned native code into the target Cellar after isolation begins. Native
Homebrew has no target plan and retains its normal sandbox dependency behavior.
The dedicated build identity, transient systemd service, `NoNewPrivileges`,
immutable inputs, and teardown checks remain the publisher's primary process
boundary when the host cannot create a rootless Bubblewrap sandbox. The builder
also snapshots the planned target Cellar after installation and rejects any
Formula test or bottle command that adds or removes a rack or keg.

The publisher force-pours the planned same-tap Kandelo bottles into the target
prefix. It then runs the selected target install with
`--ignore-dependencies`: the builder combines that flag with `--build-bottle`,
while the verifier combines it with `--force-bottle`. Homebrew therefore uses
the already provisioned target bottles and exact native proxy kegs instead of
resolving both package realms into one Cellar. The verifier still runs the
Formula's `test do` block after pouring the target bottle.

This separation changes publisher orchestration, not Kandelo's process ABI or
a package's target build inputs. By itself it does not require an ABI version
bump, a `build.toml` package revision change, or a rebuild of existing package
archives or bottle outputs. Those artifacts change only when their actual
output inputs change.

After building the consumer, the builder checks every same-tap dependency in
its `INSTALL_RECEIPT.json`. The installed dependency receipt must say
`built_as_bottle: true`, `poured_from_bottle: true`, and
`installed_on_request: false`, and its source tap commit must match the exact
planned tap. The selected Formula's `wasm32_kandelo` or `wasm64_kandelo`
bottle digest and bounded fetch/pour log lines are recorded alongside those
receipt facts. Raw logs do not cross the runner boundary. Fresh verifier and
finalizer runners rehash each dependency Formula from the exact planned tap
before accepting the bounded provenance.

While holding the tap state lock, the finalizer repeats the complete static
dependency-closure derivation against refreshed `main`. Every recorded
dependency Formula digest and selected-architecture bottle tuple must still
match. A dependency Formula or bottle change after planning therefore causes a
truthful stale-build failure instead of publishing a consumer against a newer
dependency graph.

The exact same-tap closure resolved before installation must equal the closure
recorded in the target receipt. A missing or unexpected receipt entry fails the
build before any publication handoff is created. A target receipt entry outside
the selected tap is rejected rather than omitted from provenance: native tools
belong only to the sealed host realm, and a Linux executable must never become a
Kandelo bottle's declared runtime dependency.

Fresh verifier and finalizer validation independently derive that closure from
the exact tap without evaluating Formula Ruby. Same-tap dependencies must use
direct Formula class-body literal declarations such as `depends_on
"automattic/kandelo-homebrew/zlib"`. The static resolver includes untagged and
`:recommended` dependencies, excludes the canonical `:build`, `:test`, and
`:optional` forms, and recursively resolves explicit same-tap references.
Conditional, interpolated, helper-hidden, unknown-tag, duplicate, and cyclic
dependency declarations fail closed. The submitted provenance dependency set
must exactly equal this independently derived closure, including for an empty
root-package closure.

The finalizer also independently derives the root Formula's direct same-tap
runtime dependencies. Each provenance record's `declared_directly` value must
match that source-derived set, and the composition handoff's `{name, version}`
dependency array must exactly equal the direct provenance records. Missing,
extra, duplicate, wrong-version, or forged-directness entries fail before
sidecars are generated.

For every closure member, the resolver also reads the canonical static
`bottle do` block and derives the selected architecture's cellar, rebuild,
digest, tag, and digest-bound URL. Fresh validation requires the submitted
prior-bottle record to equal that exact tap data; a closure member with no
selected-architecture bottle fails validation.
Required or recommended dependencies outside the selected Kandelo tap are not
portable runtime inputs and fail validation anywhere in the closure. Optional
external declarations may remain static Formula metadata, but selecting one in
an installed bottle receipt also fails closed.

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
      tap-repository: Automattic/kandelo-homebrew
      tap-name: Automattic/kandelo-homebrew
      formulae: hello
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
**Publish Kandelo bottles**; do not restore the narrower legacy **Publish hello
bottle** name. The three dispatch events are `publish-kandelo-bottles`,
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
`https://ghcr.io/v2/<lowercase-owner>/<lowercase-repository>` from the tap
repository. The separate reusable maintenance workflow remains first-party
specific because its rollback and deletion paths own default-tap state. A
third-party `maintain-bottles.yml` on the protected default branch may call the
generic publisher for rebuilds, but generic rollback and deletion orchestration
are not provided by this change. Third-party actions in the privileged path are
pinned by commit. The reusable workflow uses the caller's scoped
`github.token`; it cannot publish another repository's tap state or GHCR
packages because caller and target repository identities must match.

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
   unprivileged user. The original Kandelo and tap checkouts remain hidden from
   that identity. Each transient service receives root-created, read-only bind
   aliases for those exact trees, and the Kandelo SDK environment points only
   at the alias. The patched Homebrew source is recursively non-writable and
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
   read-only XDG configuration store and trusts only the reviewed selected tap
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
   is scoped to same-tap dependency pours and final bottle creation. Homebrew
   resolves both the runtime-only same-tap closure used for provenance and the
   complete same-tap build/test closure. A static direct-host plan separately
   selects native build and test tools. Native Homebrew installs their full
   closure in its own state realm, the publisher validates their canonical
   `homebrew/core` identities, and each sealed direct tool receives a canonical
   read-only proxy keg in the target prefix. Plain-name `brew list` must
   recognize every proxy before the target build starts. The bounded same-tap
   union is then force-poured as Kandelo
   bottles, and the target Formula is built with dependency resolution
   disabled. Native tools therefore do not inherit a Kandelo target tag, and no
   same-tap dependency can fall back to a source build. The workflow also
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
   1 MiB, the compressed bottle at 2 GiB, and its expanded tar stream at 16 GiB.
   Generated formula and link sidecars are each capped at 16 MiB. Artifact
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
   and deterministic OCI child against the plan before exposing the token to an
   isolated ORAS transport. This includes bounded tar structure, link safety,
   receipt identity, local-build-root
   absence across all regular members, and every Wasm member's ABI, memory width,
   object kind, and fork instrumentation. The credentialed step cannot evaluate
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
   private-state disambiguation. The uploader copies only the validated child
   layout to its content-derived tag, retires the isolated ORAS authentication
   state, and requires an anonymous exact-digest readback. Its only output is a
   strict data receipt binding the canonical layout receipt to that public
   readback.
3. `publish-bottle-index` receives `packages: write` once per Formula. The
   official caller-repository workflow uses a formula-scoped concurrency lock to
   serialize supported writers. Under that lock it validates every requested
   child layout and public child receipt, anonymously imports the current
   Homebrew top reference, and preserves a compatible sibling architecture. The
   anonymous importer
   validates bounded top, child, config, and layer descriptors by digest before
   it starts the layer copy, confirms the mutable tag did not change during that
   validation, and pins the copy to the validated top digest. It then composes
   one complete OCI image index at Homebrew's version/rebuild reference. Only
   the final layout copy receives registry credentials; Formula Ruby and OCI
   composition remain credential-free. A conflicting same-reference child or a
   stale Formula/support closure fails instead of overwriting bytes. The top
   index receipt records the previous digest, transport rechecks that digest
   immediately before its copy, and an anonymous readback verifies the result.
   GitHub Container Registry (GHCR) does not provide this path with a documented
   conditional tag update, so an authorized writer outside the official workflow
   lock must not publish the same Formula concurrently. First publication of a
   private GHCR package fails at the explicit visibility boundary; automation
   never changes package visibility.
4. `verify-bottle` is read-only and starts from fresh exact source checkouts. It
   revalidates the build handoff and receipt, fetches only the declared Kandelo
   platform runtime for Formula tests, builds the VFS image, and runs the
   runtime and browser gates. The `hello` browser-gallery smoke separately
   prepares the supported interactive-demo graph; packages supplied by the
   external software gallery are not verifier prerequisites.
   Its isolated Homebrew process receives the same selected-tap trust as the
   build process, sealed into a readable, immutable build-local XDG store and
   using the same publisher-only redundant-persistence exception.
   It uses the locally built bottle in dry-run mode. In write mode it discards
   that bottle as runtime evidence, anonymously imports and validates the exact
   public top-index-to-child-to-layer graph, and rechecks the selected layer's
   SHA-256 and byte count. It statically composes the selected bottle block from
   reconstructed canonical metadata. In an isolated identity it then runs the
   reviewed pinned Homebrew implementation with the Kandelo platform patch. The
   verifier independently resolves the runtime-only same-tap closure and the
   complete runtime/test closure. Its static direct-host plan excludes pure
   build tools, then native Homebrew installs the remaining runtime/test tools
   and their complete closure under the separate native state realm. After
   canonical core validation, only the sealed direct tools receive read-only
   proxy kegs in the target prefix, and plain-name `brew list` must recognize
   them there. The verifier then force-pours the same-tap portion from prior
   Kandelo bottles and pours the target bottle with dependency resolution
   disabled. It also
   provisions a separate protected Playwright Chromium
   tree for the verifier identity. Runtime provenance remains limited to the
   runtime-only closure. The target cache then starts empty, source fallback is
   forbidden, and Homebrew itself must fetch, force-pour, inspect, and test the
   exact public bottle. Formula and
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
   refreshed tap while the lock is held. It then statically composes the
   selected bottle tag and regenerates aggregate sidecars from refreshed tap
   metadata. A sibling-architecture tag is retained only when the refreshed
   metadata proves the same ABI, version, formula revision, and bottle rebuild.
   A stale handoff cannot move the tap to an older ABI or, for the same package
   identity and ABI, to a lower bottle rebuild.
   It does not load Formula Ruby or run Homebrew in the credentialed role. Only
   the composed and fully validated Formula update, sidecars, and provenance are
   pushed.

Tap writes use a tap-wide state lock, an attached `main` checkout, an explicit
remote-main refresh, and an explicit `HEAD:refs/heads/main` push. The workflow
uses a separate clean checkout for failure reports so a partially generated or
locally committed success attempt cannot enter a last-green failure commit.

Use `dry-run: true` for local or CI validation that must not push GHCR blobs or
tap commits. Dry runs still build bottles and validate the generated metadata
shape. An anonymous GHCR authorization failure remains a non-public dry-run
result; dry-run upload planning neither loads registry credentials nor attempts
to distinguish a missing namespace from a private reference. Dry runs seed the
VFS builder from the current local bottle. Non-dry runs seed it only with bytes
returned by the anonymous GHCR readback. The publisher deliberately does not
restore GitHub
Actions dependency caches: selected tap and Kandelo refs are executable code,
and a manually dispatched dry run can write Actions storage in the same
repository scope as a later privileged publish. Run-scoped diagnostic artifacts
remain available, but cached build output is not an input to bottle publication.

`bottles-abi-v<N>` is currently a metadata namespace, not a promise that a
GitHub Release with that tag contains sidecars or gallery archives. Immutable,
serialized gallery release publication is deferred. Do not restore the old
mutable `gh release upload --clobber` path.

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

The shared planner is `planHomebrewVfs()` in
`host/src/homebrew-vfs-planner.ts`. It consumes `Kandelo/metadata.json` plus a
caller-provided link-manifest loader and rejects bad ABI, unsupported arch,
tap-identity drift, duplicate roots or metadata, cache-key drift, missing
packages, dependency cycles, unsafe paths, and link-manifest bottle drift
before any bottle bytes are extracted. It resolves the requested roots and
their single-tap dependency closure in deterministic dependency-first order.

The Node-side builder is `buildHomebrewVfs()` in
`host/src/homebrew-vfs-builder.ts`. It verifies bottle byte count and sha256,
extracts supported tar entries, stages kegs under the declared prefix,
validates receipts, applies link manifests, writes
`/etc/kandelo/homebrew-vfs.json`, and emits a build report.

The CLI starts with an empty VFS by default. Pass `--base-image` to overlay the
same verified bottle plan onto an explicit platform-only `.vfs` or `.vfs.zst`
base image. The base must declare the same kernel ABI as the bottle metadata
and must not already carry Homebrew composition metadata or
`/etc/kandelo/homebrew-vfs.json`; merging independently composed Homebrew
prefixes would lose package provenance, so it fails closed. Existing files
remain unchanged except for requested bottle/link paths and the builder-owned
Homebrew manifest (plus the optional profile fragment); path collisions fail
through the normal staging checks.

The output image metadata binds the exact base input with a bounded object:
SHA-256, byte count, and declared kernel ABI. It also records the selected tap
repository and canonical tap name. The JSON report carries the same binding
plus the base's full source metadata for auditing. Base signatures,
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
tap "automattic/kandelo-homebrew"
brew "sqlite"
brew "automattic/kandelo-homebrew/xz"
```

The subset accepts blank lines, comments, exactly one literal canonical
lowercase `tap "owner/tap"`, and between 1 and 128 literal `brew` entries.
Entries may use a bare formula name or a fully qualified name from that exact
tap. Bare and qualified forms normalize to the same root, so duplicates fail.
The selected tap must exactly match `metadata.json`, and the complete resolved
closure is limited to 128 packages.

The parser uses Ripper to inspect the syntax tree and never evaluates the file.
Options, interpolation, conditionals, variables, nested Ruby, `cask`, `mas`,
`service`, and every other Homebrew Bundle entry are rejected. Full Bundle DSL
belongs to real Homebrew running inside a Kandelo guest; it is not a safe or
deterministic host-side image specification. This builder intentionally accepts
only one tap, so a root or required dependency from another tap must fail until
multi-tap composition has an explicit metadata and provenance contract.

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
  --metadata /path/to/kandelo-homebrew/Kandelo/metadata.json \
  --tap-root /path/to/kandelo-homebrew \
  --brewfile /path/to/Brewfile \
  --arch wasm32 \
  --runtime node \
  --base-image target/platform-base.vfs.zst \
  --out target/homebrew-hello.vfs.zst \
  --report target/homebrew-hello.vfs-report.json
```

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

The acceptance gate parses the static Brewfile, requires at least one real
dependency edge reachable from the selected Formula, and resolves the same
dependency-first plan for Node and browser. Every package must select a current
`success` bottle at the exact public URL
`https://ghcr.io/v2/<tap-owner>/<tap-repository>/<formula>/blobs/sha256:<digest>`.
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

The Node smoke for the published `hello` bottle:

```bash
scripts/dev-shell.sh npx tsx packages/registry/hello/test/homebrew-node-smoke.ts \
  --result-dir test-runs/homebrew-node-smoke \
  --tap-repository Automattic/kandelo-homebrew
```

It clones or reads the tap, builds a Homebrew VFS from published sidecars, runs
`/home/linuxbrew/.linuxbrew/bin/hello --version` through `NodeKernelHost`, and
checks negative ABI-mismatch and missing-bottle cases.

Browser compatibility requires a separate browser smoke. For the current
`hello` path, the trusted publisher builds a precomposed wasm32 VFS image,
serves it through the browser demo, runs Chromium Playwright against
`apps/browser-demos/test/kandelo-homebrew.spec.ts`, and executes:

```bash
/home/linuxbrew/.linuxbrew/bin/hello --version
```

Only after that smoke passes may sidecars record
`runtime_support = ["node", "browser"]` and `browser_compatible = true`.
Packages without a successful browser smoke remain Node-only.

The `hello` package bytes in this smoke come from the current Homebrew bottle:
from the local build in dry-run mode, or from the anonymously fetched GHCR blob
in write mode. The browser demo still resolves Kandelo-owned ABI platform
prerequisites such as `node.wasm` and `node-vfs.vfs.zst` through Kandelo's normal
binary release. Generic Formula and dependency-bearing VFS verification fetches
only the base command set and `rootfs`; its focused Vite input does not scan the
interactive demo. The `hello` gallery smoke additionally materializes the
supported interactive graph through `./run.sh --fetch-only prepare-browser`,
which excludes packages whose demos are provided by the external software
gallery. Those platform assets are not the migrated package under test, and
unrelated gallery packages are not bottle verification prerequisites.

## Browser Gallery Assets

Generate browser gallery assets only from browser-smoked wasm32 metadata:

```bash
scripts/dev-shell.sh bash scripts/homebrew-create-browser-gallery.sh \
  --metadata /path/to/kandelo-homebrew/Kandelo/metadata.json \
  --image target/homebrew-hello.vfs.zst \
  --report target/homebrew-hello.vfs-report.json \
  --out target/homebrew-gallery \
  --formula hello
```

The script writes `gallery.json`, `index.toml`, and a package-source-shaped
`.tar.zst` whose payload is the precomposed `.vfs.zst` image. It refuses
metadata where the wasm32 bottle is not `status = "success"` and
`browser_compatible = true`.

`scripts/validate-software-gallery.mjs` verifies that every gallery entry has
wasm32 success metadata, an `archive_url`, and `browser_compatible = true`.
Launch-time archive failures must remain visible in the Kandelo UI. The trusted
publisher retains these generated files as run diagnostics only. Durable public
gallery publication requires a separate immutable asset contract.

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
  transitions discard all old sibling tags before publishing the selected
  architecture. Formula source changes after planning, noncanonical bottle
  blocks, required shared Formula-support changes, Formula root/tag/digest
  disagreement with the tap sidecars, or symlinks in refreshed `Formula/` and
  `Kandelo/` state must fail publication; a global lock alone does not make
  stale aggregate sidecars safe.
- Do not publish a new formula's tap metadata until its GHCR package passes the
  anonymous digest readback. New GHCR packages are private by default; changing
  package visibility is an explicit operator action, not a workflow side effect.
- Do not bump `build.toml` revisions for docs-only changes.

## Current Gaps

The implemented path covers a trusted bottle build, GHCR upload plus anonymous
readback, sidecar validation, verified VFS image building, browser smoke,
diagnostic gallery gating, and lossless under-lock tap composition with Formula
source-closure drift rejection. Public visibility provisioning for new GHCR
packages, immutable gallery release publication, broader package coverage,
general guest `brew install`, and full operator runbooks remain separate work.
