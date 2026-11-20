# Kandelo problems found while building Delo

Each entry names the Kandelo code, what it does, how it affects Delo, and its state.

## Open

### Every composed image gets `/home/maker` and `/root`

- **Code:** `ensureDemoHomes` in `apps/browser-demos/pages/kandelo/kernel-host/image-composer.ts`, called at line 301.
- **What it does:** at the first boot of every image the browser composer boots, it creates `/home/maker` (uid 1000, mode 755) and `/root` (uid 0, mode 700). It does not read `/etc/passwd` first. The WordPress patches next to it check the image before they change it.
- **Effect on Delo:** every Delo computer has `/home/maker`, also a computer without `login` and without a `maker` account. The disk Delo builds and the disk the computer boots are different.
- **Proposed fix:** create a home only for an account that `/etc/passwd` in the image declares. Kandelo's own images declare `maker` and `root`, so they do not change.

### A lazy file the registry does not name resolves only on the dev server

- **Code:** `scripts/build-local-vfs-asset-group.ts`, and `delo write --from <path> --lazy` in `apps/browser-demos/pages/delo/src/write.ts`.
- **What it does:** a production build serves a lazy file only when its asset group has it. The group holds what Kandelo's shipped images and the delo registry name. The dev server answers every path of the binaries store.
- **Effect on Delo:** `delo write /usr/bin/foo <computer> --from programs/wasm32/foo.wasm --lazy` works on the dev server for any built file. In a production build it works only for a path that is already in the group.

### `chroot` returns `ENOSYS`

- **Seen in:** a Delo computer, `chroot --userspec=1000:1000 / ...` prints "Function not implemented".
- **Effect on Delo:** none now. `login` starts the non-root account.

### Kandelo's launch scripts carry Kandelo exchange code

- **Code:** `SUPERVISE_FUNCTION` and the launch scripts in `images/vfs/scripts/build-source-rootfs-shell-image.ts`.
- **What it does:** the quake and scummvm launch scripts restart the engine when a Kandelo exchange handler sends `SIGHUP`. The scripts exist only in the image builder, not in a package.
- **Effect on Delo:** the `quake` and `scummvm` packages carry their own copies of the scripts without the exchange code. A change to Kandelo's scripts does not reach Delo.

### The SDL2 shader presets have no package output

- **Code:** `programs/sdl2/presets/`.
- **Effect on Delo:** the `sdl2` package copies the 8 presets into `registry.json` as `content` files. A change to a preset does not reach Delo.

### `dinit` has no default control socket

- **Code:** the `mconfig` that `packages/registry/dinit/build-dinit.sh` writes sets no `SYSCONTROLSOCKET`.
- **What it does:** `dinit --system` without `-p` binds an empty path and stops: "Error binding control socket: Invalid argument". `dinitctl` without `-p` has no socket to reach either. Kandelo passes `-p /tmp/dinitctl` in every launcher.
- **Effect on Delo:** a computer with `dinit` starts `/sbin/dinit --system -p /run/dinitctl`. A user must type `dinitctl -p /run/dinitctl`.
- **Proposed fix:** set `SYSCONTROLSOCKET = /run/dinitctl` in the `mconfig`.

### Application trees exist only inside Kandelo images

- **Code:** the image builders in `images/vfs/scripts/` (`build-ruby-todo-vfs-image.ts`, `build-nginx-php-vfs-image.ts`, `build-redis-vfs-image.ts`, `build-image-families.ts` for WordPress).
- **What it does:** the builders read the repo folders and the upstream archives (Roda, Adminer, phpCacheAdmin, WordPress, the MariaDB system tables) in Node, and write them only into `.vfs.zst` images. No package output holds them. The upstream downloads send no CORS header, so a browser cannot fetch them.
- **Effect on Delo:** `ruby-todo`, `adminer`, `redis-board`, `wordpress`, `wordpress-sqlite` and `mariadb` copy folders out of `ruby-todo-vfs`, `nginx-php-vfs`, `redis-vfs` and `wordpress-family-vfs`. Delo depends on the paths inside those images. An install downloads the whole image once (5 to 44 MB). Each rebuild changes the image digest, so an install fails until `registry.json` names the new digest.
- **Proposed fix:** give each tree its own package output (a zip in the binaries store).

