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

import type { NetworkIO } from "../../../host/src/types";
import { EagainError } from "../../../host/src/networking/fetch-backend";
import { TLS_1_2_Connection } from "../../libs/openssl/src/tls/1_2/connection";
import {
  generateCertificate,
  certificateToPEM,
  type GeneratedCertificate,
} from "../../libs/openssl/src/tls/certificates";

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
  tls: TLS_1_2_Connection;
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

function formatHttpResponse(
  status: number,
  statusText: string,
  headers: Headers,
  body: ArrayBuffer,
): Uint8Array {
  const bodyBytes = new Uint8Array(body);
  let headerStr = `HTTP/1.1 ${status} ${statusText}\r\n`;
  headers.forEach((value, key) => {
    // Skip transfer-encoding since we set content-length
    if (key.toLowerCase() === "transfer-encoding") return;
    headerStr += `${key}: ${value}\r\n`;
  });
  if (!headers.has("content-length")) {
    headerStr += `Content-Length: ${bodyBytes.length}\r\n`;
  }
  headerStr += "Connection: close\r\n";
  headerStr += "\r\n";

  const headerBytes = new TextEncoder().encode(headerStr);
  const result = new Uint8Array(headerBytes.length + bodyBytes.length);
  result.set(headerBytes);
  result.set(bodyBytes, headerBytes.length);
  return result;
}

// ------------------------------------------------------------------ backend

export interface TlsNetworkBackendOptions {
  /** CORS proxy URL prefix. The target URL (percent-encoded) is appended.
   *  In dev: "/cors-proxy?url=" (vite middleware). In prod: set via service worker. */
  corsProxyUrl?: string;
  /** Map of in-VFS hostnames → upstream URL, routed through host fetch +
   *  CORS proxy (e.g. proxy.local → registry.npmjs.org). Defaults to that
   *  single npm-registry alias for back-compat. */
  dnsAliases?: Record<string, string>;
}

export class TlsNetworkBackend implements NetworkIO {
  private connections = new Map<number, ConnectionState>();
  private hostnameMap = new Map<string, string>(); // ip string → hostname
  private corsProxyUrl: string;
  private dnsAliases: Record<string, string>;

  // MITM CA state
  private caKeyPair: CryptoKeyPair | null = null;
  private caCert: GeneratedCertificate | null = null;
  private caCertPEM = "";
  private initialized = false;

