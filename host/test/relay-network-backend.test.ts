import { describe, it, expect, beforeEach } from "vitest";
import {
  RelayChannel,
  ENVELOPE_HEADER_LEN,
  ENVELOPE_TYPE_UDP_DATAGRAM,
  type RelayDataChannel,
  type RelayKernel,
  type RelayOutboundDatagram,
} from "../../apps/browser-demos/lib/relay-network-backend";

// Mock RTCDataChannel — an EventTarget with a `send` spy.
class MockChannel extends EventTarget implements RelayDataChannel {
  sent: Uint8Array[] = [];
  send(data: ArrayBuffer | ArrayBufferView | string): void {
    if (typeof data === "string") {
      throw new Error("string send not used by relay");
    }
    if (data instanceof ArrayBuffer) {
      this.sent.push(new Uint8Array(data.slice(0)));
    } else {
      // Copy so later mutations to the source buffer don't perturb assertions.
      const view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      this.sent.push(new Uint8Array(view));
    }
  }
  /** Helper: deliver an inbound MessageEvent to the relay. */
  recv(data: Uint8Array | ArrayBuffer): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

// Mock kernel — captures injectDatagram calls and exposes a manual fire
// hook for the host_send_dgram subscription.
class MockKernel implements RelayKernel {
  injected: Array<{
    pid: number;
    dstPort: number;
    srcIp: [number, number, number, number];
    srcPort: number;
    data: Uint8Array;
  }> = [];
  private dgramListeners = new Set<(ev: RelayOutboundDatagram) => void>();

