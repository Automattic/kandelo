# Retained TCP/SSL parent prerequisite controls

These controls verify a bounded native owner and the selected JavaScript
routing. They do not establish public TLSWrap, guest, or browser conformance.
The reference is unchanged Node 26.13.0; upstream source commit is
`18b32a3b1552e199a01f1a8d9fd64aa756d3b75b`.

`component.cpp` compiles the real production `socket-owner.h` and
`tls-owner.h` against the pinned native Node/OpenSSL headers. It creates
real loopback TCP connections and SSL/SSL_CTX instances. The controls
assert early SSL/empty-TCP birth, actual retained descriptor identity,
exclusive stream admission, delegated reference state, actual native
request-object close barriers, clean EOF versus errors, retained read
material through close, exactly-once SSL/context destruction and actual
fd reuse. Parent lifetime in this portable component is explicit C++
ownership; SpiderMonkey rooting/realm/GC and production queued callback
behavior remain unexecuted.

`bridge-control.cjs` first observes the pinned native TLSSocket's real
TCPWRAP/TLSWRAP construction order, retained parent, onread and ref
behavior. It then executes extracted production adapter, TLS and dialing
sections over an explicitly recording-only injected native boundary.
That boundary is not a real Kandelo handle or a claimed implementation.
The control verifies exact arguments, SSL preparation before lookup,
same-parent connect, fresh retry authority, before-lookup cancellation
and no public-fd getter access in this retained TLS path. No global
conformance setup, host fetch delegation or guest metadata is injected.

Run in the declared dev shell with an already compiled component:

```sh
scripts/dev-shell.sh bash third_party/node-core/tests/tls-retained-parent-owner/run-controls.sh \
  "$NODE26" "$NODE26_SOURCE" "$COMPONENT_NODE" "$CANDIDATE_ROOT"
```

Native helper compilation is a separate tiny host build. The diagnostic
uses the pinned Node headers and its exported OpenSSL symbols; it is not
a guest SDK build. Require completed semantic check names and exact
outcomes, never a minimum retry-dependent aggregate assertion count.
Keep all failed attempts and output identities. No upstream assertion is
changed by these authored controls.
