# termchat

termchat 1.3.1 is a serverless terminal chat room for connected Kandelo
machines. It discovers other instances using IPv4 multicast, then uses TCP
for messages and file transfer. Everyone in the room receives messages and
sent files; this version does not provide separate private conversations.

## Use it

The network panel also offers **Terminal chat** through the package's
[session declaration](package-sessions.md). Choose a host name and use
**Start and invite**, or select **Already running** to share a default-config
instance without restarting it. Guests follow the link, enter a different
name, and choose **Join and open chat**. New instances open in a fresh
terminal after the network is connected. The manual commands below remain
available.

Boot a shell machine on each participant's computer and join them to the same
Kandelo network session using the dock's network button and invitation link.
Then run a different name on each machine:

```sh
termchat -u alice
termchat -u bob
```

The connection messages show who has joined. Type a message and press Enter.
Send a guest file to everyone with:

```text
?send /tmp/example.txt
```

Received files are stored under `/tmp/termchat/<sender>/<filename>` on each
receiving machine. Escape or Ctrl-C exits and restores the terminal. The
optional Linux V4L webcam feature is disabled; the shipped feature set is
text chat and file transfer. Chat and file persistence follows the guest
filesystem's existing lifetime; the package adds no independent storage.

The discovery address defaults to `238.255.0.1:5877`. `-d` changes the group
and discovery port; `-t` selects the TCP listening port. `--help` lists the
upstream options. Participants must use distinct usernames: upstream ignores
a discovery message with its own username.

The peers are Kandelo machines attached to a virtual network/session. Browser
sandboxing still prevents discovery of arbitrary native computers on the
physical home or office LAN. No central chat server is needed, but creation
of Kandelo network sessions still uses the existing signalling service.

## Build and dependency portability

The registry pins the upstream crates.io archive and its Cargo.lock. Cargo
verifies the dependency archives before build-local overrides are applied.
The executable uses Kandelo's full-std Rust target and the normal SDK, musl,
package resolver, artifact admission, VFS, PTY, and guest socket paths.

The recipe carries narrow portability patches for mio 0.7.6, time 0.1.44,
parking_lot_core 0.8.0, chrono 0.4.19, whoami 1.1.0, and instant 0.1.9. They
select Unix implementations for a Unix Wasm target, initialize musl time64
padding, and enable existing mio implementations for Kandelo's APIs. They do
not claim Linux target identity or replace an event loop with host JavaScript.
See [Rust dependency portability](../sdk/rust/README.md#porting-rust-dependencies)
for the shared build helper, source verification, cfg diagnosis, and validation
workflow.

Multicast routing belongs to the kernel and networking adapters. Local
membership, interface, loopback, and source filters remain kernel state.
Virtual links transport a group packet once per receiving kernel domain,
even when multiple sockets reuse its port; the receiving kernel distributes
it to matching sockets. The session wrapper routes multicast through the
active session, and Node does not create physical TCP listeners for virtual
bindings. See [networking](architecture.md#networking) and the existing
[epoll contract](epoll.md).

## Validation

The regression tests use the real termchat executable, guest PTYs, multicast
discovery, and guest TCP streams. The Node and browser cases exercise discovery,
messages in both directions, a binary file transfer, terminal resizing,
disconnection, terminal restoration, and process cleanup. The browser test
renders the actual output with xterm. Test sources are
`packages/registry/termchat/test/termchat.test.ts` and
`apps/browser-demos/test/termchat.spec.ts`; transport and kernel regressions
cover multicast fanout and filtering separately. See the
[validation record](plans/2026-10-23-termchat-validation.md) for executed
results, build preparation failures and outstanding checks.
