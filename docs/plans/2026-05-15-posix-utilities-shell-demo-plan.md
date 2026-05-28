# POSIX Utility Coverage Plan for the Shell Demo

Date: 2026-05-15

## Scope

This plan compares the browser shell demo against the POSIX.1-2024 Shell &
Utilities utility index:

- POSIX utility index:
  https://pubs.opengroup.org/onlinepubs/9799919799/utilities/contents.html
- `ps` reference, representative of the process-inspection utilities:
  https://pubs.opengroup.org/onlinepubs/9799919799/utilities/ps.html

"Currently supported" means the utility is available by name in the shell demo
through one of:

- an executable or symlink in the shell VFS/PATH;
- a lazy-registered Wasm binary;
- a bash/dash builtin or shell keyword used by the demo.

The shell demo currently covers the common core through bash/dash, GNU
coreutils, grep, sed, bc, file, m4, make, tar, vi/vim, and other non-POSIX
convenience tools. This document tracks the POSIX utilities that are not
currently available by that definition.

## Cross-Cutting Inclusion Work

Every included utility should follow the same integration path:

1. Add or reuse a `packages/registry/<name>/package.toml` package.
2. Add a build script that installs outputs through `scripts/install-local-binary.sh`.
3. Add `has_<name>` and `build_<name>` helpers in `run.sh`.
4. Add the package to `BROWSER_DEPS` once it is release-buildable.
5. Register the binary in `apps/browser-demos/pages/shell/main.ts` as a lazy file.
6. Add matching symlinks in `images/vfs/scripts/shell-vfs-build.ts`, including
   the eager image path used by the WordPress and LAMP terminal panes.
7. Add a focused browser-shell smoke test for command discovery and one basic
   behavior check.
8. Document incomplete POSIX options in the package README or comments until
   tests cover the full POSIX surface.

The phases below are grouped by implementation mechanics, not by value.

## Practically Supportable Utilities

These 43 utilities are not currently included in the shell demo, but we can
reasonably include them with ports, small in-tree implementations, or existing
packages already present in `packages/registry`.

