# Homebrew Internal And Helper Registry Classification

Date: 2026-06-30

Tracked work:

- `kd-1mr` - Port all current Kandelo packages to Homebrew.
- `kd-u4sz` - Classify internal, source, and helper registry entries.
- Source planning: `kd-5yd` (`b6cd51d8c`) and `kd-c6p`
  (`1663df076`) define the Homebrew-all inventory and registry replacement
  model.

This is a design and disposition artifact. It does not publish bottles, edit
Formulae, delete registry directories, or change package build behavior.

## Problem Statement

The Homebrew replacement model can only delete `packages/registry` after every
current registry role has an explicit owner. Most entries are ordinary
libraries, programs, or composite VFS packages that should become Homebrew
Formulae. The entries covered here are the exceptions:

- first-party platform artifacts (`kernel`, `userspace`, `kandelo-sdk`);
- internal test fixture metadata (`kernel-test-programs`);
- source/helper material (`pcre2-source`, `node-compat`, `npm`);
- a stale manifest-incomplete program split (`sqlite-cli`).

Leaving these entries unclassified would make the registry impossible to remove
without either hiding package status or losing platform/test/tooling inputs.
The design needs to record whether each entry becomes a Formula, a Homebrew
resource/helper, sidecar or tooling-owned data, an explicit non-package release
artifact, a removal, or a blocker.

## Non-Goals

- Do not implement the moves in this bead.
- Do not remove `packages/registry` or any package directory.
- Do not treat Homebrew as the owner of Kandelo boot artifacts just because
  they currently have registry manifests.
- Do not create a standalone helper Formula where a Formula resource or
  owner-local build input is enough.
- Do not revive `sqlite-cli` as a product package unless a later package bead
  proves the CLI must stay separate from the `sqlite` Formula.
- Do not document guest `brew install` commands or user-facing Homebrew install
  support before that path is validated.

## Users And Operator Workflows

Package maintainers need to know which current registry entries are real
Homebrew packages and which are bridge-era implementation details. A generated
Formula should not accidentally include `kernel-test-programs`, `node-compat`,
or `npm` as user-installable packages.

Release operators need platform boot artifacts (`kernel.wasm`,
`userspace.wasm`, and SDK VFS images) to keep the same strong provenance,
ABI, cache-key, and fallback accounting as packages, even when those artifacts
are not Homebrew Formulae.

Runtime and test maintainers need internal fixtures to remain discoverable.
Moving `kernel-test-programs` out of package scope must not make host/kernel
tests rely on undocumented binaries.

Package porters need source helpers to move into the owning Formula graph.
`pcre2-source` belongs to MariaDB's Formula/resource closure, `npm` belongs to
the Node VFS build, and `node-compat` belongs to SpiderMonkey/Node-compatible
runtime build tooling.

Debuggers need failures to route to the right layer. A missing SDK VFS image is
not a Homebrew formula failure; a bad `pcre2-source` sha is a source-resource
failure; a missing `kernel-test-programs` output is a test fixture/tooling
failure.

## Classification Rules

Use these dispositions for this bead:

- `Formula`: a normal Homebrew Formula should own source, dependencies, build,
  install, and test behavior.
- `Homebrew resource/helper`: the entry should be represented as a Formula
  `resource`, helper input, or owner-local fetch step for another Formula.
- `sidecar/tooling-owned data`: the entry is data or source used by Kandelo
  tools/tests/status reports, not an installable Homebrew package.
- `explicit non-package release artifact`: the entry remains a first-party
  platform artifact outside Formula source-of-truth, with its own release
  manifest/provenance path.
- `removal`: the entry should leave the accepted package set; any still-needed
  behavior must be folded into another owner.
- `blocked`: there is not enough evidence to choose an owner, or an external
  blocker prevents registry removal.

## Dispositions

