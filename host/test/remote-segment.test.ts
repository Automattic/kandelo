import { MessageChannel } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteVirtualNetwork } from "../src/networking/remote-segment";
import { RemoteSegmentPortTransport, SegmentPortBridge } from "../src/networking/remote-segment-port";
import { decodeRemoteUdp, encodeRemoteUdp, remoteUdpPayloadLimit } from "../src/networking/remote-udp-codec";
import { VIRTUAL_NETWORK_ERRNO } from "../src/networking/virtual-network";
import type { UdpDatagram } from "../src/types";

const owned: { close(): void }[] = [];
afterEach(() => { for (const resource of owned.splice(0).reverse()) resource.close(); });
const ip = (id: number) => new Uint8Array([10, 89, 0, id]);
const any = new Uint8Array(4);
const packet = (from = 1, to = 2, length = 4): UdpDatagram => ({
  srcAddr: ip(from), srcPort: 9000, dstAddr: ip(to), dstPort: 9000,
  data: new Uint8Array(length).fill(42),
});
function pair(maxPayload = 65507) {
  const { port1, port2 } = new MessageChannel();
  const first = new RemoteSegmentPortTransport({ port: port1, maxPayload, maxControlBytes: 65536 });
  const second = new RemoteSegmentPortTransport({ port: port2, maxPayload, maxControlBytes: 65536 });
  owned.push(first, second);
  return { first, second, port1, port2 };
}
async function join(host: RemoteVirtualNetwork, maxPayload?: number) {
  const peer = new RemoteVirtualNetwork("joiner");
  owned.push(peer);
  const transport = pair(maxPayload);
  peer.attachPeer(transport.second);
  const id = host.attachPeer(transport.first);
  await peer.ready;
  return { peer, id, ...transport };
}
function host() {
  const result = new RemoteVirtualNetwork("host"); owned.push(result); return result;
}
async function waitBindings(segment: RemoteVirtualNetwork, count: number) {
  await vi.waitFor(() => expect(segment.snapshot().bindings).toHaveLength(count));
}

describe("remote UDP wire", () => {
  it("uses the negotiated SCTP ceiling and the IPv4 UDP maximum", () => {
    expect(remoteUdpPayloadLimit(0)).toBe(65507);
    expect(remoteUdpPayloadLimit(Infinity)).toBe(65507);
    expect(remoteUdpPayloadLimit(65536)).toBe(65507);
    expect(remoteUdpPayloadLimit(1024)).toBe(1008);
    expect(remoteUdpPayloadLimit(16)).toBe(0);
    expect(() => remoteUdpPayloadLimit(15)).toThrow();
    expect(() => encodeRemoteUdp(packet(1, 2, 1009), 1008)).toThrow("EMSGSIZE");
  });
  it("preserves source and destination, including empty datagrams, in owned storage", () => {
    const original = packet(1, 2, 0);
    const frame = encodeRemoteUdp(original, 65507);
    expect(frame.length).toBe(16);
    expect(decodeRemoteUdp(frame, 65507)).toEqual(original);
    const populated = encodeRemoteUdp(packet(), 65507);
    const decoded = decodeRemoteUdp(populated, 65507);
    populated.fill(0);
    expect(decoded).toEqual(packet());
  });
  it("rejects malformed versions, reserved bytes, truncated or oversized frames", () => {
    for (const offset of [0, 1, 2, 3]) {
      const frame = encodeRemoteUdp(packet(), 65507);
      frame[offset] = 99;
      expect(() => decodeRemoteUdp(frame, 65507)).toThrow();
    }
    expect(() => decodeRemoteUdp(new Uint8Array(15), 65507)).toThrow();
    expect(() => decodeRemoteUdp(encodeRemoteUdp(packet(), 65507), 3)).toThrow();
  });
});

