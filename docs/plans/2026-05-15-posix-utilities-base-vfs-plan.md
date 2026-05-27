# POSIX Utilities in the Kandelo Base VFS

Date: 2026-05-15

## Goal

Include every practically supportable missing POSIX utility in Kandelo's
canonical base VFS image, `host/wasm/rootfs.vfs`.

This is different from the browser shell demo's current lazy-binary path:

- `rootfs.vfs` is built by `scripts/build-rootfs.sh` from `MANIFEST` and
  `images/rootfs/`.
- It is the default `/` image for Node and Browser `kernel.boot()` paths.
- It also supplies `/etc/*` to legacy SAB-backed demos through the kernel-worker
  overlay path.
- It must remain deterministic and reproducible because it is the base image
  all higher-level images compose with or assume.

The source inventory and utility classification live in:

- `docs/plans/2026-05-15-posix-utilities-shell-demo-plan.md`

This plan describes how those supportable utilities become part of the base
VFS rather than only the shell demo.

## Constraints

1. The base VFS is shared infrastructure, not a demo-specific convenience.
   Utilities placed here must work in Node and Browser hosts.
2. The base VFS should not depend on page code calling
   `BrowserKernel.registerLazyFiles()`. Kernel-owned boot restores only the
   image. Any laziness must be encoded inside the image itself or avoided.
3. The current `mkrootfs` builder starts with a 16 MiB SAB. Adding real binaries
   will exceed that quickly, so the builder needs a configurable size.
4. The top-level `MANIFEST` is the source of truth for rootfs content today, but
   package outputs are produced by the resolver under `local-binaries/` or
   `binaries/`. We need a deterministic bridge between those systems.
5. Writable runtime state must stay out of the image. `/tmp`, `/var/tmp`,
   `/var/log`, `/var/run`, `/home/user`, `/root`, and `/srv` already mount as
   scratch in the default mount spec.

## Image Composition Strategy

Create a base-userspace composition layer on top of the existing rootfs build:

1. Add `images/rootfs/PACKAGES.toml` or `images/rootfs/packages.json`.
   It lists packages required for the base VFS and maps each package output to
   one or more VFS paths.
2. Extend `scripts/build-rootfs.sh` to resolve every listed package output from
   `local-binaries/` or `binaries/`.
3. Use the resolved outputs to validate availability and determine lazy file
   sizes.
4. Generate a derived manifest fragment with `lazy_url=` and `lazy_size=` by
   default, or `src=` only for outputs explicitly marked eager.
5. Invoke `mkrootfs build` with:
   - the existing top-level `MANIFEST`;
   - the existing `images/rootfs/` source tree;
   - the generated package manifest fragment;
   - a larger explicit SAB size.
6. Keep `MANIFEST` focused on static base filesystem content, and keep generated
   binary entries out of the checked-in static source tree.

This requires small `mkrootfs` enhancements:

- accept multiple manifest files, applied in order;
- add `--sab-size <bytes>`;
- support URL-backed lazy file entries inside `rootfs.vfs`.

For the first full inclusion pass, prefer lazy package outputs. The base image
should carry executable stubs and URL/size metadata for ordinary utilities, then
materialize Wasm payloads on first exec. Mark a package output `install =
"eager"` only after we find a concrete reason to keep it resident in the image;
interactive shells such as `bash` are good candidates because they are normally
started on every shell boot.

## Runtime Layout

Use a normal Unix layout:

- Programs: `/usr/bin/<name>`
- Compatibility symlinks: `/bin/<name>` only for commands historically expected
  there or already exposed there by the shell demo.
- Multi-call or package aliases:
  - `awk` -> `gawk`
  - `ex` -> Vim ex-mode wrapper or symlink strategy
  - `compress` / `uncompress` from the same package
  - gettext runtime/build tools from the same package
  - `find` / `xargs` from findutils
  - `diff` / `cmp` from diffutils

Avoid adding `/usr/local/bin` entries to the base VFS. That path remains for
user or demo-specific additions.

## Package Groups

### Group A: Already-Ported Packages To Wire Into Base VFS

These should be the first base-image additions because they mostly need package
resolution and VFS mapping work:

| Utility | Package | Base VFS Paths |
| --- | --- | --- |
| `awk` | `gawk` | `/usr/bin/gawk`, `/usr/bin/awk`, optional `/bin/awk` |
| `find` | `findutils` | `/usr/bin/find`, optional `/bin/find` |
| `xargs` | `findutils` | `/usr/bin/xargs`, optional `/bin/xargs` |
| `diff` | `diffutils` | `/usr/bin/diff`, optional `/bin/diff` |
| `cmp` | `diffutils` | `/usr/bin/cmp`, optional `/bin/cmp` |

