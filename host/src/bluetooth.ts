/**
 * `/dev/kandelo/bluetooth` host-side helpers: result types and the record
 * codec shared by the kernel worker and the page's GATT broker.
 *
 * The guest drives the device: it writes `KIND_REQUEST` records (a UTF-8
 * command line), the page runs the GATT operation with Web Bluetooth and
 * pushes back a `KIND_RESPONSE` with the same `seq`, plus unsolicited
 * `KIND_NOTIFY` / `KIND_STATUS` records. See `wasm_posix_shared::bluetooth`.
 */
import {
  KANDELO_BLUETOOTH_KIND_REQUEST,
  KANDELO_BLUETOOTH_MAX_PAYLOAD_BYTES,
  KANDELO_BLUETOOTH_RECORD_HEADER_SIZE,
  KANDELO_BLUETOOTH_RECORD_VERSION,
} from "./generated/abi";

/** How often the worker checks for guest requests while waiting. */
export const BLUETOOTH_REQUEST_POLL_MS = 16;
/** Default wait for one guest request before the page re-arms the wait. */
export const BLUETOOTH_REQUEST_TIMEOUT_MS = 5_000;

export interface BluetoothRequest {
  /** The guest's request id; echo it in the response. */
  seq: number;
  /** The command line, e.g. `read battery_service battery_level`. */
  command: string;
}

export type BluetoothRequestResult =
  | { ok: true; request: BluetoothRequest }
  | { ok: false; reason: "timeout" | "no-agent" | "unsupported" | "invalid-request" };

export type BluetoothPushResult =
  | { ok: true }
  | { ok: false; reason: "no-agent" | "too-large" | "queue-full" | "invalid" | "unsupported" };

/** Classify a negative errno from `kernel_bluetooth_push`. */
export function bluetoothPushFailure(negErrno: number): BluetoothPushResult {
  switch (-negErrno) {
    case 6: return { ok: false, reason: "no-agent" };     // ENXIO
    case 90: return { ok: false, reason: "too-large" };   // EMSGSIZE
    case 28: return { ok: false, reason: "queue-full" };  // ENOSPC
    default: return { ok: false, reason: "invalid" };
  }
}

/** UTF-8 payload for a push, or null when it exceeds the device cap. */
export function encodeBluetoothPayload(text: string): Uint8Array | null {
  const bytes = new TextEncoder().encode(text);
  return bytes.byteLength > KANDELO_BLUETOOTH_MAX_PAYLOAD_BYTES ? null : bytes;
}

/** Decode one request record taken from the kernel, or null if malformed. */
export function decodeBluetoothRequest(record: Uint8Array): BluetoothRequest | null {
  const header = KANDELO_BLUETOOTH_RECORD_HEADER_SIZE;
  if (record.byteLength < header) return null;
  const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
  const version = view.getUint32(0, true);
  const kind = view.getUint32(4, true);
  const seq = view.getUint32(8, true);
  const len = view.getUint32(12, true);
  if (
    version !== KANDELO_BLUETOOTH_RECORD_VERSION
    || kind !== KANDELO_BLUETOOTH_KIND_REQUEST
    || seq === 0
    || len !== record.byteLength - header
  ) {
    return null;
  }
  try {
    const command = new TextDecoder("utf-8", { fatal: true }).decode(record.subarray(header));
    return { seq, command };
  } catch {
    return null;
  }
}
