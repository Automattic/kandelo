import { describe, expect, it } from "vitest";
import { FetchNetworkBackend } from "../src/networking/fetch-backend";
import { TcpNetworkBackend } from "../src/networking/tcp-backend";
import { TlsNetworkBackend } from "../src/networking/tls-network-backend";
import type { NetworkIO } from "../src/types";

const receiver = { receive: () => 0 };
const backends: [string, () => NetworkIO][] = [
  ["browser fetch", () => new FetchNetworkBackend()],
  ["browser TLS", () => new TlsNetworkBackend()],
  ["Node sockets", () => new TcpNetworkBackend()],
];

describe.each(backends)("the %s egress link", (_name, create) => {
  it("is a NAT link the guest owns 10.0.2.15/24 on", () => {
    const network = create();
    expect(Array.from(network.localAddress!)).toEqual([10, 0, 2, 15]);
    expect(Array.from(network.localNetmask!)).toEqual([255, 255, 255, 0]);
    expect(Array.from(network.udpSourceAddress!(new Uint8Array([192, 0, 2, 1])) as Uint8Array)).toEqual([10, 0, 2, 15]);
  });

  it("refuses UDP beyond the machine with EHOSTUNREACH, not a missing route", () => {
    const network = create();
    expect(network.sendDatagram!({ srcAddr: new Uint8Array([10, 0, 2, 15]), srcPort: 4000,
      dstAddr: new Uint8Array([192, 0, 2, 1]), dstPort: 9, data: new Uint8Array(1) })).toBe(113);
  });

  it("lets a socket bind this machine's address or any, and nothing else", () => {
    const network = create();
    expect(network.bindUdp!("a", new Uint8Array(4), 9000, receiver)).toBe(0);
    expect(network.bindUdp!("b", new Uint8Array([10, 0, 2, 15]), 9001, receiver)).toBe(0);
    expect(network.bindUdp!("c", new Uint8Array([10, 0, 2, 16]), 9002, receiver)).toBe(99);
  });
});

describe("fetch-backed streams", () => {
  it("report this machine's side of the NAT from getsockname", () => {
    const network = new FetchNetworkBackend();
    const remote = network.getaddrinfo("example.com");
    network.connect(1, remote, 80);
    network.connect(2, remote, 80, { addr: new Uint8Array([10, 0, 2, 15]), port: 40000 });
    const first = network.localEndpoint!(1);
    expect(Array.from(first.addr)).toEqual([10, 0, 2, 15]);
    expect(first.port).toBeGreaterThanOrEqual(49152);
    expect(network.localEndpoint!(2).port).toBe(40000);
    network.close(1);
    expect(() => network.localEndpoint!(1)).toThrow();
    expect(() => network.connect(3, remote, 80, { addr: new Uint8Array([192, 0, 2, 9]), port: 0 })).toThrow(/EADDRNOTAVAIL/);
  });
});
