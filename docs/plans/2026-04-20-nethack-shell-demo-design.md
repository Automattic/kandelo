# NetHack 3.6.7 for the Shell Demo — Design

**Date:** 2026-04-20
**Status:** Design approved, implementation pending
**Scope:** Port NetHack 3.6.7 (curses interface) to wasm32 and expose it through the browser shell demo. No kernel changes planned.

## Goals

Add NetHack as a playable program in the shell demo, loaded the same way vim and nano are loaded today: binary fetched lazily, large read-only data tree delivered via a lazy archive baked into `shell.vfs`.

Use the opportunity to elevate the "lazy-archive pattern" from an undocumented vim-specific trick to the canonical, documented approach for shipping programs with large runtime directories.

## Non-goals

- Multi-player / score-sharing across browser tabs.
- Persistent saves across sessions (MemoryFileSystem is not IndexedDB-backed in the shell demo).
- A dedicated browser page for NetHack. The shell demo is the home for interactive terminal programs.
- Any kernel change. If one becomes necessary, it is out of scope for this port and must be scoped separately.

## Approach

### Version and interface

- **NetHack 3.6.7** (stable, tagged 2023). Avoids the moving-target risk of 3.7-alpha.
- **Curses interface** (`CURSES_GRAPHICS`). We already ship ncurses 6.5 for vim/nano; the curses window interface gives better menus and color than raw tty.

### Toolchain

- `wasm32posix-cc` / `wasm32posix-ar` for the cross build. We stay on wasm32 because ncurses is built for wasm32 today.
- Upstream Makefile-driven build. NetHack's build has a host-tool bootstrap phase (`makedefs`, `dgn_comp`, `lev_comp`, `dlb`) that generates headers and the data archive. Standard cross-compilation pattern: run those with host CC, then re-run with the wasm toolchain for the game binary. Same bootstrap pattern as Erlang.

### Config choices

Baked into `include/config.h` and `sys/unix/unixconf.h`:

- `CURSES_GRAPHICS` on; tty-only off.
- `DLB` on — all data files packed into a single `nhdat` archive (~2 MB).
- `COMPRESS` / `ZLIB_COMP` off — our VFS is in-memory; compression buys nothing.
- `HACKDIR=/usr/share/nethack` (read-only data).
- `VAR_PLAYGROUND=/home/.nethack` (writable saves, bones, scores, lockfile).
- `SECURE` off — single-player demo; no setuid/games distinction.
- `TIMED_DELAY` via `nanosleep` (supported).

## Build script: `examples/libs/nethack/build-nethack.sh`

Modeled on `examples/libs/vim/build-vim.sh`. Phases:

1. **Fetch & verify.** Download `nethack-367-src.tgz`, check SHA-256, extract to `nethack-src/`.
2. **Host bootstrap.** `cd sys/unix && sh setup.sh hints/linux` to stage Makefiles. Build `makedefs`, `dgn_comp`, `lev_comp`, `dlb` with host CC.
3. **Patch config.** `sed` edits on `include/config.h` and `sys/unix/Makefile.src` for the config choices above; point `LIBS` / `HACKCFLAGS` at `examples/libs/ncurses/out/`.
4. **Cross build.** Re-enter `src/` with `CC=wasm32posix-cc`, linking `-lcurses -ltinfo`.
5. **Data generation.** Run the host-built `makedefs` and `dlb` to produce `nhdat`, `data`, `rumors`, `options`, `quest.dat`, `oracles`.
6. **Stage output:**
   - `out/nethack.wasm`.
   - `runtime/usr/share/nethack/{nhdat,license,symbols}`.
   - `runtime/home/.nethack/` with empty `record` and `logfile` stubs so NetHack can append without first-run failures.
7. **Bundle.** Call `bundle-runtime.sh` to produce the tar archive registered as a lazy archive in `shell.vfs`.

### Asyncify

NetHack 3.6 uses `fork()` only for the `mail` helper and post-death `recover` — neither is on the play path. Build **without** asyncify-onlylist initially. If any save/quit/dungeon-entry path turns out to reach `fork`, add an onlylist per the project-wide preference (trace call sites manually, instrument only those functions, keep `-gline-tables-only` and `-Wl,--no-wasm-opt`).

### Expected failure modes

