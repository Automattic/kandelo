# Kandelo Multi-Machine Virtual Networking Plan

Status: implemented and regression-tested in this branch.

## Goal

Enable multiple local Kandelo machines in one browser session to communicate
with each other through normal POSIX UDP and TCP sockets. The first demo should
use real guest tools, especially a portable `nc` and existing `curl`, rather
than Kandelo-specific messaging APIs. WebRTC between different browsers is a
follow-up backend that should plug into the same network interface.

## Design Principles

- Guest programs use POSIX sockets: `socket`, `bind`, `connect`, `listen`,
  `accept`, `send*`, `recv*`, `shutdown`, `poll`, and `select`.
- Browser, Node, local virtual networking, and future WebRTC are host backends
  below the POSIX socket layer.
- Do not reintroduce public demo-specific datagram APIs such as
  `BrowserKernel.injectDatagram` as the userspace-visible model.
- Loopback stays per-machine. Routed virtual addresses are for cross-machine
  communication.
- UDP remains connectionless. Machine removal unregisters endpoints and drops
  queued/in-flight datagrams; idle UDP peers do not get a synthetic disconnect.
- TCP machine removal wakes peer sockets and listener/connect waiters with EOF
  or reset-style behavior, depending on whether the removal is graceful.

## Local Virtual Network

Create a browser-session virtual network with attached Kandelo machines:

- Reserve a small subnet such as `10.88.0.0/24`.
- Assign each machine one IPv4 address, for example `10.88.0.2`,
  `10.88.0.3`, and so on.
- Keep `127.0.0.0/8` local to each machine.
- Route non-loopback virtual addresses through the session network backend.
- Keep DNS simple initially: machine names resolve to assigned virtual IPs.

## Host Backend Contract

Evolve the current `NetworkIO` boundary, which mainly covers outbound TCP, into
a POSIX socket backend contract capable of:

- UDP bind/unbind/send/deliver.
- TCP listen/unlisten/connect/accept/send/recv/shutdown/close.
- Readiness wakeups for blocked `accept`, `connect`, `recv*`, `send*`, `poll`,
  and `select`.
- Address ownership checks and errno mapping.

The local browser-session backend should implement this contract in memory.
Node real networking and browser fetch/TLS should remain compatible backends for
external communication.

## UDP Scope

Extend existing AF_INET SOCK_DGRAM support from in-kernel loopback to routed
virtual-network delivery:

- Bind to `INADDR_ANY`, loopback, and assigned virtual NIC addresses.
- Allocate ephemeral ports and enforce bind conflicts.
- Support `SO_REUSEADDR` semantics already covered by Sortix UDP tests.
- Support `sendto` on unconnected sockets.
- Support `connect` as peer selection and `AF_UNSPEC` unconnect.
- Support `send` and `recv` on connected UDP sockets.
- Preserve datagram boundaries and truncation behavior.
- Report source addresses through `recvfrom` and `recvmsg`.
- Filter receives on connected UDP sockets to the selected peer.
- Make `poll` and `select` readiness queue-based.
- Bound queues without violating normal UDP expectations.
- Surface `ENETUNREACH`, `EHOSTUNREACH`, `ECONNREFUSED`,
  `EADDRINUSE`, and `EADDRNOTAVAIL` where appropriate.

## TCP Scope

Implement virtual-network TCP as reliable byte streams over host-managed
connections, not as a raw packet TCP stack:

- `bind`, `listen`, `accept`, and `connect`.
- Blocking and nonblocking connect behavior.
- `SO_ERROR` for failed async connects and peer errors.
- `getsockname` and `getpeername`.
- `send`, `recv`, `sendmsg`, and `recvmsg`.
- EOF, reset, close, and half-close through `shutdown`.
- Bounded buffers and backpressure.
- `poll` and `select` readiness for read, write, hangup, and error.
- `MSG_DONTWAIT` and `MSG_NOSIGNAL`.
- Listener and connection cleanup when a process or machine exits.

## Real Netcat

Commit to supporting a real portable netcat instead of implementing a narrow
clone:

- Add a package for portable netcat, installed as `/usr/bin/nc` and `/bin/nc`.
- Use GNU netcat 0.7.1 as a small portable upstream with Kandelo-focused
  portability patches.
- Keep patches portability-focused.
- Let real `nc` drive missing socket behavior.
- Use `nc` for TCP and UDP demo traffic.

## Curl Demo Use

Use the existing `curl` package as a higher-level TCP proof:

- Run an HTTP server on machine A.
- Use `curl http://10.88.0.2:PORT/` from machine B.
- Keep the path using normal TCP sockets, not `fetchInKernel`.

## Test Plan

Add tests in three layers.

### Upstreamable Sortix-Style Tests

Strengthen generic POSIX socket coverage in `tests/sortix/os-test` where the
tests are not Kandelo-specific. Good candidates to contribute upstream later:

- TCP nonblocking `connect` completion and failure.
- TCP `SO_ERROR` after async connect errors.
- TCP `poll` readiness for listener backlog, connected streams, EOF, and error.
- TCP half-close behavior around `shutdown(SHUT_RD/WR/RDWR)`.
- TCP send/recv edge cases around EOF, EPIPE, and `MSG_NOSIGNAL`.

These tests should avoid Kandelo virtual-machine concepts so they remain
portable.

### Kandelo Kernel Regressions

Add focused Rust/kernel tests for the socket state machine where direct unit
coverage is clearer than an end-to-end guest program.

### Host/Browser Integration Tests

Add tests that prove two BrowserKernel instances in one browser session can
communicate:

- UDP `sendto` from machine B to `recvfrom` on machine A.
- Connected UDP receive filtering across machines.
- TCP `listen`/`connect`/`accept` across machines.
- TCP bidirectional `send`/`recv`.
- TCP half-close and EOF across machines.
- `poll`/`select` wakeups across worker boundaries.
- Cleanup when one machine exits.

## UI Demo

Build a Kandelo UI demo that boots multiple local machines in one browser
session:

- Show each machine's name, virtual IP, status, and terminal.
- Include useful packet/connection counters in the UI.
- Demonstrate TCP with `nc`.
- Demonstrate UDP with `nc -u`.
- Demonstrate HTTP with `curl` from one machine to a server on another.

## WebRTC Follow-Up

After local virtual networking is working, add WebRTC as another backend:

- Same POSIX socket behavior from the guest perspective.
- WebRTC signaling outside the socket layer.
- UDP over unreliable/unordered data channels where available.
- TCP over reliable ordered data channels or multiplexed streams.

## Acceptance Criteria

- The PR contains one coherent implementation, not separate PR slices.
- Multiple local browser Kandelo machines can communicate over UDP and TCP.
- Real `nc` runs in the guest image and works for TCP and UDP paths.
- `curl` can fetch from a service on a peer Kandelo machine.
- Existing UDP and basic socket suites do not regress.
- Added TCP tests cover gaps in current Sortix/basic coverage.
- Remaining platform limits are documented with exact causes and next steps.

## Current Results

- Browser demo page: `/pages/network/`.
- Guest tools: GNU `nc` is packaged as `/usr/bin/nc`, `/bin/nc`,
  `/usr/bin/netcat`, and `/bin/netcat`; `curl` is used as the HTTP client.
- Demo scenarios verified in Chromium:
  - beta sends a UDP datagram to alpha with `nc -u`.
  - beta opens a TCP stream to alpha with `nc`.
  - gamma fetches alpha's netcat-served HTTP response with `curl`.
- Focused Playwright coverage:
  `cd apps/browser-demos && npx playwright test test/network.spec.ts --project=chromium --workers=1`.
- Host integration coverage:
  `cd host && npx vitest run test/virtual-network.test.ts test/virtual-network-e2e.test.ts`.
- UDP conformance coverage:
  `scripts/run-sortix-tests.sh udp` and
  `scripts/run-browser-sortix-tests.sh udp` both report 196 pass, 13 exact
  XFAIL, and 0 fail.
- Sortix-style coverage added for connected UDP read/write and TCP
  accept/send/recv, poll readiness, half-close, nonblocking connect, and
  `SO_ERROR`.
