# Internal benchmark reporter consumers

The actual testing factory now consumes the complete unchanged Node 26.13.0
`internal/bench_runner/reporter/json` and `internal/bench_runner/reporter/spec`
modules through its existing module registry. The normal source manifest pins
both files. The JSON reporter is the target async generator; Spec is the target
Transform class over the existing internal Transform owner. Neither requires a
second clock, fabricated measurements or a replacement benchmark runner.

These are internal reporter owners, not public `node:bench/reporters` activation.
That namespace still needs the exact public lazy aliases, constructor wrapper,
experimental warning and module/CLI gate. The public `node:bench` entry, CLI file
loading and process isolation/IPC remain separate implementation gaps.

The reporters consume real benchmark record streams: JSON converts BigInt,
Error fields and repeated graph references; Spec formats measured summaries,
parameters, skips and diagnostics, buffers until summary and flushes when no
summary arrives. Async iteration cancellation and original conversion exceptions
remain owned by the actual iterator/stream algorithms. JSON rendering is an
output format, not the benchmark's structured transport or V8 serialization.

Focused component observations compare actual runner-to-reporter output,
Transform completion through a low-watermark sink, no-summary flush, graph
formatting, iterator cancellation and throwing-property cleanup against the
pinned native modules. The component uses disclosed native stream, async,
histogram, clock, graph-clone and V8 dependencies. It does not validate those
guest providers. The pre-existing named-error record failure with the missing
guest V8 serializer remains an implementation nonpass; a native serializer
dependency passing in the component cannot close it.

No normal bundle generation, engine compilation, guest execution, overall suite
or four-host conformance was performed for this slice.
