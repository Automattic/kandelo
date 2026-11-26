# Sway terminal bursts in Chromium, Firefox and WebKit

## What the demo does

In the shared-memory Sway desktop, five rapid Alt+Return presses started five
copies each of `/bin/sh`, Foot and Bash. Sway painted intermediate layouts as
clients came up. A Firefox screenshot taken after the fifth Bash passed
compilation still showed four terminal panes with wallpaper beneath three of
them. Later screenshots and the process inspector showed all six terminals and
their prompts.

After all six prompts were visible, the median time from a trusted mouse move
to the next DRM submission, over 18 moves per run, was 27–31 ms in Chromium,
38–45 ms in WebKit and 66–87 ms in Firefox in the two baseline runs. The median
time to evdev was 0.3–0.8 ms. The median time from DRM submission to the
subsequent latch was 5–12 ms, with most of the gap preceding submission.
The first submission after a move can also include the status clock or other
outstanding damage. It measures progress through the compositor, with
visible focus sampled separately.

A Firefox control with two rendered terminals had a 64 ms median to the
first DRM submission. Four of its eighteen moves waited over 250 ms for that
submission.

A lighter trace grouped native WebGL calls between display ticks. Across one
18-move sweep Firefox spent 408 ms in 4,274 `getError` calls. Chromium spent
249 ms in 3,218 calls. WebKit spent 144 ms in 91 `blitFramebuffer` calls.
Those totals cover work around the sweep, including intervening frames. They
identify where to look for extra render work. The relative cost of preparing
Wayland clients, processing their state changes and rendering the focused frame
is still open. Playwright WebKit remains an experimental target.

## Kernel change

During each group-image bind, Rust already holds the admitted image and freshly
reads the same descriptor into the proposed replacement. Compare the two byte
ranges directly. The layout's source hash can be checked against the hash
already held by the executable pair's source binding. This replaces two image
hashes and a second source hash per bind with one exact comparison and reuse of
the existing digest. The fifteen launches in this trace avoid 45 hash passes.
The kernel still validates the source and image policies, checks permissions
and descriptor identity and revalidates the source after reading the image.

## Comparison

The browser host was PR #1793 at
`0ae2a062cd89a95ca945adeb393d0ba9fa7a07f0`. Its partial Sway shell came from
the normal package path with `bibata-cursor-theme desktop-data foot sway swaybg`
and image SHA-256
`8f7a25bc1b93fdb82e2ae78ac0448798d7dfdf22cb63822e6cc1c50bdb997e92`.
The demo artifacts were prepared from `5d8e58809c9447190e94ba12782454df584a8caf`.
The base demo kernel SHA-256 was
`7064525a2436379bc088ff2aa54ad0dfe1f6781a8be6b8d4de9f1eee05206b98`.
The candidate used the normal kernel package built at develop
`6b6904b3075437433a1cccec0273142850c8f93c` with the binding patch
`d66e77033bb8578b73e4613d711e5ea73897f2af`. Its kernel SHA-256 was
`af47c623f87611b6d05d5ab42cec7dfa291648afbc64a36ff8992a9c8158bb87`.
The candidate build also refreshed the image helper modules. A private Vite
proxy fetched lazy bodies for both arms from the same frozen SourceOnly
server, with the image's original digest checks active.

The run used headless Chromium 153, Firefox 155 and Playwright WebKit 26.6 on
macOS, a 1600×1000 CSS viewport and 1600×892 scanout. Two runs per engine and
arm followed baseline, candidate, candidate, baseline order. The machine was
shared with other builds. One-minute load averages ranged from 21 to 34.
The five key presses had no deliberate gap. This initial comparison started
the sparse screenshot observer after the fifth Bash module compiled and
three additional DRM flips latched. The observer checked the glyph mask at
all six tile positions. The input sweep began after this check. Waiting for
three flips allows already visible prompts to go unobserved, so these
readiness times include the wait as well as the screenshot sampling.

| Engine | Image binding time summed across 15 launches, in seconds | First key to six prompts observed after the flip wait, in seconds |
| --- | --- | --- |
| Chromium | 1.09, **0.50, 0.58**, 1.00 | 5.29, **3.55, 4.58**, 4.15 |
| Firefox | 1.12, **0.74, 0.90**, 1.26 | 7.22, **8.64, 12.85**, 8.27 |
| WebKit | 1.24, **0.56, 0.56**, 1.09 | 5.66, **6.46, 6.46**, 5.06 |

Bold values are candidate runs. Binding time includes the interval around the
kernel call after the host read the retained group image. The elapsed launch
intervals also include command startup, guest execution, window configuration,
and screenshot sampling. Firefox and WebKit spent less time in the measured
binding interval and took longer to reach six prompts in these runs. The
earliest gaps already vary while waiting for Sway to begin its first shell
launch. The comparison leaves the cause of the end-to-end differences open.

A burst-only control omitted the sweep and showed the same split. Firefox's
binding interval changed from 1.21 to 0.77 s, and all prompts appeared in 7.85
and 9.01 s. WebKit's binding interval changed from 0.99 to 0.60 s, and all
prompts appeared in 4.61 and 4.88 s.

## Same-source baseline and earlier screenshot sampling

The last comparison rebuilt the exact parent revision
`6b6904b3075437433a1cccec0273142850c8f93c` with the same kernel package
build path as the patch. Its kernel SHA-256 was
`3079c6bdecee1cb1ee13acebeb1751d12bd0a3f5b149d1c5f071a11fdc769d59`.
The same browser host, frozen image and lazy bodies were used. The image
helper module bytes differed between the two builds.

The observer checked the six prompts immediately after the fifth Bash
compiled and retried with sparse screenshots. Each cell below is one
fresh-page run, with one-minute load averages from 16 to 22. Binding took
less time in all three runs on the patch. Firefox took three seconds longer
to show the six prompts. The first shell started at a different time even
before the first binding call, and the Firefox result remains unresolved.

| Engine | Total binding, before → after | First key to six observed prompts, before → after |
| --- | --- | --- |
| Chromium | 1.05 → 0.48 s | 4.09 → 3.42 s |
| Firefox | 1.18 → 1.07 s | 7.12 → 10.10 s |
| WebKit | 1.27 → 0.62 s | 7.03 → 4.80 s |

## Validation and retained failures

- 4,100 native runtime-core unit tests, one integration test and six doc tests
  passed in the serial run. The initial four-thread run reported failures and
  aborted. The new mutation test checks changed image bytes under identical
  file metadata and verifies that rejection preserves the original target.
- The ABI snapshot check passed with program ABI 56 and host adapter 40.
- Twenty-five focused Node tests passed, including ordinary and grouped VFS
  execution, threaded SDK exec, exec rollback, and pthread churn. The threaded
  SDK exec test also passed in Chromium, Firefox and WebKit.
- The Wasmtime smoke runner rejected the `host_proc_validate_range` import
  signature for both kernel artifacts. Third-engine smoke coverage is pending.
- The initial pixel-observer run sampled six WebGL canvas regions on every
  animation frame. Focus timed out in each engine and the prompt helper
  returned before all six panes were visible. The comparison above uses
  sparse screenshots and a six-prompt check. One intermediate trace also
  failed because a trace marker was inserted in the wrong JavaScript scope.
- Full Node/browser benchmark suites and the canonical gallery were outside
  this diagnostic. The measured benefit applies to executable binding.
