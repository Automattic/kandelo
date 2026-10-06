import type { UdpDatagram } from "../types";
import {
  MAX_SEGMENT_CONTROL_BYTES,
  type RemoteSegmentControl,
  type RemoteSegmentTransport,
} from "./remote-segment";
import { decodeRemoteUdp, encodeRemoteUdp, IPV4_UDP_MAX_PAYLOAD, REMOTE_UDP_HEADER_BYTES } from "./remote-udp-codec";

/** The native MessagePort methods shared by DOM and node:worker_threads. */
export interface SegmentPort {
  postMessage(value: unknown, transfer?: ArrayBuffer[]): void;
  addEventListener(type: string, listener: (event: any) => void): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
  start(): void;
  close(): void;
}
export interface RemoteSegmentPeer {
  port: SegmentPort;
  maxPayload: number;
  maxControlBytes: number;
}
export type RemoteSegmentInit = { role: "host" } | { role: "joiner"; peer: RemoteSegmentPeer };

const MAX_PENDING_FRAMES = 128;
const MAX_PENDING_BYTES = 1024 * 1024;
type FrameKind = "udp" | "control";
type FrameMessage = { type: FrameKind; sequence: number; frame: Uint8Array };
type PortMessage = FrameMessage | { type: "ack"; sequence: number } | { type: "close"; reason: string };

/**
 * Bound native-port ownership in each direction. Acknowledgements release
 * bridge storage, not remote application delivery. Excess inbound UDP drops.
 */
export class SegmentPortBridge {
  private readonly pending = new Map<number, number>();
  private pendingBytes = 0;
  private nextSequence = 1;
  private closed = false;
  private readonly frameListeners = new Set<(kind: FrameKind, frame: Uint8Array, release: () => void) => void>();
  private readonly closeListeners = new Set<(reason: string) => void>();
  private closeReason = "the segment port closed";
  private readonly handleMessage = (event: { data: unknown }) => {
    if (this.closed) return;
    const message = event.data as PortMessage;
    if (!message || typeof message !== "object") { this.close("invalid segment port message"); return; }
    if (message.type === "close") { this.close(String(message.reason).slice(0, 512), false); return; }
    if (!Number.isSafeInteger(message.sequence) || message.sequence < 1) { this.close("invalid segment port sequence"); return; }
    if (message.type === "ack") {
      const bytes = this.pending.get(message.sequence);
      if (bytes === undefined) { this.close("unknown or duplicate segment port acknowledgement"); return; }
      this.pending.delete(message.sequence); this.pendingBytes -= bytes;
      return;
    }
    const limit = message.type === "udp" ? this.descriptor.maxPayload + REMOTE_UDP_HEADER_BYTES : this.descriptor.maxControlBytes;
    if ((message.type !== "udp" && message.type !== "control") || !(message.frame instanceof Uint8Array)
      || !(message.frame.buffer instanceof ArrayBuffer) || message.frame.byteLength > limit
      || (message.type === "udp" && message.frame.byteLength < REMOTE_UDP_HEADER_BYTES)) {
      this.close("invalid or oversized segment port frame"); return;
    }
    let released = false;
    const release = () => {
      if (released || this.closed) return;
      released = true;
      this.descriptor.port.postMessage({ type: "ack", sequence: message.sequence });
    };
    if (!this.frameListeners.size) { this.close("the segment port has no frame consumer"); return; }
    try {
      for (const listener of [...this.frameListeners]) listener(message.type, message.frame, release);
    } catch (error) { this.close(`segment port frame failed: ${String(error)}`); }
  };
  private readonly handleMessageError = () => this.close("segment port deserialization failed");

  constructor(readonly descriptor: RemoteSegmentPeer) {
    if (!Number.isInteger(descriptor.maxPayload) || descriptor.maxPayload < 0 || descriptor.maxPayload > IPV4_UDP_MAX_PAYLOAD
      || !Number.isInteger(descriptor.maxControlBytes) || descriptor.maxControlBytes < 128
      || descriptor.maxControlBytes > MAX_SEGMENT_CONTROL_BYTES) throw new Error("invalid segment port limits");
    descriptor.port.addEventListener("message", this.handleMessage);
    descriptor.port.addEventListener("messageerror", this.handleMessageError);
    descriptor.port.start();
  }

