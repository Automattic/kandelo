/**
 * TLS-MITM Network Backend for browser environments.
 *
 * Implements the NetworkIO interface by handling:
 *   - HTTP (non-443): same approach as FetchNetworkBackend
 *   - HTTPS (port 443): TLS MITM using the vendored WordPress Playground
 *     TLS 1.2 library. Programs do real TLS handshakes via their compiled-in
 *     OpenSSL; this backend terminates the TLS locally, decrypts the HTTP
 *     request, fetches via the browser's fetch() API, encrypts the response,
 *     and returns it to the program.
 *
 * The async TLS processing (Web Crypto) integrates with the kernel's
 * EAGAIN/retry pattern — no separate worker thread needed.
 */

import type { NetworkIO } from "../types";
import { EagainError } from "./fetch-backend";
import {
  parseNumericIpv4Hostname,
  validateSyntheticDnsHostname,
} from "./hostname";
import {
  BrowserCorsProxy,
  type BrowserCorsProxyConfig,
  type HttpHeaderOccurrence,
  validateBrowserCorsProxyConfig,
} from "./browser-cors-proxy";
import { TLS_1_2_Connection } from "../../../packages/registry/openssl/src/tls/1_2/connection";
import {
  generateCertificate,
  certificateToPEM,
  type GeneratedCertificate,
} from "../../../packages/registry/openssl/src/tls/certificates";

const POLLIN = 0x0001;
const POLLOUT = 0x0004;
const POLLERR = 0x0008;
const POLLHUP = 0x0010;
const MSG_PEEK = 0x0002;

// ------------------------------------------------------------------ types

interface HttpConnectionState {
  kind: "http";
  hostname: string;
  ip: Uint8Array;
  port: number;
  sendBuf: Uint8Array;
  responseBuf: Uint8Array | null;
  responseOffset: number;
  fetchDone: boolean;
  fetchError: Error | null;
}

interface TlsConnectionState {
  kind: "tls";
  hostname: string;
  ip: Uint8Array;
  port: number;
  tls: TlsMitmConnection;
  /** Writer for clientEnd.upstream.writable — feeds encrypted data from program */
  clientUpstreamWriter: WritableStreamDefaultWriter<Uint8Array>;
  /** Writer for serverEnd.downstream.writable — sends plaintext responses */
  serverDownstreamWriter: WritableStreamDefaultWriter<Uint8Array>;
  /** Encrypted data from TLS engine, waiting to be returned to program via recv() */
  clientDownstreamBuf: Uint8Array;
  /** Decrypted plaintext HTTP data received from program */
  plaintextBuf: Uint8Array;
  /** Whether a fetch is currently in flight for this connection */
  httpResponsePending: boolean;
  /** Whether the TLS connection has been closed */
  closed: boolean;
  /** Whether the TLS handshake has completed */
  handshakeDone: boolean;
  /** Error from handshake or fetch */
  error: Error | null;
}

type ConnectionState = HttpConnectionState | TlsConnectionState;

// ------------------------------------------------------------------ helpers

function concatBuffers(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.length + b.length);
  result.set(a);
  result.set(b, a.length);
  return result;
}

function findHeaderEnd(buf: Uint8Array): number {
  for (let i = 0; i <= buf.length - 4; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a && buf[i + 2] === 0x0d && buf[i + 3] === 0x0a) {
      return i;
    }
  }
  return -1;
}

function parseContentLength(headers: string): number {
  const match = headers.match(/content-length:\s*(\d+)/i);
  return match ? parseInt(match[1], 10) : 0;
}

function parseHttpRequest(buf: Uint8Array, headerEnd: number): {
  method: string;
  path: string;
  version: string;
  headers: HttpHeaderOccurrence[];
  body: Uint8Array | null;
} {
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

function indexOfCRLF(buf: Uint8Array, from: number): number {
  for (let i = from; i + 1 < buf.length; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) return i;
  }
  return -1;
}