### Copied files lose their opcache prewarm

- **Code:** `prewarmOpcache` in `images/vfs/scripts/opcache-prewarm.ts`; `KandeloImageFs` has no call to set a modification time.
- **What it does:** the prewarmed `/var/cache/opcache` entries match the image's file times. A file Delo copies gets the build time.
- **Effect on Delo:** Delo does not copy the opcache trees. PHP-FPM compiles each script on its first request.

### Service files and the notes app are copies

- **Code:** the dinit service lines, `nginx.conf` and `fastcgi_params` in `images/vfs/scripts/build-*-vfs-image.ts`; `packages/registry/nginx-python-vfs/app/`.
- **Effect on Delo:** `registry.json` carries copies as `content` files. A change in Kandelo does not reach Delo.

### A network session link keeps only a gallery machine's parameters

- **Code:** `sessionLink` and `MACHINE_PARAMS` in `apps/browser-demos/lib/network-session.ts`.
- **What it does:** the link is the page's origin and path, `vfs` and `profile` if the page has them, and `network` and `networkName`. Every other parameter is dropped.
- **Effect on Delo:** a Delo computer page names its computer with `?computer=<id>`, an id in this browser's storage only. Kandelo's link opens a computer page that names no computer. Delo builds its own link: its share link (`?draft=`) with the session parameters (`withDeloSession` in `share.ts`). Opening it creates the draft, and `delo run` of that draft joins the session.
- **Proposed fix:** let the caller of `NetworkSessionController` give the page a link should open, instead of only `pageHref`.

### Vite's dependency scan refuses an exact binary path without a dot

- **Code:** `transformSourceOnlyMirrorGlobs` in `apps/browser-demos/source-only-vite-assets.ts` admits only one exact path per `import.meta.glob`; Vite's dependency scan (`vite:dep-scan:transform:js-glob`) does not run that rewrite.
- **What it does:** for an exact path whose last part has no dot, for example `tyrquake/quake-data`, Vite takes the whole path as the glob base and passes an empty pattern to `picomatch`: "Expected pattern to be a non-empty string". The scan stops, and Vite skips dependency pre-bundling. Dependencies are then optimized during a run, which reloads open pages.
- **Effect on Delo:** the `quake` package installs `quake-data` as a lazy output, which needs no line in `binaries.ts`. A program without an extension cannot be an eager output.
- **Proposed fix:** run the SourceOnly glob rewrite in the dependency scan too, or skip scanning `binaries.ts`.

### Two nginx WebMCP tests are out of date

- **Code:** `apps/browser-demos/test/webmcp.e2e.ts`, the tests "gallery launch boots in place and the new computer rejects previous IDs" and "nginx serves a guest file through the preview and rejects external or traversing paths". origin/main has the same two tests with the same problems.
- **What it does:**
  - The first test waits for `profile=nginx` in the URL. A gallery launch now creates a stored computer, and `computerUrl` in `pages/kandelo/url-state.ts` deletes `profile` and sets `?computer=<id>`.
  - The second test writes `/var/www/html/webmcp-proof.html`. The `nginx` profile now boots the `browser-web-stack` image, whose `web-static` service runs `nginx -c /etc/nginx/static.conf` with `root /var/www/static` (`images/vfs/scripts/build-image-families.ts`). The preview shows nginx's "404 Not Found". The test reads `/etc/nginx/nginx.conf`, the PHP configuration, so its `root /var/www/html` check passes.
- **Effect on Delo:** none. The two tests fail on every run, so the Kandelo WebMCP suite never passes in full.
- **Proposed fix:** wait for `computer` in the URL in the first test. Write into the root of `static.conf` in the second test, and read that file.

