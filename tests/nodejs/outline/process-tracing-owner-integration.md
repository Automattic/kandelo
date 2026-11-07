# Process tracing category and file ownership

Source214 integrates a real process-wide mutex/category multiset and native file
sink. Unchanged pinned trace_events algorithms and Console producers consume
this state; private callback subscriptions remain independent realm consumers.
Events use actual executing guest PID/TID/monotonic timestamps. The sink owns
lazy creation, CLOEXEC, short writes/EINTR, sticky errors and once-only close.
Public Worker contexts share state; main teardown finishes the sink after public
Node Worker join and producer retirement. Shell extension-thread joining is not
established by this source path.

Current root factories pass8 of9 unchanged comparison groups against identified
native references. The failed-open native timeout stays nonpassing, with raw
reference outputs/timeout identity retained; fresh candidate exits0. No artificial
hang or runtime workaround reproduces the reference. Original lost partial-output
limitations remain explicit. Five standalone owner modes passed, including41 real
events from5 native threads. Exact compiled header/addon/control dependencies admit
binary reuse; root performed zero new compilations. Five original compiler attempts,
including one failure, are accounted once.

Normal generation,884 declared inputs, native staging, unchanged Mozilla style,
bootstrap syntax, zero-fuzz teardown replay and14 package checks pass. An old
staging hunk conflicted with newer Worker startup source; only that failed hunk
was composed, preserving19 already-applied source leaves and all later owners.

Actual guest JSAPI/teardown/GC/realm/fatal/Worker behavior remains uncompiled and
unexecuted. Full producers, schema/CPU/duration/metadata, allocation accounting,
CLI/NODE_OPTIONS/file rotation/permissions/inspector/Perfetto and process.report
remain implementation gaps. Source wait analysis is consistent with the observed
native timeout but is not stack-confirmed defect attribution or an accepted
platform boundary. No finding/family closes; accepted200 excludes201–214 and all
four hosts need identified-artifact evidence. Full product/overall suites remain
deferred and exact target/source/reference pins stay unchanged.