Required work:

- Add these packages to the base-userspace package list.
- Ensure their release archives are present in the binary index.
- Add smoke tests under Node and Browser:
  - `awk 'BEGIN { print 42 }'`
  - `printf 'a\n' > /tmp/a; cp /tmp/a /tmp/b; cmp /tmp/a /tmp/b`
  - `diff /tmp/a /tmp/b`
  - `find /tmp -name a`
  - `printf 'one\ntwo\n' | xargs echo`

### Group B: Small In-Tree Utilities

Create one package, `posix-utils-lite`, with multiple C sources and outputs.
These should be in-tree because the POSIX behavior is small, the dependencies
are minimal, and the integration cost of separate upstream ports would be
higher than the implementation.

| Utility | Implementation Notes |
| --- | --- |
| `asa` | Transform ASA carriage-control input to plain text output. |
| `cal` | Gregorian calendar output; document any locale/calendar limits. |
| `fuser` | Read `/proc/<pid>/fd` like `lsof`; report PIDs using a file. |
| `getconf` | Table-driven frontend over `sysconf()` / `pathconf()` constants. |
| `ipcrm` | SysV IPC removal using `msgctl`, `semctl`, `shmctl`. |
| `ipcs` | SysV IPC listing; add kernel enumeration support if needed. |
| `locale` | Report supported categories and values, initially `C`/`POSIX` plus any intentional UTF-8 locale. |
| `logger` | Write to a simple host/kernel log sink; start with stderr fallback only if documented. |
| `ps` | Read `/proc`, `/proc/<pid>/stat`, `/status`, `/cmdline`; support POSIX `-A`, `-p`, and `-o` first. |
| `renice` | Use existing `getpriority()` / `setpriority()` support. |
| `tabs` | Emit terminal tab-stop control sequences for `TERM=xterm-256color`. |
| `uudecode` | Shared uuencode/uudecode source. |
| `uuencode` | Shared uuencode/uudecode source. |
| `what` | Scan files for SCCS `@(#)` markers. |

Required work:

- Add `packages/registry/posix-utils-lite/package.toml`.
- Add `packages/registry/posix-utils-lite/build-posix-utils-lite.sh`.
- Build each utility as a separate Wasm output for straightforward `argv[0]`
  behavior and smaller future replacement granularity.
- Add rootfs package mappings for every output.
- Add tests that exercise the kernel substrate:
  - `ps` sees at least itself and init where applicable.
  - `fuser` sees a file held open by a child.
  - `ipcs` sees a created SysV IPC object; `ipcrm` removes it.
  - `renice` changes the stored nice value visible in `/proc/<pid>/stat`.

### Group C: Pager, Editor, and Terminal Utilities

| Utility | Package Plan |
| --- | --- |
| `ed` | Port GNU ed or a compact BSD-compatible ed. |
| `ex` | Provide through the existing Vim package as `/usr/bin/ex`; use a wrapper if Vim needs `argv[0]` or `-e`. |
| `man` | Add a minimal viewer plus a small base manpage tree. It can page through `more`/`less` or print directly when no pager exists. |
| `more` | Implement a small pager or wrap `less` after fixing the current `less` release/build issue. |
| `tput` | Port a small terminfo frontend, likely via ncurses once the terminfo data layout is defined. |

Required work:

- Decide whether `less` becomes a base dependency or whether `more` is an
  independent small pager.
- Add `/usr/share/terminfo` or a compact terminfo subset for `xterm-256color`
  before shipping `tput`.
- Add `/usr/share/man` only for base utilities we ship, not for every package
  in the repo.

### Group D: Archive and Compression Utilities

| Utility | Package Plan |
| --- | --- |
| `compress` | Port `ncompress` or an equivalent LZW implementation. |
| `uncompress` | Same package as `compress`. |
| `pax` | Port a POSIX pax implementation, likely paxutils or a libarchive-backed frontend. |

Required work:

- Add compatibility tests for `.Z` files:
  `printf data | compress > /tmp/x.Z; uncompress -c /tmp/x.Z`.
- Add `pax` read/write tests for tar-compatible archives in `/tmp`.
- Keep GNU `tar` in the base VFS only if already part of the base package map;
  `pax` should not depend on `tar` shelling out.

### Group E: Developer and Object-File Utilities