### No exported way to open a saved computer's files

- **Code:** `persistenceIdentity` and the profile it reads in `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts:1562`. None of it is exported.
- **What it does:** a computer that booted keeps its files as a saved image plus a journal. `loadFixedPersistenceImageHandle` opens the image only under the exact identity Kandelo saved it with, and only a kernel replays the journal.
- **Effect on Delo:** The files pane of `delo config` and `delo run` (to write a pending configuration) copy the identity into `stored-disk.ts` and start their own kernel without any process. If Kandelo changes the identity, they fail with "Cannot prove the latest persistent image state; refusing an older checkpoint". This happened once: develop added `preforkServiceProcesses` to the identity, and the copy had to follow. The copy also ignores the `memoryProfile` URL override of the computer page, so a computer that boots with `?memoryProfile=` does not open.
- **Proposed fix:** export one function that opens a stored computer's filesystem in a kernel with no process, for reading and for writing.

### The kernel host cannot create a folder or set an owner

- **Code:** `writeFileToVfs` in `host/src/browser-kernel-host.ts:1816` (and `write_vfs_file` in both kernel workers) writes one regular file with a mode. Its parent must exist, and the file belongs to root. The host has no call to create a folder or to change an owner.
- **Effect on Delo:** The files pane of `delo config` cannot write an upload through the kernel. It exports the whole disk, applies the uploads with `KandeloImageFs`, and saves the disk again with `replaceDisk`, as `delo run` does for a pending configuration. Uploaded files and folders belong to root. A computer that boots an image has no disk for `replaceDisk` to replace, so the pane opens it read only.
- **Proposed fix:** two host calls, "create a folder" and "set an owner", on the Node and browser hosts. Then the files pane writes only the uploaded files through the kernel, into the journal of any computer, one that boots an image included, and an upload can belong to the computer's user.

### The image writer cannot remove a directory

- **Code:** `KandeloImageFs` in `images/vfs/lib/kandelo-image-fs.ts` has `unlink` and no `rmdir`; `sm_unlink` in `crates/kandelo-image-module/src/lib.rs:1433` calls `rootfs::unlink`, which answers `EISDIR` for a directory.
- **Effect on Delo:** writing a pending configuration onto a disk deletes the files and symlinks of a removed step, and leaves its directories, such as an empty directory or the folders of an extracted archive. `written` in `delo.json` keeps them, so a later step can create them again instead of finding them as data.
- **Proposed fix:** an `sm_rmdir` export and a `KandeloImageFs.rmdir` that removes an empty directory, as POSIX `rmdir` does.

### Leaving a computer's page loses every unsynced write

- **Code:** no page in `apps/browser-demos/pages/kandelo` or `apps/browser-demos/pages/delo` shuts the kernel down when the page closes; nothing listens for `pagehide`. Delo's Kandelo icon halts the computer before it leaves (`wireBack` in `computer/main.ts`), and every other way out shows the browser's leave dialog; neither covers a tab closed without a click or typing in it, or a browser crash. `docs/browser-support.md` documents the boundary: guest `write` and `close` keep POSIX writeback semantics, and "browser termination loses unsynced writes".
- **What it does:** a file's creation reaches the journal at once, but its bytes stay in the cache until a program calls `fsync` or `sync`. Leaving the page ends the kernel the way a power cut ends a machine.
- **Effect on Delo:** in a computer with `bash`, `printf foo > /root/foo` reads back `foo`, but after closing the tab and `delo run` again `/root/foo` is empty. With `sync` (coreutils) after the write, the bytes survive. The files pane of `delo config` shows what the disk holds, so it shows the empty file.
- **Proposed fix:** a clean shutdown on leaving the page cannot wait for asynchronous storage. A periodic writeback can: the kernel writes a dirty block to the disk within a few seconds even when no program syncs, as Linux writes dirty pages back within about 30 seconds. Leaving the page then loses only the last few seconds of writes.

### Kandelo has no console, so no keyboard without a shell

