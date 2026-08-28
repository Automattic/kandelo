# Man page support via shell lazy-archives

Status: approved design (2026-08-27)
Builds on: `2026-08-26-shell-image-lazy-refs-design.md` (the interpreter
lazy-archive contract for python/ruby/node/perl)

## Why

Kandelo's shell demos now ship real interpreters (python, ruby,
node/npm, perl) as on-demand lazy-archives, but there is no way to read
a manual page. A user who types `man ls` or `man lsof` gets nothing —
there is no `man` viewer, no man pages captured from any package build,
and no `MANPATH`/discovery machinery. Manual pages are a baseline
expectation of a POSIX command-line environment; their absence makes
the shell feel like a stripped-down toy rather than a real system.

This work adds `man` to the same shell VFS layer, so `man ls`,
`man lsof`, and eventually `man <anything>` render the genuine upstream
manual page for the exact artifact the user is running. Each package's
manual pages ship in a dedicated, per-package `-docs` lazy-archive that
streams in only when a page from it is first read — keeping the base
image small while making the full manual set reachable on demand.

The north-star platform-values contract shapes one non-obvious
decision: the manual text must reflect the real behavior of the real
Kandelo artifact, not a host-native rebuild. Where an upstream project
generates its man pages from the compiled binary (GNU coreutils uses
`help2man`, which scrapes `PROG --help`/`PROG --version`), we generate
them by running the actual wasm binaries **inside a Kandelo instance**
at docs-build time. The manual page is then a faithful description of
what the platform actually does.

## Scope

First delivery (this PR): the mechanism, proven end-to-end on a
representative pair.

- The `man` viewer (mandoc) as its own lazy-archive `man.zip`.
- `coreutils-docs.zip` — exercises the runtime-driven generation path
  (`man ls`, `man cat`, ...).
- `lsof-docs.zip` — exercises the direct-capture path (`man lsof`).

After this PR lands, more `<pkg>-docs` bundles are added under the same
worktree by following the documented pattern.

Viewer scope for this PR: `man <name>` / `man <section> <name>` lookup
and rendering only. `whatis`, `apropos`, and `man -k` (keyword search
over a `mandoc.db` index) are Future Work — see below.

## Non-goals

- No `whatis`/`apropos`/`man -k`/index database in this PR.
- No man-db or groff. mandoc only.
- No custom/hand-written man formatter. A bespoke formatter would be an
  alternate implementation of `man`, which the platform-values contract
  forbids. mandoc is the real tool.
- No baking man pages into the base image. Docs are per-package,
  streamed on demand.

## Architecture

Everything ships as lazy-archives mounted at `/usr/`, exactly like the
interpreter bundles. There are two archive kinds:

- **Viewer archive** `man.zip` (built by `mandoc-browser-bundle`):
  carries `bin/mandoc`, `bin/man` (and the `apropos`/`whatis`
  front-ends, unused until Future Work) plus mandoc's support files.
  This is a normal executable-bearing archive.
- **Per-package docs archives** `<pkg>-docs.zip` (built by `<pkg>-docs`
  packages): carry only `share/man/manN/*.N` files. **No executable.**
  Proof set: `coreutils-docs.zip`, `lsof-docs.zip`.

### Registration happens at VFS image build time

The lazy-archives are registered at **VFS image build time**, not at
boot. The image builders call `MemoryFileSystem.registerLazyArchiveFrom
Entries(...)`, which:

- `mkdir`s the archive's directories (ignoring "already exists"), so
  independent archives share directory nodes; and
- creates one lazy **stub** per file plus the archive's integrity/mount
  metadata,

and all of that is baked into the emitted `.vfs` image. When a demo
boots, it loads the pre-built image with the stubs already present. The
compressed archive bytes are fetched only when a stub is first read, via
the lazy-URL contract.

