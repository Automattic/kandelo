import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  answerPeerConnectionInvite,
  createPeerConnectionInvite,
  decodePeerSignal,
  encodePeerSignal,
  type PeerConnectionDeclaration,
} from "../src/peer-connection";

class FakeChannel extends EventTarget {
  binaryType = "arraybuffer";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  readyState = "connecting";
  readonly ordered: boolean;
  readonly maxRetransmits: number | null;
  readonly maxPacketLifeTime: number | null;
  readonly protocol: string;
  constructor(readonly label: string, options: RTCDataChannelInit = {}) {
    super();
    this.ordered = options.ordered ?? true;
    this.maxRetransmits = options.maxRetransmits ?? null;
    this.maxPacketLifeTime = options.maxPacketLifeTime ?? null;
    this.protocol = options.protocol ?? "";
  }
  send() {}
  open() { this.readyState = "open"; this.dispatchEvent(new Event("open")); }
  close() {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
  }
}

class FakeConnection extends EventTarget {
  static instances: FakeConnection[] = [];
  iceGatheringState = "complete";
  connectionState = "new";
  localDescription: RTCSessionDescriptionInit | null = null;
  channels: FakeChannel[] = [];
  constructor(readonly config: RTCConfiguration) {
    super(); FakeConnection.instances.push(this);
  }
  createDataChannel(label: string, options?: RTCDataChannelInit) {
    const channel = new FakeChannel(label, options);
    this.channels.push(channel);
    return channel;
  }
  async createOffer() { return { type: "offer", sdp: "v=0\r\n" }; }
  async createAnswer() { return { type: "answer", sdp: "v=0\r\n" }; }
  async setLocalDescription(description: RTCSessionDescriptionInit) { this.localDescription = description; }
  async setRemoteDescription() {}
  arrive(channel: FakeChannel) {
    const event = new Event("datachannel");
    Object.assign(event, { channel });
    this.dispatchEvent(event);
  }
  fail() { this.connectionState = "failed"; this.dispatchEvent(new Event("connectionstatechange")); }
  close() { this.connectionState = "closed"; this.dispatchEvent(new Event("connectionstatechange")); }
}

const network: PeerConnectionDeclaration = {
  purpose: "network",
  channels: [{ label: "udp", options: { ordered: false, maxRetransmits: 0 } }],
  iceServers: [],
};
const migration: PeerConnectionDeclaration = {
  purpose: "migration", channels: [{ label: "handover", chunking: {} }],
};
const offer = (declaration = network) => encodePeerSignal({ type: "offer", sdp: "v=0\r\n" }, declaration);
const answer = (declaration = network) => encodePeerSignal({ type: "answer", sdp: "v=0\r\n" }, declaration);

