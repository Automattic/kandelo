# WordPress demos: terminal pane + shell-based VFS

**Date:** 2026-05-14
**Status:** Design accepted, ready to implement
**Scope:** `examples/browser/pages/wordpress/`, `examples/browser/pages/lamp/`,
shared VFS build helpers, BrowserKernel + PtyTerminal API extension

## Goal

Give the WordPress (SQLite) and WordPress (LAMP/MariaDB) browser demos a
collapsible terminal pane at the bottom of the page that drops the user
into an interactive `bash` inside the same kernel that's running
nginx + PHP-FPM (+ MariaDB). The terminal must have the full Shell-demo
tooling — coreutils, grep, sed, file, less, m4, make, tar, curl, wget,
git, gzip/bzip2/xz/zstd, zip/unzip, nano, vim, bc, lsof — so users can
poke around the live WordPress install with a real shell.

To get there, the WordPress VFS images are restructured to start from
the same shell environment the Shell demo bakes, plus the
WordPress-specific layers (nginx/php-fpm/MariaDB/WP core).

## Non-goals

- New backend functionality. This is entirely demo-layer work — no
  kernel, syscall, or host-runtime changes.
- Lazy-loading individual tool binaries in `kernelOwnedFs: true` mode.
  WP/LAMP demos bake binaries eagerly. (vim + nethack stay as lazy
  archives because the existing `registerLazyArchiveFromEntries`
  mechanism already works through `kernelOwnedFs`.)
- Touching the Node host. This is browser-only.

## Approach

### 1. Shared shell-environment VFS builder

New file `examples/browser/scripts/shell-vfs-build.ts` exports
`populateShellEnvironment(fs, opts)`. It encapsulates everything the
Shell VFS does today:

- Standard directory layout (`/bin`, `/usr/bin`, `/etc`, `/root`,
  `/tmp` with 0777, `/usr/share/misc`, etc.)
- `/etc/services`, `/etc/gitconfig`, `/etc/profile` (the color
  aliases + NetHack env vars currently in build-shell-vfs-image.ts)
- `dash` binary + `sh`/`/usr/bin/sh` symlinks
- `bash` binary + `bash`/`/usr/bin/bash` symlinks
- `coreutils` multicall binary + 91 + 1 (`[`) symlinks into
  `/bin` and `/usr/bin`
- `grep` + egrep/fgrep symlinks
- `sed` + symlinks
- Extended toolset: `bc`, `file`, `less`, `m4`, `make`, `tar`,
  `curl`, `wget`, `git` (+ `git-remote-http(s)`/`ftp(s)`), `gzip`
  (+ gunzip/zcat), `bzip2` (+ bunzip2/bzcat), `xz`
  (+ unxz/xzcat/lzma/unlzma/lzcat), `zstd` (+ unzstd/zstdcat), `zip`,
  `unzip` (+ zipinfo/funzip), `nano`, `lsof`
- Magic database (`/usr/share/misc/magic`)
- `vim.zip` lazy archive (the binary at `/usr/bin/vim` + runtime tree
  under `/usr/share/vim/vim91/`)
- `nethack.zip` lazy archive

Signature:

```ts
export interface ShellVfsOptions {
  /**
   * When true, every individual tool binary (bash, coreutils, grep,
   * sed, bc, file, less, …) is read from disk and baked into the VFS
   * image. WP/LAMP use this — they run in `kernelOwnedFs: true` mode
   * where main-thread `kernel.registerLazyFiles()` is unavailable.
   *
   * When false, only dash + bash + magic + lazy archives are baked;
   * the page is responsible for lazy-registering the rest at runtime
   * (the Shell demo's existing pattern).
   */
  eagerBinaries: boolean;
}

export function populateShellEnvironment(
  fs: MemoryFileSystem,
  opts: ShellVfsOptions,
): void;
```

Callers:

- `build-shell-vfs-image.ts` — `eagerBinaries: false`. Shrinks to
  ~30 lines: prerequisite checks + `populateShellEnvironment` +
  `saveImage`.
- `build-wp-vfs-image.ts` — `eagerBinaries: true`, then layer
  nginx.conf, php-fpm.conf, opcache.so, WP core, SQLite plugin,
  dinit service tree.
- `build-lamp-vfs-image.ts` — `eagerBinaries: true`, plus the
  MariaDB layer on top.