Because directories are shared and files are per-archive stubs, multiple
`-docs` archives coexist under one `/usr/share/man` tree:
`coreutils-docs.zip` contributes `man1/ls.1`, `man1/cat.1`, ...;
`lsof-docs.zip` contributes `man8/lsof.8`; both live under the same
`/usr/share/man/manN/` directories.

### `man ls` data flow (runtime)

1. `man ls` invokes mandoc's `man` front-end.
2. It reads `/etc/man.conf` (`manpath /usr/share/man`) and globs
   `/usr/share/man/man1/ls.1` — a lazy stub.
3. Reading the stub faults in `coreutils-docs.zip`'s bytes.
4. mandoc parses the troff/mdoc source and renders `-Tutf8`.
5. Output goes to `$MANPAGER` (paged through `less` when available and
   interactive) or straight to stdout.
6. A missing page yields mandoc's honest
   `man: No entry for X in the manual`.

## Components

### `mandoc` package + `mandoc-browser-bundle`

- `mandoc`: source build of mandoc (mandoc.bsd.lv portable
  distribution) with the SDK. Produces `bin/mandoc` and the
  `man`/`apropos`/`whatis` front-ends. mandoc is self-contained C with
  no groff/perl/man-db dependency and searches the manpath by
  filesystem globbing, so no index database is required for this PR's
  scope. New `package.toml` + `build.toml` + `build-mandoc.sh`.
- `mandoc-browser-bundle`: depends on `mandoc`, reshapes its outputs
  into a root-relative `man.zip` (`bin/man`, `bin/mandoc`, support
  files), declared output `name=man wasm=man.zip`. Mirrors the
  interpreter `-browser-bundle` packages.

### `lsof-docs` package (direct capture)

lsof's upstream source tarball ships a ready nroff man page
(`Lsof.8`). The recipe extracts it, installs it as
`share/man/man8/lsof.8`, and emits `lsof-docs.zip`. No runtime, no
compilation — pure extraction. `depends_on` includes lsof's source
only as needed to obtain the page. This is the lightweight template
that most future `-docs` bundles will follow.

### `coreutils-docs` package (runtime-driven generation)

This is the one genuinely new build shape. GNU coreutils does not ship
man pages in source; they are generated at build time by `help2man`,
which runs each freshly-compiled binary. Because we cross-compile to
wasm, the build host cannot execute the target binaries — so the pages
are generated by running the real wasm binaries **inside Kandelo**:

- `depends_on`: the built `coreutils` output, the `kernel`, and `perl`
  (help2man is Perl; see the execution-locus decision below).
- `build-coreutils-docs.sh` drives a Node/tsx harness that:
  1. boots **one** `NodeKernelHost` with a rootfs containing the built
     coreutils binaries (the interpreter offline harness pattern);
  2. for each coreutils program, runs `<prog> --help` and
     `<prog> --version` inside that instance and captures stdout;
  3. feeds the captured output to host-side `help2man` via a thin
     per-tool wrapper (the wrapper shells `PROG` into the running
     Kandelo instance, so the *content* is 100% from the wasm binary —
     only the troff-formatting Perl runs on the host);
  4. installs the emitted `.1` files under `share/man/man1/` and emits
     `coreutils-docs.zip`.

**Build-order dependency (documented boundary):** unlike an ordinary
compile recipe, this docs recipe needs a *built kernel + runtime
rootfs*, not just the SDK. It is a runtime-driven build step. This is
the deliberate cost of faithfulness: the manual text describes the real
wasm artifact's behavior, not a host-native rebuild. The host-side
`help2man` execution is a documented build-host boundary, not a runtime
shim.

### Lazy-archive spec generalization

`ShellLazyArchiveSpec` today assumes every archive carries exactly one
`bin/<exe>` (`requiredExecutable`), and `loadDeclaredShellLazyArchive`
asserts "exactly one regular executable". Docs archives have **no**
executable. The spec is widened:

