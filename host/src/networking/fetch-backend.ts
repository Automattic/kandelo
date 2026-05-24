import type { NetworkIO } from "../types";

/** Error with errno property for EAGAIN propagation to the kernel host imports. */
export class EagainError extends Error {
  readonly errno = 11;
  constructor() { super("EAGAIN"); }
}

interface ConnectionState {
  hostname: string;
  ip: Uint8Array;
  port: number;
  sendBuf: Uint8Array;
  responseBuf: Uint8Array | null;
  responseOffset: number;
  fetchDone: boolean;
  fetchError: Error | null;
}

export interface FetchBackendOptions {
  corsProxyUrl?: string;
}

export class FetchNetworkBackend implements NetworkIO {
  private connections = new Map<number, ConnectionState>();
  private hostnameMap = new Map<string, string>(); // ip string → hostname
  private options: FetchBackendOptions;

  constructor(options?: FetchBackendOptions) {
    this.options = options ?? {};
  }

  connect(handle: number, addr: Uint8Array, port: number): void {
    const ipStr = `${addr[0]}.${addr[1]}.${addr[2]}.${addr[3]}`;
    const hostname = this.hostnameMap.get(ipStr) || ipStr;
    this.connections.set(handle, {
      hostname,
      ip: new Uint8Array(addr),
      port,
      sendBuf: new Uint8Array(0),
      responseBuf: null,
      responseOffset: 0,
      fetchDone: false,
      fetchError: null,
    });
  }

  // fetch() is deferred to send(); connect always completes synchronously.
  connectStatus(handle: number): number {
    return this.connections.has(handle) ? 0 : 107; // 107 = ENOTCONN
  }

  send(handle: number, data: Uint8Array, _flags: number): number {
    const conn = this.connections.get(handle);
    if (!conn) throw new Error("ENOTCONN");

    // Append to send buffer
    const newBuf = new Uint8Array(conn.sendBuf.length + data.length);
    newBuf.set(conn.sendBuf);
    newBuf.set(data, conn.sendBuf.length);
    conn.sendBuf = newBuf;

    // Check if we have a complete HTTP request (headers end with \r\n\r\n)
    const headerEnd = findHeaderEnd(conn.sendBuf);
    if (headerEnd === -1) {
      return data.length; // Still buffering
    }

    // Parse headers to check Content-Length
    const headerStr = new TextDecoder().decode(conn.sendBuf.subarray(0, headerEnd));
    const contentLength = parseContentLength(headerStr);
    const bodyStart = headerEnd + 4; // skip \r\n\r\n
    const bodyReceived = conn.sendBuf.length - bodyStart;

    if (contentLength > 0 && bodyReceived < contentLength) {
      return data.length; // Still waiting for body
    }

    // We have a complete request — parse and issue fetch asynchronously.
    // Don't block with Atomics.wait — that deadlocks in web workers where the
    // event loop must yield for fetch() promises to resolve.
    const { method, path, headers, body } = parseHttpRequest(conn.sendBuf, headerEnd);
    const hostHeader = headers.get("host");
    const scheme = conn.port === 443 ? "https" : "http";
    const portSuffix = (conn.port === 80 || conn.port === 443) ? "" : `:${conn.port}`;
    // Use Host header as-is (it already includes :port when non-default),
    // otherwise fall back to conn.hostname + port suffix.
    const host = hostHeader ? hostHeader : `${conn.hostname}${portSuffix}`;
    const url = `${scheme}://${host}${path}`;

    // Convert headers map to Headers object (skip Host and Connection)
    const fetchHeaders = new Headers();
    for (const [key, value] of headers) {
      const lower = key.toLowerCase();
      if (lower !== "host" && lower !== "connection") {
        fetchHeaders.set(key, value);
      }
    }

    // Copy body into a standard ArrayBuffer-backed Uint8Array for fetch compatibility
    // (the input buffer may be backed by SharedArrayBuffer which isn't accepted as BodyInit)
    const fetchBody: Uint8Array<ArrayBuffer> | undefined =
      body && body.length > 0 ? new Uint8Array(body) as Uint8Array<ArrayBuffer> : undefined;

    // Fire-and-forget: start the async fetch. The response will be available
    // when recv() is called later. If recv() is called before the fetch completes,
    // it throws EagainError → kernel returns EAGAIN → handleBlockingRetry retries
    // after yielding the event loop (allowing this promise to resolve).
    const doFetch = async () => {
      try {
        let response: Response;
        try {
          response = await fetch(url, {
            method,
            headers: fetchHeaders,
            body: fetchBody,
          });
        } catch (e) {
          // Try CORS proxy if configured
          if (this.options.corsProxyUrl) {
            response = await fetch(`${this.options.corsProxyUrl}${url}`, {
              method,
              headers: fetchHeaders,
              body: fetchBody,
            });
          } else {
            throw e;
          }
        }

        conn.responseBuf = formatHttpResponse(response.status, response.statusText, response.headers, await response.arrayBuffer());
        conn.fetchDone = true;
      } catch (e) {
        conn.fetchError = e as Error;
        conn.fetchDone = true;
      }
    };

    // Reset connection state before dispatching — allows HTTP keep-alive
    // connections to handle multiple request/response cycles on the same handle.
    conn.fetchDone = false;
    conn.responseBuf = null;
    conn.responseOffset = 0;
    conn.fetchError = null;

    doFetch();
    // Clear the send buffer now that the request is dispatched
    conn.sendBuf = new Uint8Array(0);

    return data.length;
  }

