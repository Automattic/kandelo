# Captured TTY read material and queued close

Source213 retains consumed input bytes/status in actual native allocation tickets
owned by the captured terminal resource. Generation and sequence distinguish real
requests. Stopping readiness preserves consumed material; failed pre-admission
publication returns the same ticket to ready state. Actual callback admission
releases the queued slot, while reactor roots and native-memory claims survive
callback, after-hooks and job unwind. No future public descriptor is read as the
captured owner: descriptor replacement cannot redirect the input source.

Actual configure/onread/start/stop/ref operations share the stream state consumed
by stdin. Close stops reads and releases captured descriptors, then retires the
native owner and close callback behind its request count. Public descriptors are
borrowed and remain independently owned. This does not implement public TTY
constructor/kind admission, writes/WriteWrap/shutdown or early-init ordering.

Root reran the exact sealed portable binary after matching all owner/header
identities:27 distinct named checks pass. Two actual native-backed JS factory
scenarios pass with4 positive processes. The disabled callback route exits1 and
is retained as a negative control. The native fixture adapter translates a private
seam over real Node TTY transport; it is not a production Kandelo backend or proof
of guest callback/GC/realm/queued-close behavior. One previously compiled tiny
portable helper is accounted once; root did not recompile it.

Normal generation,880 declared source inputs, native staging, unchanged Mozilla
style, bootstrap syntax, zero-fuzz engine patch replay and14 package checks pass.
Original skipped-bootstrap-hunk and omitted-codec fixture failures remain sealed.
New production C++ remains uncompiled/unexecuted; accepted engine200 excludes
201–213. Raw-mode/restoration/master/fallback/backpressure and other existing
nonpasses remain. No finding or family closes. Full rebuild/overall-suite deferral
and exact target/source/reference pins remain unchanged.