`eagerBinaries: true` resolves all extended-tool binaries via
`resolveBinary("programs/<name>.wasm")` and reads them at build time.
`tryResolveBinary` is used for the optional vim.zip / nethack.zip
archives (they may be missing in a fetch-only checkout).

### 2. `BrowserKernel.spawnFromVfs` + `PtyTerminal.spawnFromVfs`

The kernel-worker protocol's `SpawnMessage` already accepts a
`programPath` field; only the main-thread API doesn't expose it. Add a
thin public method to `BrowserKernel`:

```ts
async spawnFromVfs(
  programPath: string,
  argv: string[],
  options?: { env?: string[]; cwd?: string; pty?: boolean; stdin?: Uint8Array },
): Promise<{ pid: number; exit: Promise<number> }>;
```

It sends a `{type: "spawn", programPath, …}` request and returns the
worker-allocated pid + an exit promise. No `programBytes` cross the
worker boundary — the kernel reads the binary from its own VFS.

Parallel method on `PtyTerminal`:

```ts
async spawnFromVfs(
  programPath: string,
  argv: string[],
  options?: { env?: string[]; cwd?: string },
): Promise<number>;
```

It calls `kernel.spawnFromVfs(…, { pty: true })`, then wires the same
xterm.js ↔ PTY plumbing the existing `boot()` method does:

- `kernel.onPtyOutput(pid, data => terminal.write(data))`
- `terminal.onData(s => kernel.ptyWrite(pid, encode(s)))`
- `terminal.onResize(({cols,rows}) => kernel.ptyResize(pid, rows, cols))`
- Initial `kernel.ptyResize(pid, terminal.rows, terminal.cols)`

Returns the exit promise.

### 3. WordPress + LAMP page integration

Per page (`pages/wordpress/main.ts`, `pages/lamp/main.ts`):

1. **Patch VFS image** so lazy-archive URLs get the deployed base URL:

   ```ts
   const memfs = MemoryFileSystem.fromImage(rawImage, {…});
   memfs.rewriteLazyArchiveUrls((url) => import.meta.env.BASE_URL + url);
   // (lamp also patches bootstrap.sh + nginx.conf here)
   const vfsImage = await memfs.saveImage();
   ```

   `wordpress/main.ts` doesn't currently round-trip the image — this
   adds the pattern. `lamp/main.ts` already does, just extend the same
   `fs` instance.

2. **After `kernel.boot()` resolves**, instantiate the panel:

   ```ts
   import { TerminalPanel } from "../../lib/init";
   import { PtyTerminal } from "../../lib/pty-terminal";

   const terminalPanel = new TerminalPanel(document.getElementById("terminal-panel")!);
   terminalPanel.setStatus("Click to open a shell");
   let started = false;
   terminalPanel.onExpand(async () => {
     if (started) return;
     started = true;
     const pty = new PtyTerminal(terminalPanel.getTerminalContainer(), kernel!);
     terminalPanel.setStatus("bash running");
     const code = await pty.spawnFromVfs("/bin/bash", ["bash", "-l", "-i"], {
       env: [
         "HOME=/root",
         "TERM=xterm-256color",
         "LANG=en_US.UTF-8",
         "PATH=/usr/local/bin:/usr/bin:/bin:/sbin:/usr/sbin",
         "PS1=bash$ ",
       ],
     });
     pty.terminal.writeln(`\r\n[Shell exited with code ${code}]`);
     terminalPanel.setStatus(`exited ${code}`);
   });
   ```

3. **HTML already has the slot.** `<div id="terminal-panel"></div>`
   is the last child of `.main`, after `.preview-area`, so it docks to
   the bottom of the page. Collapsed = 32 px bar; expanded = flex body
   filling remaining height. `PtyTerminal`'s ResizeObserver re-fits
   xterm.js when the panel transitions.

## File-level change list

- **New:** `examples/browser/scripts/shell-vfs-build.ts`
- **Refactor:** `examples/browser/scripts/build-shell-vfs-image.ts` — delete
  the now-shared populate\* functions, call `populateShellEnvironment(fs, {eagerBinaries: false})`.
- **Refactor:** `examples/browser/scripts/build-wp-vfs-image.ts` — replace
  `populateSystem/populateDash/populateShellSymlinks` with
  `populateShellEnvironment(fs, {eagerBinaries: true})`; keep the
  nginx/php-fpm/WP/SQLite/dinit-service-tree layers.