| Utility | Package Plan |
| --- | --- |
| `ar` | Port or implement POSIX archive support; prefer LLVM/binutils if broader object compatibility is needed. |
| `cflow` | Port GNU cflow or another C call graph utility. |
| `ctags` | Port Universal Ctags or a smaller POSIX-oriented ctags. |
| `cxref` | Port or implement a compact C cross-reference frontend. |
| `lex` | Port flex and provide `/usr/bin/lex`. |
| `nm` | Port LLVM/binutils `nm` or implement a Wasm/archive-focused subset with documented limits. |
| `patch` | Port GNU patch or a compact POSIX-compatible implementation. |
| `strings` | Implement small in-tree version or port from binutils/LLVM. |
| `strip` | Port LLVM/binutils strip or implement a Wasm-focused subset with documented limits. |
| `yacc` | Port byacc and provide `/usr/bin/yacc`. |

Required work:

- Decide up front whether object tools must support ELF, Wasm object files,
  Unix archives, or only the formats Kandelo can produce today.
- Add fixture files under `host/test/fixtures` or a new package test fixture
  directory so the tests are deterministic and do not depend on host tools.
- Do not include `c17` in this phase. `c17` is intentionally deferred because
  a working guest compiler/linker/sysroot is a larger project than these
  inspection/generator utilities.

### Group F: Message Catalog and Gettext Utilities

| Utility | Package Plan |
| --- | --- |
| `gencat` | Small catalog compiler matching the runtime catalog format we support. |
| `gettext` | GNU gettext-runtime or a small compatible lookup tool. |
| `msgfmt` | GNU gettext-tools or compact `.po` to `.mo` compiler. |
| `ngettext` | Same runtime package as `gettext`. |
| `xgettext` | Same tools package as `msgfmt`. |

Required work:

- Decide whether Kandelo supports POSIX message catalogs, GNU gettext `.mo`, or
  both.
- Add sample catalogs under tests and verify lookup in `C`/`POSIX` locale.
- Keep locale database work separate from `localedef`; `localedef` remains
  deferred until the libc locale archive story exists.

## Rootfs Build Changes

### Task 1: Make `mkrootfs` Suitable For Binary Composition

Files:

- `tools/mkrootfs/src/cli/build.ts`
- `tools/mkrootfs/src/builder.ts`
- `tools/mkrootfs/src/validate.ts`
- `tools/mkrootfs/test/cli.test.ts`

Changes:

1. Add `--sab-size <bytes>`.
2. Accept multiple manifest files, or add `--manifest-fragment <path>` repeated.
3. Keep collision validation across all static and generated entries.
4. Ensure generated symlinks can point at package outputs.
5. Add tests for multi-manifest order, duplicate rejection, and large image size.

### Task 2: Add Base Package Mapping

Files:

- new `images/rootfs/PACKAGES.toml` or `images/rootfs/packages.json`
- `scripts/build-rootfs.sh`
- possibly `xtask` if a reusable resolver command is needed

The mapping should record:

- package name;
- package version constraint or exact package name as already pinned by
  `package.toml`;
- output wasm name;
- VFS install path;
- symlink aliases;
- mode/uid/gid.

Example shape:

```toml
[[packages]]
name = "findutils"

[[packages.outputs]]
binary = "programs/wasm32/findutils/find.wasm"
path = "/usr/bin/find"
aliases = ["/bin/find"]

[[packages.outputs]]
binary = "programs/wasm32/findutils/xargs.wasm"
path = "/usr/bin/xargs"
aliases = ["/bin/xargs"]
```

`scripts/build-rootfs.sh` should:

1. resolve each package output from `local-binaries/` or `binaries/`;
2. stat each output to record the lazy file size;
3. generate a manifest fragment with `lazy_url=` / `lazy_size=` by default;
4. run `mkrootfs build`;
5. print a summary of utilities installed into the base image.

### Task 3: Release the Base VFS As A Package Artifact

Today `rootfs.vfs` is built locally by `build.sh`. To make the expanded base
image reliable for demos and downstream users:

1. Add a package manifest for the canonical rootfs image, for example
   `packages/registry/rootfs/package.toml`.
2. Make the package depend on every package mapped into
   `images/rootfs/PACKAGES.toml`.
3. Publish it through the existing binary index.
4. Teach browser and Node resolution to prefer the released rootfs image when a
   local `host/wasm/rootfs.vfs` is absent.

This keeps first-run setup from rebuilding all base utilities locally.

### Task 4: Move Shared Shell Environment Onto The Base VFS

The shell, WordPress, and LAMP VFS builders currently call
`populateShellEnvironment()`. After the base VFS contains the POSIX utilities:

1. Leave demo-specific content in those images:
   - Vim and NetHack lazy archives, if still demo-specific;
   - WordPress/LAMP/nginx/PHP/MariaDB runtime files;
   - `/etc/profile` custom aliases if they are shell-demo-specific.