  recv(handle: number, maxLen: number, _flags: number): Uint8Array {
    const conn = this.connections.get(handle);
    if (!conn) throw new Error("ENOTCONN");

    if (!conn.fetchDone) {
      // Fetch still in progress — throw EAGAIN so the kernel retries after
      // yielding the event loop (allowing the fetch promise to resolve).
      throw new EagainError();
    }

    if (conn.fetchError) throw conn.fetchError;

    if (!conn.responseBuf) {
      return new Uint8Array(0); // EOF
    }

    const remaining = conn.responseBuf.length - conn.responseOffset;
    const len = Math.min(maxLen, remaining);
    if (len === 0) return new Uint8Array(0);

    const result = conn.responseBuf.slice(conn.responseOffset, conn.responseOffset + len);
    conn.responseOffset += len;
    return result;
  }

  close(handle: number): void {
    this.connections.delete(handle);
  }

  getaddrinfo(hostname: string): Uint8Array {
    // In the browser, return a synthetic IP.
    // The actual connection uses the Host header, not this IP.
    // Use a deterministic hash to generate a fake IP in the 10.x.x.x range.
    let hash = 0;
    for (let i = 0; i < hostname.length; i++) {
      hash = ((hash << 5) - hash + hostname.charCodeAt(i)) | 0;
    }
    const ip = new Uint8Array([10, (hash >> 16) & 0xff, (hash >> 8) & 0xff, hash & 0xff]);
    // Store hostname→IP mapping so connect() can recover the hostname
    // (needed when program connects to port 443 where Host header may not be present
    // before TLS handshake, or for constructing proper URLs)
    const ipStr = `${ip[0]}.${ip[1]}.${ip[2]}.${ip[3]}`;
    this.hostnameMap.set(ipStr, hostname);
    return ip;
  }
}

/** Find the position of \r\n\r\n in the buffer. Returns -1 if not found. */
function findHeaderEnd(buf: Uint8Array): number {
  for (let i = 0; i <= buf.length - 4; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a && buf[i + 2] === 0x0d && buf[i + 3] === 0x0a) {
      return i;
    }
  }
  return -1;
}

/** Extract Content-Length from raw header string. Returns 0 if not present. */
function parseContentLength(headers: string): number {
  const match = headers.match(/content-length:\s*(\d+)/i);
  return match ? parseInt(match[1], 10) : 0;
}

/** Parse a raw HTTP request into method, path, headers, body. */
function parseHttpRequest(buf: Uint8Array, headerEnd: number): {
  method: string;
  path: string;
  headers: Map<string, string>;
  body: Uint8Array | null;
} {
  const headerStr = new TextDecoder().decode(buf.subarray(0, headerEnd));
  const lines = headerStr.split("\r\n");
  const [method, path] = lines[0].split(" ");
  const headers = new Map<string, string>();
  for (let i = 1; i < lines.length; i++) {
    const colon = lines[i].indexOf(":");
    if (colon > 0) {
      headers.set(lines[i].substring(0, colon).trim().toLowerCase(), lines[i].substring(colon + 1).trim());
    }
  }
  const bodyStart = headerEnd + 4;
  const body = bodyStart < buf.length ? buf.subarray(bodyStart) : null;
  return { method, path, headers, body };
}

/** Headers that must not be forwarded — fetch() already decoded them. */
const HOP_BY_HOP_HEADERS = new Set([
  "transfer-encoding",
  "content-encoding",
  "connection",
  "keep-alive",
]);

/** Format an HTTP response as raw bytes. */
function formatHttpResponse(
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
  // Set Content-Length to actual body size (fetch already decoded chunked/gzip)
  headerStr += `Content-Length: ${bodyBytes.length}\r\n`;
  headerStr += "\r\n";

  const headerBytes = new TextEncoder().encode(headerStr);
  const result = new Uint8Array(headerBytes.length + bodyBytes.length);
  result.set(headerBytes);
  result.set(bodyBytes, headerBytes.length);
  return result;
}
