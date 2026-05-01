/**
 * External HTTP request interface — shared types and HTTP/1.1 framing helpers.
 *
 * These let host code send an HTTP request to a server running inside the
 * kernel ("in-kernel server") and receive a parsed response, without going
 * through real TCP. The actual pump runs inside the kernel worker via
 * {@link CentralizedKernelWorker.sendHttpRequest}; this file holds the
 * data shapes and the byte-level codec that both ends share.
 *
 * Prototype scope (see docs/plans/2026-04-30-external-kernel-http-request-interface.md):
 *   - Request and response bodies are buffered in full (no streaming).
 *   - Plain HTTP/1.1 only.
 *   - Each call opens a fresh injected connection (no pipelining).
 */

export interface HttpRequest {
  /** HTTP method, e.g. "GET", "POST". */
  method: string;
  /** Request-target — what goes after the method on the request line, e.g.
   * `/foo?x=1`. Typically a path; absolute URLs work for proxy-style requests
   * but the in-kernel server determines the routing. */
  url: string;
  /** Header name → value. Header names are sent verbatim. If
   *  `Content-Length` is missing and `body` is non-empty, it's added
   *  automatically. If `Connection` is missing, `Connection: close` is
   *  added so the server closes the response cleanly. */
  headers: Record<string, string>;
  /** Optional request body. */
  body: Uint8Array | null;
}

export interface HttpResponse {
  /** Numeric HTTP status code, e.g. 200. */
  status: number;
  /** Response headers, with `Transfer-Encoding: chunked` stripped if the
   *  body was already de-chunked here. */
  headers: Record<string, string>;
  /** Decoded response body. */
  body: Uint8Array;
}

/** Options for {@link CentralizedKernelWorker.sendHttpRequest}. */
export interface SendHttpRequestOptions {
  /** Time to wait for a complete response before bailing with status 504.
   *  Defaults to 60 seconds. */
  timeoutMs?: number;
  /** Optional label appended to log lines for grepping in busy demos. */
  debugLabel?: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Serialize an {@link HttpRequest} to raw HTTP/1.1 bytes ready to write into
 * a kernel pipe.
 *
 * Adds `Content-Length` if the request has a body but no explicit one.
 * Adds `Connection: close` if not specified, so the server cleanly closes
 * the response and the host pump sees a clean EOF.
 */
export function buildRawHttpRequest(req: HttpRequest): Uint8Array {
  let header = `${req.method} ${req.url} HTTP/1.1\r\n`;
  const lowerKeys = Object.keys(req.headers).map((k) => k.toLowerCase());
  for (const [key, value] of Object.entries(req.headers)) {
    header += `${key}: ${value}\r\n`;
  }
  if (req.body && req.body.length > 0 && !lowerKeys.includes("content-length")) {
    header += `Content-Length: ${req.body.length}\r\n`;
  }
  if (!lowerKeys.includes("connection")) {
    header += `Connection: close\r\n`;
  }
  header += `\r\n`;

  const headerBytes = encoder.encode(header);
  if (!req.body || req.body.length === 0) return headerBytes;

  const out = new Uint8Array(headerBytes.length + req.body.length);
  out.set(headerBytes, 0);
  out.set(req.body, headerBytes.length);
  return out;
}

/**
 * Parse a complete raw HTTP/1.1 response (as a single byte buffer) into an
 * {@link HttpResponse}. Decodes chunked transfer encoding when present and
 * removes the `Transfer-Encoding` header so callers see a flat body.
 */
export function parseRawHttpResponse(data: Uint8Array): HttpResponse {
  const headerEnd = findHeaderEnd(data);
  if (headerEnd < 0) {
    return { status: 200, headers: {}, body: data };
  }

  const headerText = decoder.decode(data.subarray(0, headerEnd));
  const lines = headerText.split("\r\n");
  const statusMatch = lines[0]?.match(/^HTTP\/[\d.]+ (\d+)/);
  const status = statusMatch ? parseInt(statusMatch[1]!, 10) : 200;

  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    const colon = line.indexOf(": ");
    if (colon < 0) continue;
    const key = line.slice(0, colon);
    const value = line.slice(colon + 2);
    if (key.toLowerCase() === "set-cookie" && headers[key]) {
      headers[key] += "\n" + value;
    } else {
      headers[key] = value;
    }
  }

  let body = data.subarray(headerEnd + 4);
  const te = headers["Transfer-Encoding"] ?? headers["transfer-encoding"];
  if (te && te.toLowerCase().includes("chunked")) {
    body = decodeChunked(body);
    delete headers["Transfer-Encoding"];
    delete headers["transfer-encoding"];
  }

  return { status, headers, body: new Uint8Array(body) };
}

/** Byte offset of the `\r\n\r\n` at the end of headers, or -1. */
function findHeaderEnd(data: Uint8Array): number {
  for (let i = 0; i + 3 < data.length; i++) {
    if (
      data[i] === 0x0d && data[i + 1] === 0x0a &&
      data[i + 2] === 0x0d && data[i + 3] === 0x0a
    ) {
      return i;
    }
  }
  return -1;
}

/** Decode HTTP/1.1 chunked transfer encoding. Stops on a 0-sized chunk or
 *  malformed input — trailing trailers are ignored. */
function decodeChunked(data: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  let pos = 0;
  while (pos < data.length) {
    let lineEnd = -1;
    for (let i = pos; i + 1 < data.length; i++) {
      if (data[i] === 0x0d && data[i + 1] === 0x0a) {
        lineEnd = i;
        break;
      }
    }
    if (lineEnd < 0) break;
    const sizeLine = decoder.decode(data.subarray(pos, lineEnd)).trim();
    const chunkSize = parseInt(sizeLine, 16);
    if (Number.isNaN(chunkSize) || chunkSize === 0) break;
    const chunkStart = lineEnd + 2;
    const chunkEnd = chunkStart + chunkSize;
    if (chunkEnd > data.length) break;
    chunks.push(data.subarray(chunkStart, chunkEnd));
    pos = chunkEnd + 2;
  }
  return concatChunks(chunks);
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0]!;
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
