# Base shell image: sqlite3, python, perl, and ruby as lazy refs

Status: draft for review
Date: 2026-08-26

## Why

The browser shell demo ships an interactive base image whose tools —
`git`, `vim`, `less`, `tar`, `curl`, and friends — are installed as
"lazy refs": the VFS image (`rootfs.vfs` plus the shell overlay) stores
only an executable stub plus URL/size/mode metadata, and the real Wasm
is fetched on first `exec`. This keeps the image small while making a
full toolset appear preinstalled.

Four widely-used tools are absent from that toolset even though Kandelo
already builds every one of them:

- `sqlite3`, the SQLite command-line client. We build the SQLite
  library (`libsqlite3.a`, consumed by PHP) and there is a non-building
  `sqlite-cli` package skeleton, but the CLI is not in the shell image.
- `python3` (CPython 3.13.3), `perl` (5.40.3), and `ruby` (4.0.5). All
  three build today and have (or nearly have) runtime artifacts, but
  none is wired into the shell image; some are only reachable through
  standalone `*-vfs` demo images or a Node-only demo.

A user who opens the shell demo and types `sqlite3`, `python3`, `perl`,
or `ruby` gets "command not found." That is a gap between what the
platform can do and what the base image exposes. This work closes it by
building each tool through the normal package path and wiring it in
using the same lazy-ref mechanism `git` and `vim` already use — no
demo-specific shortcuts, no synthesized success.

## Background: how a lazy ref is installed

Two registries feed the shell image, both under `images/vfs`, and the
shell overlay adds tools on top of the imported `rootfs.vfs`. A tool is
declared through three coordinated, cross-validated edits, plus a
browser-side URL map for host parity:

1. **Dependency contract (JSON)** —
   `packages/registry/shell/source-rootfs-shell-dependencies.json`.
   One entry `{ "name", "version", "role" }`. Valid roles:
   `base-image`, `eager-program`, `lazy-file`, `lazy-archive`.
2. **Package manifest (TOML)** —
   `packages/registry/shell/package.toml` `depends_on`. The contract
   reader asserts this list and the JSON are identical (same names +
   versions) or the build fails.
3. **VFS placement spec (TypeScript)** — one of:
   - `images/vfs/lib/init/shell-binaries.ts`
     (`SHELL_LAZY_BINARY_SPECS`) for a **lazy-file**:
     `{ id, resolverPath, vfsPath, symlinks }`.
   - `images/vfs/scripts/shell-lazy-archives.ts`
     (`SHELL_LAZY_ARCHIVE_SPECS`) for a **lazy-archive**:
     `{ id, dependency, resolverPath, archiveUrl, mountPrefix,
     requiredExecutable }`.
4. **Browser URL map** —
   `apps/browser-demos/lib/init/shell-lazy-files.ts` (and the
   lazy-archive equivalent) maps the placeholder URL to the fetch URL
   for the browser host. This is a cross-host change, so Node and
   browser must stay at parity.

At build time the strict resolver
(`images/vfs/scripts/build-source-rootfs-shell-image.ts:437-458`)
resolves a spec's `id`/`dependency` to real bytes by reading
`basename(resolverPath)` out of `WASM_POSIX_DEP_<DEP>_DIR`, where
`<DEP>` is the dependency name upper-cased with `-`→`_`. The resolver
does **not** care about package `kind`; it only requires that the named
dependency is declared in the contract and that the file exists in its
dep dir. `build-shell.sh` sets those `WASM_POSIX_DEP_*_DIR` vars for
every resolver-owned dependency.

**lazy-file vs lazy-archive.** A `lazy-file` is a single self-contained
`.wasm` mapped to one VFS path (plus symlinks). A `lazy-archive` is a
zip *tree* mounted under a prefix, for tools that need runtime files
alongside the binary. The archive loader
(`host/src/vfs/memory-fs.ts:648-654`) joins each zip entry onto the
mount prefix unconditionally: with `mountPrefix: "/usr/"` (normalized to
`/usr`), a zip entry `bin/vim` becomes `/usr/bin/vim`. The loader
(`shell-lazy-archives.ts:123-134`) requires **exactly one** regular
(non-dir, non-symlink) entry whose raw name equals
`requiredExecutable` — matched against the zip entry name with **no**
mount prefix applied. Therefore a lazy-archive zip must be rooted at
`bin/<exe>` + `lib/...`/`share/...` with **no leading `usr/` prefix**;
a `usr/`-rooted zip both fails the `requiredExecutable` check and
double-mounts to `/usr/usr/...`.

