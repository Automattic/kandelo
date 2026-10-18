import { MessageChannel } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteSegmentRuntime, SessionNetwork } from "../src/networking/remote-segment-runtime";
import type { NetworkIO, UdpDatagram } from "../src/types";

const runtimes: RemoteSegmentRuntime[] = [];
afterEach(() => { for (const runtime of runtimes.splice(0)) runtime.close(); });
const ip = (id: number) => new Uint8Array([10, 89, 0, id]);
const any = new Uint8Array(4);
const errnoOf = (run: () => unknown) => { try { run(); return 0; } catch (error) { return (error as { errno?: number }).errno; } };

function machine(fallback?: NetworkIO) {
  const runtime = new RemoteSegmentRuntime(); runtimes.push(runtime);
  return { runtime, network: runtime.install(fallback) as SessionNetwork };
}
/** Connect a running joiner to a running host, as the browser bridge does. */
async function link(host: RemoteSegmentRuntime, joiner: RemoteSegmentRuntime) {
  const { port1, port2 } = new MessageChannel();
  const joined = joiner.join({ port: port2, maxPayload: 65507, maxControlBytes: 65536 });
  const id = host.attachPeer({ port: port1, maxPayload: 65507, maxControlBytes: 65536 });
  return { id, address: await joined };
}
function receiver() {
  const received: UdpDatagram[] = [];
  return { received, target: { receive: (datagram: UdpDatagram) => { received.push(datagram); return 0; } } };
}

describe("a machine's session network without a session", () => {
  it("behaves as an absent network when it wraps no backend", () => {
    const { network } = machine();
    expect(network.localAddress).toBeUndefined();
    expect(errnoOf(() => network.connect(1, ip(1), 80))).toBe(111);
    expect(network.connectStatus(1)).toBe(107);
    expect(errnoOf(() => network.recv(1, 8, 0))).toBe(107);
    expect(errnoOf(() => network.getaddrinfo("host"))).toBe(2);
    expect(network.bindUdp("a", any, 9000, receiver().target)).toBe(0);
    expect(network.bindUdp("b", ip(1), 9001, receiver().target)).toBe(99);
    expect(network.sendDatagram({ srcAddr: any, srcPort: 1, dstAddr: ip(1), dstPort: 9000, data: new Uint8Array(1) })).toBe(101);
    expect(network.udpSourceAddress(ip(1))).toBe(101);
  });

  it("delegates everything outside the session subnet to the wrapped backend", () => {
    const calls: string[] = [];
    const fallback: NetworkIO = {
      localAddress: new Uint8Array([192, 0, 2, 7]),
      connect: (handle) => { calls.push(`connect ${handle}`); },
      connectStatus: () => 0,
      send: (_handle, data) => data.length,
      recv: () => new Uint8Array([1]),
      close: (handle) => { calls.push(`close ${handle}`); },
      getaddrinfo: () => new Uint8Array([192, 0, 2, 9]),
    };
    const { network } = machine(fallback);
    network.connect(4, new Uint8Array([192, 0, 2, 9]), 443);
    expect(network.send(4, new Uint8Array(3), 0)).toBe(3);
    network.close(4);
    expect(calls).toEqual(["connect 4", "close 4"]);
    expect(Array.from(network.localAddress!)).toEqual([192, 0, 2, 7]);
    expect(Array.from(network.getaddrinfo("example.org"))).toEqual([192, 0, 2, 9]);
  });
});

