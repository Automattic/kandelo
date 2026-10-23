# Tmux

The `tmux` registry package builds tmux 3.8 for wasm32 with the normal
Kandelo SDK and fork instrumentation. It links the separately resolved
libevent 2.1.12, ncurses 6.5 terminfo library, and utf8proc 2.9.0. Optional
utempter and systemd integration are disabled. No upstream source patch
or `__linux__` define is used.

The browser shell declares tmux as a lazy program at `/usr/bin/tmux`, with
`/bin/tmux` as an alias. The shell's existing ncurses terminfo database
provides `screen`, `screen-256color`, `tmux`, and `tmux-256color`; these
entries are needed by programs run inside panes as well as the outer
terminal. The package does not change the kernel ABI; it requires ABI 51.

## Try it

Start the normal browser app from the repository root:

```bash
./run.sh browser
```

Open its local URL, select the shell profile, and run:

```sh
tmux new-session -s trial
```

Tmux's default prefix is **Ctrl-B**. Release it before pressing the next
key:

| Keys after Ctrl-B | Action |
|---|---|
| `%` | Split into left and right panes |
| `"` | Split into top and bottom panes |
| Arrow key | Select a pane |
| `c` | Create a window |
| `0`, `1`, … | Select a window |
| `d` | Detach to the Kandelo shell |

After detaching, run `tmux attach-session -t trial` to return. The session
lives in the current Kandelo machine; detaching does not make it survive
closing or resetting that machine. `tmux kill-server` closes its sessions.

The Kandelo dark palette uses dark ANSI black for text on colored terminal
backgrounds, including tmux's default green status line. Theme changes
apply to the running terminal without restarting its guest session.

## Build and tests

The package can be built independently with:

```bash
bash .agents/skills/porting-software-to-kandelo/scripts/build-package.sh tmux wasm32
```

For a minimal SourceOnly runtime projection, use `cargo xtask local-build
run` with `--product kernel --product tmux --product rootfs --product bash`
and the usual absolute source-cache/output roots. The regular browser
preparation also builds the shell image that contains tmux.

`packages/registry/tmux/test/tmux.test.ts` checks guest pane shells, input,
splits, window creation, resizing, terminal attach/detach/reattach, and
process cleanup. `apps/browser-demos/test/tmux.spec.ts` runs the same guest
control script in Chromium, Firefox, and WebKit. Test images install the
same package-owned terminfo data as the browser shell. The separate
`tmux-shell.spec.ts` exercises keyboard interaction in the real app.

Tmux's upstream Linux OS-dependency module deliberately disables epoll
when creating its libevent base. The port preserves that behavior and
uses the available portable backend. The unchanged upstream libevent
edge/close tests, documented in [the libevent port](libevent.md), are the
direct evidence for the epoll improvements.

This port targets wasm32. The complete upstream tmux regression suite
and optional integrations are outside the focused runtime coverage.

## Validation record

On 2026-10-22, the normal resolver built the verified tmux release and
its declared dependencies. The focused Node suite passed both tests,
including server shutdown with no remaining guest processes other than
init. The shared guest control script passed in Chromium, Firefox, and
WebKit (three browser tests). These runs used the current ABI 51 kernel
and SourceOnly artifacts, with no host diagnostics or page errors.

The package-system suite passed 717 unit tests and six integration tests.
The ABI version/snapshot check passed. Evidence logs are retained in the
workspace's `.context/tmux-{node,browser-controls,xtask}-validation.log`.

The normal shell image also passed the interactive tmux test in all three
browser engines: keyboard pane splits, window switching, detach/reattach,
and a viewport resize from 1400×900 to 1120×760. Tmux reported smaller
window dimensions after the resize. The browser binds tmux's deferred
file through the same verified asset URL table as the other shell tools.
The UI log is `.context/tmux-browser-ui-validation.log`; screenshots are
`.context/tmux-{chromium,firefox,webkit}.png`. Artifact SHA-256 identities
are recorded in `.context/tmux-final-artifacts.json`.

A subsequent run against the normal `./run.sh browser` server passed
21 cases: the real shell/tmux interaction in each engine plus the existing
six theme contrast cases per engine. Each tmux case selects Dark through
the Theme menu and checks the rendered status text against a 4.5:1
minimum. The palette correction changes ANSI black from `#8a7c98` to
`#241b2c`, against the existing green `#a9d878`:

| Kandelo dark status text | Contrast ratio |
|---|---:|
| Before | 2.36:1 |
| After | 10.08:1 |

The before value was reproduced by the browser assertion; the after
value is calculated from the palette colors and the rendered assertion
passes in all three engines. The run used the public
`/pages/kandelo/?profile=shell` entry point without test-only product
lookup fixtures. Its log is
`.context/tmux-dark-and-live-browser-validation.log`; the screenshots
above now show the dark palette. Native Safari was not separately tested.

The SourceOnly browser asset audit resolved all 141 imports. Its unscoped
default-policy run did not pass: the dormant Erlang image and wasm32/wasm64
MariaDB VFS images were unavailable in that policy's artifact closure.
Those three imports are outside the SourceOnly browser product selection;
the failure is retained in `.context/tmux-browser-assets-check.log`.
The selected-policy pass is
`.context/tmux-browser-assets-source-only-check.log`.

The browser memory gate passed all nine cases with zero skips or flaky
results. It includes four Doom → Quake → Freeciv → LÖVE → tmux → WordPress
cycles per engine: 72 application launches across Chromium, Firefox, and
WebKit. Each tmux visit creates two panes, detaches, and leaves the server
and shells alive for normal machine teardown. The host portion passed
162 regressions plus three teardown checks each on Node and Bun.
The complete log is `.context/tmux-memory-validation.log`. An earlier run
was invalidated by a concurrent Playwright run deleting a Firefox trace;
the final run used one Playwright runner and passed unchanged assertions.