## Scope

In scope:

- A buildable `sqlite-cli` program package and its lazy-file wiring
  (PR 1).
- Three `*-browser-bundle` packages (python, perl, ruby) and their
  lazy-archive wiring (PR 2).
- Browser-host URL maps for all four (host parity).
- Runtime standard-library discovery so each interpreter actually runs
  from the mounted tree.
- Documentation updates for the shell toolset.

Out of scope / non-goals:

- No change to the `sqlite` library package, so PHP and other SQLite
  consumers are not rebuilt.
- No new interpreter features, version bumps beyond matching existing
  builds, or SDK/libc changes.
- No change to the lazy-ref mechanism itself beyond widening the
  TypeScript literal-union types that enumerate archive specs.

## PR 1 — sqlite3 as a lazy-file

### Decision: make `sqlite-cli` a real program that links the library

`packages/registry/sqlite-cli/` exists today as a stub: `package.toml`
only, no `build.toml`, no build script, `depends_on = []`, and a 3.45.0
autoconf `[source]` that mismatches the library's 3.49.1. It cannot be
built or resolved.

We turn it into a real `kind = "program"` package that **depends on the
`sqlite` library and links only the CLI frontend** (`shell.c`) against
the prebuilt `libsqlite3.a`, rather than recompiling the ~250k-line
amalgamation. This was chosen over two alternatives:

- **Rejected — expose the CLI from the `sqlite` library package.** The
  library build deliberately refuses to emit the CLI through the
  resolver (`build-sqlite.sh:40-53`: "CLI is a consumer artifact, not a
  library. Skip it when invoked via the resolver..."). Forcing it on
  would reverse that intentional design, conflate the library and
  program roles under one identity, and — because `php/package.toml`
  pins `sqlite@3.49.1` — bump the sqlite revision and force PHP (and
  every future sqlite consumer) to rebuild. Given known cache-key
  drift, poking a base library is exactly what triggers slow full
  source rebuilds.
- **Rejected — recompile the full amalgamation in sqlite-cli.** Works,
  but ships a second, independently-flagged SQLite engine build that
  can drift from the library PHP links. Linking `libsqlite3.a` gives a
  single engine source of truth and a tiny build.

Result: one SQLite version in the image (3.49.1), zero change to the
`sqlite` library, and a clean program package that mirrors `git`.

### Build script

Model on `netcat` (resolver-vs-developer output handling) plus `git` /
`vim` (link a static lib + fork-instrument). Key points, all grounded
in existing scripts:

- **Dependency:** `depends_on = ["sqlite@3.49.1"]`. The resolver
  provides `WASM_POSIX_DEP_SQLITE_DIR` containing `lib/libsqlite3.a`,
  `include/sqlite3.h`, `include/sqlite3ext.h`, `lib/pkgconfig`. It does
  **not** contain `shell.c`.
- **Source for `shell.c` only:** `sqlite-cli` keeps its own `[source]`,
  repointed to the **3.49.1 amalgamation zip** (same version as the
  library) so the compiled `shell.c` matches the linked library. Bump
  `version` to `3.49.1`.
- **Compile/link:**
  `wasm32posix-cc <cflags> -I"$SQLITE_DIR/include" "$SRC/shell.c"
  -L"$SQLITE_DIR/lib" -lsqlite3 -lm
  -Wl,-z,stack-size=1048576 -Wl,--export=__abi_version -o sqlite3.wasm`.
- **Feature-flag consistency (must-fix):** the library is built with
  `-DSQLITE_OMIT_LOAD_EXTENSION`. `shell.c` references
  `sqlite3_load_extension`/`.load`, so it must be compiled with the
  **same** `-DSQLITE_OMIT_LOAD_EXTENSION` (and any other library
  feature flags that affect the CLI surface) or linking fails on an
  unresolved symbol. The build must derive or mirror the library's
  relevant flags, not guess them.
- **Fork instrumentation (required):** `.shell`, `.system`, and
  `.import` (via `popen`) fork, so the artifact must be fork-
  instrumented via `scripts/run-wasm-fork-instrument.sh` as the final
  step (after any `wasm-opt`), matching `git`/`vim`. Do **not** use the
  check-only `wasm_require_fork_instrumentation_if_needed` guard that
  non-forking tools like `netcat` use.
- **Output:** the declared `sqlite3.wasm`, installed into
  `WASM_POSIX_DEP_OUT_DIR` (resolver mode) or via
  `install_local_binary` (developer mode).
- **build.toml:** add one listing the build script and
  `scripts/run-wasm-fork-instrument.sh` as inputs, mirroring
  `packages/registry/sqlite/build.toml`, with a `[binary] index_url`.

### Wiring

- Contract JSON: `{ "name": "sqlite-cli", "version": "3.49.1",
  "role": "lazy-file" }`.
- `shell/package.toml` `depends_on`: add `"sqlite-cli@3.49.1"`.
- `SHELL_LAZY_BINARY_SPECS`: `{ id: "sqlite-cli",
  resolverPath: "programs/sqlite3.wasm", vfsPath: "/usr/bin/sqlite3",
  symlinks: ["/bin/sqlite3"] }`. (`id` → `WASM_POSIX_DEP_SQLITE_CLI_DIR`;
  basename `sqlite3.wasm`.)
- Browser URL map entry in
  `apps/browser-demos/lib/init/shell-lazy-files.ts`.

### Validation (PR 1)

- Build the `browser-main-shell` product; confirm `sqlite3.wasm`
  resolves and the shell image builds.
- Confirm PHP is **not** rebuilt (the `sqlite` library is untouched;
  verify its cache entry is unchanged).
- In `./run.sh browser`: open the shell demo, run `sqlite3`, create a
  table, insert, select, and confirm `.tables`/`.quit` behave. Confirm
  a fork-using dot-command (e.g. `.shell echo hi`) works, exercising
  the fork instrumentation. This is a browser-facing fix, so per the
  validation contract it is not complete on code reasoning alone.
- Node parity: run the same client under the Node host path.

## PR 2 — python, perl, ruby as lazy-archives

### Decision: three `*-browser-bundle` packages, mirroring vim

All three interpreters need their standard-library tree at runtime, so
each is a lazy-archive, not a lazy-file. None of the existing artifacts
is loader-consumable as-is:

- **ruby** — `ruby-runtime.zip` is a first-class output but is
  `usr/`-rooted (`usr/bin/ruby`, `usr/lib/ruby`): it would mount to
  `/usr/usr/bin/ruby` and has no root-level `bin/ruby`.
- **python** — `python-runtime.zip` is correctly root-relative
  (`lib/python3.13/...`) but contains **stdlib only, no `bin/python3`**
  (the interpreter is the separate `python.wasm`).
- **perl** — emits **no** zip; its stdlib exists only in the
  `packages/registry/perl/perl-src/{lib,cpan,dist,ext}` checkout, which
  `build-perl-vfs-image.ts` reads to build the standalone
  `perl-vfs.vfs.zst`.

Each therefore needs a reshaping step that produces a root-relative zip
containing `bin/<exe>` plus the stdlib. vim already establishes the
repo convention for exactly this: `build-vim-zip.sh:88` — "This ZIP is
the declared output of vim-browser-bundle, not vim: vim owns vim.wasm
and its runtime tree." The reshaping (rename binary to `bin/<exe>`,
relayout runtime, deterministic zip, no `usr/` prefix) lives in a
dedicated bundle package so shell-image layout coupling stays out of
the general-purpose interpreter package and the resolver validates the
output against the bundle's own manifest.

**Decision:** create `python-browser-bundle`, `perl-browser-bundle`,
and `ruby-browser-bundle`, each `kind = "program"`, each depending on
its interpreter package, each emitting a `<tool>.zip` rooted at
`bin/<exe>` + the interpreter's stdlib prefix, with
`requiredExecutable: "bin/<exe>"` and `mountPrefix: "/usr/"`. Use
`create-deterministic-zip.sh` as vim does.

Considered and not chosen: adding a bundle-shaped output directly to
each interpreter package. Mechanically possible (the resolver ignores
`kind`), but it pushes shell-image layout knowledge into `cpython` /
`perl` / `ruby`, which the codebase deliberately avoids. Revisit only
if a maintainer prefers fewer packages over pattern consistency.

### Per-interpreter bundle contents

