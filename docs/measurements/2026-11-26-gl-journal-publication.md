# GPU error checks during shader program publication

While Sway changed focus between Foot windows, both Firefox and WebKit received many DRM program journal barrier queries. Action 3 publishes a previously reserved batch of shader-program changes. The common case advances host-side slots, generation references and sequence numbers. The old kernel adapter still made a synchronous native WebGL error query when the logical owner was already current and publication touched no native object.

The new adapter uses the existing WebGL batch's native-work flag for this journal action. A native owner switch, framebuffer selector replay or program/shader retirement still requires checked native work. Both the initial and final renderer-loss checks and the per-owner error handling remain in the batch. The journal continues to preflight, seal receipts and return the same reply across the guest boundary.

## Five-window cursor sweep

The graphics source change was developed against `dffcfca532`. To isolate it in a working desktop, the two diagnostic servers used the same cumulative Sway/Foot packages and served kernel `cbddc6fb8f3b452106f8d503f6497007d2906630ea52ef49e42a9846422b255f`. Only the publication condition differed. Five fully painted terminals filled a 2634 × 1806 canvas. A sweep sent 120 trusted positions at about 60 Hz across the five windows. The final event jumped vertically to a fresh location, where an animation-frame probe looked for actual cursor-plane pixels. Another sweep inside one terminal preceded each crossing. Browser and graphics tracing add overhead. Other builds ran on the machine.

For each crossing, the table counts completed publication requests in the input-to-final-observation window and native error calls taking at least 0.25 ms inside those requests. Request counts can differ because the compositor makes different amounts of progress. The time column is synchronous elapsed time inside the observed calls. It does not measure the incremental cost of fencing a GPU if another operation would have waited for the same work.

| Browser | Run order | Publication requests | Slow native error calls | Time in those calls | Final event to cursor pixels |
| --- | --- | ---: | ---: | ---: | ---: |
| Firefox | Baseline 1 | 42 | 20 | 35 ms | 2,562 ms |
| Firefox | Candidate 1 | 55 | 0 | 0 ms | 2,228 ms |
| Firefox | Candidate 2 | 75 | 0 | 0 ms | 473 ms |
| Firefox | Baseline 2 | 102 | 12 | 40 ms | 419 ms |
| Playwright WebKit | Baseline 1 | 156 | 0 | 0 ms | 131 ms |
| Playwright WebKit | Candidate 1 | 127 | 0 | 0 ms | 313 ms |
| Playwright WebKit | Candidate 2 | 145 | 0 | 0 ms | 111 ms |
| Playwright WebKit | Baseline 2 | 148 | 0 | 0 ms | 102 ms |

The harness observed all 120 DOM moves in every arm. Firefox lost a measurable synchronous GPU wait at this boundary. The cursor observations overlap substantially and the WebKit baseline had no error call over the threshold here. Earlier WebKit traces instead found costly full-resolution framebuffer blits. This change does not establish a visible cursor-latency improvement in either engine.

## Scope and rejected alternatives

The complete source-only host graphics suite passed 2,388 tests in 93 files. The public Wasm32 and Wasm64 scratch-boundary regressions verify that a metadata publication makes no native error call, while publication that actually retires a native program still checks the renderer. Logical context loss, failed publication and recovery remain covered.

A full-resolution shader blit that forced opaque alpha matched source/destination pixel samples on Chromium, Firefox and WebKit. Including readback and bitmap capture, the second comparison measured 8.28 vs 8.29 ms on Firefox and 16.07 vs 15.78 ms on WebKit. Replacing the production blit would have introduced additional native state to restore for a small and inconsistent saving. A separate experiment reduced redraws by asking native GL which attachment changed, but the added synchronous queries still left a long Firefox cursor tail. Both experiments stayed out of the runtime.
