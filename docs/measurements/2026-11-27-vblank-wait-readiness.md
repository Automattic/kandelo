# DRM readiness at vblank

Develop baseline `e58ab40d00a94313d2bb7a4cfedc8a41307137ea`.

Retiring a flip can queue a DRM event and make a Rust-owned epoll wait ready.
The host already consumes the kernel's vblank readiness flag and schedules
its own poll, select and I/O retries. An epoll completion in Rust previously
depended on a later wake drain, which could be driven by another input event
or syscall. The vblank entry now runs the existing drain when Rust reports
readiness. The legacy retry path still handles host-owned waits.

## Pointer sweep

The two arms reused the frozen grouped Sway partial image
`abce61e1fc4a1a942c40fbcc39426c1c41ff2bbc7710db5efb46c617800a1149`,
kernel `9eaa8327abfea93bf841839f249d36678f6d42d25fdd4e9b1a97b9c16029abb8`
and process Worker `worker-entry-browser-DgBChsCz.js`. Both arms used the
same instrumentation. Every sweep started with five fitted Foot terminals
at 2634 × 1806 DPR 2 and delivered 120 trusted pointer moves.

| Engine and arm | Sway wait completions inside vblank readiness | Cursor records painted | Median cursor interval |
| --- | ---: | ---: | ---: |
| Firefox control 1 | 0 | 43 | 41.77 ms |
| Firefox candidate 1 | 22 | 40 | 42.58 ms |
| Firefox candidate 2 | 12 | 34 | 58.20 ms |
| Firefox control 2 | 0 | 21 | 92.50 ms |
| Playwright WebKit control | 0 | 64 | 33.16 ms |
| Playwright WebKit candidate | 46 | 58 | 33.42 ms |
| Chromium candidate smoke | 104 | 116 | 16.66 ms |

Each observed cursor record had a matching display acknowledgement. The wait
counter counts completions observed inside the vblank entry before scanout
preparation. A vblank can run when Sway has no parked wait. The first Firefox
control's next observed Sway wait followed a readiness notification by a
median of 27.31 ms, versus 0.18 ms in its candidate arm. The repeated control
had no observed Sway wait completions during the sweep. Cursor cadence varied
across runs, including the Firefox repeat. These results establish earlier
delivery when the wait is ready in that entry. Overall pointer response and
terminal launch latency remain unproven by this comparison.

## Validation

The normal host distribution build passed. All 19 focused KMS and interrupted
ioctl cases passed, including the regression that requires both wake drains
before scheduling a legacy retry. A broader four-file run had 227 passing
cases. Its wasm32 and wasm64 pselect6 restoration cases failed in the same
way in the unchanged control and candidate. The tests remain unchanged.

An SDK-built C guest on the dedicated Node host completed four actual DRM
page flips through poll and four through epoll per arm, with exact event
type, CRTC, sequence and user data and no host diagnostics. The probe used
the same kernel bytes in both arms. Native Safari and the full application
and benchmark suites were outside this change's validation.
