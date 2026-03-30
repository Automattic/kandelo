/**
 * HTTP Bridge — SharedArrayBuffer-based protocol for service worker ↔ main thread
 * HTTP request/response bridging.
 *
 * Layout of the shared buffer (per request slot):
 *
 *   Offset  Size    Field
 *   0       4       status: 0=IDLE, 1=REQUEST_READY, 2=RESPONSE_READY, 3=ERROR
 *   4       4       request method length
 *   8       4       request URL length
 *   12      4       request headers length (serialized)
 *   16      4       request body length
 *   20      4       response status code
 *   24      4       response headers length (serialized)
 *   28      4       response body length
 *   32      N       data area (method + URL + headers + body / response headers + body)
 *
 * The service worker writes the request, sets status to REQUEST_READY,
 * and uses Atomics.waitAsync for RESPONSE_READY.
 * The main thread reads the request, processes it, writes the response,
 * and sets status to RESPONSE_READY with Atomics.notify.
 */

const HEADER_SIZE = 32;
const SLOT_SIZE = 256 * 1024; // 256KB per slot (enough for most HTTP requests/responses)
const STATUS_OFFSET = 0;
const METHOD_LEN_OFFSET = 4;
const URL_LEN_OFFSET = 8;
const REQ_HEADERS_LEN_OFFSET = 12;
const REQ_BODY_LEN_OFFSET = 16;
const RESP_STATUS_OFFSET = 20;
const RESP_HEADERS_LEN_OFFSET = 24;
const RESP_BODY_LEN_OFFSET = 28;
const DATA_OFFSET = HEADER_SIZE;

export const STATUS_IDLE = 0;
export const STATUS_REQUEST_READY = 1;
export const STATUS_RESPONSE_READY = 2;
export const STATUS_ERROR = 3;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface HttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Uint8Array | null;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

/**
 * Create the shared buffer for the HTTP bridge.
 * @param numSlots Number of concurrent request slots (default: 4)
 */
export function createHttpBridgeBuffer(numSlots = 4): SharedArrayBuffer {
  return new SharedArrayBuffer(SLOT_SIZE * numSlots);
}

/**
 * Get the Int32Array view for a specific slot's header.
 */
function getSlotI32(buffer: SharedArrayBuffer, slot: number): Int32Array {
  return new Int32Array(buffer, slot * SLOT_SIZE, HEADER_SIZE / 4);
}

/**
 * Get the Uint8Array view for a specific slot's data area.
 */
function getSlotData(buffer: SharedArrayBuffer, slot: number): Uint8Array {
  return new Uint8Array(buffer, slot * SLOT_SIZE + DATA_OFFSET, SLOT_SIZE - DATA_OFFSET);
}

function serializeHeaders(headers: Record<string, string>): Uint8Array {
  const lines = Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\r\n");
  return encoder.encode(lines);
}

function deserializeHeaders(data: Uint8Array): Record<string, string> {
  const text = decoder.decode(data);
  if (!text) return {};
  const headers: Record<string, string> = {};
  for (const line of text.split("\r\n")) {
    const colon = line.indexOf(": ");
    if (colon >= 0) {
      headers[line.slice(0, colon)] = line.slice(colon + 2);
    }
  }
  return headers;
}

// --- Service Worker Side ---

/**
 * Write an HTTP request into a bridge slot and wait for the response.
 * Called from the service worker's fetch handler.
 *
 * @returns Promise that resolves with the HTTP response
 */
export async function bridgeFetch(
  buffer: SharedArrayBuffer,
  slot: number,
  request: HttpRequest,
): Promise<HttpResponse> {
  const header = getSlotI32(buffer, slot);
  const data = getSlotData(buffer, slot);

  // Serialize request data
  const methodBytes = encoder.encode(request.method);
  const urlBytes = encoder.encode(request.url);
  const headersBytes = serializeHeaders(request.headers);
  const bodyBytes = request.body ?? new Uint8Array(0);

  // Write request data
  let offset = 0;
  data.set(methodBytes, offset);
  offset += methodBytes.length;
  data.set(urlBytes, offset);
  offset += urlBytes.length;
  data.set(headersBytes, offset);
  offset += headersBytes.length;
  data.set(bodyBytes, offset);

  // Write header fields
  Atomics.store(header, METHOD_LEN_OFFSET / 4, methodBytes.length);
  Atomics.store(header, URL_LEN_OFFSET / 4, urlBytes.length);
  Atomics.store(header, REQ_HEADERS_LEN_OFFSET / 4, headersBytes.length);
  Atomics.store(header, REQ_BODY_LEN_OFFSET / 4, bodyBytes.length);

  // Signal request ready
  Atomics.store(header, STATUS_OFFSET / 4, STATUS_REQUEST_READY);
  Atomics.notify(header, STATUS_OFFSET / 4);

  // Wait for response (service worker must use waitAsync)
  const result = Atomics.waitAsync(header, STATUS_OFFSET / 4, STATUS_REQUEST_READY);
  if (result.async) {
    await result.value;
  }

  const status = Atomics.load(header, STATUS_OFFSET / 4);
  if (status === STATUS_ERROR) {
    // Reset slot
    Atomics.store(header, STATUS_OFFSET / 4, STATUS_IDLE);
    throw new Error("Bridge request failed");
  }

  // Read response
  const respStatus = Atomics.load(header, RESP_STATUS_OFFSET / 4);
  const respHeadersLen = Atomics.load(header, RESP_HEADERS_LEN_OFFSET / 4);
  const respBodyLen = Atomics.load(header, RESP_BODY_LEN_OFFSET / 4);

  let rOffset = 0;
  const respHeaders = deserializeHeaders(data.subarray(rOffset, rOffset + respHeadersLen));
  rOffset += respHeadersLen;
  const respBody = data.slice(rOffset, rOffset + respBodyLen);

  // Reset slot to idle
  Atomics.store(header, STATUS_OFFSET / 4, STATUS_IDLE);

  return { status: respStatus, headers: respHeaders, body: respBody };
}