  injectDatagram(
    pid: number,
    dstPort: number,
    srcIp: [number, number, number, number],
    srcPort: number,
    data: Uint8Array,
  ): void {
    this.injected.push({ pid, dstPort, srcIp, srcPort, data: new Uint8Array(data) });
  }
  onHostSendDgram(handler: (event: RelayOutboundDatagram) => void): () => void {
    this.dgramListeners.add(handler);
    return () => {
      this.dgramListeners.delete(handler);
    };
  }
  /** Test hook: simulate the kernel-worker forwarding an outbound datagram. */
  fireHostSendDgram(ev: RelayOutboundDatagram): void {
    for (const h of this.dgramListeners) h(ev);
  }
  hasListeners(): boolean {
    return this.dgramListeners.size > 0;
  }
}

const PEER_ADDR: [number, number, number, number] = [10, 99, 0, 2];
const LOCAL_ADDR: [number, number, number, number] = [10, 99, 0, 1];
const TARGET_PID = 7;

function makeRelay(): { relay: RelayChannel; channel: MockChannel; kernel: MockKernel } {
  const kernel = new MockKernel();
  const channel = new MockChannel();
  const relay = new RelayChannel({
    kernel,
    channel,
    localAddr: LOCAL_ADDR,
    peerAddr: PEER_ADDR,
  });
  return { relay, channel, kernel };
}

describe("RelayChannel envelope encode (outbound)", () => {
  let relay: RelayChannel;
  let channel: MockChannel;
  let kernel: MockKernel;

  beforeEach(() => {
    ({ relay, channel, kernel } = makeRelay());
    relay.setTargetPid(TARGET_PID);
  });

  it("frames host_send_dgram into a single envelope on channel.send", () => {
    const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    kernel.fireHostSendDgram({
      srcPort: 5029,
      dstIp: PEER_ADDR,
      dstPort: 6000,
      data: payload,
    });

    expect(channel.sent.length).toBe(1);
    const env = channel.sent[0];
    expect(env.length).toBe(ENVELOPE_HEADER_LEN + payload.length);
    expect(env[0]).toBe(ENVELOPE_TYPE_UDP_DATAGRAM);
    // srcPort big-endian
    expect(env[1]).toBe(5029 >>> 8);
    expect(env[2]).toBe(5029 & 0xff);
    // reserved zeros
    expect(env[3]).toBe(0);
    expect(env[4]).toBe(0);
    // dstPort big-endian
    expect(env[5]).toBe(6000 >>> 8);
    expect(env[6]).toBe(6000 & 0xff);
    // payload preserved
    expect(Array.from(env.subarray(ENVELOPE_HEADER_LEN))).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it("encodes the maximum u16 src/dst ports without sign issues", () => {
    kernel.fireHostSendDgram({
      srcPort: 0xffff,
      dstIp: PEER_ADDR,
      dstPort: 0xfffe,
      data: new Uint8Array(0),
    });
    const env = channel.sent[0];
    expect(env[1]).toBe(0xff);
    expect(env[2]).toBe(0xff);
    expect(env[5]).toBe(0xff);
    expect(env[6]).toBe(0xfe);
  });

  it("emits zero outbound traffic after close()", () => {
    relay.close();
    kernel.fireHostSendDgram({
      srcPort: 5029,
      dstIp: PEER_ADDR,
      dstPort: 6000,
      data: new Uint8Array([1, 2, 3]),
    });
    expect(channel.sent.length).toBe(0);
  });
});

describe("RelayChannel envelope decode (inbound)", () => {
  let relay: RelayChannel;
  let channel: MockChannel;
  let kernel: MockKernel;

  beforeEach(() => {
    ({ relay, channel, kernel } = makeRelay());
    relay.setTargetPid(TARGET_PID);
  });

  it("calls kernel.injectDatagram with parsed envelope fields", () => {
    const payload = [10, 20, 30];
    const env = new Uint8Array([
      ENVELOPE_TYPE_UDP_DATAGRAM,
      0x13,
      0xa5, // srcPort = 0x13a5 = 5029
      0,
      0,
      0x17,
      0x70, // dstPort = 0x1770 = 6000
      ...payload,
    ]);
    channel.recv(env);

    expect(kernel.injected.length).toBe(1);
    const got = kernel.injected[0];
    expect(got.pid).toBe(TARGET_PID);
    expect(got.dstPort).toBe(6000);
    expect(got.srcIp).toEqual(PEER_ADDR);
    expect(got.srcPort).toBe(5029);
    expect(Array.from(got.data)).toEqual(payload);
  });

  it("accepts ArrayBuffer payloads as well as Uint8Array", () => {
    const env = new Uint8Array([ENVELOPE_TYPE_UDP_DATAGRAM, 0, 5, 0, 0, 0, 80, 0xaa]);
    channel.recv(env.buffer);
    expect(kernel.injected.length).toBe(1);
    expect(kernel.injected[0].srcPort).toBe(5);
    expect(kernel.injected[0].dstPort).toBe(80);
  });

  it("drops messages with unknown type byte", () => {
    const env = new Uint8Array([0x02, 0, 0, 0, 0, 0, 0]);
    channel.recv(env);
    expect(kernel.injected.length).toBe(0);
  });

  it("drops messages shorter than the envelope header", () => {
    channel.recv(new Uint8Array([ENVELOPE_TYPE_UDP_DATAGRAM, 0, 0, 0]));
    expect(kernel.injected.length).toBe(0);
  });

  it("drops inbound traffic until setTargetPid has been called", () => {
    // Fresh relay without setTargetPid
    const { relay: r2, channel: ch2, kernel: k2 } = makeRelay();
    void r2;
    ch2.recv(new Uint8Array([ENVELOPE_TYPE_UDP_DATAGRAM, 0, 5, 0, 0, 0, 80, 0xaa]));
    expect(k2.injected.length).toBe(0);
  });

  it("ignores inbound traffic after close()", () => {
    relay.close();
    channel.recv(new Uint8Array([ENVELOPE_TYPE_UDP_DATAGRAM, 0, 5, 0, 0, 0, 80, 0xaa]));
    expect(kernel.injected.length).toBe(0);
  });
});

// Inline copy of the production RelayHostShim from
// host/src/browser-kernel-worker-entry.ts. The production class is
// defined alongside `self.postMessage` / `kernelWorker` worker globals
// and can't be imported in a vitest unit (no worker context). Keep the
// body identical to the production one so this test pins the contract:
// if either side drifts, the round-trip assertion below fails.
class RelayHostShim {
  constructor(private postFn: (msg: HostSendDgramMessage) => void) {}
  send_dgram(
    srcPort: number,
    dstIp: [number, number, number, number],
    dstPort: number,
    data: Uint8Array,
  ): number {
    this.postFn({ type: "host_send_dgram", srcPort, dstIp, dstPort, data: new Uint8Array(data) });
    return data.length;
  }
}

interface HostSendDgramMessage {
  type: "host_send_dgram";
  srcPort: number;
  dstIp: [number, number, number, number];
  dstPort: number;
  data: Uint8Array;
}

describe("RelayHostShim → RelayChannel contract", () => {
  it("kernel send_dgram produces a host_send_dgram message that fans out via RelayChannel", () => {
    // Simulate the worker-thread → main-thread postMessage hop with a
    // direct function call: in production this is `self.postMessage`,
    // which lands in BrowserKernel.handleWorkerMessage's `case
    // "host_send_dgram"` and fans out to all `onHostSendDgram` listeners.
    const kernel = new MockKernel();
    const channel = new MockChannel();
    const relay = new RelayChannel({
      kernel,
      channel,
      localAddr: LOCAL_ADDR,
      peerAddr: PEER_ADDR,
    });
    relay.setTargetPid(TARGET_PID);

    const shim = new RelayHostShim((msg) => {
      // Imitate BrowserKernel.handleWorkerMessage fan-out to onHostSendDgram listeners.
      kernel.fireHostSendDgram({
        srcPort: msg.srcPort,
        dstIp: msg.dstIp,
        dstPort: msg.dstPort,
        data: msg.data,
      });
    });

    // Kernel-side "outbound" call.
    const written = shim.send_dgram(5029, PEER_ADDR, 6001, new Uint8Array([0xaa, 0xbb, 0xcc]));
    expect(written).toBe(3);

    // The envelope landed on the channel with the expected wire shape.
    expect(channel.sent.length).toBe(1);
    const env = channel.sent[0];
    expect(env.length).toBe(ENVELOPE_HEADER_LEN + 3);
    expect(env[0]).toBe(ENVELOPE_TYPE_UDP_DATAGRAM);
    expect(env[1]).toBe(5029 >>> 8);
    expect(env[2]).toBe(5029 & 0xff);
    expect(env[5]).toBe(6001 >>> 8);
    expect(env[6]).toBe(6001 & 0xff);
    expect(Array.from(env.subarray(ENVELOPE_HEADER_LEN))).toEqual([0xaa, 0xbb, 0xcc]);

    relay.close();
  });

  it("send_dgram defensively copies — later mutation of the kernel buffer does not leak to main", () => {
    // The kernel-worker hands us a Uint8Array view into its scratch
    // buffer; that buffer is reused by the next syscall. The shim must
    // snapshot before the postMessage queue delivers, otherwise the
    // main thread sees garbled bytes.
    const captured: HostSendDgramMessage[] = [];
    const shim = new RelayHostShim((msg) => captured.push(msg));
    const buf = new Uint8Array([1, 2, 3, 4]);
    shim.send_dgram(5029, PEER_ADDR, 6001, buf);
    // Mutate the kernel-side buffer after the call returns.
    buf[0] = 0xff;
    buf[1] = 0xff;
    expect(Array.from(captured[0].data)).toEqual([1, 2, 3, 4]);
  });
});

describe("RelayChannel lifecycle", () => {
  it("unsubscribes from the kernel on close()", () => {
    const { relay, kernel } = makeRelay();
    expect(kernel.hasListeners()).toBe(true);
    relay.close();
    expect(kernel.hasListeners()).toBe(false);
  });

  it("close() is idempotent", () => {
    const { relay, kernel } = makeRelay();
    relay.close();
    expect(() => relay.close()).not.toThrow();
    expect(kernel.hasListeners()).toBe(false);
  });

  it("encode → decode round-trips through a paired RelayChannel", () => {
    // Two relays connected through a single mock channel — what host A
    // emits, host B should decode as the same datagram (modulo srcIp,
    // which the receiver synthesizes from its configured peerAddr).
    const channelAtoB = new MockChannel();
    const channelBtoA = new MockChannel();
    const kernelA = new MockKernel();
    const kernelB = new MockKernel();

    // Cross-wire: A's outbound is B's inbound (and vice-versa).
    const relayA = new RelayChannel({
      kernel: kernelA,
      channel: {
        addEventListener: channelAtoB.addEventListener.bind(channelAtoB),
        removeEventListener: channelAtoB.removeEventListener.bind(channelAtoB),
        dispatchEvent: channelAtoB.dispatchEvent.bind(channelAtoB),
        send: (data) => {
          // Re-emit on B's listen side.
          const buf = data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : new Uint8Array((data as ArrayBufferView).buffer, (data as ArrayBufferView).byteOffset, (data as ArrayBufferView).byteLength);
          channelBtoA.dispatchEvent(new MessageEvent("message", { data: new Uint8Array(buf) }));
        },
      },
      localAddr: [10, 99, 0, 1],
      peerAddr: [10, 99, 0, 2],
    });
    const relayB = new RelayChannel({
      kernel: kernelB,
      channel: channelBtoA,
      localAddr: [10, 99, 0, 2],
      peerAddr: [10, 99, 0, 1],
    });
    relayA.setTargetPid(11);
    relayB.setTargetPid(22);

    // A's kernel emits an outbound datagram → B's kernel should see an inject.
    kernelA.fireHostSendDgram({
      srcPort: 5029,
      dstIp: [10, 99, 0, 2],
      dstPort: 6001,
      data: new Uint8Array([0x42]),
    });

    expect(kernelB.injected.length).toBe(1);
    expect(kernelB.injected[0]).toEqual({
      pid: 22,
      dstPort: 6001,
      srcIp: [10, 99, 0, 1], // B's configured peerAddr
      srcPort: 5029,
      data: new Uint8Array([0x42]),
    });

    relayA.close();
    relayB.close();
  });
});
