import {REMOTE_TCP_MARKER} from './remote-tcp-codec';
import { MAX_SEGMENT_CONTROL_BYTES } from "./remote-segment";
import { remoteUdpPayloadLimit } from "./remote-udp-codec";
import { SegmentPortBridge, type RemoteSegmentPeer } from "./remote-segment-port";

const MAX_RTC_BUFFER_BYTES = 1024 * 1024;

/** Browser main-thread byte proxy. It never interprets routes or socket state. */
export function bridgeRemoteSegmentChannels(
  udp: RTCDataChannel,
  control: RTCDataChannel,
  maxMessageSize: number,
  closeConnection: () => void,
): { peer: RemoteSegmentPeer; close(): void } {
  if (udp.ordered || udp.maxRetransmits !== 0 || udp.maxPacketLifeTime !== null
    || !control.ordered || control.maxRetransmits !== null || control.maxPacketLifeTime !== null) {
    throw new Error("remote segments need unordered zero-retry UDP and reliable ordered control");
  }
  const maxPayload = remoteUdpPayloadLimit(maxMessageSize);
  const maxControlBytes = Math.min(MAX_SEGMENT_CONTROL_BYTES, maxMessageSize === 0 ? Infinity : maxMessageSize);
  if (maxControlBytes < 128) throw new Error("the peer SCTP ceiling cannot carry segment control");
  if (udp.readyState !== "open" || control.readyState !== "open") throw new Error("remote segment channels must be open before attaching a worker bridge");
  const { port1, port2 } = new MessageChannel();
  const bridge = new SegmentPortBridge({ port: port1, maxPayload, maxControlBytes });
  const pendingControl: { frame: Uint8Array; release: () => void }[] = [];
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    udp.removeEventListener("message", onUdp);
    control.removeEventListener("message", onControl);
    control.removeEventListener("bufferedamountlow", drainControl);
    udp.removeEventListener("close", close); control.removeEventListener("close", close);
    udp.removeEventListener("error", close); control.removeEventListener("error", close);
    pendingControl.length = 0;
    bridge.close(); closeConnection();
  };
  const drainControl = () => {
    while (!closed && pendingControl.length && control.bufferedAmount < MAX_RTC_BUFFER_BYTES) {
      const next = pendingControl.shift()!;
      try { control.send(next.frame as Uint8Array<ArrayBuffer>); next.release(); }
      catch { close(); }
    }
  };
  bridge.onFrame((kind, frame, release) => {
    if (kind === "control" || kind === "tcp") {
      pendingControl.push({ frame, release }); drainControl();
    } else {
      // A full RTC send buffer drops UDP after bridge admission. It is not a
      // delivery acknowledgement, and it must not grow a second send queue.
      try { if (udp.bufferedAmount < MAX_RTC_BUFFER_BYTES) udp.send(frame as Uint8Array<ArrayBuffer>); }
      catch { close(); }
      finally { release(); }
    }
  });
  bridge.onClose(close);
  const forward = (kind: "udp" | "control" | "tcp", event: MessageEvent) => {
    if (!(event.data instanceof ArrayBuffer)) { close(); return; }
    const frame = new Uint8Array(event.data);
    if (frame.byteLength > (kind === "udp" ? maxPayload + 16 : maxControlBytes)) { close(); return; }
    if (!bridge.send(kind, frame) && kind !== "udp") close();
  };
  const onUdp = (event: MessageEvent) => forward("udp", event);
  const onControl = (event: MessageEvent) => forward(event.data instanceof ArrayBuffer && new Uint8Array(event.data)[0] === REMOTE_TCP_MARKER ? "tcp" : "control", event);
  udp.binaryType = "arraybuffer"; control.binaryType = "arraybuffer";
  control.bufferedAmountLowThreshold = MAX_RTC_BUFFER_BYTES / 2;
  udp.addEventListener("message", onUdp); control.addEventListener("message", onControl);
  control.addEventListener("bufferedamountlow", drainControl);
  udp.addEventListener("close", close); control.addEventListener("close", close);
  udp.addEventListener("error", close); control.addEventListener("error", close);
  return { peer: { port: port2, maxPayload, maxControlBytes }, close };
}