- **ruby (smallest):** re-root the existing `usr/`-rooted payload to
  `bin/ruby` + `lib/ruby/<x.y.0>/...` (drop the leading `usr/`). Ruby
  already has a fork-instrumented `ruby.wasm` and a runtime staging
  step to reuse. Ship the full command suite typical of a Ruby
  environment — `ruby`, `gem`, `irb`, `bundle`, `bundler` — which the
  lazy-archive delivers in one ref because it mounts a tree, not a
  single file (see "Ruby command suite" below).
- **python (medium):** merge `python.wasm` in as `bin/python3` and
  include the `lib/python3.13/...` stdlib from `python-runtime.zip`
  (already root-relative). Expose `python3` as the `requiredExecutable`
  and add a `python` symlink; do not ship a `cpython` alias.
- **perl (largest):** synthesize a new zip from
  `perl-src/{lib,cpan,dist,ext}` — port the selection logic in
  `build-perl-vfs-image.ts` (`.pm/.pl/.ph`, `Config_*`, excluding
  tests/docs/C sources) into a root-relative tree at
  `lib/perl5/5.40.3/...`, plus `bin/perl` from `perl.wasm`.

### Ruby command suite (gem, irb, bundle, bundler)

Because the Ruby lazy-archive mounts a tree rather than a single file,
the whole `bin/` suite ships in one ref — no per-command lazy refs.
`gem`, `irb`, `bundle`, and `bundler` are Ruby scripts executed through
the host shebang handler (`host/src/exec-target.ts:198,312`), which
supports one level of `#!` indirection like Linux but does **no PATH
search for the interpreter** — the interpreter path is resolved
verbatim.

Two build facts drive the bundle's handling:

- Ruby's build hand-writes `gem`/`bundle`/`bundler` with
  `#!/usr/bin/env ruby`, while `make install` stubs (`irb`, …) use an
  absolute `#!/usr/bin/ruby`. Env-style shebangs would require a real
  `/usr/bin/env` binary; absolute shebangs resolve directly.
- `irb` is only present if `make install` succeeds; its libraries
  (`irb`, `reline`) and `io/console` (a statically linked C extension)
  are always in the tree.

**Decision:** the `ruby-browser-bundle` stages `ruby`, `gem`, `irb`,
`bundle`, `bundler` explicitly and **normalizes every wrapper shebang
to absolute `#!/usr/bin/ruby`** — this sidesteps the `/usr/bin/env`
dependency and the shebang inconsistency, and matches the tree's
mounted interpreter path (`/usr/bin/ruby`). `requiredExecutable` stays
`bin/ruby`; the other commands ride along in the same tree.

**Truthful-failure boundary:** `irb` and pure-Ruby `gem` operations
work, but `gem install` of gems with native C extensions cannot compile
under Wasm today and fails honestly. This is documented as a real
platform boundary, to be revisited once Kandelo supports native builds
in-image — not hidden.

### Runtime standard-library discovery

Mounting the tree is necessary but not sufficient: when a user types
`python3`, the interpreter must **find** its stdlib. The standalone
`*-vfs` images set this up via an `autoCommand` (`python-vfs` sets
`PYTHONHOME=/usr`; ruby's Node demo sets `RUBYLIB`), but a shell
lazy-archive has **no autoCommand hook**.

**Decision:** rely on each interpreter's compiled-in `--prefix=/usr`
resolving to the mounted `/usr/...` tree (Ruby builds with
`GUEST_PREFIX=/usr`; Perl's privlib is `/usr/lib/perl5/5.40.3`; Python
is configured with `--prefix=/usr`). We do **not** add `/etc/profile.d`
env files up front. This policy is revisited only if a specific
interpreter proves it needs explicit env — a discovered gap is then a
platform fix, not demo-config papering.

Per the platform-values contract, "it runs" must still be **verified by
actually running each interpreter in `./run.sh browser`**, not assumed.

### Wiring (per interpreter)

- Contract JSON: `{ "name": "<tool>-browser-bundle", "version": "...",
  "role": "lazy-archive" }`.
- `shell/package.toml` `depends_on`: add
  `"<tool>-browser-bundle@<version>"`.
- Generalize the `ShellLazyArchiveSpec` types in
  `shell-lazy-archives.ts` from the hard-coded `vim`/`nethack` literal
  unions (`id`, `dependency`, `resolverPath`, `archiveUrl`,
  `requiredExecutable`) to plain `string` fields validated at runtime.
  Decided: avoid overspecific types and repeated type surgery so future
  tools need no type edits.
- Add a `SHELL_LAZY_ARCHIVE_SPECS` entry per interpreter with
  `mountPrefix: "/usr/"` and `requiredExecutable: "bin/<exe>"`.
- Browser URL map for the lazy-archive path.

### Validation (PR 2)

- Build `browser-main-shell`; confirm all three bundle zips resolve and
  pass the loader's single-`requiredExecutable` check (no `/usr/usr`
  double-mount).