// --- Main Thread Side ---

/**
 * Poll a bridge slot for incoming requests.
 * Called from the main thread's event loop.
 *
 * @returns The HTTP request if one is ready, null otherwise
 */
export function pollRequest(
  buffer: SharedArrayBuffer,
  slot: number,
): HttpRequest | null {
  const header = getSlotI32(buffer, slot);
  const status = Atomics.load(header, STATUS_OFFSET / 4);
  if (status !== STATUS_REQUEST_READY) return null;

  const data = getSlotData(buffer, slot);

  const methodLen = Atomics.load(header, METHOD_LEN_OFFSET / 4);
  const urlLen = Atomics.load(header, URL_LEN_OFFSET / 4);
  const headersLen = Atomics.load(header, REQ_HEADERS_LEN_OFFSET / 4);
  const bodyLen = Atomics.load(header, REQ_BODY_LEN_OFFSET / 4);

  let offset = 0;
  const method = decoder.decode(data.subarray(offset, offset + methodLen));
  offset += methodLen;
  const url = decoder.decode(data.subarray(offset, offset + urlLen));
  offset += urlLen;
  const headers = deserializeHeaders(data.subarray(offset, offset + headersLen));
  offset += headersLen;
  const body = bodyLen > 0 ? data.slice(offset, offset + bodyLen) : null;

  return { method, url, headers, body };
}

/**
 * Write an HTTP response into a bridge slot and signal the service worker.
 */
export function sendResponse(
  buffer: SharedArrayBuffer,
  slot: number,
  response: HttpResponse,
): void {
  const header = getSlotI32(buffer, slot);
  const data = getSlotData(buffer, slot);

  const headersBytes = serializeHeaders(response.headers);

  // Write response data
  let offset = 0;
  data.set(headersBytes, offset);
  offset += headersBytes.length;
  data.set(response.body, offset);

  // Write header fields
  Atomics.store(header, RESP_STATUS_OFFSET / 4, response.status);
  Atomics.store(header, RESP_HEADERS_LEN_OFFSET / 4, headersBytes.length);
  Atomics.store(header, RESP_BODY_LEN_OFFSET / 4, response.body.length);

  // Signal response ready
  Atomics.store(header, STATUS_OFFSET / 4, STATUS_RESPONSE_READY);
  Atomics.notify(header, STATUS_OFFSET / 4);
}

/**
 * Signal an error for a bridge slot.
 */
export function sendError(buffer: SharedArrayBuffer, slot: number): void {
  const header = getSlotI32(buffer, slot);
  Atomics.store(header, STATUS_OFFSET / 4, STATUS_ERROR);
  Atomics.notify(header, STATUS_OFFSET / 4);
}

/**
 * HttpBridgeHost — Main thread side of the HTTP bridge.
 * Polls for requests and routes them through the kernel.
 */
export class HttpBridgeHost {
  private buffer: SharedArrayBuffer;
  private numSlots: number;
  private polling = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private handler: ((slot: number, request: HttpRequest) => void) | null = null;

  constructor(buffer: SharedArrayBuffer, numSlots = 4) {
    this.buffer = buffer;
    this.numSlots = numSlots;
  }

  /** Set the request handler. Called when a request is received. */
  onRequest(handler: (slot: number, request: HttpRequest) => void): void {
    this.handler = handler;
  }

  /** Start polling for requests. */
  start(): void {
    if (this.polling) return;
    this.polling = true;
    this.poll();
  }

  /** Stop polling. */
  stop(): void {
    this.polling = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** Send a response for the given slot. */
  respond(slot: number, response: HttpResponse): void {
    sendResponse(this.buffer, slot, response);
  }

  /** Signal an error for the given slot. */
  error(slot: number): void {
    sendError(this.buffer, slot);
  }

  /** Get the shared buffer (to pass to service worker). */
  getBuffer(): SharedArrayBuffer {
    return this.buffer;
  }

  private poll(): void {
    if (!this.polling) return;

    let anyActive = false;
    for (let i = 0; i < this.numSlots; i++) {
      const request = pollRequest(this.buffer, i);
      if (request) {
        anyActive = true;
        this.handler?.(i, request);
      }
    }

    // Poll more aggressively when handling requests
    this.pollTimer = setTimeout(() => this.poll(), anyActive ? 1 : 10);
  }
}