- **Code:** `match_virtual_device` in `crates/runtime-core/src/syscalls.rs:265` maps `/dev/console` to the null device, and no path names `/dev/tty0`. The Linux keyboard ioctls (`KDGKBTYPE`, `KDGKBMODE`, `KDSKBMODE`, line 17102) answer only on a terminal, and `KDSKBMODE` changes nothing: the host must already send the key codes the program asked for.
- **What it does:** only a PTY carries keys into a program, and only a terminal session (a shell) opens a PTY. fbDOOM looks for a terminal that answers `KDGKBTYPE` on its standard descriptors and the console. As pid 1 it finds none, prints "Unable to find a file descriptor associated with the keyboard", and exits after its first frame.
- **Effect on Delo:** a computer that starts fbDOOM at boot needs `bash` and a file in `/etc/profile.d/`, which the terminal's login shell runs, so fbDOOM gets the shell's terminal. "An empty computer plus `fbdoom` as its init process" does not work, although Kandelo has its framebuffer (`/dev/fb0`) and its mouse (`/dev/input/mice`). A WebMCP tool cannot start fbDOOM without a shell either.
- **Proposed fix:** a console device `/dev/tty0`, with `/dev/console` naming it. The browser keyboard feeds it, as it feeds the Framebuffer view's PTY today. It answers the keyboard ioctls and honors `KDSKBMODE`: characters in `K_XLATE`, scan codes in `K_MEDIUMRAW`. A program started as pid 1 then gets its keyboard from the console, as on Linux, with no shell and no fbDOOM patch.

### The framebuffer handle reports a bound process before its canvas has the framebuffer's size

- **Code:** `attachFramebuffer` in `web-libs/kandelo-session/src/kernel-host.ts:3075` and `attachCanvas` in `host/src/framebuffer/canvas-renderer.ts`.
- **What it does:** `tryAttach` sets the bound pid at once, then imports the renderer. The renderer sets the canvas to the binding's width and height only at its first animation frame. Until then the canvas keeps its HTML default size, 300×150. `FramebufferHandle` has no call that gives the binding's width and height.
- **Effect on Delo:** `device_framebuffer_screenshot` promises a PNG "at the framebuffer's own resolution", but just after a process binds `/dev/fb0` it can return a blank 300×150 PNG. Delo cannot detect this. The page opens the framebuffer at boot when it is the device the page shows, so the window opens on every boot of such a computer. The test "the framebuffer tools take a PNG of /dev/fb0" in `test/delo-webmcp.spec.ts` waits for a 640-pixel-wide PNG.
- **Proposed fix:** report the bound pid only after the canvas has the binding's size, or add a call to `FramebufferHandle` that gives the binding's width and height.

### Kandelo registers every image-declared tool as a page tool, with the image's own text

- **Code:** `registerVfsTools` in `apps/browser-demos/pages/kandelo/webmcp/vfs-tool-registration.ts`, `imageTool` in `pages/kandelo/webmcp/registry.ts`.
- **What it does:** every file in `/etc/mcp` and `/home/maker/mcp` registers on the page's `document.modelContext` under its file name, with the file's description and schema, next to the `kandelo_` tools. Only the `kandelo_` prefix is reserved. A call runs at once, with no acceptance. The `maker` account can write `/home/maker/mcp`, and a program can write either folder while the computer runs. An image comes from a URL that a share link can name.
- **Effect on Delo:** none on the delo computer page, which registers a file under `unofficial_<name>`, shows Delo's text until the visitor accepts an untrusted file, and asks for acceptance before the first input from an agent (`computer/trust.ts`, `computer/acceptance.ts`). A delo computer opened on Kandelo's own page gets none of that. A WordPress Playground report on HackerOne describes the same pattern there: site tools mirrored into the trusted top-level registry under the site's origin, with attacker-chosen names, descriptions and annotations.
- **Proposed fix:** register image-declared tools under a prefix Kandelo controls, keep the image's description and schema away from the agent until the user accepts the tool, and ask for acceptance on the first call.

