# DRI v2 — wpk-shell plan (libwpkterm VT100 emulator + wpkshell built-in shell + compositor client)

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to execute this plan task-by-task.

**Goal:** Ship `examples/programs/wpkshell/` — a small (~1.0 kLoC)
wasm32 program that runs as a wpkcompositor client (plan 9), draws
a single tiled window via libwpkdraw (plan 8), embeds a hand-rolled
ANSI/VT100 terminal-emulator core (libwpkterm, ~600 LoC), and runs
a tiny custom POSIX-sh-shaped shell with five built-ins
(`cd`, `ls`, `cat`, `echo`, `exit`) plus `|` pipelines that
fork-exec external programs over plan-6-sockets' socketpair +
fork-exec surface. Plus one new sysroot library — `libwpkterm.a`
(VT100 cell grid + escape-sequence parser + render glue) — that
future apps (a logfile pager, a debug console, an inline
text editor) can reuse.

**Architecture:** Three PRs (one per phase). The user-facing
binary is one C program with three internal modules; libwpkterm
is a separate static archive.

1. **`examples/libs/libwpkterm/`** (~600 LoC + headers, ~120 KB
   static lib) — VT100 cell-grid + escape-sequence parser.
   Public API:
   - `wpk_term_create(cols, rows) → struct wpk_term *` — allocate
     a cell grid (cols × rows × sizeof(struct cell)); scrollback
     ring of `8 × rows` lines.
   - `wpk_term_feed(t, bytes, len)` — drive the parser with raw
     bytes from the child program's stdout; cells get filled,
     cursor advances, escape sequences mutate state. Implements
     the VT100 subset: CR / LF / BS / HT / BEL, CSI cursor
     motion (`CUP CUU CUD CUF CUB`), CSI erase (`ED EL`), CSI
     SGR colour + bold + reverse (`m`), and the 16-colour ANSI
     palette. NO mouse, NO alt-screen, NO 256-colour, NO line
     drawing — see "What this plan doesn't cover" below.
   - `wpk_term_render(t, wpk_surface, font, x, y, w, h)` —
     render the current grid into a libwpkdraw surface; uses
     `wpk_text` for cell-by-cell rendering with per-cell colour.
     Dirty-line tracking to avoid re-rendering unchanged lines.
   - `wpk_term_input_key(t, keysym, modifiers) → ssize_t` — turn
     a keysym + modifier-mask into bytes (the inverse of the
     parser): `Enter` → "\r", `Backspace` → "\x7f",
     `Ctrl-C` → "\x03", arrow keys → CSI sequences, etc. Writes
     the bytes into a caller-provided buffer; returns byte count.
   - `wpk_term_destroy(t)`.
2. **`examples/programs/wpkshell/main.c`** (~400 LoC) — compositor
   client + event loop + terminal/shell wiring. Opens a
   libwpkclient connection, allocates a 800 × 600 surface,
   creates a libwpkterm grid sized to 80 × 25 cells (10 × 24 px
   font cells, default), and runs the event loop:
   - `wpk_client_poll(c, ...)` → on `WPK_CLIENT_KEY`, call
     `wpk_term_input_key` to translate → write bytes to the
     shell's `pipe_to_shell[1]`.
   - `read(pipe_from_shell[0], ...)` → call `wpk_term_feed` to
     update the grid → mark dirty.
   - On `dirty`, re-render the grid via `wpk_term_render` →
     `wpk_surface_present` → `wpk_client_attach_buffer` +
     `wpk_client_commit`.
3. **`examples/programs/wpkshell/shell.c`** (~600 LoC) — the
   built-in shell. Reads command lines from `pipe_to_shell[0]`,
   parses `cmd [args...] [| cmd2 [args...]]`, dispatches:
   - Built-ins (cd, ls, cat, echo, exit) — execute in the
     shell's own process; write output to `pipe_from_shell[1]`.
   - External commands — fork(); child execs the program with
     stdin/stdout/stderr replaced via `dup2(pipe_*, 0/1/2)`;
     parent waits or sets up the next pipe stage. Pipeline
     stages are wired via `socketpair(AF_UNIX, SOCK_STREAM, 0)`
     (plan-6 sockets' surface; `pipe2(2)` is the upstream
     idiom but socketpair works equivalently in v1).

The shell runs **in the same process as the terminal emulator**.
There is no PTY. Built-ins write directly to the in-process
output pipe (`pipe_from_shell`); external commands inherit the
pipe ends via fork+exec. The terminal emulator reads from one
end and feeds VT100 bytes into the grid.

**Tech Stack:**
- Userland C: C99 with `wasm32posix-cc`; static archives only.
- Shell program: `examples/programs/wpkshell/{main.c,shell.c,builtins.c}`
  cross-compiles to `wpkshell.wasm`; installed at
  `/usr/bin/wpkshell`. Init's user-shell exec line (post-PR
  #486) targets `wpkshell` by default if the compositor is
  running; the existing /bin/sh path remains for the
  WordPress demo (which doesn't ship the compositor).
- Wire format: libwpkclient (plan 9) for compositor wire;
  in-process pipe (kernel-side AF_UNIX socketpair via plan 6)
  for terminal ↔ shell ↔ external-command data.
- Buffer sharing: client → compositor via plan 2's prime fd +
  SCM_RIGHTS over libwpkclient. NO host imports.
- Input: libwpkclient delivers `WPK_CLIENT_KEY` events with the
  compositor's xkb-resolved keysym + modifier mask. libwpkterm
  translates keysym → byte stream.
- Text rendering: plan 8's libwpkdraw + DejaVu Sans default
  font @ 14 px (768 × 480 grid for 80 × 25 cells).

**Companion design doc:** `docs/plans/2026-05-18-dri-design.md`
§9.4 (wpk-shell rationale) + §9.3 (libwpkdraw consumer story) +
§13 (fork+exec via SCM_RIGHTS for pipe ends).

**Critical wasm32 ABI detail:** the shell is entirely userspace —
every byte goes through existing syscalls (`socketpair`, `pipe`,
`fork`, `execve`, `dup2`, `read`, `write`, `wait4`, `chdir`,
`getcwd`, `opendir`, `readdir`, `open`, `close`, `stat`). **Zero
kernel exports added.** Zero host imports added.

**Clock source:** All components use `clock_gettime(CLOCK_MONOTONIC,
…)` via the musl shim — cross-stream parity with plans 4/5/6/7/8/9.

**Design reference:** `docs/plans/2026-05-18-dri-design.md` §9.4
(wpk-shell), §9.3 (libwpkdraw text rendering), §13 (fork+exec
surface for pipelines).

**Consistency with plans 2 + 4 + 5 + 6 + 7 + 8 + 9:**

- **No new kernel exports.** All shell surface is userspace C
  over plans 2/6's existing socket + process surfaces.
- **Plan 6 (sockets) ships `socketpair` + `fork` + `execve` +
  `dup2` + `wait4` + SCM_RIGHTS.** Plan 6 audit (session 10)
  confirms all five are IMPLEMENTED. Pipeline construction in
  shell.c uses these directly.
- **Plan 8 (libwpkdraw) is the rendering backend.** Cell grid
  rendering is N × `wpk_text` calls per dirty line; cursor is
  one `wpk_rect`. Plan 8's font (DejaVu Sans) at 14 px is the
  default; the grid is `floor(surface_w / cell_w)` ×
  `floor(surface_h / cell_h)`.
- **Plan 9 (compositor) is the surface broker.** wpkshell is
  always a compositor client. The "direct-KMS" fall-back
  (plan 8 E1) is NOT used — wpkshell never takes KMS master,
  because v1 expects the compositor to be running. Init
  fork-execs wpkshell as PID 3 (after PID 2 wpkcompositor)
  when `/etc/wpk/compositor` exists.
- **Plan 5 (evdev) is bypassed.** libwpkterm consumes
  `WPK_CLIENT_KEY` from libwpkclient — keysym + modifier-mask
  pre-resolved by the compositor's libxkbcommon (plan 9 D4).
  wpkshell does NOT open `/dev/input/event*`.
- **Plan 7 (SDL2) is not involved.** wpkshell is a TTY app;
  no GLES, no audio, no video.

**Stack base:** Plan 9's `…-wpk-demo` branch tip (plan 9 PR #5
head). The shell needs everything from plans 2–9 plus the GL
stack follow-ups. wpkshell links: `-lwpkclient -lwpkterm
-lwpkdraw -lc` (no `-lEGL -lGLESv2 -lgbm` — wpkshell is CPU-
tier-only, like wpkdraw apps).

