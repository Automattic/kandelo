import type { NetworkAddress } from '../types';

export const REMOTE_TCP_HEADER_BYTES = 24;
export const REMOTE_TCP_DATA_BYTES = 16 * 1024;
export const REMOTE_TCP_WINDOW_BYTES = 64 * 1024;
export const REMOTE_TCP_MARKER = 0x54;
export const TCP_FRAME = { open: 1, accept: 2, data: 3, credit: 4, fin: 5, readStop: 6, reset: 7, refuse: 8, close: 9 } as const;
export type RemoteTcpFrame = {
  kind: number; origin: number; serial: number;
  source: NetworkAddress; destination: NetworkAddress;
  value: number; data: Uint8Array;
};
export function validateRemoteTcpFrame(frame: RemoteTcpFrame): void {
  if (!Number.isInteger(frame.kind) || frame.kind < 1 || frame.kind > 9
    || !Number.isInteger(frame.origin) || frame.origin < 1 || frame.origin > 254
    || !Number.isInteger(frame.serial) || frame.serial < 1 || frame.serial > 0xffffffff
    || !Number.isInteger(frame.value) || frame.value < 0 || frame.value > 0xffffffff
    || !(frame.data instanceof Uint8Array)) throw new Error('invalid remote TCP frame');
  for (const endpoint of [frame.source, frame.destination]) {
    if (!(endpoint?.addr instanceof Uint8Array) || endpoint.addr.length !== 4
      || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535) throw new Error('invalid remote TCP endpoint');
  }
  if (frame.kind === TCP_FRAME.data) {
    if (frame.value || !frame.data.length || frame.data.length > REMOTE_TCP_DATA_BYTES) throw new Error('invalid remote TCP data length');
  } else {
    if (frame.data.length) throw new Error('remote TCP control has a payload');
    if ([TCP_FRAME.open, TCP_FRAME.accept, TCP_FRAME.credit].includes(frame.kind as 1 | 2 | 4)) {
      if (!frame.value || frame.value > REMOTE_TCP_WINDOW_BYTES) throw new Error('invalid remote TCP credit');
    } else if (frame.kind === TCP_FRAME.reset || frame.kind === TCP_FRAME.refuse) {
      if (!frame.value || frame.value > 4095) throw new Error('invalid remote TCP errno');
    } else if (frame.value) throw new Error('invalid remote TCP control value');
  }
}
export function encodeRemoteTcp(frame: RemoteTcpFrame): Uint8Array<ArrayBuffer> {
  validateRemoteTcpFrame(frame);
  const bytes = new Uint8Array(REMOTE_TCP_HEADER_BYTES + frame.data.length);
  const view = new DataView(bytes.buffer);
  bytes.set([REMOTE_TCP_MARKER, 1, frame.kind, frame.origin]); view.setUint32(4, frame.serial);
  bytes.set(frame.source.addr, 8); bytes.set(frame.destination.addr, 12);
  view.setUint16(16, frame.source.port); view.setUint16(18, frame.destination.port); view.setUint32(20, frame.value);
  bytes.set(frame.data, REMOTE_TCP_HEADER_BYTES); return bytes;
}
export function decodeRemoteTcp(bytes: Uint8Array): RemoteTcpFrame {
  if (bytes.length < REMOTE_TCP_HEADER_BYTES || bytes.length > REMOTE_TCP_HEADER_BYTES + REMOTE_TCP_DATA_BYTES
    || bytes[0] !== REMOTE_TCP_MARKER || bytes[1] !== 1) throw new Error('invalid remote TCP frame header');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frame = { kind: bytes[2], origin: bytes[3], serial: view.getUint32(4),
    source: { addr: bytes.slice(8, 12), port: view.getUint16(16) },
    destination: { addr: bytes.slice(12, 16), port: view.getUint16(18) },
    value: view.getUint32(20), data: bytes.slice(REMOTE_TCP_HEADER_BYTES) };
  validateRemoteTcpFrame(frame); return frame;
}