  send(kind: FrameKind, frame: Uint8Array): boolean {
    const limit = kind === "udp" ? this.descriptor.maxPayload + REMOTE_UDP_HEADER_BYTES : this.descriptor.maxControlBytes;
    if (this.closed || frame.byteLength > limit || this.pending.size >= MAX_PENDING_FRAMES
      || this.pendingBytes + frame.byteLength > MAX_PENDING_BYTES) return false;
    const sequence = this.nextSequence++;
    // Never transfer guest memory, a view's surrounding storage, or an SAB.
    const owned = new Uint8Array(frame);
    this.pending.set(sequence, owned.byteLength); this.pendingBytes += owned.byteLength;
    try {
      this.descriptor.port.postMessage({ type: kind, sequence, frame: owned }, [owned.buffer]);
      return true;
    } catch (error) {
      this.pending.delete(sequence); this.pendingBytes -= frame.byteLength;
      this.close(`segment port send failed: ${String(error)}`); return false;
    }
  }

  onFrame(listener: (kind: FrameKind, frame: Uint8Array, release: () => void) => void): () => void {
    this.frameListeners.add(listener); return () => { this.frameListeners.delete(listener); };
  }
  onClose(listener: (reason: string) => void): () => void {
    if (this.closed) queueMicrotask(() => listener(this.closeReason));
    else this.closeListeners.add(listener);
    return () => { this.closeListeners.delete(listener); };
  }
  close(reason = "the local segment port closed", notify = true): void {
    if (this.closed) return;
    this.closed = true; this.closeReason = reason;
    if (notify) {
      try { this.descriptor.port.postMessage({ type: "close", reason: reason.slice(0, 512) }); } catch { /* the port is already gone */ }
    }
    this.descriptor.port.removeEventListener("message", this.handleMessage);
    this.descriptor.port.removeEventListener("messageerror", this.handleMessageError);
    this.descriptor.port.close(); this.pending.clear(); this.pendingBytes = 0;
    for (const listener of [...this.closeListeners]) listener(reason);
    this.closeListeners.clear(); this.frameListeners.clear();
  }
}

/** Kernel-worker endpoint: decode, validate through the segment, then release. */
export class RemoteSegmentPortTransport implements RemoteSegmentTransport {
  private readonly bridge: SegmentPortBridge;
  private readonly controlListeners = new Set<(value: unknown) => void>();
  private readonly datagramListeners = new Set<(datagram: UdpDatagram) => void>();
  readonly maxPayload: number;
  constructor(descriptor: RemoteSegmentPeer) {
    this.maxPayload = descriptor.maxPayload;
    this.bridge = new SegmentPortBridge(descriptor);
    this.bridge.onFrame((kind, frame, release) => {
      try {
        if (kind === "udp") {
          const datagram = decodeRemoteUdp(frame, this.maxPayload);
          for (const listener of [...this.datagramListeners]) listener(datagram);
        } else {
          const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame));
          for (const listener of [...this.controlListeners]) listener(value);
        }
      } finally { release(); }
    });
  }
  sendControl(message: RemoteSegmentControl): boolean {
    return this.bridge.send("control", new TextEncoder().encode(JSON.stringify(message)));
  }
  sendDatagram(datagram: UdpDatagram): number {
    if (datagram.data.length > this.maxPayload) return 90;
    return this.bridge.send("udp", encodeRemoteUdp(datagram, this.maxPayload)) ? 0 : 11;
  }
  onControl(listener: (value: unknown) => void): () => void {
    this.controlListeners.add(listener); return () => { this.controlListeners.delete(listener); };
  }
  onDatagram(listener: (datagram: UdpDatagram) => void): () => void {
    this.datagramListeners.add(listener); return () => { this.datagramListeners.delete(listener); };
  }
  onClose(listener: (reason: string) => void): () => void { return this.bridge.onClose(listener); }
  close(): void { this.bridge.close(); this.controlListeners.clear(); this.datagramListeners.clear(); }
}