| Entry | Current evidence | Disposition | Registry-removal action |
|---|---|---|---|
| `kandelo-sdk` | `package.toml` declares a program output `kandelo-sdk.vfs.zst`; `build.toml` uses `commit = "UNPUBLISHED"`; the builder creates a precomposed SDK VFS layer with wrappers, sysroot, glue, clang resource headers, and license notices. The SDK README says compiler executables are staged separately. | Explicit non-package release artifact. | Move SDK VFS provenance, host-tool requirements, input digests, Node/browser smoke status, and gallery eligibility to a platform-artifact manifest or equivalent sidecar. Do not make a user-facing Formula until the in-guest compiler/toolchain ownership is designed. |
| `kernel` | First-party boot artifact built by `packages/registry/kernel/build-kernel.sh`; resolver places it at `binaries/kernel.wasm`, not under `binaries/programs/<arch>/`; Homebrew docs keep ABI identity in sidecars/releases rather than Formula tags. | Explicit non-package release artifact. | Keep kernel publication on the Kandelo runtime/binary-release path. Move current registry metadata into a platform artifact owner before registry deletion. Homebrew package sidecars may reference its ABI, but the kernel itself is not a Formula. |
| `kernel-test-programs` | Manifest describes host/kernel smoke test programs (`exec-caller`, `fork-exec`, etc.); packages README says sources live in `programs/` and `examples/`; package-system tests explicitly exempt it from requiring `build.toml`. | Sidecar/tooling-owned data. | Move fixture inventory to host/kernel test tooling or a test-artifact manifest. It should not appear in Homebrew package discovery or Formula generation. |
| `userspace` | First-party `wasm_posix_userspace.wasm` boot support artifact; resolver special-cases it to `binaries/userspace.wasm`; build script writes `local-binaries/userspace.wasm` and optional resolver output. | Explicit non-package release artifact. | Keep with the Kandelo runtime/binary-release artifact set beside `kernel.wasm`. Move metadata out of package scope before deleting the registry. |
| `pcre2-source` | `kind = "source"` with only upstream URL, sha256, and license; package-management docs identify it as MariaDB's source-kind dep because MariaDB compiles PCRE2 with consumer-specific flags. | Homebrew resource/helper. | Represent it as a MariaDB Formula resource or owner-local helper input, not a standalone Formula. Preserve source URL, sha256, license, and MariaDB dependency evidence in sidecars/provenance. |
| `sqlite-cli` | Manifest-only `kind = "program"` at SQLite `3.45.0`; no build script or `build.toml`; current `sqlite` package is the maintained `3.49.1` library; the Homebrew sqlite pilot explicitly says not to revive `sqlite-cli` unless later evidence requires it. | Removal. | Remove from the accepted package set. If a sqlite3 executable is needed, fold it into the `sqlite` Formula or create a focused future bead from pilot evidence. Do not keep the stale standalone manifest. |
| `node-compat` | No `package.toml`; contains shared `bootstrap.js`; consumed by `packages/registry/spidermonkey/build-spidermonkey.sh` and tracked in SpiderMonkey build inputs. | Sidecar/tooling-owned data. | Move under the SpiderMonkey/Node-compatible runtime owner or build-tooling input set. Formula generation should treat it as source-tree data for `spidermonkey`/`spidermonkey-node`, not as a package. |
| `npm` | No `package.toml`; `fetch-npm.sh` pins npm `10.9.2`, verifies sha256, unpacks `dist/`; `node-vfs` build consumes it and already records the npm tarball as its package source. | Homebrew resource/helper. | Model the npm tarball as a `node-vfs` Formula resource/helper input. Preserve URL, sha256, version, license, and dist-pruning behavior in the owning Formula/provenance. |

No entry remains `blocked`. Registry deletion is still blocked by the
implementation work needed to move these owners out of `packages/registry`,
but the ownership decisions themselves are no longer unknown.

## Registry-Removal Follow-Ups

The classification created focused blocker beads for implementation work that
must finish before `packages/registry` can be deleted:

| Bead | Package set | Dispositions | Required outcome |
|---|---|---|---|
| `kd-t13y` | `kernel`, `userspace`, `kandelo-sdk` | Explicit non-package release artifact | Move runtime/platform artifact metadata to an explicit owner with ABI, cache-key, provenance, fallback, and smoke-status fields. |
| `kd-nacw` | `kernel-test-programs` | Sidecar/tooling-owned data | Move host/kernel test fixture inventory and output mapping out of package discovery. |
| `kd-immv` | `pcre2-source`, `node-compat`, `npm` | Homebrew resource/helper and sidecar/tooling-owned data | Fold helper/source inputs into the owning MariaDB, SpiderMonkey/Node-compatible runtime, and `node-vfs` Formula/tooling paths. |
| `kd-xmch` | `sqlite-cli` | Removal | Remove the stale standalone CLI package identity, or replace it only with evidence-backed SQLite Formula ownership. |

## Architecture And Data Flow

Target ownership:

```text
Kandelo platform artifact manifest
  kernel.wasm
  userspace.wasm
  kandelo-sdk.vfs.zst
        |
        v
runtime/npm package/binary release surfaces
  ABI, cache key, input digests, provenance, fallback state

host/kernel test tooling
  kernel-test-programs fixture inventory
        |
        v
test builds and host/runtime smoke suites

Automattic/kandelo-homebrew Formulae
  mariadb resource "pcre2-source"
  node-vfs resource/helper "npm"
  spidermonkey source input "node-compat"
  sqlite Formula owns any future sqlite3 CLI output
        |
        v
Kandelo sidecars and reports
  status, provenance, host smoke, browser smoke, upstream-test outcome lists
```

Control-flow invariants:

- Homebrew Formulae remain authoritative only for package identities Homebrew
  can install into a keg.
- Boot/runtime artifacts must not be poured as guest Homebrew packages merely
  to eliminate registry manifests.
- Source/helper inputs must be declared by the Formula that consumes them.
- Tooling/test inputs must move to explicit tooling manifests before registry
  deletion.
- Sidecars can report status for non-package platform artifacts, but they must
  not pretend those artifacts are ordinary Homebrew install targets.
- Browser compatibility remains evidence-based. A precomposed SDK or Node VFS
  image is browser-compatible only after a browser smoke boots it through the
  normal Kandelo browser host.

## Alternatives Considered

Make every entry a Formula:

- Rejected. `kernel`, `userspace`, and `kernel-test-programs` are runtime/test
  artifacts, not guest packages. Making them Formulae would mix boot state,
  test fixtures, and user-installable software in one graph.

Keep source/helper directories as hidden registry entries forever:

- Rejected. That would preserve `packages/registry` as a hidden source of
  truth and contradict the Homebrew replacement direction.

Create standalone helper Formulae for `pcre2-source`, `npm`, and
`node-compat`:

- Rejected as the default. `pcre2-source` is compiled with MariaDB-specific
  flags, `npm` is mounted into `node-vfs`, and `node-compat` is SpiderMonkey
  build source data. Owner-local resources keep dependency intent clearer.

Revive `sqlite-cli` as a separate Formula now:

- Rejected. The manifest is stale and incomplete. The maintained SQLite
  migration path is the `sqlite` library Formula; a separate CLI should be
  justified by later pilot evidence, not by an orphan manifest.

Treat `kandelo-sdk` as a normal Formula immediately:

- Rejected for this classification. The current artifact is a VFS layer whose
  compiler executable ownership is separate. It can become a package later
  only after the in-guest toolchain surface is explicitly designed.

## Risks And Mitigations

Registry deletion loses boot artifacts:

- Risk: deleting `kernel` or `userspace` manifests before replacement metadata
  exists could break fresh-checkout binary materialization.
- Mitigation: create a platform-artifact manifest or equivalent release owner
  before removing those registry entries.

SDK VFS becomes invisible:

- Risk: excluding `kandelo-sdk` from Formula generation could hide browser SDK
  support from operators.