### The Omarchy desktop is built from demo programs

- **Code:** the `wayland-demo` package (`packages/registry/wayland-demo/`, `programs/wlcompositor/`, `programs/wlclock.c`, `programs/wlpaint.c`, `programs/notify-send.c`, `programs/kclipd.c`), the `qtgallery` package, and the `omarchy` pipeline in `apps/browser-demos/pages/delo/src/registry.json`.
- **What it does:** Kandelo writes its own compositor (`wlcompositor`), demo clients (`wlclock`, `wlpaint`, `qtgallery`), its own `notify-send`, and one start script (`omarchydesktop`) with its config in `kandelo-desktop-data.zip`. The start script and the config name `wlcompositor`, `wlclock` and `wlpaint`.
- **Effect on Delo:** the `omarchy` pipeline uses the binaries `wlcompositor`, `quickshell`, `dbus`, `foot`, `kclipd`, `wlclock` and `wlpaint`, so a computer can leave one out. It cannot be a pipeline of upstream binaries: a computer cannot swap the compositor, and without `wlclock` or `wlpaint` the Alt+C and Alt+P bindings start nothing.
- **Proposed fix:** remove `wlclock`, `wlpaint` and `qtgallery` from the desktop. Build the desktop from the upstream packages on `develop`: `sway`, `cage` or `labwc` on `wlroots`, `swaybg`, `foot`, `quickshell`, `mako`, `dbus`, `libinput` and `xkeyboard-config`. Keep `kclipd`: it is the agent at the host clipboard boundary (`/dev/kandelo/clipboard`), not a demo program. Replace Kandelo's `notify-send` with libnotify's once it has a package.

## Fixed in this branch

### Lazy files resolved only on the dev server

- **Code:** `scripts/build-local-vfs-asset-group.ts`, `apps/browser-demos/vite.config.ts`, `apps/browser-demos/pages/delo/src/lazy-directory.ts`.
- **Was:** a production build did not have the delo pages. With them, Delo asked for a lazy file under the deployment base, where no file is, and `delo run` failed with "Zip EOCD record not found". The asset group held only the lazy files of Kandelo's shipped images, so 7 of the 46 lazy paths of `registry.json` were not in it.
- **Fix:** the delo pages are inputs of the production build. `deloLazyDirectory` passes the deployment's asset group, as Kandelo's computer page does. `./run.sh build-browser` adds the lazy paths of `registry.json` (`deloLazyStorePaths`) to the group through the new `extraLazyMembers` option. Checked in a production build served by `vite preview`: the fbdoom script and the Omarchy script boot.

### A lazy archive registered without a digest had no length

- **Code:** `registerLazyArchive` in `images/vfs/lib/kandelo-image-fs.ts`.
- **Was:** the archive's length came only in `integrity`, together with its SHA-256. Without `integrity`, the image recorded the length 0, the kernel downloaded 0 bytes, and every member read failed with `EINVAL`.
- **Effect on Delo:** Delo reads only an archive's central directory, so it knows the length but not the digest. Every lazy archive failed: `xkeyboard-config`, `libinput-quirks`, `omarchy`, `love-games`, `freeciv`, `python` and `ruby`. The Omarchy desktop started without its D-Bus configuration and key bindings.
- **Fix:** `integrity.sha256` is optional, as the digest of a lazy file is. Delo passes the length `fetchArchiveIndex` reads. Test: `reads a member of an archive registered with its length and no digest` in `host/test/node-lazy-archive-runtime.test.ts`. `integrity` itself is required, so an archive cannot be registered without its length; four calls in `host/test/kandelo-image-fs.test.ts` that gave none now give one.

### Every computer got the exchange mount point

