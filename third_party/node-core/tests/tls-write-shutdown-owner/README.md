# Normal-open TLS write-shutdown prerequisite controls

Actual production socket-owner.h/tls-owner.h compile over pinned native Node
OpenSSL exports and real loopback TCP. Six clean-queue TLS1.2/TLS1.3 subjects
cover prior write/callback gating, original alert receipt acknowledgment before
actual parentSHUT_WR, no peer-notify wait, cancellation/descriptorreuse and fatal
read refusal before SSL_shutdown. The callback ticket is a declared portable
fixture dependency; new SpiderMonkey ShutdownWrap/root/frame/GC/realm/Worker
code is source-only and does not follow from this component.

control-dirty.cjs preserves its TLS1.3 injected-error-queue preservation failures.
They are not removed, unsupported or passing controls. Native-reference.cjs uses
actual pinned native TLSWrap.shutdown/ShutdownWrap and snapshots actual same-
thread queue values; both native protocols preserve the injected entry in that
configuration. Portable inputBIO/config/policy parity remains unresolved.

No public _final is activated. Valid early-end-before-secure mismatch and old
blocked direct-BIO/invalid abrupt-after-fatal fixture remain recorded. Existing
best-effort Close behavior is unchanged and not declared equal to Node Destroy.