- In `./run.sh browser`: run each interpreter and execute a small
  program that imports/uses a stdlib module (e.g. Python `import json,
  os`; Perl `use strict; use List::Util`; Ruby `require 'json'`) to
  prove stdlib discovery works from the mounted tree.
- Exercise fork paths where relevant (Ruby `system`/`spawn`), since the
  interpreters are fork-instrumented programs.
- Run the Ruby command suite: `gem --version`, `irb` (start the REPL and
  evaluate an expression), and `bundle --version`, confirming the
  normalized `#!/usr/bin/ruby` shebangs resolve. Confirm `gem install`
  of a native-extension gem fails with a clear error (the documented
  boundary), not a hang or a false success.
- Node parity: the same runs under the Node host path.

## Cross-cutting concerns

- **ABI:** no ABI-adjacent change is intended. All artifacts are built
  through the normal package path and fork-instrumented via the current
  `run-wasm-fork-instrument.sh`. If any interpreter build surfaces a
  fork-buffer or instrumentation limit, that is a platform issue to
  escalate under the ABI contract, not to work around in the bundle.
- **Host parity:** every wiring change includes the browser URL map so
  Node and browser expose the same tools. No Node-first landing.
- **Cache keys / revisions:** each new/changed package gets a
  `build.toml` with a `[binary] index_url` and correct inputs so binary
  resolution works in fresh worktrees (see the known cache-key drift
  issue); source builds must remain reproducible.
- **Documentation:** update the shell toolset docs / demo tool list to
  include `sqlite3`, `python3`, `perl`, `ruby`. Do not document them as
  available until the browser validation above passes.

## Sequencing

1. **PR 1 — `Packages: sqlite3 CLI in the base shell image`.** Small,
   self-contained, no interpreter risk. Ships first.
2. **PR 2 — `Packages: python/perl/ruby in the base shell image`.** The
   three bundle packages + lazy-archive wiring + stdlib-discovery
   correctness. Larger; ruby/perl carry the most new packaging.

## Decisions resolved during review

1. **Stdlib discovery** — trust each interpreter's compiled-in
   `--prefix=/usr`; no `/etc/profile.d` env files up front. Policy
   adjustable if an interpreter proves it needs explicit env.
2. **Archive-spec typing** — generalize `ShellLazyArchiveSpec` to
   runtime-validated `string` fields; avoid overspecific types and
   repeated type surgery.
3. **Python aliases** — ship `python3` + a `python` symlink; no
   `cpython` alias.
4. **sqlite-cli feature set** — keep the CLI feature-consistent with
   the library (compile `shell.c` with `-DSQLITE_OMIT_LOAD_EXTENSION`,
   so `.load` is absent). Enabling load-extension is a possible future
   change, not part of this work.
5. **Ruby command suite** — ship `ruby`, `gem`, `irb`, `bundle`,
   `bundler` in the one archive, with wrapper shebangs normalized to
   absolute `#!/usr/bin/ruby` and `irb` staged explicitly. Document the
   native-extension `gem install` boundary; revisit when in-image
   native builds exist.

## To verify during implementation

- **Python prefix sufficiency** — confirm `--prefix=/usr` alone lets
  CPython find `/usr/lib/python3.13` without `PYTHONHOME`; if not, add a
  single env file per the policy above.
- **sqlite-cli flag derivation** — confirm the exact set of library
  build flags (beyond `-DSQLITE_OMIT_LOAD_EXTENSION`) that affect the
  CLI surface, and mirror them onto the `shell.c` compile.
- **Ruby suite execution** — run each of `gem`, `irb`, `bundle` in the
  browser to confirm the normalized shebangs resolve to `/usr/bin/ruby`
  and the tools start.