**Branch:** `emdash/explore-direct-rendering-infrastructure-wpk-shell-plan-XXXXX`
(chains off plan 9's tip per the branching rule). Three
sub-branches stack off it for the three PRs.

**Final PR base:** Plan 9's `…-wpk-demo` tip. **Do not merge**
until Brandon validates the design, plan 9 has merged, and
Phase C's manual browser verification confirms the shell
prompts, accepts input, runs the five built-ins, runs an
external command, runs a `|`-piped pair of external commands,
and renders ANSI colour output correctly.

**Three PRs, coordinated merge.** Each task below is one commit.
PR titles use Brandon's `scope(area): action` shape:

1. `sysroot(wpkterm): libwpkterm — VT100 cell grid + parser + render`
2. `examples(wpk): wpkshell — compositor client + built-in shell + fork-exec pipes`
3. `examples(wpk): wpkshell — demo polish + browser spec`

PR base/head topology (stacked):

```
… (plans 2–9 tips + plan 2/3 GL stack follow-ups + plan 9 demo)
 └── …-wpk-demo                          (plan 9 PR #5 tip)
      └── …-wpk-shell-plan-XXXXX         (this plan PR base)
           └── …-wpk-libwpkterm          (PR #1)
                └── …-wpk-wpkshell       (PR #2)
                     └── …-wpkshell-demo (PR #3)
```

**Verification gauntlet** (CLAUDE.md): all of the below must pass
with zero regressions before any PR is opened, and re-run before
final merge:

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib
(cd host && npx vitest run)
scripts/run-libc-tests.sh
scripts/run-posix-tests.sh
bash scripts/check-abi-version.sh
```

`XFAIL` / `TIME` acceptable; `FAIL` that isn't pre-existing is a
regression. Phase C adds manual `./run.sh browser` verification
(CLAUDE.md item 6) — the compositor boots, wpkshell starts as
PID 3, a `$` prompt renders in a tiled window, typing `echo
hello` echoes `hello`, typing `ls /` lists the rootfs root,
typing `cat /etc/wpk/compositor` cat's the config, typing
`ls / | cat` pipes the listing through cat (external commands
via fork-exec), typing `exit` closes the surface and exits.

**ABI impact:** **None.** Plan 10 adds zero kernel exports,
zero host imports, zero new ioctls, zero new device nodes.
Every byte crosses the kernel-userland ABI via existing surfaces
from plans 2 + 6 + plan-6-sockets. `ABI_VERSION` does not bump;
`abi/snapshot.json` is byte-identical.

The sysroot grows: `sysroot/lib/libwpkterm.a` (~120 KB),
`sysroot/include/wpkterm/wpkterm.h`, the wpkshell binary at
`/usr/bin/wpkshell` (~250 KB including its statically linked
deps). Package index ledger gets one new entry.

Existing kernel + host + ABI surfaces — all unchanged.

---

## Pre-implementation review

Devil's-advocate + consistency pass run 2026-05-19 (session 11),
after plan 10 drafted in session 10. Pass covers: focus areas from
the handoff-10 sentinel (VT100 escape-sequence subset gap risk for
external commands; socketpair-as-pipe EOF semantics vs pipeline
construction; fork-exec depth + PROCESS_TABLE contention;
`opendir`/`readdir` against synthetic /dev entries + `/run/wpk`
socket inode; xkb modifier-mask convention plan 9→plan 10
`input.c`; init shell-line race vs compositor binding
`/run/wpk/comp`; keysym→byte mapping for non-ASCII keys;
in-process shell+terminal vs PTY trade-off; compositor-crash →
wpkshell graceful exit), plus a code-level re-read of every C
snippet in the plan body — `main.c`, `shell.c` (parse_pipeline,
shell_main, execute_line, print_prompt), `builtins.c`
(cd/ls/cat/echo/exit/help), `exec.c` (resolve, run_external,
run_pipeline), `parser.c`, `input.c`, `render.c`, the C2 help
string — plus a re-audit of plan 9's libwpkclient public header
(lines 1366–1410), plan 8's `wpk_surface_create` signature
(line 813), plan-6-sockets' socketpair / SHUT_WR / EOF tests
(`crates/kernel/src/syscalls.rs:11232+`), and the rootfs MANIFEST
for PATH layout (`/bin` + `/usr/bin` at MANIFEST:30 + 32).
Findings are structured Brandon-style. Inline fixes (14) are
**folded conceptually** — plan body retains pre-review text per
the Brandon convention; implementation applies each fix per this
section. Four cross-plan amendments leak back into plans 5 + 9
reviews (three to plan 9 alone — the API gaps are concentrated
there). The load-bearing open-architecture items (3) gate plan
10 implementation start; all three resolve via plan 9 API
amendments, none require new kernel surface.

### Inline fixes (14 — folded conceptually; plan body unchanged)

1. **Help-string `dprintf` length is off by 42 bytes.** Plan 10
   C2 line 1261 ships `dprintf(1, "wpkshell built-ins:\r\n…", 232)`
   but the actual concatenated literal is **274 bytes** (counted:
   21+35+33+29+29+28+29+52+18 with CRLF line endings). The fourth
   `dprintf` positional argument is the format string's length-
   modifier slot under a generic interpretation, but here it's
   being treated as a precision on the trailing args — except the
   format has no `%.*s`, so the `232` literal is dead code OR
   (depending on which `dprintf` overload's actually in plan 10's
   intent) a misplaced length argument that doesn't apply. **Lean:**
   the hardcoded count is a latent bug regardless of whether
   `dprintf` interprets it — drop it and emit via either
   `write(1, msg, strlen(msg))` or `dprintf(1, "%s", msg)`. Fold
   into C2. Same hygiene applies to C1's banner (line 1241 uses
   `strlen(banner)` correctly; the C2 lapse is the outlier).
2. **`wpk_client_get_fd` accessor missing from plan 9 libwpkclient
   API.** Plan 10 main.c B2 line 923 polls
   `wpk_client_get_fd(cl)`, but plan 9's public header (lines
   1366-1410) exposes only `connect/poll/create_surface/
   attach_buffer/commit/set_title/set_type/destroy_surface` — no
   fd accessor. The internal `struct wpk_client` carries `.fd`
   (line 1433) but it's not reachable across the API boundary.
   **Lean:** add `int wpk_client_get_fd(struct wpk_client *c);`
   to plan 9's public header (one-line accessor returning
   `c->fd`). Cross-plan amendment to plan 9 below; fold into
   plan 10's B2 includes.
3. **`wpk_client_attach_buffer` has no `stride` parameter; plan
   9 inline fix #2 (stride-plumbing) is incomplete on the
   client side.** Plan 9 inline fix #2 commits the wire-format
   `wpk_msg_attach_buffer` payload to carry `stride: u32` so
   the compositor's `gbm_bo_import` uses the producer's actual
   row pitch instead of `width * 4`. But plan 9's C API
   `wpk_client_attach_buffer(c, surface_id, prime_fd)` takes no
   stride. Plan 10's `wpk_surface_present` (plan 8 / plan 9 E1
   line 2039) passes only `(client, surface_id, prime_fd)`. The
   stride is unreachable from the call site. **Lean:** extend
   the signature to `wpk_client_attach_buffer(c, surface_id,
   prime_fd, uint32_t stride)`. The libwpkdraw bo-handle path
   already knows the stride via `gbm_bo_get_stride(bo)`; plan
   9 E1's `wpk_surface_present_via_compositor` queries it and
   forwards. Cross-plan amendment to plan 9 below; fold into
   plan 10's `wpk_surface_present` callers (no plan-10-only C
   to change, but the API contract must agree at link time).
4. **Main.c poll loop never installs `SIGPIPE` handler — closed-
   peer writes terminate the wpkshell terminal process.** Plan
   10 B2 line 939 writes a keystroke to `pipe_to_shell[1]` after
   `poll`. If the shell child has already exited (e.g., user
   typed `exit`, or the shell crashed), the write hits a closed
   peer → SIGPIPE → default action terminates the terminal
   process before the cleanup chain at lines 957-962 runs. Same
   hazard exists in shell.c's `write(1, …)` echo at line 1035 if
   main.c crashes. **Lean:** add `signal(SIGPIPE, SIG_IGN);` as
   the first statement of `main()` AND `shell_main()`; check
   `write(...)` returns for `errno == EPIPE` and treat as graceful
   exit. Fold into B2 + B3.
5. **Compositor fd leaks across `execv` in `run_external` /
   `run_pipeline`.** main.c connects to the compositor at B2
   line 889 (libwpkclient opens an AF_UNIX socket). main.c then
   forks `shell_pid` at line 906; the shell child inherits the
   compositor fd. When the shell child fork-execs an external
   command (B5 line 1167/1201), the compositor fd leaks into
   the external program's open-fd table. Worst case: the
   external program reads/writes the compositor protocol stream
   by accident; best case: kernel OFD-table bloat per command.
   Plan 9 inline fix #5 already mandates `SOCK_CLOEXEC` on
   `accept4` for the compositor's accept side; the symmetric
   client-side fix is to set `FD_CLOEXEC` on
   `wpk_client_connect`'s returned fd OR (cleaner) request
   `SOCK_CLOEXEC` on the `socket(2)` call inside libwpkclient.
   **Lean:** plan 9's `wpk_client_connect` body (lines
   1439-1455) calls `socket(AF_UNIX, SOCK_STREAM, 0)`; amend to
   `socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0)`. Cross-plan
   amendment to plan 9 below; no plan-10-only fix needed.
6. **POLLHUP / POLLERR on the compositor fd causes a tight CPU
   spin in main.c's poll loop.** B2 line 931 checks only
   `fds[0].revents & POLLIN`. If the compositor exits, the
   kernel posts POLLHUP|POLLERR on the fd; main.c's `poll`
   returns immediately every iteration because the condition's
   unhandled. No `read` is ever issued to clear the hangup, no
   exit path triggers, and the loop burns CPU. **Lean:** add
   `if (fds[0].revents & (POLLHUP | POLLERR)) { quitting = 1;
   break; }` ahead of the POLLIN arm. Same applies to fds[1]
   (the shell pipe — POLLHUP on shell death must also bail).
   Fold into B2.
7. **Terminal parser treats bare `\n` as line-feed-only; external
   commands' output stair-steps.** A3 line 575-577 advances
   `cy++` on `\n` but does NOT reset `cx = 0`. The shell's
   built-ins explicitly write `"\r\n"` (lines 1019, 1031, 1099)
   so they render correctly, but external commands and the
   built-in `cat` (B4 line 1111 — `write(1, buf, r)` raw) emit
   `\n` alone. Result: `cat /etc/wpk/compositor` renders with
   each line starting where the previous ended (stair-step).
   This is the classic "termios ONLCR" expectation: terminal
   output mode interprets `\n` as CR + LF. **Lean:** parser
   treats `\n` as both CR and LF — set `t->cx = 0` before the
   `cy++` in A3 line 576. Standard xterm behaviour in cooked-
   ish output mode. Fold into A3.
8. **`fork()` return value < 0 unhandled in main.c (line 906).**
   `if (shell_pid == 0)` is the child arm; non-zero is treated
   as parent. But if fork returns -1 (e.g., process-table
   exhaustion under plan 7 risk register), main.c proceeds to
   `close(pipe_to_shell[0])`, then polls on a pipe that has no
   writer, reads 0, exits — with a delayed `waitpid(-1, …)` that
   returns EINVAL. Silent misdiagnosis. **Lean:** add
   `if (shell_pid < 0) { perror("fork"); return 1; }` after
   line 906. Same hygiene applies to `run_pipeline`'s fork loop
   (B5 line 1192): on fork failure, close all sp fds, waitpid
   the previously-forked stages, return cleanly. Fold into B2 +
   B5.
9. **`wpk_term_input_key` returns `(size_t)snprintf(...)` —
   truncation-aware byte count missing.** A6 lines 753-761 cast
   snprintf's int return to `size_t`. snprintf returns the
   number of bytes that WOULD have been written, not the number
   actually written. If `out_cap < 4`, snprintf still returns 3
   for `"\x1b[D"` while writing only `out_cap - 1` bytes plus a
   NUL. The caller writes `3` bytes from `out[]` — including
   uninitialised data past the truncated tail. main.c's caller
   passes `sizeof buf = 8` (line 938), so the practical
   exposure is zero, but the function contract is buggy.
   **Lean:** for the CSI arms, replace `snprintf` with direct
   `memcpy`/`memcpy_const` of a fixed-length 3-byte / 4-byte
   array and return the constant length; gate on `out_cap` first.
   Fold into A6.
10. **`<errno.h>` not included in `main.c`.** B2 references
    `errno == EINTR` at line 929 but the include block (lines
    867-874) lacks `<errno.h>`. Compile error (or implicit-int
    in pre-C11 dialects, which `wasm32posix-cc` is not). Same
    omission in shell.c — `try_builtin`'s `cd` arm calls
    `strerror(errno)` at line 1084 without including
    `<errno.h>`. **Lean:** add `#include <errno.h>` to both
    `main.c` and `shell.c`. Fold into B2 + B3.
11. **`SIGCHLD` reaping policy unspecified — pipeline zombies
    accumulate if a stage exits before the sequential
    `waitpid` loop reaches it.** B5 lines 1209 walks
    `for (int i = 0; i < n; i++) waitpid(pids[i], …)`. POSIX
    queues zombies per parent until reaped, so the sequential
    reap is correct — but a long-running stage N earlier in the
    loop blocks reaping of already-exited stages N+1..n-1, and
    a `SIGINT` mid-pipeline could leave the shell stuck on a
    waitpid that never resolves. **Lean:** use `WNOHANG` polling
    on each subsequent pid after the first non-blocking wait,
    OR (simpler) accept the sequential-wait penalty as v1's
    documented behaviour and add a comment. Lean (b);
    pipelines in v1 are short-lived. No code change; ship the
    comment. Fold into B5.
12. **Init's wpkshell-exec race vs compositor binding
    `/run/wpk/comp`.** B1 line 847 unconditionally `execl`s
    `/usr/bin/wpkshell` if `access("/etc/wpk/compositor", F_OK)
    == 0`. Init has just fork-exec'd the compositor at plan 9
    D1; the compositor's `socket() → bind() → listen()` sequence
    has not yet completed when init proceeds to the user-shell
    exec. wpkshell's `wpk_client_connect` calls `connect(2)` on
    `/run/wpk/comp` — which doesn't exist yet → ENOENT →
    wpkshell exits fatally → init reaps → empty screen. **Lean:**
    init waits for the socket-path to exist before exec'ing
    wpkshell — a tight loop of `access("/run/wpk/comp", F_OK)`
    with a 50 ms sleep, 2-second timeout. Approximately 10
    lines. Plan 9's libwpkclient could alternatively add a
    connect-retry loop (cross-plan amendment); lean the init-
    side fix because plan 9's connect is already correct under
    "compositor-up" assumption and the race is init's
    sequencing problem to solve. Fold into B1.