describe("worker-owned remote UDP segment over native Node ports", () => {
  it("selects its actual interface for segment routes and rejects absent external UDP routes", async () => {
    const server = host();
    const { peer } = await join(server);
    expect(server.udpSourceAddress(ip(2))).toEqual(ip(1));
    expect(peer.udpSourceAddress(ip(1))).toEqual(ip(2));
    expect(peer.udpSourceAddress(new Uint8Array([192, 0, 2, 1]))).toBe(101);
  });

  it("assigns stable addresses and hostnames before joiner readiness", async () => {
    const server = host();
    const first = await join(server);
    const second = await join(server);
    expect(first.id).toBe(2); expect(second.id).toBe(3);
    await vi.waitFor(() => expect(first.peer.snapshot().members).toHaveLength(3));
    expect(first.peer.localAddress).toEqual(ip(2));
    expect(second.peer.getaddrinfo("host")).toEqual(ip(1));
    expect(first.peer.getaddrinfo("peer-3")).toEqual(ip(3));
    expect(first.peer.getaddrinfo("10.89.0.3")).toEqual(ip(3));
  });
  it("forwards between two joiners and carries replies from wildcard-bound sockets", async () => {
    const server = host();
    const first = await join(server); const second = await join(server);
    const atFirst: UdpDatagram[] = []; const atSecond: UdpDatagram[] = [];
    expect(first.peer.bindUdp("100:0", any, 9000, { receive: (d) => { atFirst.push(d); return 0; } })).toBe(0);
    expect(second.peer.bindUdp("100:0", any, 9000, { receive: (d) => { atSecond.push(d); return 0; } })).toBe(0);
    await waitBindings(first.peer, 2); await waitBindings(second.peer, 2);
    expect(first.peer.sendDatagram({ ...packet(2, 3), srcAddr: any })).toBe(0);
    await vi.waitFor(() => expect(atSecond).toHaveLength(1));
    expect(atSecond[0]).toEqual(packet(2, 3));
    expect(second.peer.sendDatagram({ ...packet(3, 2), srcAddr: any })).toBe(0);
    await vi.waitFor(() => expect(atFirst).toHaveLength(1));
    expect(atFirst[0]).toEqual(packet(3, 2));
  });
  it("reports the same unknown-host and known-unbound-port errors as LocalVirtualNetwork", async () => {
    const server = host(); const { peer } = await join(server);
    expect(peer.sendDatagram(packet(2, 99))).toBe(VIRTUAL_NETWORK_ERRNO.EHOSTUNREACH);
    expect(peer.sendDatagram(packet(2, 1))).toBe(VIRTUAL_NETWORK_ERRNO.ECONNREFUSED);
    expect(server.sendDatagram(packet(1, 2))).toBe(VIRTUAL_NETWORK_ERRNO.ECONNREFUSED);
    expect(server.sendDatagram(packet(1, 99))).toBe(VIRTUAL_NETWORK_ERRNO.EHOSTUNREACH);
  });
  it("removes advertisements on unbind and on peer teardown", async () => {
    const server = host(); const first = await join(server); const second = await join(server);
    first.peer.bindUdp("socket", any, 9000, { receive: () => 0 });
    await waitBindings(second.peer, 1);
    first.peer.unbindUdp("socket"); await waitBindings(second.peer, 0);
    expect(second.peer.sendDatagram(packet(3, 2))).toBe(111);
    first.peer.close();
    await vi.waitFor(() => expect(second.peer.snapshot().members).toHaveLength(2));
    expect(second.peer.sendDatagram(packet(3, 2))).toBe(113);
    expect(() => second.peer.getaddrinfo("peer-2")).toThrow("ENOENT");
  });
  it("removes a crashed native-port peer's routes and binding advertisements", async () => {
    const server = host(); const first = await join(server); const second = await join(server);
    first.peer.bindUdp("socket", any, 9000, { receive: () => 0 });
    await waitBindings(second.peer, 1);
    first.port2.close();
    await vi.waitFor(() => expect(server.snapshot().members).toHaveLength(2));
    await vi.waitFor(() => expect(second.peer.snapshot().members).toHaveLength(2));
    expect(second.peer.snapshot().bindings).toHaveLength(0);
    expect(second.peer.sendDatagram(packet(3, 2))).toBe(113);
  });
  it("limits a forwarded packet to the smaller destination link", async () => {
    const server = host(); const first = await join(server, 4096); const second = await join(server, 1024);
    second.peer.bindUdp("socket", any, 9000, { receive: () => 0 });
    await waitBindings(first.peer, 1);
    expect(first.peer.sendDatagram(packet(2, 3, 1025))).toBe(90);
    expect(first.peer.sendDatagram(packet(2, 3, 1024))).toBe(0);
  });
  it("refuses forged source ownership and removes the offending ingress peer", async () => {
    const server = host(); const first = await join(server); const second = await join(server);
    expect(first.second.sendDatagram(packet(3, 1))).toBe(0);
    await vi.waitFor(() => expect(server.snapshot().members).toHaveLength(2));
    expect(server.snapshot().members.map((m) => m.address)).toEqual(["10.89.0.1", "10.89.0.3"]);
    await vi.waitFor(() => expect(second.peer.snapshot().members).toHaveLength(2));
  });
  it("refuses a binding for another member's address", async () => {
    const server = host(); const first = await join(server);
    first.second.sendControl({ version: 1, type: "bind", id: "bad", addr: Array.from(ip(1)), port: 9000 });
    await vi.waitFor(() => expect(server.snapshot().members).toHaveLength(1));
    expect(server.snapshot().bindings).toHaveLength(0);
  });
});

describe("bounded native-port bridge", () => {
  it("owns transferred bytes and stops after 128 unreleased frames", async () => {
    const { port1, port2 } = new MessageChannel();
    const sender = new SegmentPortBridge({ port: port1, maxPayload: 65507, maxControlBytes: 65536 });
    const receiver = new SegmentPortBridge({ port: port2, maxPayload: 65507, maxControlBytes: 65536 });
    owned.push(sender, receiver);
    const delivered: Uint8Array[] = []; const releases: (() => void)[] = [];
    receiver.onFrame((_kind, frame, release) => { delivered.push(frame); releases.push(release); });
    const frame = encodeRemoteUdp(packet(), 65507);
    for (let i = 0; i < 128; i++) expect(sender.send("udp", frame)).toBe(true);
    expect(sender.send("udp", frame)).toBe(false);
    expect(frame.byteLength).toBe(20);
    frame.fill(0);
    await vi.waitFor(() => expect(delivered).toHaveLength(128));
    expect(decodeRemoteUdp(delivered[0], 65507)).toEqual(packet());
    releases[0]();
    await vi.waitFor(() => expect(sender.send("udp", encodeRemoteUdp(packet(), 65507))).toBe(true));
  });
  it("also stops at the one MiB byte budget and closes on forged acknowledgements", async () => {
    const { port1, port2 } = new MessageChannel();
    const sender = new SegmentPortBridge({ port: port1, maxPayload: 65507, maxControlBytes: 65536 });
    const receiver = new SegmentPortBridge({ port: port2, maxPayload: 65507, maxControlBytes: 65536 });
    owned.push(sender, receiver);
    receiver.onFrame(() => {});
    const frame = encodeRemoteUdp(packet(1, 2, 65507), 65507);
    for (let i = 0; i < 16; i++) expect(sender.send("udp", frame)).toBe(true);
    expect(sender.send("udp", frame)).toBe(false);
    const closed = vi.fn(); sender.onClose(closed);
    port2.postMessage({ type: "ack", sequence: 999999 });
    await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
    expect(sender.send("udp", frame)).toBe(false);
  });
});
