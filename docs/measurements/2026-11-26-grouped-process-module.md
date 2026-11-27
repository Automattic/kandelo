# Reusing a compiled grouped process executable

On the grouped Sway desktop one trusted Alt+Return started a fork of Sway, a shell, Foot, a fork of Foot and Bash. Each of the five process Workers compiled the executable even though the kernel Worker already had the compiled program for its privately owned bytes. Timing from receipt of each image placed 248 ms in the five compile calls in one instrumented Firefox run. A launch that transported the cached modules eliminated all five calls.

The desktop used the normal partial shell packages, the integrated November 26 preview kernel (SHA-256 `7edd1b96d182c6a9b2b0dd11d972d9dadee40ec3993a5dd3649a5b5b2baac974`) and a 2634 × 1806 canvas. The end point was a fitted dark background and prompt pixels in both the new terminal and its resized peer. The test polled the actual canvas. The physical display and keyboard hardware are outside that interval.

Four fresh Playwright Firefox sessions, in control/candidate/candidate/control order, took 4493, 2491, 3481 and 3587 ms. These exploratory sessions timed a prototype of the same cache lookup. The shared machine also ran builds. They establish the eliminated work more clearly than its effect on total latency. Installed Firefox 161 took 3515 ms with the final implementation integrated into that preview. Playwright WebKit took 1714 ms. Both still visibly exceed the 100 ms launch target.

The cache continues to own the weak reference and retention budget. Neither the transport nor the process creates another cache. An old or absent cache entry, a different byte buffer, or a sender without the new field takes the byte-compile path. The original process module supplied by a caller cannot substitute for the compiler result, and a thread still needs its own constructor preparation.
