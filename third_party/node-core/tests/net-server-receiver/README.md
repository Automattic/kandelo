# Server receiver and captured-listener controls

Explicit no-global-setup. Use the declared devshell with the exact audited
Node26.13.0 reference and a fresh evidence directory:

```
WASM_POSIX_DEV_SHELL_ATTEMPTS=1 scripts/dev-shell.sh env \
  NODE26_REFERENCE=/absolute/pinned-reference/bin/node \
  NET_SERVER_CONTROL_DIR=/absolute/fresh/evidence \
  bash third_party/node-core/tests/net-server-receiver/run-controls.sh
```

The same assertions run against native Server and the candidate constructor,
complete extracted production Server owner closure, accepted adoption and socket
option algorithms. Actual native TCPWrap resources back bind/listen/accept,
close/ref/options; actual native Duplex owns stream state. Native EventEmitter,
DNS and clone prohibition are explicit dependencies. The component Socket uses
real accepted handles but deliberately has no payload transport; all connections
are paused. This is not guest JSAPI, kernel, async-init/fatal, Worker-transfer or
full-net validation. The native reference suite is not replaced or modified.

Controls cover call/new/subclass/newTarget and exact inheriting receiver,
options snapshot/error order, real descriptors, captured listener continuity
across active reinitialization, distinct concurrent bindings, mutable public
field/helper non-authority, close/relisten, rollback, stale DNS, and an adopted
native handle's setup failure preserving the original error. The setup-failure
case is candidate-only boundary injection; the other groups run natively too.

The old raw-fd getter assumption in the first exploratory candidate run expected
-1 after close; native TCPWrap's observed closed getter was -22. That failed log
is retained. Closure checks now require actual invalid fd and separately prove
EBADF on the original closed descriptor, without prescribing private getter
sentinels. No assertion about accepted native init timing has been weakened.

Public Worker listener transfer, full Socket/Server lifecycle, arbitrary borrowed
method receivers, pending-DNS repeated-reinit generation edge cases and the guest
Promise-versus-fatal boundary remain separate gaps. Successful constructor source
controls do not establish HTTP Server support.