/** Decode an HTTP/1.1 `Transfer-Encoding: chunked` request body starting at
 *  `start`. Returns the dechunked bytes plus how many buffer bytes the encoded
 *  form occupied, or null if the terminating zero-chunk has not arrived yet.
 *  git streams a large `git-upload-pack` negotiation this way (requests over
 *  http.postBuffer, default 1 MiB), so the MITM must reassemble it before
 *  handing a plain body to fetch(). */
function parseChunkedBody(
  buf: Uint8Array,
  start: number,
): { body: Uint8Array; consumed: number } | null {
  const chunks: Uint8Array[] = [];
  let pos = start;
  for (;;) {
    const lineEnd = indexOfCRLF(buf, pos);
    if (lineEnd === -1) return null;
    const sizeToken = new TextDecoder()
      .decode(buf.subarray(pos, lineEnd))
      .split(";")[0]
      .trim();
    const size = parseInt(sizeToken, 16);
    if (!Number.isFinite(size) || size < 0) return null;
    const dataStart = lineEnd + 2;
    if (size === 0) {
      // Last chunk: consume any trailer lines up to the terminating blank line.
      let trailerPos = dataStart;
      for (;;) {
        const trailerEnd = indexOfCRLF(buf, trailerPos);
        if (trailerEnd === -1) return null;
        if (trailerEnd === trailerPos) {
          return { body: concatChunks(chunks), consumed: trailerPos + 2 - start };
        }
        trailerPos = trailerEnd + 2;
      }
    }
    const dataEnd = dataStart + size;
    if (buf.length < dataEnd + 2) return null; // need the data and its CRLF
    chunks.push(buf.subarray(dataStart, dataEnd));
    pos = dataEnd + 2;
  }
}