- add a `kind: "program" | "docs"` discriminator (or an optional
  `requiredMember`);
- for `program` archives, keep the existing "exactly one executable"
  validation on `requiredExecutable`;
- for `docs` archives, validate on a required *file* member instead
  (e.g. a known man page such as `share/man/man8/lsof.8`), and skip the
  executable assertion.

`host/test/shell-lazy-archive-inputs.test.ts` iterates the specs with
`it.each`, so new specs are auto-covered; a focused test is added for
the new `docs` validation path.

### manpath and pager configuration

- Ship `/etc/man.conf` containing `manpath /usr/share/man` so mandoc's
  `man` front-end has a search root.
- Set `MANPAGER` via `/etc/profile.d` (a shared helper, mirroring
  `registerPythonShellProfile`). If `less` is present in the shell
  base, page through it; otherwise default `MANPAGER=cat` (non-paged)
  for this PR. `less` availability is verified during implementation;
  interactive paging refinement is noted but not a blocker.

## Wiring (mirrors the interpreter lazy-archive contract)

For **each** new archive (`man`, `coreutils-docs`, `lsof-docs`):

1. `images/vfs/scripts/shell-lazy-archives.ts` — add a
   `SHELL_LAZY_ARCHIVE_SPECS` entry (with the new `kind`).
2. `images/vfs/scripts/build-source-rootfs-shell-image.ts` +
   `source-rootfs-shell-overlay.ts` — the main-shell demo
   (`browser-main-shell`); the generic loop registers each archive, and
   a `/bin/man` symlink is added for the viewer.
3. `images/vfs/scripts/shell-vfs-build.ts` `populateShellEnvironment` —
   the composite demos; register the archives explicitly.
4. Shell `package.toml` `depends_on`;
   `source-rootfs-shell-dependencies.json`; `test-build-shell.sh`
   archive count; `local-supported.toml`; browser side
   (`apps/browser-demos/lib/init/lazy-archives.ts`,
   `shell-lazy-url-contract.ts`,
   `web-libs/kandelo-session/src/vfs-asset-group-reference.ts`).

`program-packages.json` is gitignored and regenerated by
`build-deps program-index`.

## Testing and validation

Per the validation contract, each claim is backed by the evidence for
that exact claim, and the report states what ran on which host.

- **Host/unit**: `shell-lazy-archive-inputs.test.ts` auto-covers the new
  specs; add a focused test for the `docs`-kind validation path
  (docs archive with no executable passes; a `program` archive missing
  its executable still fails).
- **Functional (Node-host offline)**: boot `shell.vfs.zst` under
  `NodeKernelHost`, bind `man.zip` + `coreutils-docs.zip` +
  `lsof-docs.zip` offline (the interpreter offline harness), run
  `man ls` and `man lsof`, and assert real rendered content (the
  `NAME`/`SYNOPSIS` sections appear).
- **Browser**: Playwright `?demo=shell` — `man ls` and `man lsof`
  render live.

## Future Work

Recorded here as the future-work doc for this effort:

1. **`whatis` / `apropos` / `man -k` keyword search.** Requires each
   `-docs` bundle to carry a `makewhatis`-generated `mandoc.db` index,
   plus a strategy for merging indexes across independently-mounted
   lazy-archives and managing the combined manpath database. Its own
   subproject.
2. **Run `help2man` fully inside Kandelo.** Maximal dogfooding: execute
   the Perl `help2man` itself inside the Kandelo instance via the perl
   lazy-archive, removing the host-side formatting step entirely. Adds a
   perl fork/pipe (`open("PROG |")`) dependency on the docs-build
   critical path, so it is deferred until that path is proven robust; a
   hardening follow-up, not a blocker.
3. **Generalize `-docs` bundles** to the rest of the registry packages
   that carry (or can faithfully generate) man pages, following the
   `lsof-docs` (direct capture) and `coreutils-docs` (runtime-driven)
   templates.