  constructor(options?: TlsNetworkBackendOptions) {
    this.corsProxyUrl = options?.corsProxyUrl ?? "";
    this.dnsAliases = options?.dnsAliases ?? { "proxy.local": "https://registry.npmjs.org" };
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

  recv(handle: number, maxLen: number, _flags: number): Uint8Array {
    const conn = this.connections.get(handle);
    if (!conn) throw new Error("ENOTCONN");

    if (conn.kind === "tls") {
      return this.tlsRecv(conn, maxLen);
    }
    return this.httpRecv(conn, maxLen);
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
    const tls = new TLS_1_2_Connection();

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

  private tlsRecv(conn: TlsConnectionState, maxLen: number): Uint8Array {
    if (conn.error) throw conn.error;

    // Check if we have encrypted data buffered from the TLS engine
    if (conn.clientDownstreamBuf.length > 0) {
      const n = Math.min(maxLen, conn.clientDownstreamBuf.length);
      const result = conn.clientDownstreamBuf.slice(0, n);
      conn.clientDownstreamBuf = conn.clientDownstreamBuf.subarray(n);
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
    const bodyStart = headerEnd + 4;
    const bodyReceived = conn.plaintextBuf.length - bodyStart;

    if (contentLength > 0 && bodyReceived < contentLength) return;

    // Complete HTTP request — parse and fetch
    conn.httpResponsePending = true;

    const { method, path, headers, body } = parseHttpRequest(conn.plaintextBuf, headerEnd);

    // Consume the request from the plaintext buffer
    const totalRequestLen = headerEnd + 4 + Math.max(contentLength, 0);
    conn.plaintextBuf = conn.plaintextBuf.subarray(totalRequestLen);

    const host = headers.get("host") || conn.hostname;
    // Wasm process can't reach cross-origin URLs directly from the browser;
    // when corsProxyUrl is configured, every fetch goes through it.
    const upstreamUrl = `https://${host}${path}`;
    const url = this.corsProxyUrl
      ? `${this.corsProxyUrl}${encodeURIComponent(upstreamUrl)}`
      : upstreamUrl;

    const fetchHeaders = new Headers();
    for (const [key, value] of headers) {
      const lower = key.toLowerCase();
      if (lower !== "host" && lower !== "connection") {
        fetchHeaders.set(key, value);
      }
    }

    const fetchBody: Uint8Array<ArrayBuffer> | undefined =
      body && body.length > 0 ? new Uint8Array(body) as Uint8Array<ArrayBuffer> : undefined;

    (async () => {
      try {
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
      } catch (err) {
        // Send a 502 Bad Gateway response through TLS
        const errorBody = `Error fetching ${url}: ${err}`;
        const errorResponse = formatHttpResponse(
          502,
          "Bad Gateway",
          new Headers({ "Content-Type": "text/plain" }),
          new TextEncoder().encode(errorBody).buffer as ArrayBuffer,
        );
        try {
          await conn.serverDownstreamWriter.write(errorResponse);
        } catch {
          // Ignore write errors
        }
      }
      conn.httpResponsePending = false;
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
    const hostHeader = headers.get("host");
    const scheme = conn.port === 443 ? "https" : "http";
    const portSuffix = (conn.port === 80 || conn.port === 443) ? "" : `:${conn.port}`;
    // Use Host header as-is (it already includes :port when non-default),
    // otherwise fall back to conn.hostname + port suffix.
    const host = hostHeader ? hostHeader : `${conn.hostname}${portSuffix}`;
    // Sentinel hostnames in dnsAliases route to an upstream URL through host
    // fetch + CORS proxy, bypassing the in-process TLS engine.
    const aliasUpstream = this.dnsAliases[conn.hostname];
    const upstreamUrl = aliasUpstream !== undefined
      ? `${aliasUpstream}${path}`
      : `${scheme}://${host}${path}`;
    const url = this.corsProxyUrl
      ? `${this.corsProxyUrl}${encodeURIComponent(upstreamUrl)}`
      : upstreamUrl;
    const isNpmRegistry = aliasUpstream === "https://registry.npmjs.org";

    const fetchHeaders = new Headers();
    for (const [key, value] of headers) {
      const lower = key.toLowerCase();
      if (lower !== "host" && lower !== "connection") {
        fetchHeaders.set(key, value);
      }
    }

    const fetchBody: Uint8Array<ArrayBuffer> | undefined =
      body && body.length > 0 ? new Uint8Array(body) as Uint8Array<ArrayBuffer> : undefined;

    const doFetch = async () => {
      try {
        const response = await fetch(url, {
          method,
          headers: fetchHeaders,
          body: fetchBody,
        });

        let bodyBuf = await response.arrayBuffer();
        // Packument JSON's tarball URLs point back at registry.npmjs.org;
        // rewrite them to the alias so follow-up fetches stay on the proxy.
        if (isNpmRegistry && (response.headers.get("content-type") || "").includes("json")) {
          const text = new TextDecoder().decode(bodyBuf);
          const rewritten = text.replace(
            /"tarball"\s*:\s*"https:\/\/registry\.npmjs\.org/g,
            `"tarball":"http://${conn.hostname}`,
          );
          if (rewritten !== text) {
            bodyBuf = new TextEncoder().encode(rewritten).buffer as ArrayBuffer;
          }
        }

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

    doFetch();
    conn.sendBuf = new Uint8Array(0);
    return data.length;
  }

  private httpRecv(conn: HttpConnectionState, maxLen: number): Uint8Array {
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
    conn.responseOffset += len;
    return result;
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