13. **`run_pipeline` resolve-failure mid-loop leaks socketpair
    fds + leaves previously-forked stages orphaned.** B5 line
    1188-1190: if `resolve(stages[i][0])` returns NULL for stage
    i > 0, the function waits previously-forked stages but
    never closes `sp[0..n-2][*]` — leaks 2(n-1) fds per failed
    pipeline. Subsequent execve calls also dangle (the loop
    `return`s). **Lean:** factor the close-all-sp-fds block out
    of the parent's post-loop sequence (line 1208) and call it
    from the resolve-failure path AND the fork-failure path.
    Fold into B5.
14. **Pipeline child's resolve-failure leaks `path` malloc.** B5
    line 1185-1186: `char *path = resolve(stages[i][0])` is
    only `free`d at line 1204 in the parent's post-fork branch.
    The child does not `free(path)` before `execv` (acceptable —
    process exit reclaims) nor before `_exit(127)` on execv
    failure (acceptable for the same reason). But if the child
    fork's `execv` ever exits to an error path that loops back
    (it doesn't in this code, but defensive), the malloc
    persists. **Lean:** explicit `free(path)` after `execv(...)`
    and before `_exit(127)` is hygiene — costs one line, gains
    nothing functional but matches plan 8/9 conventions. Fold
    into B5 as a comment only ("path malloc reclaimed by
    process exit; free is hygiene"); not strictly required.

### Correctness — open (lean documented)

- **`compositor_crash` → wpkshell graceful exit.** Per plan 9
  Correctness — open ("compositor-client mode is one-way"),
  EPIPE on libwpkclient send → libwpkclient propagates the
  error → wpkshell main.c sees a failed `wpk_surface_present`
  or POLLHUP on the compositor fd (per inline fix #6) → quits.
  Cleanup chain (lines 957-962) runs: kill shell child,
  waitpid, destroy surfaces, return. Lean: documented; no
  watchdog / auto-relaunch in v1.
- **VT100 unknown-CSI silent-drop visual artifact.** Per A3
  line 558-559, unknown CSI finals are ignored. External
  programs that emit 256-colour (`ESC [ 38;5;n m`), truecolour
  (`ESC [ 38;2;r;g;b m`), alt-screen (`ESC [ ? 1049 h`), or
  mouse-tracking (`ESC [ ? 1000 h`) leave residual parameter
  bytes in `csi_buf` correctly cleared by the final-byte arm,
  but the SGR side-effects are lost. Demo's `ls`/`cat`/`echo`
  output stays in the 16-colour subset; lean: documented;
  no logging in v1 (would clutter the user's stderr).
- **xkb modifier-mask convention plan 9 → plan 10.** Plan 9 D4
  emits `WPK_CLIENT_KEY.modifiers` as the result of
  `xkb_state_serialize_mods(state, XKB_STATE_MODS_EFFECTIVE)`.
  xkbcommon's effective-mods bitmask uses index 2 for Control
  in the default `evdev` keymap (`xkb_keymap_mod_get_index(km,
  "Control") == 2`). Plan 10 input.c line 736 hardcodes
  `MOD_CTRL = (1u << 2)`. Lean: convention matches; document in
  input.c's header comment that the bit assignment depends on
  xkbcommon's keymap-default order. If a future keymap-load
  change rebinds the mod indices (unlikely — `evdev` is the
  pinned rules-file per plan 9), input.c needs an update.
  Regression test in B4 asserts `Ctrl-c` → 0x03.
- **PROCESS_TABLE contention under nested fork-exec.** Plan 10
  pipelines fork ≤ 3 children per command; init + compositor
  + wpkshell main + wpkshell shell-child + 3 stages = 7
  processes at peak. Plan 7 risk register #2 (OFD-table-split
  refactor) profiled this class of contention as not load-
  bearing at small N. Lean: documented; profile in C4 and
  defer the refactor unless visible. No plan-10 architectural
  change.
- **`SIGPIPE` in external-command children.** v1 pipeline
  stages inherit default `SIGPIPE = terminate`. When stage N+1
  closes its read end early (e.g., `yes | head -1`), stage N's
  next `write` triggers SIGPIPE → stage N dies. This is the
  correct POSIX shell behaviour for pipeline backpressure. The
  shell process itself (per inline fix #4) ignores SIGPIPE;
  the children explicitly do NOT inherit SIG_IGN because the
  shell's `signal(SIGPIPE, SIG_IGN)` is process-local and is
  NOT preserved across `execve` (kernel resets dispositions
  set to non-default to default on exec, except SIG_IGN — but
  POSIX explicitly says SIG_IGN IS preserved across execve, so
  the children would inherit SIG_IGN). **Lean:** in
  `run_external` / `run_pipeline` children, restore default
  SIGPIPE disposition before `execv`: `signal(SIGPIPE,
  SIG_DFL);` immediately before each `execv` call. Fold into
  B5; treat as part of inline fix #4's symmetric story rather
  than a separate fix.
- **Built-in `ls` against `/dev/input` returns only `mice`.**
  `devfs.rs:180` documents "No /dev/input/eventN evdev nodes
  yet (mousedev surface only)". Plan 5's evdev nodes are
  virtual — present via `open(2)` but not enumerated by
  `readdir(2)`. v1 demo's `ls /dev` shows `mice` but not
  `event0`/`event1` despite plan 9's compositor opening them.
  Lean: cross-plan amendment to plan 5 (enumerate event0..N
  in devfs); not LOAD-BEARING for plan 10 — the demo command
  `ls /` is sufficient to validate `opendir`/`readdir`.
- **`/run/wpk/comp` not listed by `readdir("/run/wpk")`.**
  AF_UNIX bound sockets are not regular dentries in the
  kernel's host-backed VFS — they live in the
  `UnixSocketRegistry` (kernel/src/socket.rs). `ls /run/wpk`
  via wpkshell's built-in `ls` will not show the socket. Lean:
  documented; AF_UNIX sockets being directory-invisible is
  not a regression — Linux exposes them via the abstract
  namespace OR a file inode of type `S_IFSOCK` if `bind`-ed
  to a real path. The kandelo VFS doesn't currently produce
  `S_IFSOCK` dentries from `UnixSocketRegistry.bind`.
  Cross-plan amendment to plan-6-sockets noted under
  "Cross-plan amendments" below; not LOAD-BEARING — wpkshell
  doesn't depend on `ls /run/wpk` for any functionality.
- **`wait4` in shell child blocks the read-loop.** Risk
  register #6 documents this; main.c is a separate process so
  the terminal stays responsive. Lean: documented; v1.

### Architecture — open (LOAD-BEARING flag)

1. **`wpk_client_get_fd` accessor required for `poll(2)`
   integration.** [LOAD-BEARING] Plan 10's poll loop cannot
   function without the accessor (inline fix #2). Two options:
   (a) plan 9 amendment exposes the public API (one-line
   accessor + signature in libwpkclient.h); (b) plan 10 reaches
   into the struct via a private header `#include`. Lean (a) —
   plan 9 is the API owner; the accessor is a five-minute
   amendment. Cross-plan amendment to plan 9 below. Without
   this, plan 10 implementation cannot start.
2. **`wpk_client_attach_buffer` stride extension required for
   plan 9 inline fix #2's wire contract.** [LOAD-BEARING] Plan
   9 inline fix #2 mandates the wire payload carry `stride: u32`
   but plan 9's libwpkclient C API has no stride parameter.
   Without the extension, the compositor's `gbm_bo_import` MUST
   recompute `width * 4`, re-introducing plan 9 fix #2's bug.
   Lean: plan 9 amends the C signature; plan 10 forwards the
   client-side stride from `gbm_bo_get_stride(bo)` (already
   wired through plan 8's bo handle). Cross-plan amendment to
   plan 9 below. Without this, plan 9 fix #2 is incomplete and
   plan 10's first non-trivial render exposes the bug.
3. **Init → wpkshell sequencing vs compositor `bind`.**
   [LOAD-BEARING] (Inline fix #12.) Three resolution options:
   (a) init `access("/run/wpk/comp", F_OK)`-poll with 50 ms /
   2 s timeout (≈10 lines of C in init); (b) plan 9
   libwpkclient `wpk_client_connect` retries with backoff
   (≈8 lines of C in libwpkclient); (c) document the race +
   relaunch manually. Lean (a) — init is the sequencing
   authority, and (a) keeps libwpkclient's connect semantics
   single-attempt for non-init callers (which is the more
   common case). (b) ships as a fallback if (a) proves
   flaky in practice. Cross-plan amendment to plan 9 below for
   the (b) option as a future-proofing escape hatch. Without
   (a), wpkshell exits fatally before the demo ever renders.

### Missing tests

- **Compositor-up wpkshell boot.** vitest spawns compositor +
  wpkshell; assert wpkshell connects + a green `$` prompt
  renders in the surface within 1 s. Regression guard for
  inline fix #12.
- **socketpair-as-pipe EOF.** cargo test (plan-6-sockets
  audit confirms IMPLEMENTED: `test_socketpair_close_one_end`
  at `crates/kernel/src/syscalls.rs:11259`); plan 10 adds a
  vitest that runs `echo hi | cat` end-to-end and asserts cat
  exits cleanly after stage 0 closes.
- **`parse_pipeline` token boundaries.** Cargo test on
  shell.c's `parse_pipeline`: `"echo hi"` → 1 stage;
  `"ls / | cat"` → 2 stages; `"a|b|c"` → 3 stages;
  `"   "` → 0 stages; `"|cmd"` → 0 stages (or 1 with empty
  argv — define which); `"cmd args   args   "` → 1 stage with
  argc=3. Regression guard for inline fix #14 polish.
- **`resolve` against PATH = /usr/bin:/bin.** Cargo test:
  resolve `"echo"` → `/usr/bin/echo` if present; resolve
  `"nosuchcmd"` → NULL; resolve `"./foo"` → `./foo` (slash
  in argv[0] short-circuits PATH search).
- **3-stage pipeline.** vitest: `echo hello | cat | cat`
  produces `hello` on the terminal grid. Confirms n=3 sp
  setup, fork-exec, sequential waitpid.
- **SIGPIPE shell survival.** vitest: run a pipeline where
  the consumer closes early; assert the shell process is
  still alive afterward (no SIGPIPE-kill). Regression guard
  for inline fix #4.
- **Compositor-fd close-on-exec.** vitest: spawn wpkshell;
  run `ls /proc/self/fd` (if available — else a custom helper
  that lists open fds via syscalls); assert the compositor
  fd (libwpkclient's socket) is NOT present in the external
  command's fd table. Regression guard for inline fix #5.
- **POLLHUP cleanup.** vitest: spawn compositor + wpkshell;
  send SIGTERM to compositor; assert wpkshell exits within
  500 ms (not spinning on poll). Regression guard for inline
  fix #6.
- **`\n` → CR+LF in terminal parser.** Cargo test on
  `wpk_term_feed`: feed `"line1\nline2"`; assert grid[0]
  starts with `"line1"` (cx=5 at end of feed becomes cx=0
  before cy++) and grid[1] starts with `"line2"` at column 0.
  Regression guard for inline fix #7.
- **`wpk_term_input_key` truncation bounds.** Cargo test:
  call with `out_cap = 2` for Up arrow (needs 3 bytes); assert
  return is 0 or ≤ out_cap (never claims more bytes than
  written). Regression guard for inline fix #9.
- **Init shell-line gating.** vitest: rootfs WITH
  `/etc/wpk/compositor` → init exec's `/usr/bin/wpkshell`
  AND waits for socket presence first. rootfs WITHOUT →
  init exec's `/bin/sh`. Regression guards for inline fix
  #12 + plan 9 D1 + plan 10 B1.
- **C2 help-string byte-count agreement.** Cargo or vitest
  smoke: read the help-string literal at compile time and
  assert `strlen(s) == bytes_written_by_dprintf` (or just
  use `strlen` directly per inline fix #1). Regression guard
  against off-by-N hardcoded counts.
- **`ls /dev` enumeration.** Cargo test: assert `readdir("/dev")`
  includes `mice`; document that `event0`/`event1` are NOT
  present (per `devfs.rs:180`). Cross-plan amendment to plan 5
  changes this expectation later.
- **Pipeline cleanup on resolve-failure.** vitest: run
  `nosuchcmd | cat`; assert (a) the second stage's socketpair
  fds are cleaned up; (b) the shell process's open-fd count
  is the same after the failed pipeline as before. Regression
  guard for inline fix #13.

### Trade-offs verified

- **Hand-rolled VT100 parser, no vterm/libtsm port.** Per the
  plan's design: ~600 LoC + headers vs ~5000 LoC libtsm port.
  v1 demo's escape subset is reachable in the smaller surface
  area. ✓
- **In-process shell + terminal, no PTY.** No kernel pty
  surface; built-ins write directly to the in-process output
  pipe; external commands inherit pipe ends via fork+exec. ✓
- **Five built-ins (cd, ls, cat, echo, exit) + help.** Smallest
  set that demonstrates fork-exec + pipelines + filesystem +
  output. ✓
- **No quoting / variable expansion / wildcards / redirection.**
  v2. ✓
- **VT100 subset, 16-colour palette.** ✓
- **Fixed 80 × 25 grid in 800 × 600 surface.** Matches plan 9's
  surfaces-immutable invariant. ✓
- **Monospace font assumption.** DejaVu Sans M-advance
  heuristic; risk register #4 documents the post-v1 path
  (DejaVu Sans Mono). ✓
- **PATH = /usr/bin:/bin hardcoded.** MANIFEST:30+32+63 confirm
  both directories exist as real rootfs entries. ✓
- **Pipelines via socketpair, not pipe(2).** Plan-6-sockets
  audit confirms IMPLEMENTED; EOF semantics tested at
  `crates/kernel/src/syscalls.rs:11259`. ✓
- **No background jobs, no signal forwarding.** v2. ✓
- **No history, no readline.** Up-arrow CSI A delivered to the
  shell but ignored (no history buffer). v2. ✓
- **One window, one shell, one tab.** v2 multi-tab. ✓
- **Compositor-only, no direct-KMS fall-back.** wpkshell exits
  if no compositor — matches plan 9 client expectations. ✓
- **No clipboard.** Plan 9 reserves CLIPBOARD_* messages as
  v2. ✓
- **Init exec gated on `/etc/wpk/compositor` marker.**
  WordPress demo path (`/bin/sh`) preserved. ✓
- **Zero ABI impact.** No kernel exports, no host imports, no
  new ioctls, no new device nodes. ✓
- **Three-PR stacked merge.** libwpkterm → wpkshell → demo
  polish. ✓
- **CLOCK_MONOTONIC pinned via musl shim.** Cross-stream
  parity with plans 4–9. ✓
- **Static-link-only invariant.** `libwpkterm.a` (~120 KB)
  ships `.a` only; wpkshell statically links. ✓
- **No animation framework / per-keystroke dirty redraw.** ✓
- **socketpair as one-way pipe.** Plan 6 surface; bidirectional
  but used uni-directionally. ✓
- **Shell child stdin/stdout dup2'd; stderr also points at
  pipe_from_shell[1].** Single sink simplifies the terminal
  display (no separate error stream). ✓

### Deliberately not flagged

- **Real PTY surface (`openpty` / `forkpty`).** v2. ✓
- **External shells (bash, zsh) hosted under wpkshell.**
  Requires PTY surface; v2. ✓
- **Sixel / Kitty graphics.** Out of scope. ✓
- **Multi-monitor (plan 4 invariant).** ✓
- **Per-user `.wpkrc` config.** v2. ✓
- **Lua / scripting / plugin layer.** No. ✓
- **Cursor blink animation.** v1 = static underline cursor. ✓
- **Scrollback UI keybinding.** Ring exists in libwpkterm;
  Shift-PageUp binding is v2. ✓
- **Locale handling beyond UTF-8.** v1 = UTF-8 only. ✓
- **`pwd` built-in.** Overlap with the prompt's cwd
  display. ✓
- **`env` / `set` / `export` built-ins.** No env-var
  expansion in v1. ✓
- **256-colour / truecolour SGR parameters.** Silently dropped
  per A3's CSI default arm; risk register #8 documents. ✓
- **Wayland-bridge from plan 9 §15.** v2. ✓
- **Terminal resize (SIGWINCH).** v1 surfaces are client-
  immutable per plan 9. ✓
- **Pipeline >8 stages.** B5 caps at 8 (sp[8][2] + pids[8]);
  no realistic v1 command uses more. ✓
- **Cursor wrap-at-right-margin newline emission.** A3 line
  483-486 wraps + advances cy; renders correctly. Edge case:
  the wrap-and-scroll-at-bottom is handled. ✓
- **stb_truetype double-include in wpkshell vs libwpkterm.**
  wpkshell links libwpkdraw (stb impl ships once there) +
  libwpkterm (header-only consumer). Same invariant as plan 9
  inline fix #16 — verify `nm wpkshell.wasm | grep stbtt_`
  shows one resolution. Documented; not a separate fix. ✓
- **fork-failure mid-pipeline leaves partial state.** B5's
  cleanup path (per inline fix #13) handles resolve-failure;
  the symmetric fork-failure path is folded into the same
  helper. ✓
- **`cat`'s 4 KB buffer.** Risk register #4; slow but
  correct. ✓
- **Cursor underline at `(cy + 1) * cell_h - 2`.** Renders 2
  px inside the cell; visually acceptable; v2 may make
  configurable. ✓
- **`waitpid` ordering — kernel-queued zombies per parent.**
  POSIX semantics; tested across plan-6-sockets. ✓
- **VT100 BEL (0x07).** A3 line 580 — ignored in v1 (no audio
  / no flash). v2 may add a flash. ✓
- **`compositor_pick` z-order from plan 9.** Plan 10 inherits
  it; not a plan 10 concern. ✓

### Cross-plan amendments (added to plans 5 + 9 reviews)

- **Plan 9 follow-up (LOAD-BEARING).** Add public-API accessor
  `int wpk_client_get_fd(struct wpk_client *c);` to plan 9's
  libwpkclient header (lines 1366-1410). One-line
  implementation: `return c ? c->fd : -1;`. Required for plan
  10's poll-loop integration (plan 10 inline fix #2). Note
  added under plan 9's existing "Cross-plan amendments"
  subsection as an addendum item: "Plan 10 follow-up
  (LOAD-BEARING): expose `wpk_client_get_fd` accessor for
  poll(2) integration."
- **Plan 9 follow-up (LOAD-BEARING).** Extend
  `wpk_client_attach_buffer` signature to
  `(c, surface_id, prime_fd, uint32_t stride)`. The wire-format
  fix from plan 9 inline fix #2 is incomplete on the C-API side
  without this. libwpkclient's body queries the bo's stride via
  `gbm_bo_get_stride(bo)` at the call site (plan 8 / plan 9 E1
  `wpk_surface_present_via_compositor`) and forwards. Plan 10
  inline fix #3.
- **Plan 9 follow-up (escape hatch).** Optionally add a
  connect-retry loop to `wpk_client_connect` (≈8 lines:
  10 × 50 ms backoff on ENOENT before returning NULL). Lean:
  ship the init-side wait first (plan 10 inline fix #12); add
  the libwpkclient escape hatch only if init's poll proves
  flaky.
- **Plan 9 follow-up.** Amend `wpk_client_connect` to
  `socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0)` so the
  compositor fd does not leak across `execv` in client-side
  fork-exec flows. Plan 10 inline fix #5. Note added to plan
  9's "Cross-plan amendments" subsection: "Plan 10 follow-up:
  SOCK_CLOEXEC on client socket — symmetric to plan 9 inline
  fix #5 (SOCK_CLOEXEC on accept4)."
- **Plan 5 follow-up.** Enumerate `/dev/input/event0..N` in
  devfs `readdir` (kernel/src/devfs.rs around line 180 where
  the comment "No /dev/input/eventN evdev nodes yet (mousedev
  surface only)" lives). Without this, `ls /dev/input` from
  wpkshell shows only `mice`. Not LOAD-BEARING for plan 10 —
  the demo's `ls /` doesn't depend on it — but a UX paper-cut
  worth a one-line note under plan 5's existing "Cross-plan
  amendments" subsection: "Plan 10 follow-up: enumerate
  /dev/input/event* in devfs readdir for `ls /dev/input` UX."
- **Plan-6-sockets follow-up (optional, NOT LOAD-BEARING).**
  AF_UNIX-bound socket paths (e.g., `/run/wpk/comp`) are not
  surfaced as `S_IFSOCK` dentries via the host-backed VFS.
  `readdir("/run/wpk")` returns nothing for the bound socket.
  Lean: documented as v2 hygiene; wpkshell doesn't depend on
  the listing.

---

## Phase A — sysroot: libwpkterm (PR #1)

The VT100 cell-grid + parser + render-glue library.

### Task A1: Package scaffold

**Files:**
- Create: `examples/libs/libwpkterm/package.toml` — recipe.
- Create: `examples/libs/libwpkterm/build.toml` — build state.
- Create: `examples/libs/libwpkterm/build.sh` — build script.

```toml
# examples/libs/libwpkterm/package.toml
name = "libwpkterm"
version = "0.1.0"
license = "MIT"
description = "VT100 terminal emulator — cell grid + ANSI escape parser + render via libwpkdraw"

[source]
type = "local"

[deps]
libwpkdraw = "0.1.0"   # rendering primitives + DejaVu Sans

[build]
script_path = "build.sh"
```

```toml
# examples/libs/libwpkterm/build.toml
script_path = "build.sh"
revision = 1

[binary]
index_url = "https://github.com/<repo>/releases/download/binaries-abi-v{abi}/index.toml"
```

```bash
#!/usr/bin/env bash
# examples/libs/libwpkterm/build.sh
set -euo pipefail
. "$WPK_WORKTREE/sdk/activate.sh"

SRC_DIR="$1"
OUT_DIR="$2"
WORK="$OUT_DIR/build"
mkdir -p "$WORK/lib" "$WORK/include/wpkterm"

cd "$SRC_DIR/src"
wasm32posix-cc -c -O2 \
    -I"$SRC_DIR/include" \
    -I"$WPK_SYSROOT/include" \
    grid.c parser.c render.c input.c
llvm-ar rcs "$OUT_DIR/lib/libwpkterm.a" *.o
cp -r "$SRC_DIR/include/wpkterm" "$OUT_DIR/include/"
```

**Commit:** `sysroot(wpkterm): scaffold libwpkterm package`

### Task A2: Public header + cell-grid type

**Files:**
- Create: `examples/libs/libwpkterm/include/wpkterm/wpkterm.h`
- Create: `examples/libs/libwpkterm/src/grid.c`

```c
// include/wpkterm/wpkterm.h
#ifndef WPKTERM_H
#define WPKTERM_H

#include <stdint.h>
#include <sys/types.h>

struct wpk_term;          /* opaque */
struct wpk_surface;       /* from wpkdraw */
struct wpk_font;          /* from wpkdraw */

/** Allocate a cells × rows terminal grid. Returns NULL on OOM. */
struct wpk_term *wpk_term_create(int cols, int rows);
void wpk_term_destroy(struct wpk_term *t);

/** Feed N bytes from the child's stdout. The parser advances the
 * cursor + mutates cells. */
void wpk_term_feed(struct wpk_term *t, const char *bytes, size_t len);

/** Render the grid into a libwpkdraw surface at (x, y, w, h). Uses
 * dirty-line tracking; only changed lines are repainted. */
void wpk_term_render(struct wpk_term *t,
                     struct wpk_surface *s,
                     struct wpk_font *f,
                     int x, int y, int w, int h);

/** Translate a keysym + modifier mask into an ANSI byte sequence
 * suitable for writing to the child's stdin. Returns the number
 * of bytes written to `out` (≤ out_cap); 0 if the key produces
 * no output (e.g., a bare Shift press). */
size_t wpk_term_input_key(uint32_t keysym, uint32_t modifiers,
                          char *out, size_t out_cap);

/** Force a full re-render on the next wpk_term_render call. Useful
 * after window resize (post-v1) or theme change. */
void wpk_term_mark_dirty_all(struct wpk_term *t);

#endif /* WPKTERM_H */
```

```c
// src/grid.c — cell grid + cursor state + scrollback ring.
#include <wpkterm/wpkterm.h>
#include <stdlib.h>
#include <string.h>

struct cell {
    uint32_t codepoint;       /* UTF-32 */
    uint8_t fg, bg;           /* 0-15 ANSI palette + 16 = default */
    uint8_t flags;            /* bit 0 = bold, bit 1 = reverse */
    uint8_t _pad;
};

struct wpk_term {
    int cols, rows;
    struct cell *grid;        /* cols × rows */
    /* Cursor */
    int cx, cy;
    /* SGR state */
    uint8_t fg, bg, flags;
    /* Dirty-line bitmap, one bit per row */
    uint8_t *dirty;
    /* Parser state machine */
    enum { GROUND, ESCAPE, CSI } state;
    char csi_buf[32];         /* CSI parameter buffer */
    int csi_used;
    /* Scrollback (post-v1 might expose; v1 just bounds memory) */
    int scrollback_lines;     /* hard-coded = 8 × rows */
    struct cell *scrollback;
    int scrollback_head;      /* circular write index */
};

struct wpk_term *wpk_term_create(int cols, int rows) {
    if (cols < 4 || cols > 512 || rows < 4 || rows > 256) return NULL;
    struct wpk_term *t = calloc(1, sizeof *t);
    if (!t) return NULL;
    t->cols = cols; t->rows = rows;
    t->grid = calloc((size_t)cols * rows, sizeof(struct cell));
    t->dirty = calloc((rows + 7) / 8, 1);
    t->scrollback_lines = 8 * rows;
    t->scrollback = calloc((size_t)cols * t->scrollback_lines,
                           sizeof(struct cell));
    if (!t->grid || !t->dirty || !t->scrollback) {
        wpk_term_destroy(t); return NULL;
    }
    t->fg = 7; t->bg = 16;    /* default fg = white, bg = default */
    wpk_term_mark_dirty_all(t);
    return t;
}

void wpk_term_destroy(struct wpk_term *t) {
    if (!t) return;
    free(t->scrollback); free(t->dirty); free(t->grid); free(t);
}

void wpk_term_mark_dirty_all(struct wpk_term *t) {
    for (int i = 0; i < (t->rows + 7) / 8; i++) t->dirty[i] = 0xff;
}

/* Mark one row dirty. */
static void mark_dirty(struct wpk_term *t, int row) {
    if (row >= 0 && row < t->rows) t->dirty[row / 8] |= 1u << (row % 8);
}

/* Scroll the grid up by one line (top line goes to scrollback). */
static void scroll_up(struct wpk_term *t) {
    /* Copy top row to scrollback. */
    memcpy(&t->scrollback[t->scrollback_head * t->cols],
           &t->grid[0], (size_t)t->cols * sizeof(struct cell));
    t->scrollback_head = (t->scrollback_head + 1) % t->scrollback_lines;
    /* Shift rows up. */
    memmove(&t->grid[0], &t->grid[t->cols],
            (size_t)(t->rows - 1) * t->cols * sizeof(struct cell));
    /* Clear bottom row. */
    memset(&t->grid[(t->rows - 1) * t->cols], 0,
           (size_t)t->cols * sizeof(struct cell));
    /* Set the bottom row's bg from current SGR state. */
    for (int x = 0; x < t->cols; x++) {
        t->grid[(t->rows - 1) * t->cols + x].fg = t->fg;
        t->grid[(t->rows - 1) * t->cols + x].bg = t->bg;
    }
    /* All lines dirty after a scroll. */
    wpk_term_mark_dirty_all(t);
}
```

**Cargo test:** smoke — `wpk_term_create(80, 25)` returns
non-NULL; `wpk_term_destroy` doesn't leak.

**Commit:** `sysroot(wpkterm): cell grid + cursor + scrollback ring`

### Task A3: VT100 escape-sequence parser

```c
// src/parser.c
#include <wpkterm/wpkterm.h>
#include "_internal.h"   /* struct wpk_term, struct cell — same as grid.c */
#include <string.h>
#include <stdlib.h>

static void put_char(struct wpk_term *t, uint32_t codepoint) {
    /* Wrap at right margin. */
    if (t->cx >= t->cols) {
        t->cx = 0;
        if (++t->cy >= t->rows) { scroll_up(t); t->cy = t->rows - 1; }
    }
    struct cell *c = &t->grid[t->cy * t->cols + t->cx];
    c->codepoint = codepoint;
    c->fg = t->fg; c->bg = t->bg; c->flags = t->flags;
    mark_dirty(t, t->cy);
    t->cx++;
}

static void apply_csi(struct wpk_term *t, char final) {
    /* Parse t->csi_buf as semicolon-separated ints. */
    int params[16] = {0};
    int n_params = 0;
    const char *p = t->csi_buf;
    while (*p && n_params < 16) {
        params[n_params++] = strtol(p, (char **)&p, 10);
        if (*p == ';') p++;
    }
    switch (final) {
    case 'A': /* CUU n */ t->cy -= params[0] ? params[0] : 1; break;
    case 'B': /* CUD n */ t->cy += params[0] ? params[0] : 1; break;
    case 'C': /* CUF n */ t->cx += params[0] ? params[0] : 1; break;
    case 'D': /* CUB n */ t->cx -= params[0] ? params[0] : 1; break;
    case 'H': /* CUP r;c */ {
        int r = params[0] ? params[0] - 1 : 0;
        int c = n_params > 1 && params[1] ? params[1] - 1 : 0;
        t->cy = r; t->cx = c;
        break;
    }
    case 'J': /* ED — erase display */ {
        int mode = params[0];
        if (mode == 2) {
            memset(t->grid, 0, (size_t)t->cols * t->rows * sizeof(struct cell));
            wpk_term_mark_dirty_all(t);
        } else if (mode == 0) {
            /* Erase from cursor to end of screen */
            int start = t->cy * t->cols + t->cx;
            memset(&t->grid[start], 0,
                   ((size_t)t->cols * t->rows - start) * sizeof(struct cell));
            for (int r = t->cy; r < t->rows; r++) mark_dirty(t, r);
        }
        break;
    }
    case 'K': /* EL — erase line */ {
        int mode = params[0];
        if (mode == 0) {
            for (int x = t->cx; x < t->cols; x++)
                memset(&t->grid[t->cy * t->cols + x], 0, sizeof(struct cell));
            mark_dirty(t, t->cy);
        }
        break;
    }
    case 'm': /* SGR — colour + bold + reverse */ {
        if (n_params == 0) { t->fg = 7; t->bg = 16; t->flags = 0; break; }
        for (int i = 0; i < n_params; i++) {
            int p = params[i];
            if (p == 0) { t->fg = 7; t->bg = 16; t->flags = 0; }
            else if (p == 1) t->flags |= 1;          /* bold */
            else if (p == 7) t->flags |= 2;          /* reverse */
            else if (p == 22) t->flags &= ~1;
            else if (p == 27) t->flags &= ~2;
            else if (p >= 30 && p <= 37) t->fg = p - 30;
            else if (p == 39) t->fg = 7;             /* default fg */
            else if (p >= 40 && p <= 47) t->bg = p - 40;
            else if (p == 49) t->bg = 16;            /* default bg */
            else if (p >= 90 && p <= 97) t->fg = p - 90 + 8;   /* bright */
            else if (p >= 100 && p <= 107) t->bg = p - 100 + 8;
            /* 256-colour (38;5;n) and truecolor (38;2;r;g;b) — silently
             * dropped in v1. */
        }
        break;
    }
    default:
        /* Unknown CSI final — ignore in v1. */
        break;
    }
    /* Clamp. */
    if (t->cx < 0) t->cx = 0;
    if (t->cx > t->cols - 1) t->cx = t->cols - 1;
    if (t->cy < 0) t->cy = 0;
    if (t->cy > t->rows - 1) t->cy = t->rows - 1;
}

void wpk_term_feed(struct wpk_term *t, const char *bytes, size_t len) {
    for (size_t i = 0; i < len; i++) {
        unsigned char b = (unsigned char)bytes[i];
        switch (t->state) {
        case GROUND:
            if (b == 0x1b) { t->state = ESCAPE; }
            else if (b == '\r') { t->cx = 0; }
            else if (b == '\n') {
                if (++t->cy >= t->rows) { scroll_up(t); t->cy = t->rows - 1; }
            }
            else if (b == '\b') { if (t->cx > 0) t->cx--; }
            else if (b == '\t') { t->cx = (t->cx + 8) & ~7; }
            else if (b == 0x07) { /* BEL — visual flash post-v1; ignore in v1 */ }
            else if (b >= 0x20) put_char(t, b);  /* ASCII; UTF-8 handled at A4 */
            break;
        case ESCAPE:
            if (b == '[') { t->state = CSI; t->csi_used = 0; }
            else { t->state = GROUND; /* unknown 2-byte escape; drop */ }
            break;
        case CSI:
            if (b >= 0x40 && b <= 0x7e) {
                t->csi_buf[t->csi_used] = 0;
                apply_csi(t, (char)b);
                t->state = GROUND;
            } else if (t->csi_used < (int)sizeof t->csi_buf - 1) {
                t->csi_buf[t->csi_used++] = (char)b;
            }
            break;
        }
    }
}
```

**Cargo test:** drive the parser with `"hello\r\nworld"` and
assert the grid has "hello" on row 0 and "world" on row 1.
Drive with `"\x1b[2J\x1b[H"` and assert cells are zeroed +
cursor is at (0, 0).

**Commit:** `sysroot(wpkterm): VT100 escape-sequence parser (CSI cursor + ED/EL + SGR)`

### Task A4: UTF-8 input decoder

```c
// src/parser.c (continuation) — split out the GROUND-state byte
// handler so multi-byte UTF-8 sequences decode to a single
// codepoint before put_char.

static int utf8_decode(const unsigned char *bytes, size_t len,
                       uint32_t *out_cp, size_t *out_consumed) {
    unsigned char b0 = bytes[0];
    if (b0 < 0x80) { *out_cp = b0; *out_consumed = 1; return 1; }
    if ((b0 & 0xe0) == 0xc0 && len >= 2) {
        *out_cp = ((b0 & 0x1f) << 6) | (bytes[1] & 0x3f);
        *out_consumed = 2; return 1;
    }
    if ((b0 & 0xf0) == 0xe0 && len >= 3) {
        *out_cp = ((b0 & 0x0f) << 12) | ((bytes[1] & 0x3f) << 6)
                | (bytes[2] & 0x3f);
        *out_consumed = 3; return 1;
    }
    if ((b0 & 0xf8) == 0xf0 && len >= 4) {
        *out_cp = ((b0 & 0x07) << 18) | ((bytes[1] & 0x3f) << 12)
                | ((bytes[2] & 0x3f) << 6) | (bytes[3] & 0x3f);
        *out_consumed = 4; return 1;
    }
    /* Malformed or truncated — caller decides. */
    *out_cp = 0xFFFD; *out_consumed = 1; return 0;
}
```

Integrate into `wpk_term_feed`: replace the `put_char(t, b)` line
in the GROUND case with a UTF-8 decode loop.

**Cargo test:** feed `"héllo"` (h, é = 0xC3 0xA9, l, l, o);
assert grid[0..5] has codepoints `'h', 0x00E9, 'l', 'l', 'o'`.

**Commit:** `sysroot(wpkterm): UTF-8 decode (BMP-only, malformed → U+FFFD)`

### Task A5: Render — cell grid → libwpkdraw

```c
// src/render.c
#include <wpkterm/wpkterm.h>
#include <wpkdraw/wpkdraw.h>
#include "_internal.h"

/* ANSI 16-colour palette, RGB triples. */
static const uint8_t palette[17][3] = {
    {  0,   0,   0}, {170,   0,   0}, {  0, 170,   0}, {170,  85,   0},
    {  0,   0, 170}, {170,   0, 170}, {  0, 170, 170}, {170, 170, 170},
    { 85,  85,  85}, {255,  85,  85}, { 85, 255,  85}, {255, 255,  85},
    { 85,  85, 255}, {255,  85, 255}, { 85, 255, 255}, {255, 255, 255},
    {  0,   0,   0},  /* index 16 = "default" — black */
};

void wpk_term_render(struct wpk_term *t,
                     struct wpk_surface *s,
                     struct wpk_font *f,
                     int x, int y, int w, int h) {
    int cell_w = wpk_font_advance_px(f);   /* monospace advance */
    int cell_h = wpk_font_height_px(f);
    int ascent = wpk_font_ascent_px(f);

    for (int row = 0; row < t->rows; row++) {
        /* Skip clean rows. */
        if (!(t->dirty[row / 8] & (1u << (row % 8)))) continue;
        t->dirty[row / 8] &= ~(1u << (row % 8));
        for (int col = 0; col < t->cols; col++) {
            struct cell *c = &t->grid[row * t->cols + col];
            int px = x + col * cell_w;
            int py = y + row * cell_h;
            uint8_t fg = c->fg & 0x1f, bg = c->bg & 0x1f;
            if (c->flags & 2) { uint8_t tmp = fg; fg = bg; bg = tmp; }
            /* Background fill. */
            wpk_rect(s, px, py, cell_w, cell_h,
                     WPK_RGB(palette[bg][0], palette[bg][1], palette[bg][2]));
            /* Glyph. */
            if (c->codepoint && c->codepoint != ' ') {
                char utf8[5];
                int n = wpk_encode_utf8(c->codepoint, utf8);
                utf8[n] = 0;
                wpk_text(s, f, px, py + ascent, utf8,
                         WPK_RGB(palette[fg][0], palette[fg][1], palette[fg][2]));
            }
        }
    }
    /* Cursor: draw a thin underline at the current cell. */
    int cx_px = x + t->cx * cell_w;
    int cy_px = y + (t->cy + 1) * cell_h - 2;
    wpk_rect(s, cx_px, cy_px, cell_w, 2, WPK_RGB(220, 220, 220));
}
```

`wpk_encode_utf8` (used here) lives in libwpkdraw or libwpkterm
utility — encode a UTF-32 codepoint back to 1-4 bytes for
`wpk_text`'s consumption. Add it under
`src/render.c` if libwpkdraw doesn't expose it.

**Cargo test:** render a 4 × 4 grid with `"Hi"` in the top row;
assert two non-zero glyph pixels exist in the top-left quadrant
of the surface; assert the cursor underline is at (cell_w × 2,
cell_h × 1 - 2).

**Commit:** `sysroot(wpkterm): render — cell → libwpkdraw + ANSI 16-colour palette + cursor`

### Task A6: `wpk_term_input_key` — keysym → byte stream

```c
// src/input.c
#include <wpkterm/wpkterm.h>
#include <string.h>
#include <stdio.h>

/* Common xkb keysym values (from <xkbcommon/xkbcommon-keysyms.h>). */
#define XKB_KEY_Return     0xff0d
#define XKB_KEY_BackSpace  0xff08
#define XKB_KEY_Tab        0xff09
#define XKB_KEY_Escape     0xff1b
#define XKB_KEY_Left       0xff51
#define XKB_KEY_Up         0xff52
#define XKB_KEY_Right      0xff53
#define XKB_KEY_Down       0xff54
#define XKB_KEY_Home       0xff50
#define XKB_KEY_End        0xff57
#define XKB_KEY_Page_Up    0xff55
#define XKB_KEY_Page_Down  0xff56
#define XKB_KEY_Delete     0xffff

#define MOD_CTRL  (1u << 2)
#define MOD_ALT   (1u << 3)

size_t wpk_term_input_key(uint32_t keysym, uint32_t mods,
                          char *out, size_t out_cap) {
    /* Control combinations. */
    if ((mods & MOD_CTRL) && keysym >= 'a' && keysym <= 'z') {
        if (out_cap < 1) return 0;
        out[0] = (char)(keysym - 'a' + 1);   /* C-a = 0x01, … C-z = 0x1a */
        return 1;
    }
    /* Named keys. */
    switch (keysym) {
    case XKB_KEY_Return:    if (out_cap < 1) return 0; out[0] = '\r'; return 1;
    case XKB_KEY_BackSpace: if (out_cap < 1) return 0; out[0] = '\x7f'; return 1;
    case XKB_KEY_Tab:       if (out_cap < 1) return 0; out[0] = '\t'; return 1;
    case XKB_KEY_Escape:    if (out_cap < 1) return 0; out[0] = '\x1b'; return 1;
    case XKB_KEY_Left:      return (size_t)snprintf(out, out_cap, "\x1b[D");
    case XKB_KEY_Right:     return (size_t)snprintf(out, out_cap, "\x1b[C");
    case XKB_KEY_Up:        return (size_t)snprintf(out, out_cap, "\x1b[A");
    case XKB_KEY_Down:      return (size_t)snprintf(out, out_cap, "\x1b[B");
    case XKB_KEY_Home:      return (size_t)snprintf(out, out_cap, "\x1b[H");
    case XKB_KEY_End:       return (size_t)snprintf(out, out_cap, "\x1b[F");
    case XKB_KEY_Page_Up:   return (size_t)snprintf(out, out_cap, "\x1b[5~");
    case XKB_KEY_Page_Down: return (size_t)snprintf(out, out_cap, "\x1b[6~");
    case XKB_KEY_Delete:    return (size_t)snprintf(out, out_cap, "\x1b[3~");
    }
    /* Printable: pass through the keysym low byte (xkb returns the
     * UTF-32 value for printable keys). UTF-8 encode if > 0x7f. */
    if (keysym >= 0x20 && keysym <= 0x10ffff) {
        if (keysym < 0x80) {
            if (out_cap < 1) return 0;
            out[0] = (char)keysym; return 1;
        } else if (keysym < 0x800) {
            if (out_cap < 2) return 0;
            out[0] = 0xc0 | (keysym >> 6);
            out[1] = 0x80 | (keysym & 0x3f);
            return 2;
        } else if (keysym < 0x10000) {
            if (out_cap < 3) return 0;
            out[0] = 0xe0 | (keysym >> 12);
            out[1] = 0x80 | ((keysym >> 6) & 0x3f);
            out[2] = 0x80 | (keysym & 0x3f);
            return 3;
        } else {
            if (out_cap < 4) return 0;
            out[0] = 0xf0 | (keysym >> 18);
            out[1] = 0x80 | ((keysym >> 12) & 0x3f);
            out[2] = 0x80 | ((keysym >> 6) & 0x3f);
            out[3] = 0x80 | (keysym & 0x3f);
            return 4;
        }
    }
    return 0;
}
```

**Cargo test:** assert `wpk_term_input_key(XKB_KEY_Return, 0, ...)`
returns 1 + "\r"; assert C-c (Ctrl+c) returns 1 + 0x03; assert
Left arrow returns 3 + "\x1b[D".

**Commit:** `sysroot(wpkterm): input — keysym → byte stream (named keys + Ctrl + UTF-8)`

### Task A7: Smoke program

```c
// programs/wpkterm_smoke.c
#include <wpkterm/wpkterm.h>
#include <stdio.h>
int main(void) {
    struct wpk_term *t = wpk_term_create(80, 25);
    if (!t) return 1;
    wpk_term_feed(t, "\x1b[2J\x1b[H", 7);  /* clear + home */
    wpk_term_feed(t, "Hello, ", 7);
    wpk_term_feed(t, "\x1b[31mworld\x1b[0m\r\n", 17);
    wpk_term_destroy(t);
    return 0;
}
```

**Vitest:** spawn the smoke; assert exit 0. (Render-path is
exercised in Phase B with the live shell.)

**Commit:** `examples(wpkterm): wpkterm_smoke — create, feed, destroy`

### Task A8: Phase A — full gauntlet + open PR #1

PR title: `[explore-dri] sysroot(wpkterm): libwpkterm — VT100 cell grid + parser + render`

Body covers: cell grid + cursor + scrollback ring, parser (CSI
cursor / erase / SGR + UTF-8 decode), render via libwpkdraw +
ANSI 16-colour palette, keysym → byte stream input mapping.
ABI impact: none.

---

## Phase B — examples: wpkshell binary (PR #2)

The compositor-client shell — compositor wire + terminal + shell
built-ins + fork-exec pipelines.

### Task B1: Init amendment — exec wpkshell when compositor present

**Files:**
- Modify: `examples/init/init.c` (post plan 9 D1) — choose between
  `/bin/sh` and `/usr/bin/wpkshell` based on
  `/etc/wpk/compositor` presence.

```c
/* After plan 9 D1's compositor fork-exec, before the user shell exec: */
const char *shell = "/bin/sh";
if (access("/etc/wpk/compositor", F_OK) == 0)
    shell = "/usr/bin/wpkshell";
execl(shell, shell, NULL);
```

**Commit:** `examples(init): exec wpkshell as user shell when compositor present`

### Task B2: Program scaffold + main loop skeleton

**Files:**
- Create: `examples/programs/wpkshell/main.c` — top-level
  compositor-client + terminal-render loop.
- Create: `examples/programs/wpkshell/shell.h` — shared types
  between main.c and shell.c.
- Create: `examples/programs/wpkshell/Makefile` — wired into
  `scripts/build-programs.sh`.

```c
// main.c
#define _GNU_SOURCE
#include <fcntl.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>

#include <wpkclient/wpkclient.h>
#include <wpkdraw/wpkdraw.h>
#include <wpkterm/wpkterm.h>
#include "shell.h"

#define SURFACE_W 800
#define SURFACE_H 600
#define COLS 80
#define ROWS 25

int main(void) {
    /* 1. Connect to compositor (fatal if none — wpkshell is a
     *    compositor client, not a TTY-only shell). */
    struct wpk_client *cl = wpk_client_connect();
    if (!cl) {
        fprintf(stderr, "wpkshell: no compositor at /run/wpk/comp\n");
        return 1;
    }
    /* 2. Create surface + libwpkdraw wpk_surface for rendering. */
    int sw = SURFACE_W, sh = SURFACE_H;
    struct wpk_surface *s = wpk_surface_create(&sw, &sh);  /* compositor-client mode */
    if (!s) { wpk_client_disconnect(cl); return 1; }
    /* 3. Terminal grid + default font. */
    struct wpk_term *t = wpk_term_create(COLS, ROWS);
    struct wpk_font *f = wpk_font_load_default(14);
    /* 4. Set up shell ↔ terminal pipes. */
    int pipe_to_shell[2], pipe_from_shell[2];
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, pipe_to_shell) < 0) return 1;
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, pipe_from_shell) < 0) return 1;
    /* 5. Fork the shell. */
    pid_t shell_pid = fork();
    if (shell_pid == 0) {
        /* Child: dup2 the pipe ends to stdin/stdout, exec shell_main. */
        dup2(pipe_to_shell[0], 0);
        dup2(pipe_from_shell[1], 1);
        dup2(pipe_from_shell[1], 2);
        close(pipe_to_shell[1]); close(pipe_from_shell[0]);
        close(pipe_to_shell[0]); close(pipe_from_shell[1]);
        exit(shell_main());   /* defined in shell.c; never returns */
    }
    close(pipe_to_shell[0]); close(pipe_from_shell[1]);
    /* 6. Initial render. */
    wpk_surface_clear(s, WPK_RGB(20, 20, 25));
    wpk_term_render(t, s, f, 8, 8, SURFACE_W - 16, SURFACE_H - 16);
    wpk_surface_present(s);
    /* 7. Event loop. */
    struct pollfd fds[2] = {
        { wpk_client_get_fd(cl), POLLIN, 0 },
        { pipe_from_shell[0], POLLIN, 0 },
    };
    int quitting = 0;
    while (!quitting) {
        int n = poll(fds, 2, -1);
        if (n < 0) { if (errno == EINTR) continue; break; }
        /* Compositor events. */
        if (fds[0].revents & POLLIN) {
            struct wpk_client_event ev[16];
            int nev = wpk_client_poll(cl, ev, 16);
            for (int i = 0; i < nev; i++) {
                if (ev[i].type == WPK_CLIENT_KEY && ev[i].key.pressed) {
                    char buf[8];
                    size_t k = wpk_term_input_key(ev[i].key.keysym,
                        ev[i].key.modifiers, buf, sizeof buf);
                    if (k > 0) write(pipe_to_shell[1], buf, k);
                } else if (ev[i].type == WPK_CLIENT_WINDOW_CLOSE) {
                    quitting = 1;
                }
            }
        }
        /* Shell stdout. */
        if (fds[1].revents & POLLIN) {
            char buf[1024];
            ssize_t r = read(pipe_from_shell[0], buf, sizeof buf);
            if (r <= 0) { quitting = 1; break; }
            wpk_term_feed(t, buf, (size_t)r);
            wpk_surface_clear(s, WPK_RGB(20, 20, 25));
            wpk_term_render(t, s, f, 8, 8, SURFACE_W - 16, SURFACE_H - 16);
            wpk_surface_present(s);
        }
    }
    /* Cleanup. */
    kill(shell_pid, SIGTERM);
    waitpid(shell_pid, NULL, 0);
    wpk_font_destroy(f);
    wpk_term_destroy(t);
    wpk_surface_destroy(s);
    wpk_client_disconnect(cl);
    return 0;
}
```

**Commit:** `examples(wpkshell): scaffold main.c — compositor client + terminal grid + shell fork`

### Task B3: Shell core — command-line parser + read loop

```c
// shell.c
#include "shell.h"
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

/* Parse one command line into argv-style pipeline stages.
 * `line` is mutated (whitespace replaced with NULs).
 * `stages[][16]` is filled with NULL-terminated argv arrays.
 * Returns number of stages (1 for `cmd args`; 2 for `cmd | cmd2`). */
int parse_pipeline(char *line, char *stages[][16], int max_stages) {
    int n_stages = 0;
    char *p = line;
    while (*p && n_stages < max_stages) {
        /* Skip whitespace */
        while (*p && isspace((unsigned char)*p)) p++;
        if (!*p) break;
        /* Collect args until `|` or EOL. */
        int argc = 0;
        while (*p && *p != '|' && argc < 15) {
            stages[n_stages][argc++] = p;
            while (*p && !isspace((unsigned char)*p) && *p != '|') p++;
            if (*p && isspace((unsigned char)*p)) { *p++ = 0; }
            while (*p && isspace((unsigned char)*p) && *p != '|') p++;
        }
        stages[n_stages][argc] = NULL;
        n_stages++;
        if (*p == '|') { *p++ = 0; }
    }
    return n_stages;
}

int shell_main(void) {
    /* Print initial prompt. */
    print_prompt();
    char line[1024];
    int line_used = 0;
    for (;;) {
        char c;
        ssize_t r = read(0, &c, 1);
        if (r <= 0) return 0;        /* EOF / parent closed */
        if (c == '\r' || c == '\n') {
            write(1, "\r\n", 2);
            line[line_used] = 0;
            if (line_used > 0) execute_line(line);
            line_used = 0;
            print_prompt();
        } else if (c == 0x7f) {     /* Backspace */
            if (line_used > 0) {
                line_used--;
                write(1, "\b \b", 3);
            }
        } else if (c == 0x03) {     /* Ctrl-C */
            line_used = 0;
            write(1, "^C\r\n", 4);
            print_prompt();
        } else if (c >= 0x20 && line_used < (int)sizeof line - 1) {
            line[line_used++] = c;
            write(1, &c, 1);    /* echo */
        }
    }
}

void print_prompt(void) {
    char cwd[256];
    if (!getcwd(cwd, sizeof cwd)) strcpy(cwd, "?");
    dprintf(1, "\x1b[32m%s\x1b[0m$ ", cwd);
}

void execute_line(char *line) {
    char *stages[8][16];
    int n = parse_pipeline(line, stages, 8);
    if (n == 0) return;
    if (n == 1) {
        /* Single command — check built-ins first. */
        if (try_builtin(stages[0])) return;
        run_external(stages[0]);
    } else {
        run_pipeline(stages, n);
    }
}
```

**Cargo test:** parse `"echo hi"` → stages[0] = `["echo", "hi", NULL]`,
n = 1. Parse `"ls / | cat"` → stages[0] = `["ls", "/", NULL]`,
stages[1] = `["cat", NULL]`, n = 2.

**Commit:** `examples(wpkshell): shell core — command-line parser + read loop + prompt`

### Task B4: Built-ins — cd, ls, cat, echo, exit

```c
// builtins.c
#include "shell.h"
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

int try_builtin(char *argv[]) {
    if (!argv[0]) return 1;
    if (strcmp(argv[0], "cd") == 0) {
        const char *target = argv[1] ? argv[1] : "/";
        if (chdir(target) < 0) dprintf(2, "cd: %s\r\n", strerror(errno));
        return 1;
    }
    if (strcmp(argv[0], "ls") == 0) {
        const char *target = argv[1] ? argv[1] : ".";
        DIR *d = opendir(target);
        if (!d) { dprintf(2, "ls: %s\r\n", strerror(errno)); return 1; }
        struct dirent *e;
        while ((e = readdir(d))) {
            if (e->d_name[0] == '.') continue;
            char path[512];
            snprintf(path, sizeof path, "%s/%s", target, e->d_name);
            struct stat st;
            int is_dir = stat(path, &st) == 0 && S_ISDIR(st.st_mode);
            if (is_dir) dprintf(1, "\x1b[34m%s\x1b[0m  ", e->d_name);
            else        dprintf(1, "%s  ", e->d_name);
        }
        write(1, "\r\n", 2);
        closedir(d);
        return 1;
    }
    if (strcmp(argv[0], "cat") == 0) {
        if (!argv[1]) { dprintf(2, "cat: missing operand\r\n"); return 1; }
        int fd = open(argv[1], O_RDONLY);
        if (fd < 0) { dprintf(2, "cat: %s\r\n", strerror(errno)); return 1; }
        char buf[4096];
        ssize_t r;
        while ((r = read(fd, buf, sizeof buf)) > 0) write(1, buf, r);
        close(fd);
        return 1;
    }
    if (strcmp(argv[0], "echo") == 0) {
        for (int i = 1; argv[i]; i++) {
            if (i > 1) write(1, " ", 1);
            write(1, argv[i], strlen(argv[i]));
        }
        write(1, "\r\n", 2);
        return 1;
    }
    if (strcmp(argv[0], "exit") == 0) {
        exit(argv[1] ? atoi(argv[1]) : 0);
    }
    return 0;
}
```

**Vitest:** spawn wpkshell + compositor; type `echo hello\r`;
assert the terminal grid contains "hello" after a render tick.
Type `ls /\r`; assert grid contains "etc" + "dev" + "usr" tokens.

**Commit:** `examples(wpkshell): builtins — cd, ls, cat, echo, exit`

### Task B5: External-command fork-exec + pipelines

```c
// exec.c
#include "shell.h"
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>

static const char *path_dirs[] = { "/usr/bin", "/bin", NULL };

/* Resolve argv[0] against PATH; return malloc'd full path or NULL. */
static char *resolve(const char *cmd) {
    if (strchr(cmd, '/')) return strdup(cmd);
    for (int i = 0; path_dirs[i]; i++) {
        char *p = malloc(strlen(path_dirs[i]) + 1 + strlen(cmd) + 1);
        sprintf(p, "%s/%s", path_dirs[i], cmd);
        if (access(p, X_OK) == 0) return p;
        free(p);
    }
    return NULL;
}

void run_external(char *argv[]) {
    char *path = resolve(argv[0]);
    if (!path) { dprintf(2, "%s: command not found\r\n", argv[0]); return; }
    pid_t pid = fork();
    if (pid == 0) {
        execv(path, argv);
        dprintf(2, "%s: %s\r\n", path, strerror(errno));
        _exit(127);
    }
    free(path);
    int status = 0;
    waitpid(pid, &status, 0);
}

void run_pipeline(char *stages[][16], int n) {
    /* (n-1) socketpairs; n children. Each child closes the unused
     * fds + dup2's the right ends + execs. */
    int sp[8][2];   /* one socketpair per stage boundary */
    for (int i = 0; i < n - 1; i++)
        if (socketpair(AF_UNIX, SOCK_STREAM, 0, sp[i]) < 0) return;
    pid_t pids[8];
    for (int i = 0; i < n; i++) {
        char *path = resolve(stages[i][0]);
        if (!path) {
            dprintf(2, "%s: command not found\r\n", stages[i][0]);
            /* Drain previously-forked stages. */
            for (int j = 0; j < i; j++) waitpid(pids[j], NULL, 0);
            return;
        }
        pid_t pid = fork();
        if (pid == 0) {
            /* Wire stage i to its neighbours. */
            if (i > 0)     dup2(sp[i - 1][0], 0);
            if (i < n - 1) dup2(sp[i][1], 1);
            /* Close all socketpair fds in the child. */
            for (int j = 0; j < n - 1; j++) {
                close(sp[j][0]); close(sp[j][1]);
            }
            execv(path, stages[i]);
            _exit(127);
        }
        free(path);
        pids[i] = pid;
    }
    /* Parent: close all socketpair fds + wait. */
    for (int i = 0; i < n - 1; i++) { close(sp[i][0]); close(sp[i][1]); }
    for (int i = 0; i < n; i++) waitpid(pids[i], NULL, 0);
}
```

**Vitest:** type `ls / | cat\r`; assert the terminal grid eventually
contains the same content as `ls /` alone (cat passes through).
Type `cat /etc/wpk/compositor | cat\r`; same idempotency check.

**Commit:** `examples(wpkshell): exec — fork+exec external commands + pipeline construction via socketpair`

### Task B6: Phase B — full gauntlet + open PR #2

PR title: `[explore-dri] examples(wpk): wpkshell — compositor client + built-in shell + fork-exec pipes`

Body covers: compositor wire, terminal-grid render loop, shell
read-loop + line parser, five built-ins (cd, ls, cat, echo, exit),
external command resolution against /usr/bin + /bin, pipeline
construction via socketpair + n-stage fork-exec. ABI impact: none.

---

## Phase C — demo polish + browser verification (PR #3)

### Task C1: Default `.wpkrc` welcome banner

Render a one-line banner on shell start: `wpkshell — type help for
commands` (built-in `help` is added in C2 below).

```c
// In shell.c::shell_main, before the first prompt:
const char *banner =
    "\x1b[36mwpkshell — type \x1b[1mhelp\x1b[22m for commands\x1b[0m\r\n";
write(1, banner, strlen(banner));
print_prompt();
```

**Commit:** `examples(wpkshell): startup banner — wpkshell welcome line`

### Task C2: Built-in `help`

```c
// In builtins.c::try_builtin:
if (strcmp(argv[0], "help") == 0) {
    write(1,
        "wpkshell built-ins:\r\n"
        "  cd [path]      change directory\r\n"
        "  ls [path]      list directory\r\n"
        "  cat <file>     print file\r\n"
        "  echo [args]    print args\r\n"
        "  help           this help\r\n"
        "  exit [code]    quit shell\r\n"
        "External commands resolved via PATH=/usr/bin:/bin.\r\n"
        "Pipelines via |.\r\n", 232);
    return 1;
}
```

**Commit:** `examples(wpkshell): help built-in`

### Task C3: Vitest end-to-end

```ts
// host/test/wpkshell.spec.ts
test("wpkshell — boot, prompt, echo, exit", async () => {
    const h = await spawnCompositor();
    const shell = await spawn("wpkshell.wasm");
    await waitForPrompt(h);          // grid contains "$"
    await typeLine(h, "echo hello");
    await assertGridContains(h, "hello");
    await typeLine(h, "exit");
    await shell.exited;
});
test("wpkshell — ls + pipe", async () => {
    const h = await spawnCompositor();
    const shell = await spawn("wpkshell.wasm");
    await waitForPrompt(h);
    await typeLine(h, "ls / | cat");
    await assertGridContains(h, "etc");
    await typeLine(h, "exit");
});
```

**Commit:** `examples(wpkshell): vitest — boot, prompt, echo, ls/pipe`

### Task C4: Manual browser verification (the gate)

CLAUDE.md item 6. Build wpkcompositor + wpkshell, wire into
`examples/browser/pages/wpkshell/`. The browser page mounts:

1. wpkcompositor at PID 2.
2. wpkshell at PID 3, in a single 800×600 window.
3. The shell renders a banner + green `$` prompt.
4. Type `help` + Enter — built-in help table renders.
5. Type `echo hello, world` — green/white output line wraps
   cleanly.
6. Type `ls /` — directory listing renders with blue entries
   for directories.
7. Type `cat /etc/wpk/compositor` — file contents render.
8. Type `ls / | cat` — pipeline runs; output matches `ls /`.
9. Type `nosuchcmd` — `nosuchcmd: command not found` in default
   colour.
10. Press Ctrl-C mid-line — input line clears, fresh prompt.
11. Type `exit` — window closes; compositor returns to empty
    desktop.

Browser cursor must follow the terminal cursor (compositor-side
software cursor is separate; verify it doesn't interfere).

If the prompt never appears, fork-exec of the shell failed —
check `wait4` returns + the dup2 sequence.

If pipelines hang, the socketpair end-closing in `run_pipeline`
is incomplete — check `lsof` equivalent (or the kernel's OFD
table dump in vitest).

If colour output garbles, the SGR parser is dropping a sequence —
check `apply_csi` with `m` final.

**No commit yet — verification only.**

### Task C5: Phase C — final gauntlet + open PR #3

PR title: `[explore-dri] examples(wpk): wpkshell — demo polish + browser spec`

Body: welcome banner, help built-in, vitest specs (boot + pipe),
manual browser walk-through. ABI impact: none.

---

## Final coordinated merge

When all three PRs are reviewed and approved, the browser
verification passes:

1. Re-run the full gauntlet on each PR's branch tip.
2. Squash-merge PR #1 (libwpkterm) → PR #2's base.
3. Squash-merge PR #2 (wpkshell + init amendment) → PR #3's base.
4. Squash-merge PR #3 (demo polish + browser spec) → plan 9's
   `…-wpk-demo` (or wherever plan 9's tip lives at the time).
5. Tag: `[explore-dri-wpkshell] plan 10 merged at <sha>` in the
   next session-handoff doc.

**Do not push to upstream until v1 + plans 2–11 are all merged
upstream as a coherent chain.**

---

## Trade-offs already locked in (don't relitigate during implementation)

- **In-process shell + terminal, no PTY.** v1 shell is a function
  call away from the terminal renderer; no kernel pty surface
  needed. Post-v1: a real `openpty` + `forkpty` path lets
  external shells (bash, zsh) run inside wpkshell.
- **Five built-ins only.** cd, ls, cat, echo, exit (+ help in
  C2). No `pwd` (overlap with prompt), no `env`, no `set`,
  no `export` (no env-var expansion in v1).
- **No quoting / variable expansion / wildcards / redirection.**
  Whitespace-only tokenisation. Tokens beginning with `$`, `*`,
  `>`, `<` pass through literally.
- **VT100 subset, 16-colour palette.** No 256-colour, no
  truecolor, no mouse, no alt-screen, no line-drawing, no
  Sixel/Kitty graphics.
- **Fixed 80 × 25 grid in 800 × 600 surface.** Window resize is
  v2 (plan 9 surfaces are client-immutable dims in v1).
- **Monospace font only.** DejaVu Sans falls back to monospace
  metrics; v1 ships DejaVu Mono if available, else DejaVu Sans
  with monospace advance.
- **PATH = /usr/bin:/bin, hardcoded.** No /etc/profile, no
  ~/.bashrc, no PATH env var read.
- **Pipelines via socketpair, not pipe(2).** `pipe(2)` returns
  uni-directional file descriptors; `socketpair` is
  bidirectional but we only use one direction. Equivalent for
  v1. (Either works; socketpair is what plan 6 ships as the
  flagship surface.)
- **No background jobs (`&`), no job control, no SIGSTOP /
  SIGCONT.** Shell waits on each foreground command.
- **No signal forwarding from shell to children.** Ctrl-C in
  the shell clears the input line; doesn't kill children.
  Post-v1 with proper PTY: signals propagate.
- **No history, no readline.** Press up-arrow → CSI A passes to
  the child or is dropped (no history buffer).
- **One window, one shell, one tab.** No multi-tab terminal;
  no "open another shell".
- **Compositor-only.** No direct-KMS fall-back. wpkshell exits
  if no compositor is present (matches plan 9 client
  expectations).
- **No clipboard.** Cut/paste via the compositor's CLIPBOARD_*
  messages is a v2 feature.
- **Init exec wpkshell only if `/etc/wpk/compositor` exists.**
  Absent → existing /bin/sh path remains (WordPress demo
  compatibility).
- **Zero ABI impact.** No kernel exports, no host imports.
  Existing socket + process surfaces only.

---

## Risk register

1. **socketpair-as-pipe semantics.** Plan 6 ships `socketpair`
   as a bidirectional AF_UNIX. Plan 10 uses it as a one-way
   pipe (shell write side → next stage read side). EOF
   propagation when one end closes must work — `read` on a
   closed peer returns 0. *Mitigation:* plan 6 audit (session
   10) confirms this. Cargo test in plan 6's register may
   already cover; B5 adds a wpkshell-specific test.
2. **Fork-exec depth + the kernel's process table.** A 3-stage
   pipeline forks 3 children + waits all. The kernel's
   `PROCESS_TABLE` (CLAUDE.md cites it; per plan 7 open-arch
   #2's profiling-driven OFD-table-split refactor) is the
   contention point. *Mitigation:* v1 has at most 3-stage
   pipelines (typical user); profile in C4. If contention is
   visible, defer to the OFD-table-split refactor.
3. **`opendir` / `readdir` on synthetic /dev.** Plan 5's
   `event0`/`event1` synthetic entries + plan 9's
   /run/wpk/comp socket inode — does `readdir` return them?
   v1 expects YES (kernel registers them as devfs entries).
   *Mitigation:* B4 cargo test asserts `ls /dev` includes
   `event0` + `event1`. If it doesn't, the kernel's devfs
   producer is the bug, not wpkshell.
4. **Font advance for non-monospace fallback.** DejaVu Sans is
   variable-width. `wpk_font_advance_px` returns the M-advance
   as a heuristic. *Mitigation:* the v1 demo's output uses
   ASCII only; non-ASCII text in a non-monospace fallback
   looks ugly but readable. Post-v1: ship DejaVu Sans Mono.
5. **Cursor advance on shell echo.** When the user types a
   character, the shell writes it back to stdout for echo.
   Multiple `write(1, &c, 1)` calls per keypress are slow
   under per-syscall overhead. *Mitigation:* v1 accepts the
   cost. Post-v1: line buffering with explicit flush on `\r`.
6. **`wait4` blocking the shell read loop.** If `run_external`
   spawns a long-running child, the shell's read loop blocks
   on `waitpid`. The terminal emulator's render loop is in a
   different process (main.c is the terminal, shell.c is a
   forked child) so the terminal stays responsive. *Mitigation:*
   architecture already addresses this — terminal and shell are
   separate processes.
7. **Compositor crash mid-pipeline.** Shell parent dies on
   EPIPE from the terminal-process writes; children are
   orphaned. Init reaps them via `wait`. *Mitigation:* plan 9
   risk register #2 covers this; wpkshell exits cleanly when
   the compositor dies.
8. **VT100 unknown-escape garble.** External commands that
   emit 256-colour or alt-screen escapes (which plan 10
   doesn't implement) corrupt the cell grid. *Mitigation:*
   the parser silently drops unknown CSI finals (per A3); no
   crash, just visual artifacts. v1's external commands
   (ls, cat, echo) emit only the 16-colour subset.
9. **xkb modifier mask convention mismatch.** Plan 9 D4 emits
   `WPK_CLIENT_KEY.modifiers` as the xkbcommon
   "effective mods" bitmask. Plan 10 input.c assumes Ctrl =
   bit 2 (matches xkbcommon's MOD_CONTROL by index). *Mitigation:*
   document the convention; if xkbcommon's bit assignment
   shifts in a future port, plan 10's input.c needs an update.
10. **Init shell-line race.** Plan 10 B1 amends init to exec
    `/usr/bin/wpkshell` if compositor present. Init forks
    wpkcompositor first (plan 9 D1), then waits ~0 ticks
    before exec'ing the shell. If the compositor hasn't yet
    bound `/run/wpk/comp` when wpkshell tries to connect,
    wpkshell fails fatally. *Mitigation:* add a small connect
    retry loop in `wpk_client_connect` (~10 × 10 ms backoff)
    OR have init `waitpid(compositor_pid, WNOHANG)` + sleep
    until `/run/wpk/comp` exists.

---

## What this plan doesn't cover (deferred)

- **PTY surface.** Real `openpty` / `forkpty` for hosting
  external shells (bash, zsh). v2.
- **Quoting + globbing + redirection.** `"foo bar"`, `*.c`,
  `>` / `<` / `>>`. v2.
- **Variable expansion.** `$HOME`, `$PATH`. v2.
- **Job control.** `&` background, `Ctrl-Z` suspend, `fg` /
  `bg`. v2.
- **History + readline + tab completion.** v2.
- **Multi-tab / multi-window terminal.** v2.
- **256-colour / truecolor / alt-screen / mouse-tracking.**
  v2 may add the alt-screen pair (needed for `less`, `vim`);
  256-colour is straightforward but bloats the cell struct.
- **Sixel / Kitty graphics.** Out of scope.
- **Clipboard integration.** Per plan 9, CLIPBOARD_* messages
  are reserved but unimplemented; v2.
- **Window resize.** v1 surfaces are client-immutable dims;
  no SIGWINCH plumbing.
- **External shells (bash, sh, dash) as alternatives.** v2 with
  PTY surface.
- **Scrollback UI.** Cell-grid scrollback ring exists in
  libwpkterm but no scroll-up keybinding renders it. v2.
- **Locale / LC_ALL handling.** UTF-8 throughout; no other
  encoding.
- **`.wpkrc` config file.** No per-user shell config in v1.
- **wpkshell as a libwayland-client-compatible app** (post-v1
  Wayland bridge from plan 9 §15). v2.
- **In-process Lua / scripting.** No.

---

End of plan.
