import { describe, expect, it } from "vitest";
import { EagainError } from "../src/networking/fetch-backend";
import {
  LocalVirtualNetwork,
  VIRTUAL_NETWORK_ERRNO,
} from "../src/networking/virtual-network";
import type { TcpConnectionPeer, UdpDatagram } from "../src/types";
import { NET_READINESS } from "../src/generated/abi";

const MSG_PEEK = 0x0002;

describe("LocalVirtualNetwork", () => {
  // The numeric-address grammar and the DNS syntax check this test used to
  // assert here are now the kernel's, in `crates/runtime-core/src/hostname.rs`
  // and `sys_getaddrinfo`. What the virtual network still owns is its own
  // machine-name table.
  it("resolves the names its attached machines registered", () => {
    const net = new LocalVirtualNetwork();
    const backend = net.attachMachine({
      id: "server",
      address: [10, 88, 0, 2],
      hostnames: ["example.test", "example.test."],
    });

    expect(Array.from(backend.getaddrinfo("example.test"))).toEqual([10, 88, 0, 2]);
    expect(Array.from(backend.getaddrinfo("example.test."))).toEqual([10, 88, 0, 2]);
    expect(() => backend.getaddrinfo("unregistered.test")).toThrow("ENOENT");
  });

  it("routes TCP streams between attached machines", () => {
    const net = new LocalVirtualNetwork();
    const server = net.attachMachine({ id: "server", address: [10, 88, 0, 2] });
    const client = net.attachMachine({ id: "client", address: [10, 88, 0, 3] });
    let accepted: TcpConnectionPeer | null = null;

    expect(server.listenTcp!("srv:1", new Uint8Array([10, 88, 0, 2]), 8080, {
      accept(peer) {
        accepted = peer;
        return 0;
      },
    })).toBe(0);

    client.connect(7, new Uint8Array([10, 88, 0, 2]), 8080);
    expect(client.connectStatus(7)).toBe(0);
    expect(accepted).not.toBeNull();

    expect(client.send(7, new TextEncoder().encode("ping"), 0)).toBe(4);
    expect(new TextDecoder().decode(accepted!.recv(16, 0))).toBe("ping");

    expect(accepted!.send(new TextEncoder().encode("pong"), 0)).toBe(4);
    expect(new TextDecoder().decode(client.recv(7, 16, 0))).toBe("pong");
  });

  it("honors MSG_PEEK without consuming TCP stream data", () => {
    const net = new LocalVirtualNetwork();
    const server = net.attachMachine({ id: "server", address: [10, 88, 0, 2] });
    const client = net.attachMachine({ id: "client", address: [10, 88, 0, 3] });
    let accepted: TcpConnectionPeer | null = null;

    expect(server.listenTcp!("srv:1", new Uint8Array([10, 88, 0, 2]), 8080, {
      accept(peer) {
        accepted = peer;
        return 0;
      },
    })).toBe(0);

    client.connect(7, new Uint8Array([10, 88, 0, 2]), 8080);
    expect(accepted).not.toBeNull();
    accepted!.send(new TextEncoder().encode("peek-data"), 0);

    expect(new TextDecoder().decode(client.recv(7, 4, MSG_PEEK))).toBe("peek");
    expect(new TextDecoder().decode(client.recv(7, 9, 0))).toBe("peek-data");
  });

  it("reports refused TCP connects when no listener is bound", () => {
    const net = new LocalVirtualNetwork();
    const client = net.attachMachine({ id: "client", address: [10, 88, 0, 3] });
    net.attachMachine({ id: "server", address: [10, 88, 0, 2] });

    client.connect(1, new Uint8Array([10, 88, 0, 2]), 9);
    expect(client.connectStatus(1)).toBe(VIRTUAL_NETWORK_ERRNO.ECONNREFUSED);
  });

  it("reports host unreachable for unknown virtual addresses", () => {
    const net = new LocalVirtualNetwork();
    const client = net.attachMachine({ id: "client", address: [10, 88, 0, 3] });

    client.connect(1, new Uint8Array([10, 88, 0, 99]), 9);
    expect(client.connectStatus(1)).toBe(VIRTUAL_NETWORK_ERRNO.EHOSTUNREACH);
  });

  it("wakes TCP peers with reset when a machine detaches", () => {
    const net = new LocalVirtualNetwork();
    const server = net.attachMachine({ id: "server", address: [10, 88, 0, 2] });
    const client = net.attachMachine({ id: "client", address: [10, 88, 0, 3] });

    expect(server.listenTcp!("srv:1", new Uint8Array([10, 88, 0, 2]), 8080, {
      accept() {
        return 0;
      },
    })).toBe(0);

    client.connect(7, new Uint8Array([10, 88, 0, 2]), 8080);
    expect(client.connectStatus(7)).toBe(0);

    net.detachMachine("server");

    // The backend reports facts; the kernel turns them into revents, and its
    // own tests (`runtime_core::net_readiness`) pin that mapping. A reset
    // takes both directions down, so it is an error, end-of-stream, a hangup,
    // and no longer writable — which the kernel renders as
    // POLLERR | POLLIN | POLLHUP with POLLOUT suppressed.
    const facts = client.readiness!(7);
    expect(facts & NET_READINESS.ERROR).toBe(NET_READINESS.ERROR);
    expect(facts >>> NET_READINESS.ERRNO_SHIFT)
      .toBe(VIRTUAL_NETWORK_ERRNO.ECONNRESET);
    expect(facts & NET_READINESS.RECV_EOF).toBe(NET_READINESS.RECV_EOF);
    expect(facts & NET_READINESS.HANGUP).toBe(NET_READINESS.HANGUP);
    expect(facts & NET_READINESS.SEND_READY).toBe(0);
    try {
      client.recv(7, 16, 0);
      throw new Error("recv after detached peer unexpectedly succeeded");
    } catch (error) {
      expect((error as Error & { errno?: number }).errno).toBe(VIRTUAL_NETWORK_ERRNO.ECONNRESET);
    }
    try {
      client.send(7, new TextEncoder().encode("after-detach"), 0);
      throw new Error("send after detached peer unexpectedly succeeded");
    } catch (error) {
      expect((error as Error & { errno?: number }).errno).toBe(VIRTUAL_NETWORK_ERRNO.ECONNRESET);
    }
  });

  it("drains queued TCP data before FIN and keeps an orphaned receive sink", () => {
    const net = new LocalVirtualNetwork();
    const server = net.attachMachine({ id: "server", address: [10, 88, 0, 2] });
    const client = net.attachMachine({ id: "client", address: [10, 88, 0, 3] });
    let accepted: TcpConnectionPeer | null = null;

    expect(server.listenTcp!("srv:1", new Uint8Array([10, 88, 0, 2]), 8080, {
      accept(peer) {
        accepted = peer;
        return 0;
      },
    })).toBe(0);

    client.connect(7, new Uint8Array([10, 88, 0, 2]), 8080);
    expect(client.connectStatus(7)).toBe(0);
    expect(accepted).not.toBeNull();

    expect(accepted!.send(new TextEncoder().encode("queued"), 0)).toBe(6);
    accepted!.close();

    expect(new TextDecoder().decode(client.recv(7, 16, 0))).toBe("queued");
    expect(client.recv(7, 16, 0)).toHaveLength(0);
    // A bare peer FIN is end-of-stream, not a hangup: the write half is still
    // live, so the kernel reports POLLIN and keeps POLLOUT set. This endpoint
    // used to raise POLLHUP here, and only when POLLIN was requested.
    const facts = client.readiness!(7);
    expect(facts & NET_READINESS.RECV_EOF).toBe(NET_READINESS.RECV_EOF);
    expect(facts & NET_READINESS.SEND_READY).toBe(NET_READINESS.SEND_READY);
    expect(facts & NET_READINESS.HANGUP).toBe(0);
    expect(client.send(7, new TextEncoder().encode("after-fin-one"), 0)).toBe(13);
    expect(client.send(7, new TextEncoder().encode("after-fin-two"), 0)).toBe(13);
    client.close(7);
  });

  it("preserves queued TCP data when a cleanly closed machine detaches", () => {
    const net = new LocalVirtualNetwork();
    const server = net.attachMachine({ id: "server", address: [10, 88, 0, 2] });
    const client = net.attachMachine({ id: "client", address: [10, 88, 0, 3] });
    let accepted: TcpConnectionPeer | null = null;

    expect(server.listenTcp!("srv:1", new Uint8Array([10, 88, 0, 2]), 8080, {
      accept(peer) {
        accepted = peer;
        return 0;
      },
    })).toBe(0);

    client.connect(7, new Uint8Array([10, 88, 0, 2]), 8080);
    expect(client.connectStatus(7)).toBe(0);
    expect(accepted).not.toBeNull();

    expect(client.send(7, new TextEncoder().encode("queued before close"), 0)).toBe(19);
    client.close(7);
    net.detachMachine("client");

    expect(new TextDecoder().decode(accepted!.recv(32, 0))).toBe("queued before close");
    expect(accepted!.recv(32, 0)).toHaveLength(0);
  });

  it("keeps the receive direction usable after SHUT_WR", () => {
    const net = new LocalVirtualNetwork();
    const server = net.attachMachine({ id: "server", address: [10, 88, 0, 2] });
    const client = net.attachMachine({ id: "client", address: [10, 88, 0, 3] });
    let accepted: TcpConnectionPeer | null = null;

    expect(server.listenTcp!("srv:1", new Uint8Array([10, 88, 0, 2]), 8080, {
      accept(peer) {
        accepted = peer;
        return 0;
      },
    })).toBe(0);

    client.connect(7, new Uint8Array([10, 88, 0, 2]), 8080);
    expect(client.connectStatus(7)).toBe(0);
    accepted!.shutdown(1);

    expect(client.recv(7, 16, 0)).toHaveLength(0);
    expect(client.send(7, new TextEncoder().encode("still-readable"), 0)).toBe(14);
    expect(new TextDecoder().decode(accepted!.recv(16, 0))).toBe("still-readable");
  });

  it("routes UDP datagrams and preserves source metadata", () => {
    const net = new LocalVirtualNetwork();
    const server = net.attachMachine({ id: "server", address: [10, 88, 0, 2] });
    const client = net.attachMachine({ id: "client", address: [10, 88, 0, 3] });
    const received: UdpDatagram[] = [];

    expect(server.bindUdp!("server:9000", new Uint8Array([10, 88, 0, 2]), 9000, {
      receive(datagram) {
        received.push(datagram);
        return 0;
      },
    })).toBe(0);

    expect(client.sendDatagram!({
      srcAddr: new Uint8Array([10, 88, 0, 3]),
      srcPort: 49152,
      dstAddr: new Uint8Array([10, 88, 0, 2]),
      dstPort: 9000,
      data: new TextEncoder().encode("hello"),
    })).toBe(0);

    expect(received).toHaveLength(1);
    expect(Array.from(received[0].srcAddr)).toEqual([10, 88, 0, 3]);
    expect(received[0].srcPort).toBe(49152);
    expect(new TextDecoder().decode(received[0].data)).toBe("hello");
  });

  it("scopes INADDR_ANY UDP binds to each attached machine", () => {
    const net = new LocalVirtualNetwork();
    const one = net.attachMachine({ id: "one", address: [10, 88, 0, 2] });
    const two = net.attachMachine({ id: "two", address: [10, 88, 0, 3] });
    const client = net.attachMachine({ id: "client", address: [10, 88, 0, 4] });
    const receivedOne: UdpDatagram[] = [];
    const receivedTwo: UdpDatagram[] = [];

    expect(one.bindUdp!("one:any", new Uint8Array([0, 0, 0, 0]), 9000, {
      receive(datagram) {
        receivedOne.push(datagram);
        return 0;
      },
    })).toBe(0);
    expect(two.bindUdp!("two:any", new Uint8Array([0, 0, 0, 0]), 9000, {
      receive(datagram) {
        receivedTwo.push(datagram);
        return 0;
      },
    })).toBe(0);

    expect(client.sendDatagram!({
      srcAddr: new Uint8Array([10, 88, 0, 4]),
      srcPort: 49152,
      dstAddr: new Uint8Array([10, 88, 0, 3]),
      dstPort: 9000,
      data: new TextEncoder().encode("target-two"),
    })).toBe(0);

    expect(receivedOne).toHaveLength(0);
    expect(receivedTwo).toHaveLength(1);
    expect(new TextDecoder().decode(receivedTwo[0].data)).toBe("target-two");
  });

  it("scopes backend UDP endpoint identifiers to each attached machine", () => {
    const net = new LocalVirtualNetwork();
    const one = net.attachMachine({ id: "one", address: [10, 88, 0, 2] });
    const two = net.attachMachine({ id: "two", address: [10, 88, 0, 3] });
    const receivedOne: UdpDatagram[] = [];

    expect(one.bindUdp!("100:0", new Uint8Array([0, 0, 0, 0]), 9000, {
      receive(datagram) {
        receivedOne.push(datagram);
        return 0;
      },
    })).toBe(0);
    expect(two.bindUdp!("100:0", new Uint8Array([0, 0, 0, 0]), 49152, {
      receive() {
        return 0;
      },
    })).toBe(0);

    expect(two.sendDatagram!({
      srcAddr: new Uint8Array([10, 88, 0, 3]),
      srcPort: 49152,
      dstAddr: new Uint8Array([10, 88, 0, 2]),
      dstPort: 9000,
      data: new TextEncoder().encode("still-bound"),
    })).toBe(0);

    expect(receivedOne).toHaveLength(1);
  });

  it("scopes INADDR_ANY TCP listeners to each attached machine", () => {
    const net = new LocalVirtualNetwork();
    const one = net.attachMachine({ id: "one", address: [10, 88, 0, 2] });
    const two = net.attachMachine({ id: "two", address: [10, 88, 0, 3] });
    const client = net.attachMachine({ id: "client", address: [10, 88, 0, 4] });
    let oneAccepted = 0;
    let twoAccepted = 0;

    expect(one.listenTcp!("one:any", new Uint8Array([0, 0, 0, 0]), 8080, {
      accept() {
        oneAccepted++;
        return 0;
      },
    })).toBe(0);
    expect(two.listenTcp!("two:any", new Uint8Array([0, 0, 0, 0]), 8080, {
      accept() {
        twoAccepted++;
        return 0;
      },
    })).toBe(0);

    client.connect(11, new Uint8Array([10, 88, 0, 3]), 8080);
    expect(client.connectStatus(11)).toBe(0);
    expect(oneAccepted).toBe(0);
    expect(twoAccepted).toBe(1);
  });

  it("defers every internet-domain bind conflict to the kernel", () => {
    // The kernel decides EADDRINUSE in crates/runtime-core/src/socket.rs
    // (udp_can_bind / tcp_can_bind) and only notifies the host once that
    // decision has succeeded. The fabric must not hold a second opinion: it
    // cannot see SO_REUSEADDR, and it cannot see that two pids are
    // fork-inherited co-owners of one logical binding, so any answer it gives
    // is guesswork that overrides a correct one.
    const net = new LocalVirtualNetwork();
    const machine = net.attachMachine({ id: "server", address: [10, 88, 0, 2] });
    const noopUdp = { receive: () => 0 };
    const noopTcp = { accept: () => 0 };

    // Two distinct sockets on the same wildcard address and port: the shape
    // SO_REUSEADDR produces, and the shape a fork leaves behind.
    expect(machine.bindUdp!("1:4", new Uint8Array([0, 0, 0, 0]), 5000, noopUdp)).toBe(0);
    expect(machine.bindUdp!("1:5", new Uint8Array([0, 0, 0, 0]), 5000, noopUdp)).toBe(0);
    // A specific address overlapping an existing wildcard binding, and the
    // reverse order, are likewise the kernel's call and not the fabric's.
    expect(machine.bindUdp!("2:4", new Uint8Array([10, 88, 0, 2]), 5000, noopUdp)).toBe(0);
    expect(machine.bindUdp!("2:5", new Uint8Array([0, 0, 0, 0]), 5001, noopUdp)).toBe(0);
    expect(machine.bindUdp!("2:6", new Uint8Array([10, 88, 0, 2]), 5001, noopUdp)).toBe(0);

    expect(machine.listenTcp!("1:8", new Uint8Array([0, 0, 0, 0]), 8080, noopTcp)).toBe(0);
    expect(machine.listenTcp!("1:9", new Uint8Array([0, 0, 0, 0]), 8080, noopTcp)).toBe(0);
    expect(machine.listenTcp!("2:8", new Uint8Array([10, 88, 0, 2]), 8080, noopTcp)).toBe(0);

    // The one address fact the fabric does own is which machine holds which
    // virtual address, so binding a peer's address still fails here.
    net.attachMachine({ id: "peer", address: [10, 88, 0, 3] });
    expect(machine.bindUdp!("3:4", new Uint8Array([10, 88, 0, 3]), 5002, noopUdp))
      .toBe(VIRTUAL_NETWORK_ERRNO.EADDRNOTAVAIL);
    expect(machine.listenTcp!("3:8", new Uint8Array([10, 88, 0, 3]), 8081, noopTcp))
      .toBe(VIRTUAL_NETWORK_ERRNO.EADDRNOTAVAIL);
  });

  it("uses normal UDP errno style for missing destination hosts and ports", () => {
    const net = new LocalVirtualNetwork();
    const client = net.attachMachine({ id: "client", address: [10, 88, 0, 3] });
    net.attachMachine({ id: "server", address: [10, 88, 0, 2] });

    const base = {
      srcAddr: new Uint8Array([10, 88, 0, 3]),
      srcPort: 49152,
      dstPort: 9000,
      data: new Uint8Array(0),
    };

    expect(client.sendDatagram!({
      ...base,
      dstAddr: new Uint8Array([10, 88, 0, 99]),
    })).toBe(VIRTUAL_NETWORK_ERRNO.EHOSTUNREACH);

    expect(client.sendDatagram!({
      ...base,
      dstAddr: new Uint8Array([10, 88, 0, 2]),
    })).toBe(VIRTUAL_NETWORK_ERRNO.ECONNREFUSED);
  });

  it("throws EAGAIN when a connected stream has no data yet", () => {
    const net = new LocalVirtualNetwork();
    const server = net.attachMachine({ id: "server", address: [10, 88, 0, 2] });
    const client = net.attachMachine({ id: "client", address: [10, 88, 0, 3] });

    server.listenTcp!("srv:1", new Uint8Array([10, 88, 0, 2]), 8080, {
      accept() {
        return 0;
      },
    });
    client.connect(7, new Uint8Array([10, 88, 0, 2]), 8080);

    expect(() => client.recv(7, 16, 0)).toThrow(EagainError);
  });
});
