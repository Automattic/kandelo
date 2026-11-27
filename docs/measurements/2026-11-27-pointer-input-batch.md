# Legacy mouse packet delivery during pointer sweeps

The browser Modeset surface forwards both relative PS/2 motion and absolute
evdev positions. On develop `e58ab40d00a94313d2bb7a4cfedc8a41307137ea`,
a single large relative move uses signed-byte stepping and posts each PS/2
packet separately before sending the absolute report. The candidate sends the
existing packet sequence through one Worker message and one reader-wake pass.
It retains the single-packet path and the existing kernel encoder, queue,
and evdev frame ordering. Embedders with only single-packet injection still
receive every packet individually.

The desktop comparison used the same frozen Sway partial shell and packaged
Worker in both arms. The shell SHA-256 was
`abce61e1fc4a1a942c40fbcc39426c1c41ff2bbc7710db5efb46c617800a1149`,
the kernel SHA-256 was
`a0ac2daa12706d37f55b742316bec808716e628a0100d6bb19f740eee0af4249`,
and the process Worker was `worker-entry-browser-DNBzPWrz.js`. The common
source stack was `dffcfca5325666d5e02cacdef03d4f14893a4584` with the
previous scanout, input wake, grouped fork and Wasm admission changes.
Each completed arm waited for five fitted terminals at 2634 × 1806, then
sent the same eight trusted moves. The trace used the display Worker's exact
sequence acknowledgement without polling the canvas during the sweep.

| Browser and arm | Legacy messages | Legacy packets | Matched device paints | Median event to device paint |
| --- | ---: | ---: | ---: | ---: |
| Installed Firefox control A | 93 | 93 | 8 of 8 | 144.62 ms |
| Installed Firefox candidate A | 8 | 93 | 8 of 8 | 170.42 ms |
| Playwright WebKit control, burst setup | 93 | 93 | 8 of 8 | 53.79 ms |
| Playwright WebKit candidate, burst setup | 8 | 93 | 8 of 8 | 50.27 ms |

Both arms sent nine absolute reports because entering the canvas and the
first move produce reports at the same location. The reduction was 85 Worker
messages for the same 93 packets. The elapsed device-paint times varied
with host load. An installed-Firefox candidate repeat received all input
reports and offered only two of the eight cursor positions within the
observation window. The corresponding control stalled before the fourth
terminal was fully fitted. A first Playwright WebKit candidate run stalled
before the fifth terminal fitted. The successful Playwright WebKit pair
prepared all five terminals with spaced shortcuts before measuring the
sweep. These receipts support the operation-count reduction. A later 100 ms-spacing Firefox candidate sweep
received every input report and matched seven device paints. Its control
stalled before the fitted setup. Overall cursor responsiveness, terminal
startup latency, and native Safari remain unverified for this change.

The normal host package and declarations built. Six focused Node files
passed 125 cases, including the SDK-built `mousetest` on a canonical kernel through
both single-packet and batch injection. It checks the exact signed-byte
deltas, buttons, packet order, kernel exit and Worker quiescence. Initial
runs emitted all expected packets and timed out on exit because the direct
fixture attempted process unregistration inside the exit callback. The
revised fixture observes the Worker fence before unregistering the process.
The broader source selection passed 317 cases and failed three session
memory-counter cases that also fail on the unchanged baseline source.