- Mitigation: keep SDK VFS sidecar/provenance/status reporting in the
  platform-artifact path and require Node/browser smoke before compatibility
  claims.

Helper inputs become undeclared transitive dependencies:

- Risk: moving `pcre2-source`, `npm`, or `node-compat` carelessly could make
  Formula builds rely on ambient files.
- Mitigation: owning Formulae must declare resource/helper inputs and sidecars
  must record source URL, sha256, version, and consuming package.

Test fixtures lose provenance:

- Risk: removing `kernel-test-programs` from package discovery could make test
  binaries harder to rebuild or audit.
- Mitigation: host/kernel test tooling should own an explicit fixture manifest
  with output names and source paths.

SQLite CLI user confusion:

- Risk: removing `sqlite-cli` could look like dropping the sqlite3 command.
- Mitigation: document that the stale standalone manifest is removed, while any
  product sqlite3 executable should be folded into `sqlite` Formula work with
  current SQLite version and tests.

## Implementation Sequence

1. Add package-disposition metadata to the Homebrew bridge inventory so these
   eight entries cannot regress to "unclassified".
2. Add a platform-artifact owner for `kernel`, `userspace`, and
   `kandelo-sdk`, including input digests, ABI, cache key, provenance,
   fallback status, and host/browser smoke fields where applicable.
3. Move `kernel-test-programs` to host/kernel test fixture ownership.
4. Fold `pcre2-source` into the MariaDB Formula as a resource/helper input.
5. Fold `npm` into the `node-vfs` Formula as a resource/helper input and move
   `node-compat` under SpiderMonkey/Node-compatible runtime ownership.
6. Remove `sqlite-cli` from the accepted package set, or replace it with a
   focused future SQLite CLI Formula bead only if pilot evidence requires a
   separate package.
7. Update bridge validators so registry removal is refused if any current or
   future entry lacks a disposition and owner.
8. Delete the registry entries only after Formulae, platform-artifact
   manifests, tooling manifests, sidecars, docs, and tests have moved.

## Test And Documentation Plan

For this design bead:

- Run docs-only validation (`git diff --check`) and report that runtime gates
  were not run.

For implementation follow-ups:

- Add inventory/validator tests that fail on unclassified registry entries.
- Add negative tests for helper inputs missing URL, sha256, license, consumer,
  or provenance.
- Add tests for platform artifacts resolving outside the Homebrew Formula graph
  without losing ABI/cache-key/fallback checks.
- Run `cargo test -p xtask` for bridge, sidecar, or validator changes.
- Run `cd host && npx vitest run` for VFS planner/builder or binary resolver
  changes.
- Run package-specific Node and browser smoke before claiming package or
  platform-artifact compatibility.
- Do not run libc/POSIX/ABI gates unless implementation touches runtime,
  syscall, VFS, host, libc, or ABI behavior.

Documentation follow-ups:

- Update `docs/homebrew-publishing.md` when package-disposition sidecars and
  operator reports are implemented.
- Update `docs/package-management.md` only when Formulae or platform-artifact
  manifests actually replace the registry source of truth.
- Update package or test docs when `kernel-test-programs`, `npm`,
  `node-compat`, or `sqlite-cli` move.
- Keep this plan historical once the implementation lands.

## Open Questions

- What exact file owns non-package platform artifacts after registry removal:
  a new manifest under `abi/`, a release manifest under `homebrew/`, or a
  runtime artifact manifest near `host/`?
- Should `kandelo-sdk` eventually become a Formula after in-guest compiler
  ownership is designed, or remain a browser/runtime VFS artifact permanently?
- Should the future `sqlite` Formula install a sqlite3 executable, or is the
  library-only Formula enough for current product workflows?
- Should `node-compat` move physically under `packages/registry/spidermonkey/`
  during the bridge phase, or should Formula generation treat it as a shared
  source-tree input outside registry package discovery?
- Which operator report should display non-package artifact status alongside
  package bottle status without making them look installable by Homebrew?