| Utility | Inclusion Plan | Why It Is Not Included Today |
| --- | --- | --- |
| `ar` | Add a small POSIX archive utility or port an LLVM/binutils-compatible `ar` that can read and write standard archive files. Wire it as a shell binary, distinct from the host-side SDK wrapper. | Only host SDK wrappers exist today; there is no guest `/usr/bin/ar` Wasm program in the shell image. |
| `asa` | Implement as a small in-tree C utility that interprets ASA/FORTRAN carriage-control characters and writes transformed text. | It is a legacy text filter and has not been added as part of the current GNU/coreutils-oriented shell set. |
| `awk` | Reuse `packages/registry/gawk` and add `/usr/bin/awk` and `/bin/awk` symlinks to `gawk.wasm`. | `gawk` has a package and build script, but it is not wired into shell lazy registration or shell VFS symlinks. |
| `cal` | Add a small in-tree implementation or port the tiny util-linux/BSD implementation with only POSIX behavior enabled. | The shell demo does not currently ship calendar/date presentation tools beyond `date`. |
| `cflow` | Port GNU cflow or another compact C call-graph implementation against the wasm32 POSIX SDK. | No source package exists, and it depends on C parser behavior outside the current core shell tools. |
| `cmp` | Reuse `packages/registry/diffutils` and register `cmp.wasm`. | `diffutils` has a package and build script, but none of its outputs are wired into the shell demo. |
| `compress` | Port `ncompress` or a small LZW-compatible implementation; install `compress`, `uncompress`, and `zcat` compatibility as appropriate. | Current compression support is gzip/bzip2/xz/zstd/zip, not POSIX `compress` format. |
| `ctags` | Port Universal Ctags or a smaller POSIX-compatible ctags implementation, with non-POSIX language support disabled if needed. | No source package exists; current developer tools stop at `m4` and `make`. |
| `cxref` | Port a compact C cross-reference tool or implement the POSIX-required subset on top of the same C scanner used for `cflow`. | No source package exists, and it overlaps with the unimplemented C-analysis tool group. |
| `diff` | Reuse `packages/registry/diffutils` and register `diff.wasm`. | `diffutils` has a package and build script, but none of its outputs are wired into the shell demo. |
| `ed` | Port GNU ed or a small BSD-style ed implementation. | The shell currently ships screen editors (`nano`, `vim`) but not the POSIX line editor. |
| `ex` | Provide `ex` via the existing Vim package, either as a symlink plus argv-mode handling or a small wrapper that execs `vim -e`. | Vim is present as a lazy archive, but only `vi`/`vim` symlinks are created. |
| `find` | Reuse `packages/registry/findutils` and register `find.wasm`. | `findutils` has a package and build script, but it is not wired into shell lazy registration or shell VFS symlinks. |
| `fuser` | Implement as an in-tree `/proc` reader using `/proc/<pid>/fd`, similar to `examples/lsof.c`. | The kernel has enough procfs for a basic implementation, but only `lsof` has been written. |
| `gencat` | Add a small catalog compiler implementation that emits the message catalog format consumed by our chosen `catgets()` behavior. | Message catalog tooling has not been part of the shell target so far. |
| `getconf` | Implement as a small in-tree utility backed by `sysconf()`, `pathconf()`, and compile-time constants from the SDK/libc. | There is no guest utility exposing libc/system configuration values. |
| `gettext` | Port GNU gettext-runtime or add a small runtime lookup utility compatible with the catalog format we support. | The shell does not yet include gettext catalogs or gettext command-line tools. |
| `iconv` | Add a small utility backed by libc `iconv()` for available encodings, or port GNU libiconv if musl coverage is insufficient. | The libc surface may have enough API, but no command-line frontend is shipped. |
| `ipcrm` | Add a small in-tree SysV IPC control utility using `msgctl()`, `semctl()`, and `shmctl()`. | SysV IPC exists in the kernel, but there are no command-line inspection/control utilities for it. |
| `ipcs` | Add a small in-tree SysV IPC listing utility. If kernel enumeration exports are insufficient, add read-only enumeration support first. | SysV IPC exists, but the kernel API may need an enumeration path suitable for a utility. |
| `lex` | Port flex and install a POSIX `lex` entry point/symlink. | No lexer-generator package exists in the guest toolset. |
| `locale` | Implement a small utility reporting the currently supported locales and categories, initially `C`, `POSIX`, and any `C.UTF-8` support we intentionally expose. | Locale runtime behavior is minimal and no reporting utility exists. |
| `logger` | Add a small utility that writes to a kernel/host log sink. If no syslog sink exists yet, add a simple `/dev/log` or host-console-backed path first. | There is no guest syslog/logging service or frontend command. |
| `man` | Add a minimal man-page viewer that searches `/usr/share/man` and pipes through `less`/`cat`; package manpages for utilities we ship over time. | No manpage database or viewer is included in the shell VFS. |
| `more` | Provide a simple pager or symlink/wrapper to `less` after making `less` reliably available in release builds. | `less` is referenced but currently omitted from browser deps due known build/release issues. |
| `msgfmt` | Port GNU gettext tools or another gettext catalog compiler implementation. | Gettext build-time tools are not packaged. |
| `ngettext` | Include with the gettext runtime tools, sharing catalog lookup code with `gettext`. | Gettext runtime tools are not packaged. |
| `nm` | Add a guest object-symbol utility. Prefer an LLVM/binutils port if we want broad object support; otherwise start with archive/Wasm object support and document limits. | Only host SDK wrappers exist; no guest `/usr/bin/nm` Wasm program is shipped. |
| `patch` | Port GNU patch or a compact POSIX-compatible patch implementation. | Diff consumption/editing tools have not been included yet. |
| `pax` | Port a POSIX pax implementation, likely from libarchive/bsdtar or paxutils, with tar/cpio archive modes enabled. | The demo ships GNU tar but not the POSIX pax interface. |
| `ps` | Add an in-tree procfs reader using `/proc`, `/proc/<pid>/stat`, `/status`, and `/cmdline`; support POSIX selection/format options incrementally. | Procfs exists, but no process-status utility has been implemented or packaged. |
| `renice` | Add a small utility around `getpriority()` and `setpriority()`. | The kernel stores per-process nice values, but only `nice` is exposed through coreutils. |
| `strings` | Add a small in-tree implementation or port the binutils/LLVM utility. | No guest binary-inspection utilities are shipped. |
| `strip` | Port an LLVM/binutils-compatible stripper, or implement a Wasm-focused subset and document object-format limits. | Only host SDK wrappers exist; there is no guest `/usr/bin/strip` Wasm program. |
| `tabs` | Implement a small terminal-control utility that emits tab-stop control sequences for the xterm-compatible terminal. | Terminal-control companion utilities are not packaged. |
| `tput` | Port a small terminfo frontend backed by the ncurses/terminfo data we choose to ship. | The shell sets `TERM=xterm-256color`, but does not expose terminfo command utilities. |
| `uncompress` | Include with the `compress`/LZW package. | Current compression aliases do not cover POSIX `compress` format. |
| `uudecode` | Add a small in-tree uuencode/uudecode implementation. | Encoding helpers beyond base64/coreutils are not packaged. |
| `uuencode` | Add with `uudecode`, sharing the same small source package. | Encoding helpers beyond base64/coreutils are not packaged. |
| `what` | Implement a small SCCS-ID string scanner. It does not require the full SCCS subsystem. | The full SCCS toolset is absent, so this simple related utility was not added separately. |
| `xargs` | Reuse `packages/registry/findutils` and register `xargs.wasm`. | `findutils` has a package and build script, but it is not wired into shell lazy registration or shell VFS symlinks. |
| `xgettext` | Include with the gettext build-time tools. | Gettext extraction/build tooling is not packaged. |
| `yacc` | Port byacc or another POSIX-compatible yacc implementation. | No parser-generator package exists in the guest toolset. |

## Proposed Inclusion Sequence

The sequence below is based on shared implementation work and dependencies,
not on perceived user value.

1. Wire existing packages:
   `awk`, `find`, `xargs`, `diff`, `cmp`.
