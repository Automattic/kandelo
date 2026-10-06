import type { UdpDatagram } from "../types";

/** One SCTP message is one IPv4 UDP datagram; no reassembly or retries. */
export const REMOTE_UDP_HEADER_BYTES = 16;
export const IPV4_UDP_MAX_PAYLOAD = 65507;
const VERSION = 1;

export function remoteUdpPayloadLimit(sctpMessageSize: number): number {
  if (sctpMessageSize === 0 || sctpMessageSize === Infinity) return IPV4_UDP_MAX_PAYLOAD;
  if (!Number.isSafeInteger(sctpMessageSize) || sctpMessageSize < REMOTE_UDP_HEADER_BYTES) {
    throw new Error("the peer SCTP message ceiling cannot carry a UDP frame");
  }
  return Math.min(IPV4_UDP_MAX_PAYLOAD, sctpMessageSize - REMOTE_UDP_HEADER_BYTES);
}

function validateAddress(address: Uint8Array): void {
  if (address.length !== 4) throw new Error("remote UDP frames require IPv4 addresses");
}

function validatePort(port: number): void {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("remote UDP frames require 16-bit ports");
  }
}

export function encodeRemoteUdp(datagram: UdpDatagram, maxPayload: number): Uint8Array<ArrayBuffer> {
  validateAddress(datagram.srcAddr);
  validateAddress(datagram.dstAddr);
  validatePort(datagram.srcPort);
  validatePort(datagram.dstPort);
  if (datagram.data.length > Math.min(maxPayload, IPV4_UDP_MAX_PAYLOAD)) {
    throw Object.assign(new Error("EMSGSIZE"), { errno: 90 });
  }
  const frame = new Uint8Array(REMOTE_UDP_HEADER_BYTES + datagram.data.length);
  const view = new DataView(frame.buffer);
  frame[0] = VERSION;
  frame.set(datagram.srcAddr, 4);
  frame.set(datagram.dstAddr, 8);
  view.setUint16(12, datagram.srcPort);
  view.setUint16(14, datagram.dstPort);
  frame.set(datagram.data, REMOTE_UDP_HEADER_BYTES);
  return frame;
}

export function decodeRemoteUdp(frame: Uint8Array, maxPayload: number): UdpDatagram {
  if (frame.length < REMOTE_UDP_HEADER_BYTES
    || frame.length - REMOTE_UDP_HEADER_BYTES > Math.min(maxPayload, IPV4_UDP_MAX_PAYLOAD)
    || frame[0] !== VERSION || frame[1] !== 0 || frame[2] !== 0 || frame[3] !== 0) {
    throw new Error("invalid remote UDP frame version, length or reserved bytes");
  }
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  return {
    srcAddr: frame.slice(4, 8), dstAddr: frame.slice(8, 12),
    srcPort: view.getUint16(12), dstPort: view.getUint16(14),
    data: frame.slice(REMOTE_UDP_HEADER_BYTES),
  };
}
