/**
 * RelayChannel — main-thread half of the WebRTC UDP relay (design §5.1).
 *
 * Owns an open RTCDataChannel and bridges UDP datagrams between the
 * kernel (in a worker) and the remote peer. Inbound channel messages
 * become `kernel.injectDatagram(...)` calls; outbound datagrams from
 * the kernel's `host_send_dgram` import arrive via
 * `kernel.onHostSendDgram(...)` and are framed onto the channel.
 *
 * Wire envelope (design §5.3): 7-byte header + payload.
 *   offset 0   : type (0x01 = UDP_DATAGRAM)
 *   offset 1-2 : srcPort (big-endian u16)
 *   offset 3-4 : reserved (must be 0)
 *   offset 5-6 : dstPort (big-endian u16)
 *   offset 7+  : payload
 *
 * The receiver synthesizes `from_addr` from the configured `peerAddr`,
 * because the channel terminates at exactly one peer.
 */

/** EventTarget-shaped channel surface so the test can drive a mock. */
export interface RelayDataChannel extends EventTarget {
  send(data: ArrayBuffer | ArrayBufferView | string): void;
}

/**
 * Shape of an outbound UDP datagram delivered by `kernel.onHostSendDgram`.
 * Structurally compatible with `BrowserKernel.HostSendDgramEvent`; declared
 * locally so this module doesn't drag in `@host` (keeps the vitest unit
 * test happy with plain relative imports).
 */
export interface RelayOutboundDatagram {
  srcPort: number;
  dstIp: [number, number, number, number];
  dstPort: number;
  data: Uint8Array;
}

/** Minimal slice of `BrowserKernel` the relay depends on (so tests can stub). */
export interface RelayKernel {
  injectDatagram(
    pid: number,
    dstPort: number,
    srcIp: [number, number, number, number],
    srcPort: number,
    data: Uint8Array,
  ): void;
  onHostSendDgram(handler: (event: RelayOutboundDatagram) => void): () => void;
}

export const ENVELOPE_HEADER_LEN = 7;
export const ENVELOPE_TYPE_UDP_DATAGRAM = 0x01;
/**
 * Soft MTU floor for unreliable SCTP DataChannels. WebRTC spec doesn't
 * guarantee a number; 1024 leaves ~15% headroom under the Chromium
 * implementation's ~1200-byte SCTP MTU floor (design §5.5). DOOM packets
 * are < 100 bytes; this is a guardrail, not a real constraint.
 */
export const ENVELOPE_MAX_TOTAL = 1024;

export interface RelayChannelOptions {
  kernel: RelayKernel;
  channel: RelayDataChannel;
  /** This peer's synthetic IPv4 — unused on the wire today; reserved for routing. */
  localAddr: [number, number, number, number];
  /** The remote peer's synthetic IPv4 — used as `from_addr` for inbound datagrams. */
  peerAddr: [number, number, number, number];
}

export class RelayChannel {
  private readonly kernel: RelayKernel;
  private readonly channel: RelayDataChannel;
  private readonly peerAddr: [number, number, number, number];
  private readonly inboundListener: (e: Event) => void;
  private readonly unsubscribeOutbound: () => void;
  private targetPid: number | null = null;
  private closed = false;

  constructor(opts: RelayChannelOptions) {
    this.kernel = opts.kernel;
    this.channel = opts.channel;
    this.peerAddr = opts.peerAddr;
    void opts.localAddr; // reserved for future per-iface routing

    this.inboundListener = (e: Event) => this.handleInbound(e as MessageEvent);
    this.channel.addEventListener("message", this.inboundListener);
    this.unsubscribeOutbound = this.kernel.onHostSendDgram((ev) => this.handleOutbound(ev));
  }

  /**
   * Set the kernel pid that owns the bound DGRAM socket. Inbound
   * datagrams arriving before this is set are dropped (the program
   * hasn't spawned yet — there is no socket to inject into).
   */
  setTargetPid(pid: number): void {
    this.targetPid = pid;
  }

  /** Detach all listeners; further inbound/outbound traffic is ignored. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.channel.removeEventListener("message", this.inboundListener);
    this.unsubscribeOutbound();
  }

  private handleInbound(e: MessageEvent): void {
    if (this.closed) return;
    const pid = this.targetPid;
    if (pid === null) return;

    const data = toUint8Array(e.data);
    if (!data || data.length < ENVELOPE_HEADER_LEN) return;
    if (data[0] !== ENVELOPE_TYPE_UDP_DATAGRAM) return;

    const srcPort = (data[1] << 8) | data[2];
    // bytes 3-4 reserved
    const dstPort = (data[5] << 8) | data[6];
    const payload = data.subarray(ENVELOPE_HEADER_LEN);

    this.kernel.injectDatagram(pid, dstPort, this.peerAddr, srcPort, payload);
  }

  private handleOutbound(ev: RelayOutboundDatagram): void {
    if (this.closed) return;
    // `dstIp` is implicit in v1: the channel terminates at peerAddr. Future
    // mesh routing will dispatch on dstIp; for now we just forward.
    void ev.dstIp;

    const total = ENVELOPE_HEADER_LEN + ev.data.length;
    if (total > ENVELOPE_MAX_TOTAL) {
      console.warn(
        `[relay-channel] outbound envelope ${total} exceeds soft MTU ${ENVELOPE_MAX_TOTAL}; sending anyway`,
      );
    }

    const envelope = new Uint8Array(total);
    envelope[0] = ENVELOPE_TYPE_UDP_DATAGRAM;
    envelope[1] = (ev.srcPort >>> 8) & 0xff;
    envelope[2] = ev.srcPort & 0xff;
    envelope[3] = 0;
    envelope[4] = 0;
    envelope[5] = (ev.dstPort >>> 8) & 0xff;
    envelope[6] = ev.dstPort & 0xff;
    envelope.set(ev.data, ENVELOPE_HEADER_LEN);

    try {
      this.channel.send(envelope);
    } catch (e) {
      // Channel closed mid-send; UDP is best-effort, just drop.
      console.warn("[relay-channel] channel.send failed:", e);
    }
  }
}

function toUint8Array(raw: unknown): Uint8Array | null {
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (ArrayBuffer.isView(raw)) {
    return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  }
  return null;
}
