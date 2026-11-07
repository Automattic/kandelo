# Accepted owner publication controls

These focused controls use the exact pinned native Node26.13.0 binary, actual
native TCPWrap resources/IDs/descriptors and the candidate's extracted Server
accept/adopt publication methods. A null-prototype capability retains the real
accepted handle before a deliberately limited Socket wrapper is constructed.
No AsyncResource is invented to impersonate TCPWRAP; native Node creates each
actual accepted resource. This component boundary does not execute candidate
SpiderMonkey initialization, watch dispatch, context/GC or fatal semantics.

```
WASM_POSIX_DEV_SHELL_ATTEMPTS=1 scripts/dev-shell.sh env \
  NODE26_REFERENCE=/absolute/pinned-reference/bin/node \
  TCP_ACCEPT_CONTROL_DIR=/absolute/fresh/evidence \
  bash third_party/node-core/tests/accepted-owner/run-controls.sh
```

Four scenarios cover twelve actual connections: five concurrent publications,
two with a poisoned inherited then getter, three dropped before construction,
and two constructor-option getter failures preserving the original error and
closing the unadopted actual handle. Callback errors remain Promise rejections
in the candidate frontend; this is an explicit gap relative to the separate
unchanged native reference, which observes the constructor getter error through
uncaughtException. Passing these component assertions does not close that gap.

The init hook captures resource/ID/trigger identity only; descriptor access is
performed after native acceptance, before Socket construction. A raw private
fd read during native async init is not a safe conformance assertion about an
object whose constructor is incomplete. The initial exploratory control failed
with exit138; its source/logs are retained in the handoff, with no upstream
runtime defect allegation or fd-at-init runtime claim.

The production source constructs the actual owner before Promise publication,
retains it through a persistent-root capability, and transfers that same owner
once. Queued close performs rollback. A separately sealed engine delta detaches
an accepted watch before any init/rejection reentry and returns before using a
raw saved next pointer. Those SpiderMonkey paths are source-reviewed only.
