# Fork function catalogs during terminal launch

The baseline is develop `dffcfca5325666d5e02cacdef03d4f14893a4584`.
Each process already registered the instrumenter's fixed function ordinals
when an activation joined its registry. Four fork and peer-table paths
constructed another catalog by walking the same tables. Capture and replay
held these extra function roots until the transaction ended. Registry
membership can change only while the registry is idle.

The activation snapshot now serves every caller. The inverse index contains
one canonical recipe per distinct function and is constructed only on the
first non-null encode after register or unregister. It chooses the lowest
activation ID, then the lowest ordinal. Decode indexes the captured
activation directly. Values in mutable guest tables still go through their
existing dirty-page and journal owners. A failed registration publishes
neither forward nor inverse entries.

## Measurement

The normal partial shell started Sway and one Foot at 2634 × 1806. A trusted
Alt+Return opened the second Foot. Both Firefox traces used the same kernel,
shell image, compiled-module reuse host and packaged process Worker build
path. Counters in the Worker recorded completed registration calls between
the key and the fitted prompt-bearing tiles.

| Window | Registrations | Function-table slots read | Time in registration |
| --- | ---: | ---: | ---: |
| Baseline | 9 | 69,589 | 27.78 ms |
| Shared activation catalog | 5 | 29,979 | 7.92 ms |

The four removed walks cover the 14,615-entry Sway table and the 5,190-entry
Foot table twice each. A separate trace found zero non-null encodes or
decodes in those four transaction catalogs. No additional process-lifetime
catalog is retained. The remaining five registrations belong to five fresh
execution images. End-to-end times in this instrumented pair were 2.57 and
1.83 seconds under concurrent machine load. The 19.86 ms difference in
registration time does not explain the full desktop difference.

The host build and 174 tests across 13 fork and reference suites passed,
including failed registration, canonical aliases across unload, fresh child
identities, and typed checkpoint/replay. Node ran the ordinary and grouped
SDK fork probes, 24 grouped root cycles, and 256 ordinary and grouped pthread
cycles. The final 128 grouped iterations met the unchanged plateau assertion.
After retirement there was one allocated control page and zero images,
replicas or native observers. The SDK fork fixture linked the existing
kernel mprotect syscall directly because this develop SDK omits the libc
symbol by default. No assertions were changed.

The release Worker rendered all five fitted prompts in installed windowed
Firefox 161. Successive shortcuts took 4.41, 2.32, 2.99 and 3.73 seconds.
Experimental WebKit rendered two prompts in 1.18 seconds. The initial
Chromium run used the Firefox pixel thresholds and failed. Chromium passed
its existing glyph-mask and cursor checks in the calibrated run. The
time-to-prompt objective remains open.

A membership change invalidates the inverse index. A workload that repeatedly
loads or unloads a module between non-null encodes will rebuild it. That
workload has no throughput measurement here.
