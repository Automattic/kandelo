import { describe, expect, it } from "vitest";
import { EagainError } from "../src/networking/fetch-backend";
import {
  LocalVirtualNetwork,
  VIRTUAL_NETWORK_ERRNO,
} from "../src/networking/virtual-network";
import type { TcpConnectionPeer, UdpDatagram } from "../src/types";

const POLLIN = 0x0001;
const POLLOUT = 0x0004;
const POLLERR = 0x0008;
const POLLHUP = 0x0010;
const MSG_PEEK = 0x0002;

describe("LocalVirtualNetwork", () => {
  it("resolves bounded legacy numeric IPv4 forms and valid DNS aliases", () => {
    const net = new LocalVirtualNetwork();
    const backend = net.attachMachine({
      id: "server",
      address: [10, 88, 0, 2],
      hostnames: ["example.test", "example.test."],
    });

    expect(Array.from(backend.getaddrinfo("2130706433"))).toEqual([127, 0, 0, 1]);
    expect(Array.from(backend.getaddrinfo("127.1"))).toEqual([127, 0, 0, 1]);
    expect(Array.from(backend.getaddrinfo("127.1.1"))).toEqual([127, 1, 0, 1]);
    expect(Array.from(backend.getaddrinfo("127.0.0.1"))).toEqual([127, 0, 0, 1]);
    expect(Array.from(backend.getaddrinfo("example.test"))).toEqual([10, 88, 0, 2]);
    expect(Array.from(backend.getaddrinfo("example.test."))).toEqual([10, 88, 0, 2]);

    expect(() => backend.getaddrinfo("4294967296")).toThrow("ENOENT");
    expect(() => backend.getaddrinfo("1..2")).toThrow("ENOENT");
    expect(() => backend.getaddrinfo("1.2.3.256")).toThrow("ENOENT");
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

    const revents = client.poll!(7, POLLIN | POLLOUT);
    expect(revents & POLLERR).toBe(POLLERR);
    expect(revents & POLLIN).toBe(POLLIN);
    expect(revents & POLLOUT).toBe(0);
    expect(revents & POLLHUP).toBe(POLLHUP);
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
    const revents = client.poll!(7, POLLIN | POLLOUT);
    expect(revents & POLLIN).toBe(POLLIN);
    expect(revents & POLLOUT).toBe(POLLOUT);
    expect(client.send(7, new TextEncoder().encode("after-fin-one"), 0)).toBe(13);
    expect(client.send(7, new TextEncoder().encode("after-fin-two"), 0)).toBe(13);
    client.close(7);
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
