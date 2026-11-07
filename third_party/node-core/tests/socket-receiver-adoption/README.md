# Generic Socket receiver/admission prerequisite

The selected production callable constructor, owner initializer and pinned
stream algorithms run over explicitly declared actual native Node TCP,
StreamBase, WriteWrap, OS, Buffer/Duplex and async-context dependencies.
The reference is exactly Node 26.13.0. No conformance global setup runs.

The raw native TCP listener/accepted handles are genuine Native Node resources,
not TTY-shaped JavaScript handles. Candidate-only boundary adapters bridge
existing Kandelo `ref(bool)`, configureRead and write entry points to actual
Node native methods. Read/write state words come from the actual native
StreamBase producer; actual Buffer/data and WriteWrap requests are retained.
No fabricated state values, provider IDs or successful unsupported controls
stand in for I/O. These explicit control adapters are not production backends
and do not execute Kandelo's new C++ admission/GC/realm/kernel code.

Run each mode freshly, with no overall suite/global setup:

```sh
scripts/dev-shell.sh "$NODE26" --expose-internals \
  third_party/node-core/tests/socket-receiver-adoption/control.cjs \
  native "$CANDIDATE_ROOT"
scripts/dev-shell.sh "$NODE26" --expose-internals \
  third_party/node-core/tests/socket-receiver-adoption/control.cjs \
  candidate "$CANDIDATE_ROOT"
scripts/dev-shell.sh "$NODE26" \
  third_party/node-core/tests/socket-receiver-adoption/forwarder.cjs \
  "$CANDIDATE_ROOT"
```

Require a terminal JSON report as well as exit0. Assertions compare actual
receiver/newTarget identity, getter/error/initialization order, inherited
native transport/manualStart/pauseOnCreate/ref behavior, actual read callback
resource, Latin1 and 2 MiB bytes, real WriteWrap and queued close. Caller-supplied
native handles remain live on a throwing onread bind; the actual partial
receiver can subsequently destroy that owner. Internal newly acquired owner
rollback stays distinct. No unchanged upstream assertion is modified.

These controls do not establish public TTY support. The native TTY StreamBase
methods, constructor/init/error/resource order and kind-generic Socket shutdown/
address/control/close dispatch remain owning prerequisites. Public TTY exports
remain unchanged/incomplete. Preserve every source/setup/control failure from
the handoff, including exit0 without a completion report; none are passes.
