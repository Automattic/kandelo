/**
 * HTTP/1.1 message framing for the browser network backends — one copy.
 *
 * Both browser backends terminate a guest's HTTP conversation and re-issue it
 * as a `fetch()`: `FetchNetworkBackend` for plain HTTP, and
 * `TlsNetworkBackend` for HTTPS after its MITM decrypts the record stream (and
 * for plain HTTP on its own non-443 path). Reading a request off the wire and
 * writing a response back onto it is the same problem in all three, and until
 * now each file carried its own copy of the helpers.
 *
 * The copies had drifted, and the drift was a live defect. Both formatters
 * append a `Content-Length` they compute from the decoded body, because
 * `fetch()` has already undone `Transfer-Encoding: chunked` and
 * `Content-Encoding: gzip`. Only the TLS copy also *dropped* the upstream
 * `Content-Length` header before doing so. The plain-HTTP copy forwarded it,
 * so a guest fetching a gzip-serving origin over HTTP received a response with
 * two `Content-Length` field lines whose values disagreed — the compressed
 * length from upstream and the decoded length computed here. RFC 9110 §8.6
 * makes that unrecoverable, and real clients treat it as a framing error.
 *
 * These helpers are host code because the bytes are host-owned: the request
 * text is produced by the MITM's WebCrypto decryption or read out of a
 * host-side send buffer, and the response comes back inside a `Response`
 * object. Nothing here reads guest process memory, which is why this framing
 * has no route into the Rust kernel today — the kernel's only data channels
 * are anchored at a process address. If HTTP proxying is ever moved into the
 * kernel, this module is the unit that moves, and there is now one of it.
 */

import type { HttpHeaderOccurrence } from "./browser-cors-proxy";

/** Offset of the CRLFCRLF that ends the header block, or -1 if not yet seen. */
export function findHeaderEnd(buf: Uint8Array): number {
  for (let i = 0; i <= buf.length - 4; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a && buf[i + 2] === 0x0d && buf[i + 3] === 0x0a) {
      return i;
    }
  }
  return -1;
}

/** `Content-Length` from a decoded header block, or 0 when absent. */
export function parseContentLength(headers: string): number {
  const match = headers.match(/content-length:\s*(\d+)/i);
  return match ? parseInt(match[1], 10) : 0;
}

export interface ParsedHttpRequest {
  method: string;
  path: string;
  /** Request-line HTTP version token, e.g. `HTTP/1.1`. Drives keep-alive. */
  version: string;
  headers: HttpHeaderOccurrence[];
  body: Uint8Array | null;
}

/** Split a request whose header block ends at `headerEnd` into its parts. */
export function parseHttpRequest(buf: Uint8Array, headerEnd: number): ParsedHttpRequest {
  const headerStr = new TextDecoder().decode(buf.subarray(0, headerEnd));
  const lines = headerStr.split("\r\n");
  const [method, path, version] = lines[0].split(" ");
  const headers: HttpHeaderOccurrence[] = [];
  for (let i = 1; i < lines.length; i++) {
    const colon = lines[i].indexOf(":");
    if (colon > 0) {
      headers.push([
        lines[i].substring(0, colon).trim(),
        lines[i].substring(colon + 1).trim(),
      ]);
    }
  }
  const bodyStart = headerEnd + 4;
  const body = bodyStart < buf.length ? buf.subarray(bodyStart) : null;
  return { method, path, version, headers, body };
}

/** Last occurrence of `name` (case-insensitive), or undefined. */
export function lastHeaderValue(
  headers: readonly HttpHeaderOccurrence[],
  name: string,
): string | undefined {
  let result: string | undefined;
  for (const [headerName, value] of headers) {
    if (headerName.toLowerCase() === name) result = value;
  }
  return result;
}

/** Drop the headers `fetch()` refuses to let a caller set. */
export function browserRepresentableHeaders(
  headers: readonly HttpHeaderOccurrence[],
): HttpHeaderOccurrence[] {
  return headers.filter(([name]) => {
    const lower = name.toLowerCase();
    return lower !== "host" && lower !== "connection";
  });
}

export function headersFromOccurrences(
  occurrences: readonly HttpHeaderOccurrence[],
): Headers {
  const headers = new Headers();
  for (const [name, value] of occurrences) headers.append(name, value);
  return headers;
}

/**
 * Headers that must not be forwarded to the guest.
 *
 * `transfer-encoding` and `content-encoding` describe an encoding `fetch()`
 * already undid, `connection` and `keep-alive` govern a hop that ends here,
 * and `content-length` describes the *upstream* body — this formatter emits
 * its own for the decoded one.
 */
const HOP_BY_HOP_HEADERS = new Set([
  "transfer-encoding",
  "content-encoding",
  "connection",
  "keep-alive",
  "content-length",
]);

/** Serialize a `fetch()` result as the HTTP/1.1 response bytes a guest reads. */
export function formatHttpResponse(
  status: number,
  statusText: string,
  headers: Headers,
  body: ArrayBuffer,
): Uint8Array {
  const bodyBytes = new Uint8Array(body);
  let headerStr = `HTTP/1.1 ${status} ${statusText}\r\n`;
  headers.forEach((value, key) => {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      headerStr += `${key}: ${value}\r\n`;
    }
  });
  headerStr += `Content-Length: ${bodyBytes.length}\r\n`;
  headerStr += "\r\n";

  const headerBytes = new TextEncoder().encode(headerStr);
  const result = new Uint8Array(headerBytes.length + bodyBytes.length);
  result.set(headerBytes);
  result.set(bodyBytes, headerBytes.length);
  return result;
}
