# Child exec output, callback and custom Promise ownership

Source226 consumes complete unchanged pinned exec/execFile normalization/output
collectors and validators through a new normal generated factory. Actual bootstrap
passes existing _spawn/Buffer/timers/values; export order and live public execFile
lookup remain. Actual stream encoding, Buffer bytes, per-output maxBuffer,
timeout/kill/error/close callback-once state and custom Promise.child/output/error
identities follow target algorithms. Caller stdin is no longer unconditionally
ended; actual caller/child terminal ownership remains responsible for it.

Twenty-three current bootstrap groups and four unchanged upstream files on native
and candidate pass. Native spawn/stdio/decoder/Buffer/timer/error/VM/OS dependencies
are explicit. These do not validate guest spawn/options/signal/abort/fd/pipe/wait/
fatal/GC/realm or four-host behavior. Original5/23baseline matches, aggregate
stdin-write error, missing fixture capture and generator inputs remain retained.

A mandatory immutable companion addendum corrects the original sealed report:
no final subject used fixtureSafetyKill. Native spawn honored timeout even in
the old fixture, so its timeout mismatch proves error shape/cmd divergence,
not absent guest timeout execution. Source, results and assertions are unchanged.
Independent source review verifies actual publication/complete pinned sections/
overloads/streams/promise ownership with no new P1/P2; no runtime approval follows.

Normal887inputs/bootstrap/staging and14focused package checks pass. No compiler,
engine/kernel/product build, ABI/target change or overall suite occurs. Complete
CP-010, lower actual child lifecycle and identified-artifact four-host conformance
remain open. All19families remain partial; no finding closes.