- **Code:** `ensure_kernel_mount_points` in `crates/runtime-core/src/rootfs.rs`, and the scratch-mount routing in `crates/runtime-core/src/tmpfs.rs`.
- **Was:** at every image load the kernel mounted Kandelo exchange and created `/run/kandelo/exchange` and its parents in the root filesystem, so the saved disk kept them. Exchange is only usable through the agent at `/usr/libexec/kandelo/exchange-agent`.
- **Effect on Delo:** an empty computer showed an empty `/run/kandelo/exchange/` in its files.
- **Fix:** the kernel mounts exchange and creates the mount point only when the image has the agent (`exchange::is_mounted`). Without it, `/run/kandelo/exchange` does not exist and `/proc/mounts` does not list it. In Delo, the `kandelo-exchange` binary, and the `upload` and `download` options that use it, bring the agent. `seed_runtime_directory_layout` in the same file returns early when the image has no `/run`; before, such an image failed to load with errno 2. Test: `an_image_without_run_or_the_exchange_agent_boots_with_the_runtime_mount`. A computer saved before the fix keeps the old directories on its disk.

### Every computer got the browser's TLS certificate

- **Code:** `installBrowserCa` in `host/src/browser-kernel-worker-entry.ts`.
- **Was:** at every browser boot the host created `/etc/ssl/certs` if it was missing and wrote its per-session certificate to `/etc/ssl/certs/ca-certificates.crt`.
- **Effect on Delo:** an empty computer, with no program that makes HTTPS connections, had the certificate on its disk.
- **Fix:** the host writes the certificate only when the image already has `/etc/ssl/certs`, which a package with a TLS client installs. It no longer creates directories, so the kernel export `kernel_rootfs_mkdir_parents` is removed (kernel-host version 8). A computer saved before the fix keeps the old file on its disk.

### A saved image with no terminal session failed to load

- **Code:** `parseComposition` in `apps/browser-demos/pages/kandelo/kernel-host/fixed-persistence-image.ts`.
- **Was:** the image composer records `terminalSession: null` for an image without `/etc/kandelo/experimental-terminal-session.json`, but `parseComposition` parsed the value as a session and refused `null`. The save failed with "Image composer source cleanup is unproven; retain its staged source".
- **Effect on Delo:** a computer with nothing to run did not boot.
- **Fix:** `parseComposition` keeps `null`. Spec: `experimental computer keeps an image with no terminal session` in `test/fixed-persistence-image.spec.ts`.

### Image-declared tools ran only through a shell

- **Code:** `parseVfsTool` in `apps/browser-demos/pages/kandelo/webmcp/vfs-tools.ts` and `runGuestScript` in `apps/browser-demos/pages/kandelo/webmcp/runtime.ts`.
- **Was:** `parseVfsTool` required `command` to be a string, and `runGuestScript` ran it with the login shell of the agent's account.
- **Effect on Delo:** Delo tool files use a `command` list with no shell, so Kandelo refused Delo's tool files, and Delo needed its own parser and a copy of the job read loop.
- **Fix:** `parseVfsTool` accepts a `command` list, an argv that runs with no shell (`commandArgv` fills it). `runGuestJob` collects the output of a job that any start function begins, `startGuestProgram` starts an argv as the agent, and `startSessionJob` starts one with other options. Delo's `computer/tool-files.ts` uses them with the uid and gid of the computer's first process.

### The dev store sent the whole file for a range request

- **Code:** `apps/browser-demos/source-only-vite-assets.ts`.
- **Was:** every request got `200` and the whole file, also a request with `Range`.
- **Effect on Delo:** installing `love` downloaded its 112 MB archive in the image builder, only to read the archive's file list.
- **Fix:** the store answers one byte range with `206` and a range past the end with `416` (`sourceOnlyByteRange`).

### A suspended audio context stopped the program

- **Code:** `host/src/audio/browser-pcm-driver.ts`, `host/src/browser-kernel-host.ts`.
- **Was:** the only way to silence a computer was to suspend its `AudioContext`. Then `/dev/dsp` stopped taking samples, and a program that writes sound, for example DOOM, stopped.
- **Fix:** `setAudioMuted` sets a gain node to 0, and the audio keeps running.