describe("network sessions on running machines", () => {
  it("hosts, then assigns a joiner's address while both machines run", async () => {
    const host = machine(); const joiner = machine();
    expect(host.runtime.host()).toBe("10.89.0.1");
    expect(host.runtime.snapshot().state).toBe("hosting");
    const { address } = await link(host.runtime, joiner.runtime);
    expect(address).toBe("10.89.0.2");
    expect(Array.from(joiner.network.localAddress!)).toEqual([10, 89, 0, 2]);
    expect(joiner.runtime.snapshot()).toMatchObject({ state: "joined", address: "10.89.0.2" });
    expect(Array.from(joiner.network.getaddrinfo("host"))).toEqual([10, 89, 0, 1]);
  });

  it("delivers to a wildcard UDP socket bound before the session started", async () => {
    const host = machine(); const joiner = machine();
    const early = receiver();
    expect(joiner.network.bindUdp("1:3", any, 9000, early.target)).toBe(0);
    host.runtime.host();
    await link(host.runtime, joiner.runtime);
    await vi.waitFor(() => expect(host.runtime.snapshot().bindings).toEqual([expect.objectContaining({ address: "10.89.0.2", port: 9000 })]));
    expect(host.network.sendDatagram({ srcAddr: ip(1), srcPort: 40000, dstAddr: ip(2), dstPort: 9000, data: new Uint8Array([7]) })).toBe(0);
    await vi.waitFor(() => expect(early.received).toHaveLength(1));
    expect(Array.from(early.received[0].srcAddr)).toEqual([10, 89, 0, 1]);
  });

  it("removes the address on leave and keeps wildcard sockets for the next session", async () => {
    const host = machine(); const joiner = machine();
    const socket = receiver();
    joiner.network.bindUdp("1:3", any, 9000, socket.target);
    host.runtime.host();
    await link(host.runtime, joiner.runtime);
    joiner.runtime.leave();
    expect(joiner.network.localAddress).toBeUndefined();
    expect(joiner.runtime.snapshot()).toMatchObject({ state: "offline", address: null, members: [] });
    await vi.waitFor(() => expect(host.runtime.snapshot().members).toHaveLength(1));
    // Rejoining gets a new address; the same wildcard socket hears it.
    const again = await link(host.runtime, joiner.runtime);
    expect(again.address).toBe("10.89.0.3");
    await vi.waitFor(() => expect(host.runtime.snapshot().bindings).toEqual([expect.objectContaining({ address: "10.89.0.3", port: 9000 })]));
    host.network.sendDatagram({ srcAddr: ip(1), srcPort: 40000, dstAddr: ip(3), dstPort: 9000, data: new Uint8Array([8]) });
    await vi.waitFor(() => expect(socket.received).toHaveLength(1));
  });

  it("ends the session for a joiner when its host leaves, and says so", async () => {
    const host = machine(); const joiner = machine();
    host.runtime.host();
    await link(host.runtime, joiner.runtime);
    host.runtime.leave();
    await vi.waitFor(() => expect(joiner.runtime.snapshot().state).toBe("offline"));
    expect(joiner.runtime.snapshot().lastDisconnect).toMatch(/closed/);
    expect(joiner.network.localAddress).toBeUndefined();
  });

  it("resets a session stream when the session ends under it", async () => {
    const host = machine(); const joiner = machine();
    host.runtime.host();
    await link(host.runtime, joiner.runtime);
    joiner.network.connect(9, ip(1), 7000);
    joiner.runtime.leave();
    expect(joiner.network.connectStatus(9)).toBe(104);
    expect(errnoOf(() => joiner.network.send(9, new Uint8Array(1), 0))).toBe(104);
    joiner.network.close(9);
    expect(joiner.network.connectStatus(9)).toBe(107);
  });

  it("refuses a second session and joining while hosting", async () => {
    const host = machine();
    host.runtime.host();
    expect(() => host.runtime.host()).toThrow(/already/);
    const { port2 } = new MessageChannel();
    await expect(host.runtime.join({ port: port2, maxPayload: 65507, maxControlBytes: 65536 })).rejects.toThrow(/already/);
  });

  it("admits up to 32 computers in one session", async () => {
    const host = machine();
    host.runtime.host();
    const addresses: string[] = [];
    for (let index = 0; index < 31; index++) addresses.push((await link(host.runtime, machine().runtime)).address);
    expect(addresses.at(-1)).toBe("10.89.0.32");
    expect(host.runtime.snapshot().members).toHaveLength(32);
    const { port1 } = new MessageChannel();
    expect(() => host.runtime.attachPeer({ port: port1, maxPayload: 65507, maxControlBytes: 65536 })).toThrow(/full/);
  });

  it("broadcasts to every member with a wildcard socket on the port, never echoing", async () => {
    const host = machine(); const first = machine(); const second = machine();
    host.runtime.host();
    await link(host.runtime, first.runtime);
    await link(host.runtime, second.runtime);
    const sockets = [host, first, second].map((each) => { const socket = receiver(); each.network.bindUdp("1:3", any, 2342, socket.target); return socket; });
    const pinned = receiver();
    second.network.bindUdp("1:4", ip(3), 2343, pinned.target);
    await vi.waitFor(() => expect(host.runtime.snapshot().bindings).toHaveLength(4));
    await vi.waitFor(() => expect(first.runtime.snapshot().bindings).toHaveLength(4));
    const broadcast = new Uint8Array([255, 255, 255, 255]);

    // A joiner's broadcast: its own copy locally, the others through the host.
    expect(first.network.sendDatagram({ srcAddr: any, srcPort: 40000, dstAddr: broadcast, dstPort: 2342, data: new Uint8Array([1]) })).toBe(0);
    await vi.waitFor(() => { for (const socket of sockets) expect(socket.received).toHaveLength(1); });
    for (const socket of sockets) {
      expect(Array.from(socket.received[0].srcAddr)).toEqual([10, 89, 0, 2]);
      expect(Array.from(socket.received[0].dstAddr)).toEqual([255, 255, 255, 255]);
    }

    // The host's broadcast reaches itself and both joiners.
    expect(host.network.sendDatagram({ srcAddr: any, srcPort: 40000, dstAddr: broadcast, dstPort: 2342, data: new Uint8Array([2]) })).toBe(0);
    await vi.waitFor(() => { for (const socket of sockets) expect(socket.received).toHaveLength(2); });
    // A socket bound to a unicast address does not hear broadcasts.
    host.network.sendDatagram({ srcAddr: any, srcPort: 40000, dstAddr: broadcast, dstPort: 2343, data: new Uint8Array([3]) });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pinned.received).toHaveLength(0);
    expect(sockets.map((socket) => socket.received.length)).toEqual([2, 2, 2]);
  });

  it("meters each member's broadcasts at the forwarding host and counts the drops", async () => {
    const host = machine(); const joiner = machine();
    host.runtime.host();
    await link(host.runtime, joiner.runtime);
    const heard = receiver();
    host.network.bindUdp("1:3", any, 26000, heard.target);
    await vi.waitFor(() => expect(joiner.runtime.snapshot().bindings).toHaveLength(1));
    for (let index = 0; index < 100; index++) {
      joiner.network.sendDatagram({ srcAddr: any, srcPort: 40000, dstAddr: new Uint8Array([255, 255, 255, 255]), dstPort: 26000, data: new Uint8Array([index]) });
    }
    await vi.waitFor(() => expect(heard.received.length + host.runtime.snapshot().droppedBroadcasts).toBe(100));
    expect(heard.received.length).toBeGreaterThanOrEqual(64);
    expect(heard.received.length).toBeLessThan(100);
  });

  it("sends a broadcast nowhere without a session", () => {
    const { network } = machine();
    expect(network.sendDatagram({ srcAddr: any, srcPort: 1, dstAddr: new Uint8Array([255, 255, 255, 255]), dstPort: 2342, data: new Uint8Array(1) })).toBe(101);
  });
});
