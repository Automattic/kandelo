# Kandelo filesystem layout

Kandelo-provided VFS images follow the
[Filesystem Hierarchy Standard 3.0](https://www.debian.org/doc/packaging-manuals/fhs/fhs-3.0.html).
This is a guest filesystem contract. It does not reorganize the build
machine's files, package-cache layout, or arbitrary user-supplied images.
Minimal and test images install the parts they need; they do not simulate
missing platform capabilities to claim full-system FHS conformance.

## Installed paths

| Location | Kandelo use |
|---|---|
| `/bin` | Essential shell and user utilities needed for boot and recovery: bash, sh, login, grep, sed, ps, more, ed, tar, gzip and essential coreutils applets |
| `/sbin` | Boot and recovery administration, including dinit and kandelo-init |
| `/lib` | Libraries required by essential programs, if any; static WebAssembly programs need no invented dynamic loader |
| `/usr/bin` | Ordinary user commands, language runtimes, development tools, public Kandelo commands and game launchers |
| `/usr/sbin` | Service daemons and nonessential administration, such as mariadbd, redis-server and php-fpm |
| `/usr/libexec` | Private executable helpers; game engines behind public launch wrappers and the service control helper |
| `/usr/lib` | Libraries, runtime modules, npm, Erlang and the private Qt installation tree |
| `/usr/lib/kandelo/wasm32posix` | Guest SDK sysroot, glue and cross-compilation configuration |
| `/usr/share` | Architecture-independent application data, manuals, terminfo, licenses and demo catalogs |
| `/usr/local` | Local administrator additions; shipped images may create empty directories but install no files here |
| `/etc` | Machine configuration, accounts, service definitions and Kandelo demo metadata |
| `/srv/www` | Site content served by the machine, including its editable demo sites |
| `/var/lib` | Persistent application state, including `/var/lib/mysql` and `/var/lib/redis` |
| `/var/lib/kandelo-tests` | Writable upstream test work trees for SQLite, PHP and MariaDB, plus conformance runner fixtures |
| `/var/games` | Mutable game data: NetHack state, imported DOOM WADs, extracted Quake data and downloaded or uploaded ScummVM games |
| `/var/log` | Logs; MariaDB logs use `/var/log/mysql` |
| `/var/cache` | Regenerable application caches |
| `/run` | Boot-lifetime state, sockets and PID files; `/var/run` links here and `/var/lock` links to `/run/lock` |
| `/tmp`, `/var/tmp` | Temporary files, with mode 1777; MariaDB's private temporary directory is `/var/tmp/mysql` |
| `/home/maker`, `/root` | User and administrator homes |
| `/dev`, `/proc` | Kernel-provided devices and process information; no fake on-disk substitutes |
| `/media`, `/mnt`, `/opt`, `/srv` | Standard locations for removable media, temporary mounts, optional add-ons and service data |

## Decisions and references

Core images share the rootfs account and privilege foundation: `maker` belongs
to `wheel`, and `/etc/sudoers` grants that group password-authenticated sudo.
Service builders preserve inherited account databases and supplementary groups;
fresh images use the rootfs account files instead of independent account lists.
The shared maker Bash prompt uses `\u@\h:\W\$ ` so the user, current hostname,
and directory basename are expanded when the prompt is displayed.

Kandelo retains separate `/bin` and `/usr/bin` directories and installs each
command once. The FHS distinction is about purpose, not whether a command
was built from a package. The coreutils multicall implementation lives at
`/bin/coreutils`; applets link to it from their one appropriate directory.
`chroot` is administrative and lives in `/usr/sbin`. Semantic aliases such
as `awk`, `vi`, `gunzip`, `mysql` and `/bin/sh` remain; they are different
command names, not duplicate installations of the same name.

The installed `more`, `ed`, `tar`, `gzip`, `gunzip` and `zcat` commands use
`/bin` as specified by FHS sections 3.4.2–3.4.3. Minimal images may omit
them; omission does not justify a second location in images that provide them.

[Debian policy](https://www.debian.org/doc/debian-policy/ch-opersys.html)
is useful for reserving `/usr/local` and separating configuration from state.
Debian permits `/var/www` as an exception to the FHS; Kandelo instead uses
the standard's `/srv` location for served site content. Debian's merged-usr
layout is not Kandelo's layout.

[FreeBSD hier(7)](https://man.freebsd.org/cgi/man.cgi?query=hier&sektion=7&format=html)
provides useful examples of essential tools and private helpers. FreeBSD's
ports use `/usr/local`; Kandelo's own distribution packages belong under
`/usr`, leaving `/usr/local` to the administrator. Neither reference defines
Kandelo's ABI, package system or supported operating-system semantics.

Private service readiness helpers, including `mariadb-ready`, live in
`/usr/libexec`, including when browser composition supplies them at boot.
Browser composition uses the same MariaDB directory ownership setup as image
builds; it must preserve this layout in the final composed image.

Public game launchers live in `/usr/bin`; their private engines live in
`/usr/libexec`. This avoids two different programs named `scummvm`, `fbdoom`
or `quake` relying on PATH precedence between `/usr/local/bin` and `/usr/bin`.

The shell's `/usr/bin/kandelo-page-terminal` publishes a terminal request to
the machine's page. SFWBar's `/usr/bin/kandelo-terminal` launches native Foot
in its Wayland session. Their distinct names preserve package ownership:
the base page publisher must not overwrite an optional desktop helper.

`dos-play` keeps downloaded games, their license files and mutable DOS files
in the invoking user's `$XDG_DATA_HOME/dos-play`, defaulting to
`$HOME/.local/share/dos-play`. These are per-user game installations rather
than shared system data. DOSBox Pure's ZIP write overlays use the adjacent
`dosbox-pure/saves` directory. Static catalogs and license notices belong
under `/usr/share/dos-play`; neither command writes to `/usr`.

The base shell's shared game importer stores complete bundles, original ZIPs,
unpacked files and detection configurations under
`$XDG_DATA_HOME/kandelo/game-imports` (default
`$HOME/.local/share/kandelo/game-imports`). `/usr/bin/game-play` is the public
launcher; its guest Python helper and exchange handler live in
`/usr/libexec/kandelo`. Raw-ROM-only imports retain `~/roms`.

Image builders validate common layout errors before saving products. The
base-rootfs build also audits its artifact before stamping success. For a
manual audit, run under the repository dev shell:

```sh
node --import tsx scripts/check-image-layout.ts IMAGE.vfs.zst
```

This checks duplicate command locations, shipped files under `/usr/local`
and retired nonstandard roots without fetching lazy content. It does not
replace a placement review or prove that every installed application treats
`/usr` as read-only. Image path changes require rebuilding the affected
products; no kernel ABI change or migration of saved user images is implied.

The default mounts keep `/var/log` and `/var/tmp` on the root image and its
persistent overlay. `/tmp` and `/run` are scratch filesystems. At boot the
kernel copies the image's directory layout and uid/gid/mode beneath `/run`
into its fresh scratch filesystem; files, sockets and symlinks are omitted.
This preserves user and service runtime directories without restoring stale
PID files. Image inspection and composition do not perform boot initialization.
Guest-build input mounts must use canonical paths outside scratch filesystems.
The build runner rejects `/tmp`, `/run`, and the standard `/var/run` and
`/var/lock` aliases, including their descendants, because guest path resolution
would hide those host-backed inputs beneath scratch storage. This validation
does not resolve arbitrary symlinks in custom images.