beforeEach(() => {
  FakeConnection.instances = [];
  vi.stubGlobal("RTCPeerConnection", FakeConnection);
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("purpose-checked peer signalling", () => {
  it("round-trips the SDP and rejects a different purpose before allocating RTC", async () => {
    expect(decodePeerSignal(offer(), network, "offer")).toEqual({ type: "offer", sdp: "v=0\r\n" });
    await expect(answerPeerConnectionInvite(offer(migration), network)).rejects.toThrow("for migration, expected network");
    expect(FakeConnection.instances).toHaveLength(0);
  });
  it("rejects mismatched labels before waiting for channels", async () => {
    await expect(answerPeerConnectionInvite(offer(), { ...network, channels: [{ label: "other" }] })).rejects.toThrow("different peer channel set");
    expect(FakeConnection.instances).toHaveLength(0);
  });
  it("rejects an answer supplied as an offer", () => {
    expect(() => decodePeerSignal(answer(), network, "offer")).toThrow("must contain a offer");
  });
  it.each(["random", "kandelo1:!", "kandelo1:" + btoa("null"), "kandelo1:" + btoa("{}")])("rejects malformed code %s", (code) => {
    expect(() => decodePeerSignal(code, network, "offer")).toThrow();
  });
  it("bounds codes and rejects old envelopes without a purpose", () => {
    expect(() => decodePeerSignal("kandelo1:" + "a".repeat(65536), network, "offer")).toThrow("bounded");
    expect(() => decodePeerSignal("kandelo1:" + btoa(JSON.stringify({ type: "offer", sdp: "v=0" })), network, "offer")).toThrow("expected network");
    expect(() => encodePeerSignal({ type: "offer", sdp: "a".repeat(65536) }, network)).toThrow("64 KiB");
  });
  it("keeps chunking on reliable ordered channels", async () => {
    await expect(createPeerConnectionInvite({ purpose: "network", channels: [{ ...network.channels[0], chunking: {} }] })).rejects.toThrow("ordered, reliable");
    await expect(createPeerConnectionInvite({ purpose: "network", channels: [{ label: "udp", options: { negotiated: true } }] })).rejects.toThrow("in-band");
  });
});

describe("peer channel lifecycle", () => {
  it("opens declared raw datagram channels and reports close once", async () => {
    const invite = await createPeerConnectionInvite(network);
    const rtc = FakeConnection.instances[0];
    expect(rtc.config.iceServers).toEqual([]);
    const pending = invite.acceptAnswer(answer());
    rtc.channels[0].open();
    const link = await pending;
    expect(link.channels.get("udp")).toBe(rtc.channels[0]);
    expect(link.messages.size).toBe(0);
    const closed = vi.fn(); link.onClose(closed);
    link.close(); link.close();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(rtc.connectionState).toBe("closed");
  });
  it("wraps the reliable consumer's channels", async () => {
    const invite = await createPeerConnectionInvite(migration);
    const rtc = FakeConnection.instances[0];
    const pending = invite.acceptAnswer(answer(migration));
    rtc.channels[0].open();
    const link = await pending;
    expect(link.messages.has("handover")).toBe(true);
    link.close();
  });
  it("cancels a join before its declared channels arrive", async () => {
    const join = await answerPeerConnectionInvite(offer(), network);
    join.cancel();
    await expect(join.connected).rejects.toThrow("closed before connecting");
  });
  it("reports ICE failure while waiting for channel arrival", async () => {
    const join = await answerPeerConnectionInvite(offer(), network);
    FakeConnection.instances[0].fail();
    await expect(join.connected).rejects.toThrow("no direct route");
  });
  it("rejects undeclared and incorrectly configured incoming channels", async () => {
    const join = await answerPeerConnectionInvite(offer(), network);
    FakeConnection.instances[0].arrive(new FakeChannel("udp"));
    await expect(join.connected).rejects.toThrow("delivery settings");
    const second = await answerPeerConnectionInvite(offer(), network);
    FakeConnection.instances[1].arrive(new FakeChannel("surprise"));
    await expect(second.connected).rejects.toThrow("undeclared");
  });
  it("reports failure and closes every established channel", async () => {
    const join = await answerPeerConnectionInvite(offer(), network);
    const rtc = FakeConnection.instances[0];
    const channel = new FakeChannel("udp", network.channels[0].options);
    rtc.arrive(channel); channel.open();
    const link = await join.connected;
    const failed = vi.fn(); link.onFailure(failed);
    rtc.fail();
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("no direct route") }));
    expect(channel.readyState).toBe("closed");
  });
  it("bounds absent channel arrival after ICE connects", async () => {
    vi.useFakeTimers();
    const join = await answerPeerConnectionInvite(offer(), network);
    const rtc = FakeConnection.instances[0];
    rtc.connectionState = "connected";
    rtc.dispatchEvent(new Event("connectionstatechange"));
    const rejection = expect(join.connected).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(30_000);
    await rejection;
    expect(FakeConnection.instances[0].connectionState).toBe("closed");
  });
  it("allows the manual answer exchange to outlast the channel deadline", async () => {
    vi.useFakeTimers();
    const join = await answerPeerConnectionInvite(offer(), network);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeConnection.instances[0].connectionState).toBe("new");
    join.cancel();
    await expect(join.connected).rejects.toThrow("closed before connecting");
  });
});