- `tparm` / `tgetent` — ncurses's compiled-in fallback terminfo already covers `xterm-256color` (vim uses the same path).
- `random` / `srandom` — present in musl, no action.
- `getpwuid` — stubbed. NetHack's fallback to `$USER` kicks in; `/etc/profile` must export `USER=player`.
- `setgid` / `setuid` — gated on `SECURE`, which is off.

## Runtime layout

```
examples/libs/nethack/out/
  nethack.wasm                   # ~2-3 MB
  runtime/
    usr/share/nethack/
      nhdat                      # DLB-packed data (~2 MB)
      license
      symbols
    home/.nethack/
      record                     # high scores (0-byte stub)
      logfile                    # 0-byte stub
```

The `runtime/` tree is tarred and registered as a lazy archive in the shell VFS. On first access to any path under `/usr/share/nethack/`, the VFS fetches the tar in the worker and materializes the subtree.

## Integration touchpoints

- **`run.sh`** — new first-class target `nethack`; depends on `ncurses`, `sysroot`.
- **`examples/browser/scripts/build-shell-vfs-image.ts`** — register the NetHack runtime archive alongside vim's.
- **`examples/browser/pages/shell/main.ts`** — import `nethackWasmUrl`; add `{ url, path: "/usr/bin/nethack", symlinks: ["/bin/nethack"] }` to `lazyDefs`.
- **`/etc/profile`** (baked into shell.vfs) — append:
  ```
  export USER=player
  export NETHACKOPTIONS="windowtype:curses,color"
  mkdir -p /home/.nethack
  ```
- **`docs/porting-guide.md`** — add a canonical section on the lazy-archive pattern (see below), then a short NetHack entry referencing it.
- **`docs/software-targets.md`** — add NetHack 3.6.7 entry.
- **`README.md`** — add NetHack to the ported-software roster.

## Documentation work: canonicalize the lazy-archive pattern

The lazy-archive mechanism (`MemoryFileSystem.registerLazyArchive`, `rewriteLazyArchiveUrls`) exists in code and in `host/test/lazy-archive.test.ts`, but no `.md` file describes it. Porters discover it only by reverse-engineering the vim build. This change adds a **"Shipping runtime files: the lazy-archive pattern"** section to `docs/porting-guide.md` covering:

- **When to use it.** Any ported program whose binary depends on a tree of read-only runtime files on first use. Alternatives — baking files directly into `shell.vfs`, eager fetch at startup, per-file lazy registration — are worse for startup time or image size.
- **How it works.** `registerLazyArchive()` registers a path prefix that points to a tar URL. On first access to any path under that prefix, the VFS fetches the tar in the worker and materializes the entire subtree. Subsequent accesses are in-memory.
- **Build-side contract.** The porter produces a `runtime/` directory under `examples/libs/<program>/`, plus a `bundle-runtime.sh` (or equivalent) that tars it. The shell VFS build script (`examples/browser/scripts/build-shell-vfs-image.ts`) picks it up and registers it.
- **URL rewriting.** Archives are stored in the VFS image with bare-filename URLs; `memfs.rewriteLazyArchiveUrls()` prepends the deploy base URL at runtime. Don't hard-code absolute paths at build time.
- **Worked example.** Vim is the reference implementation; cite file paths (`examples/libs/vim/bundle-runtime.sh`, `examples/browser/scripts/build-shell-vfs-image.ts`, `examples/browser/pages/shell/main.ts`).

After this section exists, the NetHack entry in `docs/porting-guide.md` is short and references it by name.

## Verification

- **No kernel changes planned** → full test suite is not on the critical path. Run it only if the port turns out to need a syscall addition or kernel tweak.
- **Manual browser test (required by CLAUDE.md).** `./run.sh browser`, open the shell demo, type `nethack`, verify:
  - Character creation reaches the game world.
  - At least one dungeon level renders, movement works, inventory displays.
  - Save (`S`) writes to `/home/.nethack/`, relaunching restores it within the session.
- If any of the above fails, diagnose before declaring the port complete.

## Commit plan

1. Docs commit: add the lazy-archive section to `docs/porting-guide.md`.
2. Build commit: `examples/libs/nethack/build-nethack.sh`, `bundle-runtime.sh`, `run.sh` target.
3. Integration commit: VFS image registration, `main.ts` lazy entry, `/etc/profile` env additions, software-targets and README updates.

Each commit is small enough to review on its own; bundling is unnecessary.