function concatChunks(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Decide whether the MITM connection stays open after this response.
 *  HTTP/1.1 defaults to keep-alive unless `Connection: close`; HTTP/1.0
 *  defaults to close unless `Connection: keep-alive`. git-remote-http / libcurl
 *  issue ref-discovery and upload-pack as HTTP/1.1 keep-alive requests over one
 *  connection, so honoring this is what lets a smart-HTTP clone complete. */
function requestKeepsConnectionAlive(
  version: string,
  headers: readonly HttpHeaderOccurrence[],
): boolean {
  const connection = (lastHeaderValue(headers, "connection") ?? "").toLowerCase();
  if (connection.split(",").some((token) => token.trim() === "close")) {
    return false;
  }
  if (version === "HTTP/1.0") {
    return connection
      .split(",")
      .some((token) => token.trim() === "keep-alive");
  }
  return true;
}

function lastHeaderValue(
  headers: readonly HttpHeaderOccurrence[],
  name: string,
): string | undefined {
  let result: string | undefined;
  for (const [headerName, value] of headers) {
    if (headerName.toLowerCase() === name) result = value;
  }
  return result;
}

function browserRepresentableHeaders(
  headers: readonly HttpHeaderOccurrence[],
): HttpHeaderOccurrence[] {
  return headers.filter(([name]) => {
    const lower = name.toLowerCase();
    return lower !== "host" && lower !== "connection";
  });
}

function headersFromOccurrences(
  occurrences: readonly HttpHeaderOccurrence[],
): Headers {
  const headers = new Headers();
  for (const [name, value] of occurrences) headers.append(name, value);
  return headers;
}

const HOP_BY_HOP_HEADERS = new Set([
  "transfer-encoding",
  "content-encoding",
  "connection",
  "keep-alive",
]);

function formatHttpResponse(
  status: number,
  statusText: string,
  headers: Headers,
  body: ArrayBuffer,
): Uint8Array {
  const bodyBytes = new Uint8Array(body);
  let headerStr = `HTTP/1.1 ${status} ${statusText}\r\n`;
  headers.forEach((value, key) => {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase()) && key.toLowerCase() !== "content-length") {
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

// ------------------------------------------------------------------ backend

/** The slice of the TLS 1.2 server engine the MITM path drives. Kept as an
 *  injection seam so tests can exercise the connect → request → response →
 *  recv loop deterministically without a real handshake. */
export interface TlsMitmConnection {
  clientEnd: {
    upstream: { writable: WritableStream<Uint8Array> };
    downstream: { readable: ReadableStream<Uint8Array> };
  };
  serverEnd: {
    upstream: { readable: ReadableStream<Uint8Array> };
    downstream: { writable: WritableStream<Uint8Array> };
  };
  TLSHandshake(certificatePrivateKey: CryptoKey, certificatesDER: Uint8Array[]): Promise<void>;
  close(): Promise<void>;
}

export interface TlsNetworkBackendOptions {
  corsProxy?: BrowserCorsProxyConfig;
  onCorsProxyDiagnostic?: (message: string) => void;
  /** Map of in-VFS hostnames → upstream URL. */
  dnsAliases?: Record<string, string>;
  /** Factory for the MITM TLS engine. Defaults to a real TLS 1.2 server
   *  connection; tests override it to drive the loop deterministically. */
  createTlsConnection?: () => TlsMitmConnection;
}

export class TlsNetworkBackend implements NetworkIO {
  private connections = new Map<number, ConnectionState>();
  private hostnameMap = new Map<string, string>(); // ip string → hostname
  private corsProxy: BrowserCorsProxy | undefined;
  private dnsAliases: Record<string, string>;
  private createTlsConnection: () => TlsMitmConnection;

  // MITM CA state
  private caKeyPair: CryptoKeyPair | null = null;
  private caCert: GeneratedCertificate | null = null;
  private caCertPEM = "";
  private initialized = false;

  constructor(options?: TlsNetworkBackendOptions) {
    const corsProxyConfig = validateBrowserCorsProxyConfig(options?.corsProxy);
    this.corsProxy = corsProxyConfig === undefined
      ? undefined
      : new BrowserCorsProxy(corsProxyConfig, options?.onCorsProxyDiagnostic);
    this.dnsAliases = options?.dnsAliases ?? {};
    this.createTlsConnection = options?.createTlsConnection ?? (() => new TLS_1_2_Connection());
  }

  /**
   * Initialize the MITM CA. Must be called before any TLS connections.
   * Generates a CA keypair and self-signed certificate using Web Crypto.
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    this.caCert = await generateCertificate({
      subject: {
        commonName: "WASM POSIX MITM CA",
        organizationName: "WASM POSIX Kernel",
      },
      basicConstraints: { ca: true },
      keyUsage: { keyCertSign: true, cRLSign: true },
    });
    this.caKeyPair = this.caCert.keyPair;
    this.caCertPEM = certificateToPEM(this.caCert.certificate);
    this.initialized = true;
  }

  /**
   * Returns the PEM-encoded CA certificate for installing in the VFS.
   * Programs' OpenSSL will trust certificates signed by this CA.
   */
  getCACertPEM(): string {
    return this.caCertPEM;
  }

  // ---- NetworkIO implementation ----

  getaddrinfo(hostname: string): Uint8Array {
    const literalIp = parseNumericIpv4Hostname(hostname);
    if (literalIp) return literalIp;
    validateSyntheticDnsHostname(hostname, this.dnsAliases);

    const ip = this.syntheticIp(hostname);
    const ipStr = this.ipKey(ip);
    this.hostnameMap.set(ipStr, hostname);
    return ip;
  }

  connect(handle: number, addr: Uint8Array, port: number): void {
    const ipStr = this.ipKey(addr);
    const hostname = this.hostnameMap.get(ipStr) || ipStr;

    if (port === 443) {
      this.connectTls(handle, addr, port, hostname);
    } else {
      this.connections.set(handle, {
        kind: "http",
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
  }

  connectStatus(handle: number): number {
    return this.connections.has(handle) ? 0 : 107; // 107 = ENOTCONN
  }

  send(handle: number, data: Uint8Array, _flags: number): number {
    const conn = this.connections.get(handle);
    if (!conn) throw new Error("ENOTCONN");

    if (conn.kind === "tls") {
      return this.tlsSend(conn, data);
    }
    return this.httpSend(conn, data);
  }

  recv(handle: number, maxLen: number, flags: number): Uint8Array {
    const conn = this.connections.get(handle);
    if (!conn) throw new Error("ENOTCONN");

    if (conn.kind === "tls") {
      return this.tlsRecv(conn, maxLen, flags);
    }
    return this.httpRecv(conn, maxLen, flags);
  }

  close(handle: number): void {
    const conn = this.connections.get(handle);
    if (!conn) return;

    if (conn.kind === "tls") {
      conn.closed = true;
      conn.tls.close().catch(() => {});
    }
    this.connections.delete(handle);
  }

  // ---- TLS MITM ----

  private connectTls(handle: number, addr: Uint8Array, port: number, hostname: string): void {
    const tls = this.createTlsConnection();

    // Get writers for our side of the streams
    const clientUpstreamWriter = tls.clientEnd.upstream.writable.getWriter();
    const serverDownstreamWriter = tls.serverEnd.downstream.writable.getWriter();

    const conn: TlsConnectionState = {
      kind: "tls",
      hostname,
      ip: new Uint8Array(addr),
      port,
      tls,
      clientUpstreamWriter,
      serverDownstreamWriter,
      clientDownstreamBuf: new Uint8Array(0),
      plaintextBuf: new Uint8Array(0),
      handshakeDone: false,
      httpResponsePending: false,
      closed: false,
      error: null,
    };
    this.connections.set(handle, conn);

    // Background reader: encrypted data FROM TLS engine → buffer for recv()
    const downstreamReader = tls.clientEnd.downstream.readable.getReader();
    (async () => {
      try {
        while (true) {
          const { value, done } = await downstreamReader.read();
          if (done) break;
          if (value && value.length > 0) {
            conn.clientDownstreamBuf = concatBuffers(conn.clientDownstreamBuf, value);
          }
        }
      } catch {
        // Stream closed or errored — normal during teardown
      } finally {
        // Reported as EOF only here, once the last ciphertext record has been
        // buffered. Closing the connection right after the response is written
        // races the async encryption pump: recv() could observe conn.closed
        // with an empty buffer and return a premature 0-byte EOF.
        conn.closed = true;
      }
    })();

    // Background reader: decrypted plaintext FROM TLS engine → process HTTP
    const upstreamReader = tls.serverEnd.upstream.readable.getReader();
    (async () => {
      try {
        while (true) {
          const { value, done } = await upstreamReader.read();
          if (done) break;
          if (value && value.length > 0) {
            conn.plaintextBuf = concatBuffers(conn.plaintextBuf, value);
            this.tryProcessHttpRequest(conn);
          }
        }
      } catch {
        // Stream closed or errored — normal during teardown
      }
    })();

    // Generate server cert and start TLS handshake (async, fire-and-forget)
    this.startHandshake(handle, conn).catch((err) => {
      conn.error = err;
      conn.closed = true;
    });
  }

  private async startHandshake(handle: number, conn: TlsConnectionState): Promise<void> {
    if (!this.caKeyPair || !this.caCert) {
      throw new Error("CA not initialized — call init() first");
    }

    // Generate a server certificate for this hostname, signed by our CA
    const serverCert = await generateCertificate(
      {
        subject: { commonName: conn.hostname },
        issuer: this.caCert.tbsDescription.subject,
        subjectAltNames: { dnsNames: [conn.hostname] },
        keyUsage: { digitalSignature: true, keyEncipherment: true },
        extKeyUsage: { serverAuth: true },
        basicConstraints: { ca: false },
      },
      this.caKeyPair,
    );

    // Start TLS handshake — this awaits ClientHello from the program
    conn.tls.TLSHandshake(
      serverCert.keyPair.privateKey,
      [serverCert.certificate, this.caCert.certificate],
    ).then(() => {
      conn.handshakeDone = true;
    }).catch((err) => {
      if (!conn.closed) {
        conn.error = err;
      }
      conn.closed = true;
    });
  }

  private tlsSend(conn: TlsConnectionState, data: Uint8Array): number {
    if (conn.closed && !conn.error) {
      // Connection closed cleanly (e.g. SSL_shutdown) — silently accept
      return data.length;
    }
    if (conn.error) {
      throw conn.error;
    }

    // Write encrypted data from program into TLS engine's client upstream.
    // The write is queued in the stream's internal buffer and processed
    // asynchronously by the TLS engine (microtasks + Web Crypto).
    conn.clientUpstreamWriter.write(new Uint8Array(data)).catch(() => {
      // Ignore write errors on closed connections (e.g. SSL_shutdown close_notify)
      if (!conn.closed) {
        conn.closed = true;
      }
    });

    return data.length;
  }

  private tlsRecv(conn: TlsConnectionState, maxLen: number, flags: number): Uint8Array {
    if (conn.error) throw conn.error;

    // Check if we have encrypted data buffered from the TLS engine
    if (conn.clientDownstreamBuf.length > 0) {
      const n = Math.min(maxLen, conn.clientDownstreamBuf.length);
      const result = conn.clientDownstreamBuf.slice(0, n);
      if ((flags & MSG_PEEK) === 0) {
        conn.clientDownstreamBuf = conn.clientDownstreamBuf.subarray(n);
      }
      return result;
    }

    // No data yet — if connection is closed, return EOF
    if (conn.closed) {
      return new Uint8Array(0);
    }

    // Otherwise, throw EAGAIN so the kernel retries after yielding the event
    // loop (allowing TLS stream processing and Web Crypto to run).
    throw new EagainError();
  }

  private tryProcessHttpRequest(conn: TlsConnectionState): void {
    if (conn.httpResponsePending || conn.closed) return;

    const headerEnd = findHeaderEnd(conn.plaintextBuf);
    if (headerEnd === -1) return;

    const headerStr = new TextDecoder().decode(conn.plaintextBuf.subarray(0, headerEnd));
    const contentLength = parseContentLength(headerStr);
    const isChunked = /transfer-encoding:[^\r\n]*\bchunked\b/i.test(headerStr);
    const bodyStart = headerEnd + 4;
    const bodyReceived = conn.plaintextBuf.length - bodyStart;

    // Determine whether the full request body has arrived, and isolate exactly
    // its bytes — never trailing bytes from a pipelined next request, which the
    // connection now stays open to receive.
    let requestBody: Uint8Array | null;
    let totalRequestLen: number;
    if (isChunked) {
      const parsed = parseChunkedBody(conn.plaintextBuf, bodyStart);
      if (!parsed) return; // terminating zero-chunk not here yet
      requestBody = parsed.body.length > 0 ? parsed.body : null;
      totalRequestLen = bodyStart + parsed.consumed;
    } else {
      if (contentLength > 0 && bodyReceived < contentLength) return;
      requestBody = contentLength > 0
        ? conn.plaintextBuf.subarray(bodyStart, bodyStart + contentLength)
        : null;
      totalRequestLen = bodyStart + Math.max(contentLength, 0);
    }

    // Complete HTTP request — parse and fetch
    conn.httpResponsePending = true;

    const { method, path, version, headers } = parseHttpRequest(conn.plaintextBuf, headerEnd);
    const keepAlive = requestKeepsConnectionAlive(version, headers);

    // Consume exactly this request from the plaintext buffer.
    conn.plaintextBuf = conn.plaintextBuf.subarray(totalRequestLen);

    const host = lastHeaderValue(headers, "host") || conn.hostname;
    const upstreamUrl = `https://${host}${path}`;
    const browserHeaders = browserRepresentableHeaders(headers);

    const fetchBody: Uint8Array<ArrayBuffer> | undefined =
      requestBody && requestBody.length > 0
        ? new Uint8Array(requestBody) as Uint8Array<ArrayBuffer>
        : undefined;
    const url = this.corsProxy ? this.corsProxy.urlFor(upstreamUrl) : upstreamUrl;

    (async () => {
      try {
        const fetchHeaders = this.corsProxy
          ? this.corsProxy.project({
            method,
            headers: browserHeaders,
            bodyPresent: fetchBody !== undefined,
            targetUrl: upstreamUrl,
          })
          : headersFromOccurrences(browserHeaders);
        const response = await fetch(url, {
          method,
          headers: fetchHeaders,
          body: method !== "GET" && method !== "HEAD" ? fetchBody : undefined,
        });

        const responseBytes = formatHttpResponse(
          response.status,
          response.statusText,
          response.headers,
          await response.arrayBuffer(),
        );

        // Write plaintext response to server downstream — TLS engine encrypts
        // it automatically and it appears on clientEnd.downstream.readable.
        await conn.serverDownstreamWriter.write(responseBytes);
        // Keep the MITM connection open for a keep-alive client so it can send
        // the next request on the same socket. Closing after every response
        // (the earlier single-shot behavior) broke git's smart-HTTP clone,
        // which reuses one connection for info/refs then git-upload-pack.
        if (!keepAlive) {
          await conn.serverDownstreamWriter.close();
        }
      } catch (err) {
        // Send a 502 Bad Gateway response through TLS, then close: a failed
        // fetch leaves no reliable way to continue this connection.
        const errorBody = `Error fetching ${url}: ${err}`;
        const errorResponse = formatHttpResponse(
          502,
          "Bad Gateway",
          new Headers({ "Content-Type": "text/plain" }),
          new TextEncoder().encode(errorBody).buffer as ArrayBuffer,
        );
        try {
          await conn.serverDownstreamWriter.write(errorResponse);
          await conn.serverDownstreamWriter.close();
        } catch {
          // Ignore write errors
        }
        conn.httpResponsePending = false;
        return;
      }
      conn.httpResponsePending = false;
      // A keep-alive client may have already pipelined its next request into
      // plaintextBuf while this fetch was in flight; drain it now since the
      // upstream reader only calls this on newly arriving bytes.
      if (keepAlive && !conn.closed) {
        this.tryProcessHttpRequest(conn);
      }
    })();
  }

  // ---- HTTP handling (non-443 ports) ----

  private httpSend(conn: HttpConnectionState, data: Uint8Array): number {
    // Append to send buffer
    const newBuf = new Uint8Array(conn.sendBuf.length + data.length);
    newBuf.set(conn.sendBuf);
    newBuf.set(data, conn.sendBuf.length);
    conn.sendBuf = newBuf;

    const headerEnd = findHeaderEnd(conn.sendBuf);
    if (headerEnd === -1) return data.length;

    const headerStr = new TextDecoder().decode(conn.sendBuf.subarray(0, headerEnd));
    const contentLength = parseContentLength(headerStr);
    const bodyStart = headerEnd + 4;
    const bodyReceived = conn.sendBuf.length - bodyStart;

    if (contentLength > 0 && bodyReceived < contentLength) return data.length;

    // Complete request — parse and issue fetch
    const { method, path, headers, body } = parseHttpRequest(conn.sendBuf, headerEnd);
    const hostHeader = lastHeaderValue(headers, "host");
    const scheme = conn.port === 443 ? "https" : "http";
    const portSuffix = (conn.port === 80 || conn.port === 443) ? "" : `:${conn.port}`;
    // Use Host header as-is (it already includes :port when non-default),
    // otherwise fall back to conn.hostname + port suffix.
    const host = hostHeader ? hostHeader : `${conn.hostname}${portSuffix}`;
    const aliasUpstream = this.dnsAliases[conn.hostname];
    const upstreamUrl = aliasUpstream !== undefined
      ? `${aliasUpstream}${path}`
      : `${scheme}://${host}${path}`;
    const browserHeaders = browserRepresentableHeaders(headers);

    const fetchBody: Uint8Array<ArrayBuffer> | undefined =
      body && body.length > 0 ? new Uint8Array(body) as Uint8Array<ArrayBuffer> : undefined;
    const url = this.corsProxy ? this.corsProxy.urlFor(upstreamUrl) : upstreamUrl;

    const doFetch = async () => {
      try {
        const fetchHeaders = this.corsProxy
          ? this.corsProxy.project({
            method,
            headers: browserHeaders,
            bodyPresent: fetchBody !== undefined,
            targetUrl: upstreamUrl,
          })
          : headersFromOccurrences(browserHeaders);
        const response = await fetch(url, {
          method,
          headers: fetchHeaders,
          body: fetchBody,
        });

        const bodyBuf = await response.arrayBuffer();

        conn.responseBuf = formatHttpResponse(
          response.status,
          response.statusText,
          response.headers,
          bodyBuf,
        );
        conn.fetchDone = true;
      } catch (e) {
        conn.fetchError = e as Error;
        conn.fetchDone = true;
      }
    };

    // Reset connection state before dispatching so recv() waits for the new
    // fetch instead of observing the previous response.
    conn.fetchDone = false;
    conn.responseBuf = null;
    conn.responseOffset = 0;
    conn.fetchError = null;

    doFetch();
    conn.sendBuf = new Uint8Array(0);
    return data.length;
  }

  private httpRecv(conn: HttpConnectionState, maxLen: number, flags: number): Uint8Array {
    if (!conn.fetchDone) {
      throw new EagainError();
    }

    if (conn.fetchError) throw conn.fetchError;

    if (!conn.responseBuf) {
      return new Uint8Array(0);
    }

    const remaining = conn.responseBuf.length - conn.responseOffset;
    const len = Math.min(maxLen, remaining);
    if (len === 0) return new Uint8Array(0);

    const result = conn.responseBuf.slice(conn.responseOffset, conn.responseOffset + len);
    if ((flags & MSG_PEEK) === 0) {
      conn.responseOffset += len;
    }
    return result;
  }

  poll(handle: number, events: number): number {
    const conn = this.connections.get(handle);
    if (!conn) throw Object.assign(new Error("ENOTCONN"), { errno: 107 });

    let revents = 0;
    if ((events & POLLOUT) !== 0 && (conn.kind === "http" || !conn.closed)) {
      revents |= POLLOUT;
    }

    if (conn.kind === "http") {
      if (conn.fetchError) return revents | POLLERR;
      if (
        (events & POLLIN) !== 0 &&
        conn.responseBuf &&
        conn.responseOffset < conn.responseBuf.length
      ) {
        revents |= POLLIN;
      }
      if (
        conn.fetchDone &&
        conn.responseBuf &&
        conn.responseOffset >= conn.responseBuf.length
      ) {
        revents |= POLLHUP;
      }
      return revents;
    }

    if (conn.error) return revents | POLLERR;
    if ((events & POLLIN) !== 0 && conn.clientDownstreamBuf.length > 0) {
      revents |= POLLIN;
    }
    if (conn.closed && conn.clientDownstreamBuf.length === 0) {
      revents |= POLLHUP;
    }
    return revents;
  }

  // ---- Utilities ----

  private syntheticIp(hostname: string): Uint8Array {
    let hash = 0;
    for (let i = 0; i < hostname.length; i++) {
      hash = ((hash << 5) - hash + hostname.charCodeAt(i)) | 0;
    }
    return new Uint8Array([10, (hash >> 16) & 0xff, (hash >> 8) & 0xff, hash & 0xff]);
  }

  private ipKey(ip: Uint8Array): string {
    return `${ip[0]}.${ip[1]}.${ip[2]}.${ip[3]}`;
  }
}