- **Refactor:** `examples/browser/scripts/build-lamp-vfs-image.ts` — same
  treatment as wp; preserve the MariaDB layer.
- **Edit:** `examples/browser/lib/browser-kernel.ts` — add `spawnFromVfs`.
- **Edit:** `examples/browser/lib/pty-terminal.ts` — add `spawnFromVfs`.
- **Edit:** `examples/browser/pages/wordpress/main.ts` — VFS patch step,
  TerminalPanel + PtyTerminal wiring.
- **Edit:** `examples/browser/pages/lamp/main.ts` — TerminalPanel +
  PtyTerminal wiring (VFS patching already in place; just add
  `rewriteLazyArchiveUrls`).

`index.html` for both pages already has the `terminal-panel` slot and
the `terminal-panel.css` import — no HTML changes.

## Image-size impact

Adding eagerly-baked tool binaries to wordpress.vfs.zst / lamp.vfs.zst
will add roughly:

| Tool         | Raw    | After zstd in .vfs.zst |
|--------------|--------|------------------------|
| bash         | 5 MiB  | ~1.6 MiB               |
| grep         | 600 KiB| ~0.3 MiB               |
| less, m4, bc | each ~500 KiB | ~0.2 MiB each   |
| make, tar    | each ~1 MiB | ~0.4 MiB each       |
| curl, wget   | each ~2 MiB | ~0.7 MiB each       |
| git + remote | ~4 MiB | ~1.4 MiB               |
| compressors  | ~3 MiB combined | ~1.0 MiB         |
| nano, file, lsof | ~2 MiB combined | ~0.7 MiB     |
| magic.lite   | ~250 KiB | ~0.1 MiB             |
| vim.zip      | ~5 MiB (lazy — not in image bytes) | — |
| nethack.zip  | ~3 MiB (lazy) | — |

Total estimated bake: ~8–10 MiB added to the compressed WP VFS image
(currently ~52 MiB). vim + nethack contribute zero to image size —
they're lazy archives, fetched on first exec.

## Verification

Per CLAUDE.md "browser demo verification":

1. `bash build.sh` (rebuild kernel + host TS).
2. `bash examples/browser/scripts/build-shell-vfs-image.sh` — verify the
   refactor didn't regress the Shell demo image (image bytes should be
   ~identical; any drift means a structural bug in the helper).
3. `bash examples/browser/scripts/build-wp-vfs-image.sh` and
   `bash examples/browser/scripts/build-lamp-vfs-image.sh`.
4. `./run.sh browser`, navigate to each demo:
   - WordPress (SQLite): start, wait for iframe to load, click the
     terminal bar, verify bash prompt + `ls /var/www/html` shows WP
     core, `cat /etc/nginx/nginx.conf` shows the running config,
     `ps` shows nginx + php-fpm.
   - WordPress (LAMP): same, plus `mysql -h 127.0.0.1 -u root` works
     against the live MariaDB.
   - Shell: still works unchanged.
5. Vitest: `cd host && npx vitest run` — no regressions.
6. ABI check: `bash scripts/check-abi-version.sh` — clean (no kernel
   changes, so this should pass without a version bump).

## Risks & open questions

- **VFS size**: adds ~8–10 MiB compressed to each WP demo. Acceptable
  given the demo's existing 52 MiB. Could be revisited later via lazy
  archives if it becomes a load-time concern.
- **bash inside a dinit-managed kernel**: bash is being added as a
  sibling process to the running services, not under dinit. The
  kernel already supports ad-hoc spawn alongside dinit (mariadb demo
  does this via the MySQL client connection). PTY allocation for a
  non-init process is also already exercised by the Shell demo.
- **Lazy archive URL rewrite in `kernelOwnedFs` mode**: the worker
  constructs memfs from `vfsImage` bytes; if the URLs aren't rewritten
  before that, vim/nethack will fail to fetch on deployed builds. The
  fix (round-trip the image on the main thread) is straightforward and
  mirrors what `lamp/main.ts` already does for config patches.
- **Build-time prerequisite discovery**: the WP/LAMP builders gain
  ~20 new `resolveBinary` calls. A fetch-only checkout where any of
  those binaries are missing must surface a clear error. Use
  `tryResolveBinary` with explicit error messages for non-critical
  tools (vim, nethack archives) and `resolveBinary` for required
  shell tools.