2. Stop duplicating base binaries into demo VFS images.
3. Boot demos from the base VFS plus overlays where possible, or rebuild the
   demo images by starting from `rootfs.vfs` before adding demo files.
4. Delete shell-only binary registration for utilities that are now in the
   base image.

This is the point where the browser shell becomes a consumer of the base VFS,
not the owner of the shared userspace definition.

## Utility Inclusion Checklist

Every practically supportable utility from the prior plan must end in one of
these states:

- `base`: installed in `rootfs.vfs`;
- `base-alias`: available through a symlink/wrapper to another installed tool;
- `deferred`: moved back to the "not yet practical" list with a new reason.

Initial target state:

| Utility | Target State | Package Group |
| --- | --- | --- |
| `ar` | `base` | Developer/object tools |
| `asa` | `base` | `posix-utils-lite` |
| `awk` | `base-alias` | Existing `gawk` |
| `cal` | `base` | `posix-utils-lite` |
| `cflow` | `base` | Developer/object tools |
| `cmp` | `base` | Existing `diffutils` |
| `compress` | `base` | Archive/compression |
| `ctags` | `base` | Developer/object tools |
| `cxref` | `base` | Developer/object tools |
| `diff` | `base` | Existing `diffutils` |
| `ed` | `base` | Pager/editor |
| `ex` | `base-alias` | Existing `vim` or wrapper |
| `find` | `base` | Existing `findutils` |
| `fuser` | `base` | `posix-utils-lite` |
| `gencat` | `base` | Catalog/gettext |
| `getconf` | `base` | `posix-utils-lite` |
| `gettext` | `base` | Catalog/gettext |
| `iconv` | `base` | `posix-utils-lite` or libiconv |
| `ipcrm` | `base` | `posix-utils-lite` |
| `ipcs` | `base` | `posix-utils-lite` |
| `lex` | `base` | Developer/object tools |
| `locale` | `base` | `posix-utils-lite` |
| `logger` | `base` | `posix-utils-lite` |
| `man` | `base` | Pager/editor |
| `more` | `base` | Pager/editor |
| `msgfmt` | `base` | Catalog/gettext |
| `ngettext` | `base` | Catalog/gettext |
| `nm` | `base` | Developer/object tools |
| `patch` | `base` | Developer/object tools |
| `pax` | `base` | Archive/compression |
| `ps` | `base` | `posix-utils-lite` |
| `renice` | `base` | `posix-utils-lite` |
| `strings` | `base` | Developer/object tools |
| `strip` | `base` | Developer/object tools |
| `tabs` | `base` | `posix-utils-lite` |
| `tput` | `base` | Pager/editor |
| `uncompress` | `base` | Archive/compression |
| `uudecode` | `base` | `posix-utils-lite` |
| `uuencode` | `base` | `posix-utils-lite` |
| `what` | `base` | `posix-utils-lite` |
| `xargs` | `base` | Existing `findutils` |
| `xgettext` | `base` | Catalog/gettext |
| `yacc` | `base` | Developer/object tools |

## Verification Plan

### Build Verification

- `bash scripts/build-rootfs.sh` succeeds from a clean checkout after
  `scripts/fetch-binaries.sh`.
- `node tools/mkrootfs/bin/mkrootfs.mjs inspect host/wasm/rootfs.vfs` lists all
  expected `/usr/bin` entries and aliases.
- The compressed and raw image sizes are printed and tracked in the PR.

### Node Runtime Verification

Run a Node boot using `rootfsImage: "default"` and assert:

- `command -v <utility>` succeeds for all 43 target utilities.
- Each package group has at least one behavioral smoke test.
- Utilities that inspect kernel state (`ps`, `fuser`, `ipcs`, `renice`) verify
  the underlying kernel-visible state, not just command startup.

### Browser Runtime Verification

Add or extend a Playwright test that boots the shell from the base VFS and runs:

- all `command -v` checks;
- the same representative smoke tests as Node where browser host support exists;
- an image-size/load-time check so base VFS growth stays visible.

### Regression Guard

Add a generated manifest audit test:

- parse the POSIX target list from this plan or a machine-readable fixture;
- inspect `rootfs.vfs`;
- fail if a target utility is absent from `/usr/bin`, `/bin`, or an accepted
  shell builtin list.

## Deferred Utilities

The 24 utilities classified as not yet practical in
`2026-05-15-posix-utilities-shell-demo-plan.md` remain out of the base image.
Do not add placeholder stubs for them. A missing command is better than a
command that appears POSIX-compatible but cannot provide the required subsystem.