2. Add small standalone in-tree tools:
   `asa`, `cal`, `fuser`, `getconf`, `iconv`, `ipcrm`, `ipcs`, `locale`,
   `ps`, `renice`, `tabs`, `uudecode`, `uuencode`, `what`.
3. Add pager/editor/interface wrappers:
   `ed`, `ex`, `man`, `more`, `tput`.
4. Add archive/compression tools:
   `compress`, `uncompress`, `pax`.
5. Add developer/object tools:
   `ar`, `cflow`, `ctags`, `cxref`, `lex`, `nm`, `patch`, `strings`,
   `strip`, `yacc`.
6. Add gettext/catalog tools:
   `gencat`, `gettext`, `msgfmt`, `ngettext`, `xgettext`.

## Not Yet Practical To Include

These 24 utilities are not currently included and should stay deferred until
the named subsystem exists. Each can be revisited if the shell demo grows into
a fuller multi-user or development environment.

| Utility | Reason Not To Include Yet | Prerequisite To Revisit |
| --- | --- | --- |
| `admin` | SCCS administration utility; SCCS is a legacy source-control subsystem and not useful without the rest of SCCS state and workflows. | A deliberate decision to ship POSIX SCCS compatibility as a package group. |
| `at` | Requires a persistent job queue and a daemon-like scheduler that runs commands later. The browser shell has no such background scheduling service. | A guest service manager plus persistent scheduled-job storage. |
| `batch` | Same scheduler family as `at`; additionally depends on load-average semantics that do not map cleanly to the browser worker environment. | The same scheduler service as `at`, plus a defined load metric. |
| `c17` | POSIX C compiler entry point. Shipping this inside the guest means a guest compiler, assembler/object model, linker, sysroot, and usable compile-time filesystem. | A full in-guest C toolchain plan, likely clang/LLVM plus SDK/sysroot packaging. |
| `crontab` | Requires a cron daemon, persistent crontab storage, time wakeups, and background process launching. | A cron service integrated with a guest init/service model. |
| `delta` | SCCS delta creation utility; not useful without SCCS repositories and companion commands. | A deliberate SCCS package group. |
| `get` | SCCS file retrieval utility; not useful without SCCS repositories and companion commands. | A deliberate SCCS package group. |
| `localedef` | Compiles locale definitions into locale databases. The current runtime exposes minimal locale behavior and does not have a locale database model. | A designed locale archive/database format and libc integration. |
| `lp` | Requires a print spooler and printer/device backend. The browser shell has neither. | A print service abstraction and at least one output backend. |
| `mailx` | Requires local mail storage, delivery, and possibly network mail transport. The shell demo has no mail subsystem. | A guest mail spool and delivery/transport story. |
| `mesg` | Controls whether other users can write to the current terminal. The demo has no multi-user login/TTY permission model. | Multi-user sessions, terminal ownership, and write permissions. |
| `newgrp` | Changes real/effective group context and starts a new shell. The demo has only a minimal user/group model and no login group database semantics. | Full user/group/session semantics and `/etc/group` policy. |
| `prs` | SCCS metadata reporting utility; not useful without SCCS repositories and companion commands. | A deliberate SCCS package group. |
| `rmdel` | SCCS delta-removal utility; not useful without SCCS repositories and companion commands. | A deliberate SCCS package group. |
| `sact` | SCCS activity-reporting utility; not useful without SCCS repositories and companion commands. | A deliberate SCCS package group. |
| `sccs` | SCCS frontend utility; shipping it implies the whole SCCS command family and data model. | A deliberate SCCS package group. |
| `talk` | Interactive user-to-user communication. Requires multiple logged-in users, terminal discovery, and a talk service/protocol. | Multi-user login/session support and a terminal messaging daemon. |
| `unget` | SCCS checkout rollback utility; not useful without SCCS repositories and companion commands. | A deliberate SCCS package group. |
| `uucp` | UUCP file transfer utility. Requires UUCP configuration, remote systems, queues, and transport daemons. | A deliberate UUCP subsystem and transport model. |
| `uustat` | UUCP queue/status utility; not useful without UUCP queues and daemons. | A deliberate UUCP subsystem. |
| `uux` | UUCP remote execution utility; not useful without UUCP queues, remotes, and execution policy. | A deliberate UUCP subsystem. |
| `val` | SCCS validation utility; not useful without SCCS repositories and companion commands. | A deliberate SCCS package group. |
| `who` | Reports logged-in users. The demo does not maintain utmp-like login records or multiple user sessions. | A login/session accounting model, probably backed by `/var/run/utmp`-like state. |
| `write` | Sends messages to another logged-in user's terminal. The demo has no multi-user terminal registry or terminal write permissions. | Multi-user sessions, terminal ownership, and messaging permissions. |

## Verification

For each supportable utility as it lands:

- `command -v <utility>` succeeds in the browser shell demo.
- The utility returns a useful `--help` or POSIX-compatible error for invalid
  usage.
- At least one POSIX-representative invocation succeeds in a Playwright shell
  test.
- For utilities backed by procfs, IPC, priority, locale, or terminal state,
  add a kernel/unit test for the underlying data source when a gap is found.
