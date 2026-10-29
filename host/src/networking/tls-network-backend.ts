import { notifyReadiness, readinessGeneration } from "./readiness-generation";
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

import type { NetworkAddress, NetworkIO, UdpReceiveTarget } from "../types";
import { EgressLink, SyntheticHostAddresses } from "./egress-link";
import { NET_READINESS } from "../generated/abi";
import { EagainError } from "./fetch-backend";
import {
  parseNumericIpv4Hostname,
  validateSyntheticDnsHostname,
} from "./hostname";
import {
  BrowserCorsProxy,
  type BrowserCorsProxyConfig,
  type HttpHeaderOccurrence,
  requestCarriesGrantableCredential,
  validateBrowserCorsProxyConfig,
} from "./browser-cors-proxy";
import {
  CLEARTEXT_CREDENTIAL_REASON,
  type CredentialAttributionOptions,
  credentialGrantForRequest,
  currentWriter,
  mergeRequestWriter,
  PROXYLESS_CREDENTIAL_REASON,
  refuseCredentialRequest,
  type RequestWriter,
  UNATTRIBUTED_WRITER,
} from "./request-attribution";
import { TLS_1_2_Connection } from "../../../packages/registry/openssl/src/tls/1_2/connection";
import {
  generateCertificate,
  certificateToPEM,
  type GeneratedCertificate,
} from "../../../packages/registry/openssl/src/tls/certificates";

const MSG_PEEK = 0x0002;

// ------------------------------------------------------------------ types

interface HttpConnectionState {
  kind: "http";
  hostname: string;
  ip: Uint8Array;
  port: number;
  sendBuf: Uint8Array;
  /** Response bytes not yet consumed by recv(), from `responseOffset`. */
  responseBuf: Uint8Array | null;
  responseOffset: number;
  fetchDone: boolean;
  fetchError: Error | null;
  /** Bumped per request, so a response still streaming for an earlier
   *  request on this keep-alive connection stops appending. */
  requestGeneration: number;
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
  /** Attribution of the guest's ciphertext to the processes that wrote it. */
  records: TlsRecordWriters;
  /** The protocol version the engine's ServerHello chose. */
  serverHello: TlsServerHelloObserver;
  /** Who wrote each run of `plaintextBuf`, in order, covering all of it. */
  plaintextWriters: Array<{ bytes: number; writer: RequestWriter }>;
}

/**
 * Tracks TLS record framing on the guest's ciphertext so each decrypted
 * application-data record can be attributed to the processes whose `send`
 * calls carried it. The engine decrypts records in order and hands the
 * server side exactly one plaintext chunk per application-data record
 * (`pollForClientMessages` in packages/registry/openssl/src/tls/1_2), so the
 * n-th chunk it emits belongs to the n-th application-data record here.
 */
export interface TlsRecordWriters {
  header: Uint8Array;
  headerBytes: number;
  /** Payload bytes of the current record still to arrive. */
  remaining: number;
  /** Writer of the current record so far. */
  writer: RequestWriter | undefined;
  /** Writers of complete application-data records not yet decrypted. */
  applicationData: RequestWriter[];
}

const TLS_RECORD_HEADER_BYTES = 5;
const TLS_APPLICATION_DATA = 23;

/** Exported for tests. */
export function newTlsRecordWriters(): TlsRecordWriters {
  return {
    header: new Uint8Array(TLS_RECORD_HEADER_BYTES),
    headerBytes: 0,
    remaining: 0,
    writer: undefined,
    applicationData: [],
  };
}

/**
 * The protocol version the engine negotiated, read from the ServerHello it
 * sends the guest. Record attribution (`TlsRecordWriters`) relies on TLS 1.2
 * framing: in TLS 1.3 the encrypted handshake also travels in outer
 * application-data records, so writers would shift by a record. A
 * connection whose engine chose anything but TLS 1.2, or whose ServerHello
 * cannot be read, has no attributed requests (fail closed).
 */
export interface TlsServerHelloObserver {
  /** Engine output not yet split into records. */
  pending: Uint8Array;
  /** Handshake-record payload so far. */
  handshake: Uint8Array;
  /**
   * The negotiated version (0x0303 is TLS 1.2); undefined until the whole
   * ServerHello has arrived; null when the output is not a readable one.
   */
  version: number | null | undefined;
}

export const TLS_VERSION_1_2 = 0x0303;
const TLS_HANDSHAKE = 22;
const TLS_SERVER_HELLO = 2;
const TLS_EXTENSION_SUPPORTED_VERSIONS = 0x002b;

/** Exported for tests. */
export function newTlsServerHelloObserver(): TlsServerHelloObserver {
  return { pending: new Uint8Array(0), handshake: new Uint8Array(0), version: undefined };
}

/**
 * Read the engine's output to the guest until its ServerHello is complete.
 * Only the first flight is read: what follows the ServerHello is ignored,
 * and so is anything after the version is known. Exported for tests.
 */
export function observeServerRecords(
  observer: TlsServerHelloObserver,
  data: Uint8Array,
): void {
  if (observer.version !== undefined) return;
  observer.pending = concatBuffers(observer.pending, data);
  while (observer.pending.length >= TLS_RECORD_HEADER_BYTES) {
    const end = TLS_RECORD_HEADER_BYTES +
      ((observer.pending[3] << 8) | observer.pending[4]);
    if (observer.pending.length < end) return;
    if (observer.pending[0] !== TLS_HANDSHAKE) {
      observer.version = null;
      break;
    }
    observer.handshake = concatBuffers(
      observer.handshake,
      observer.pending.subarray(TLS_RECORD_HEADER_BYTES, end),
    );
    observer.pending = observer.pending.subarray(end);
    if (observer.handshake.length < 4) continue;
    if (observer.handshake[0] !== TLS_SERVER_HELLO) {
      observer.version = null;
      break;
    }
    const length = (observer.handshake[1] << 16) |
      (observer.handshake[2] << 8) | observer.handshake[3];
    if (observer.handshake.length < 4 + length) continue;
    observer.version = serverHelloVersion(observer.handshake.subarray(4, 4 + length));
    break;
  }
  if (observer.version !== undefined) {
    observer.pending = new Uint8Array(0);
    observer.handshake = new Uint8Array(0);
  }
}

/**
 * The version a ServerHello body selects: its supported_versions extension
 * if present (TLS 1.3, RFC 8446 section 4.2.1), else its legacy version.
 * Null when the body is malformed.
 */
function serverHelloVersion(body: Uint8Array): number | null {
  // legacy_version, random, session id length.
  if (body.length < 2 + 32 + 1) return null;
  const legacyVersion = (body[0] << 8) | body[1];
  // Session id, cipher suite, compression method.
  let at = 2 + 32 + 1 + body[2 + 32] + 2 + 1;
  if (at > body.length) return null;
  if (at === body.length) return legacyVersion;
  if (at + 2 > body.length) return null;
  const end = at + 2 + ((body[at] << 8) | body[at + 1]);
  if (end !== body.length) return null;
  at += 2;
  let version = legacyVersion;
  while (at < end) {
    if (at + 4 > end) return null;
    const type = (body[at] << 8) | body[at + 1];
    const length = (body[at + 2] << 8) | body[at + 3];
    at += 4;
    if (at + length > end) return null;
    if (type === TLS_EXTENSION_SUPPORTED_VERSIONS) {
      if (length !== 2) return null;
      version = (body[at] << 8) | body[at + 1];
    }
    at += length;
  }
  return version;
}

/** Attribute `data`, which `writer` wrote, to the records it carries.
 *  Exported for tests. */
export function recordCiphertextWriter(
  records: TlsRecordWriters,
  data: Uint8Array,
  writer: RequestWriter,
): void {
  let offset = 0;
  while (offset < data.length) {
    records.writer = mergeRequestWriter(records.writer, writer);
    if (records.headerBytes < TLS_RECORD_HEADER_BYTES) {
      const take = Math.min(
        TLS_RECORD_HEADER_BYTES - records.headerBytes,
        data.length - offset,
      );
      records.header.set(data.subarray(offset, offset + take), records.headerBytes);
      records.headerBytes += take;
      offset += take;
      if (records.headerBytes < TLS_RECORD_HEADER_BYTES) return;
      records.remaining = (records.header[3] << 8) | records.header[4];
    } else {
      const take = Math.min(records.remaining, data.length - offset);
      records.remaining -= take;
      offset += take;
    }
    if (records.remaining === 0) {
      if (records.header[0] === TLS_APPLICATION_DATA) {
        records.applicationData.push(records.writer);
      }
      records.headerBytes = 0;
      records.writer = undefined;
    }
  }
}

/** Remove the first `length` plaintext bytes' writers and merge them. */
function takePlaintextWriter(
  conn: TlsConnectionState,
  length: number,
): RequestWriter | undefined {
  let writer: RequestWriter | undefined;
  let left = length;
  while (left > 0 && conn.plaintextWriters.length > 0) {
    const run = conn.plaintextWriters[0];
    writer = mergeRequestWriter(writer, run.writer);
    const take = Math.min(run.bytes, left);
    run.bytes -= take;
    left -= take;
    if (run.bytes === 0) conn.plaintextWriters.shift();
  }
  // Record attribution holds only under TLS 1.2 framing.
  if (conn.serverHello.version !== TLS_VERSION_1_2) return UNATTRIBUTED_WRITER;
  return left > 0 ? UNATTRIBUTED_WRITER : writer;
}

type ConnectionState = HttpConnectionState | TlsConnectionState;

// ------------------------------------------------------------------ helpers

function concatBuffers(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.length + b.length);
  result.set(a);
  result.set(b, a.length);
  return result;
}

/** Queue response bytes for recv(), keeping only what is still unread so a
 *  long stream does not re-copy everything the guest already consumed. */
function appendHttpResponse(conn: HttpConnectionState, piece: Uint8Array): void {
  const unread = conn.responseBuf
    ? conn.responseBuf.subarray(conn.responseOffset)
    : new Uint8Array(0);
  conn.responseBuf = concatBuffers(unread, piece);
  if (piece.length) notifyReadiness(conn, 0);
  conn.responseOffset = 0;
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

/** Decode a `Content-Encoding`-compressed request body to plaintext so the
 *  re-issued fetch() carries an identity-encoded body. git gzip-compresses the
 *  `git-upload-pack` (fetch command) request and sets `Content-Encoding: gzip`;
 *  the browser CORS proxy allow-list does not carry `content-encoding`, so the
 *  faithful pass-through of the compressed body is refused. Decoding here lets
 *  the request traverse the proxy today. Returns null for an identity or
 *  unrecognized encoding, leaving the body and header untouched.
 *
 *  A more faithful alternative — forwarding `Content-Encoding` and the
 *  compressed body verbatim — is the more complete long-term behavior but
 *  requires the dev relay and the upstream CORS proxy to allow-list
 *  `content-encoding` (as they did `git-protocol`). Tracked as future work. */
async function decodeContentEncodingBody(
  body: Uint8Array,
  encoding: string,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const token = encoding.trim().toLowerCase();
  const format = token === "gzip" || token === "x-gzip"
    ? "gzip"
    : token === "deflate"
    ? "deflate"
    : null;
  if (format === null) return null;
  const decoded = new Response(
    new Response(body).body!.pipeThrough(new DecompressionStream(format)),
  );
  return new Uint8Array(await decoded.arrayBuffer()) as Uint8Array<ArrayBuffer>;
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

/**
 * Whether the response to this request can reach the guest as it arrives.
 *
 * Streaming needs chunked framing, because the length the guest will receive
 * is not knowable up front: fetch() decodes any Content-Encoding, and across
 * origins (the CORS proxy) the page cannot even see whether it did, so the
 * upstream Content-Length may describe bytes the guest never gets. Chunked
 * framing is HTTP/1.1-only, and some responses have no body to stream; those
 * keep the buffered form with an exact Content-Length.
 */
function responseStreams(method: string, version: string, response: Response): boolean {
  return version === "HTTP/1.1"
    && method !== "HEAD"
    && response.body !== null
    && response.status !== 204
    && response.status !== 304
    && response.status >= 200;
}

function formatChunkedHttpResponseHead(
  status: number,
  statusText: string,
  headers: Headers,
): Uint8Array {
  let headerStr = `HTTP/1.1 ${status} ${statusText}\r\n`;
  headers.forEach((value, key) => {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase()) && key.toLowerCase() !== "content-length") {
      headerStr += `${key}: ${value}\r\n`;
    }
  });
  headerStr += "Transfer-Encoding: chunked\r\n\r\n";
  return new TextEncoder().encode(headerStr);
}

function chunkFrame(data: Uint8Array): Uint8Array {
  const size = new TextEncoder().encode(`${data.length.toString(16)}\r\n`);
  const frame = new Uint8Array(size.length + data.length + 2);
  frame.set(size);
  frame.set(data, size.length);
  frame.set([0x0d, 0x0a], size.length + data.length);
  return frame;
}

/**
 * The response as the guest receives it, in the order its bytes become
 * available: the head as soon as fetch() has one, then each body piece as the
 * network delivers it. Buffering the whole body first (the earlier behavior)
 * meant a guest saw nothing of a large download until it had finished — curl
 * reported no progress for the length of a 69 MB fetch, then 100%.
 *
 * A failure partway through the body throws after some pieces were yielded;
 * the caller must then cut the connection, which the guest sees as a
 * truncated transfer rather than a forged complete one.
 */
async function* httpResponseBytes(
  response: Response,
  method: string,
  version: string,
): AsyncGenerator<Uint8Array> {
  if (!responseStreams(method, version, response)) {
    yield formatHttpResponse(
      response.status,
      response.statusText,
      response.headers,
      await response.arrayBuffer(),
    );
    return;
  }
  yield formatChunkedHttpResponseHead(response.status, response.statusText, response.headers);
  const reader = response.body!.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value.length > 0) yield chunkFrame(value);
  }
  yield new TextEncoder().encode("0\r\n\r\n");
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

export interface TlsNetworkBackendOptions extends CredentialAttributionOptions {
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
  // The guest sees fetch as a NAT gateway on its own link (egress-link.ts).
  private readonly egress = new EgressLink();
  private readonly addresses = new SyntheticHostAddresses();
  private corsProxy: BrowserCorsProxy | undefined;
  private dnsAliases: Record<string, string>;
  private createTlsConnection: () => TlsMitmConnection;
  private readonly attribution: CredentialAttributionOptions;

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
    this.attribution = {
      currentPid: options?.currentPid,
      peekCredentialGrantId: options?.peekCredentialGrantId,
      credentialGrantFor: options?.credentialGrantFor,
    };
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

  get localAddress(): Uint8Array { return this.egress.localAddress; }
  get localNetmask(): Uint8Array { return this.egress.localNetmask; }
  udpSourceAddress(destination: Uint8Array): Uint8Array { return this.egress.udpSourceAddress(destination); }
  bindUdp(id: string, addr: Uint8Array, port: number, target: UdpReceiveTarget): number { return this.egress.bindUdp(id, addr, port, target); }
  unbindUdp(id: string): void { this.egress.unbindUdp(id); }
  sendDatagram(): number { return this.egress.sendDatagram(); }

  /** The NAT side of a stream: this machine's address and the port it holds. */
  localEndpoint(handle: number): NetworkAddress {
    if (!this.connections.has(handle)) throw Object.assign(new Error("ENOTCONN"), { errno: 107 });
    return this.egress.streamEndpoint(handle);
  }

  getaddrinfo(hostname: string): Uint8Array {
    const literalIp = parseNumericIpv4Hostname(hostname);
    if (literalIp) return literalIp;
    validateSyntheticDnsHostname(hostname, this.dnsAliases);
    return this.addresses.resolve(hostname);
  }

  connect(handle: number, addr: Uint8Array, port: number, source?: NetworkAddress): void {
    this.egress.openStream(handle, source);
    const hostname = this.addresses.hostname(addr) ?? Array.from(addr).join(".");

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
        requestGeneration: 0,
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
      // The kernel is serving the writing process's system call right now;
      // record it with the grant it holds at this moment.
      return this.tlsSend(conn, data, currentWriter(this.attribution));
    }
    // Cleartext is never granted, so its writer does not matter.
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
    this.egress.closeStream(handle);
    const conn = this.connections.get(handle);
    if (!conn) return;

    if (conn.kind === "tls") {
      conn.closed = true;
      notifyReadiness(conn);
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
      records: newTlsRecordWriters(),
      serverHello: newTlsServerHelloObserver(),
      plaintextWriters: [],
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
            observeServerRecords(conn.serverHello, value);
            conn.clientDownstreamBuf = concatBuffers(conn.clientDownstreamBuf, value);
            if (value.length) notifyReadiness(conn, 0);
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
      notifyReadiness(conn);
      }
    })();

    // Background reader: decrypted plaintext FROM TLS engine → process HTTP
    const upstreamReader = tls.serverEnd.upstream.readable.getReader();
    (async () => {
      try {
        while (true) {
          const { value, done } = await upstreamReader.read();
          if (done) break;
          // One chunk per application-data record, empty ones included, so
          // every chunk consumes its record's writer.
          const writer = conn.records.applicationData.shift() ?? UNATTRIBUTED_WRITER;
          if (value && value.length > 0) {
            conn.plaintextBuf = concatBuffers(conn.plaintextBuf, value);
            conn.plaintextWriters.push({ bytes: value.length, writer });
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
      notifyReadiness(conn);
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
      notifyReadiness(conn);
    });
  }

  private tlsSend(conn: TlsConnectionState, data: Uint8Array, writer: RequestWriter): number {
    if (conn.closed && !conn.error) {
      // Connection closed cleanly (e.g. SSL_shutdown) — silently accept
      return data.length;
    }
    if (conn.error) {
      throw conn.error;
    }

    // Attribute before the engine can see the bytes: it decrypts later.
    recordCiphertextWriter(conn.records, data, writer);

    // Write encrypted data from program into TLS engine's client upstream.
    // The write is queued in the stream's internal buffer and processed
    // asynchronously by the TLS engine (microtasks + Web Crypto).
    conn.clientUpstreamWriter.write(new Uint8Array(data)).catch(() => {
      // Ignore write errors on closed connections (e.g. SSL_shutdown close_notify)
      if (!conn.closed) {
        conn.closed = true;
      notifyReadiness(conn);
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
    const writer = takePlaintextWriter(conn, totalRequestLen);

    const host = lastHeaderValue(headers, "host") || conn.hostname;
    const upstreamUrl = `https://${host}${path}`;
    const browserHeaders = browserRepresentableHeaders(headers);

    const fetchBody: Uint8Array<ArrayBuffer> | undefined =
      requestBody && requestBody.length > 0
        ? new Uint8Array(requestBody) as Uint8Array<ArrayBuffer>
        : undefined;
    const contentEncoding = lastHeaderValue(headers, "content-encoding");
    const url = this.corsProxy ? this.corsProxy.urlFor(upstreamUrl) : upstreamUrl;

    (async () => {
      let responseStarted = false;
      try {
        // Decode a compressed request body to identity so it can traverse the
        // proxy, and drop the now-inaccurate Content-Encoding from the headers.
        let outgoingBody = fetchBody;
        let outgoingHeaders = browserHeaders;
        if (fetchBody && contentEncoding !== undefined) {
          const decoded = await decodeContentEncodingBody(fetchBody, contentEncoding);
          if (decoded !== null) {
            outgoingBody = decoded;
            outgoingHeaders = browserHeaders.filter(
              ([name]) => name.toLowerCase() !== "content-encoding",
            );
          }
        }
        const requestBody = method !== "GET" && method !== "HEAD"
          ? outgoingBody
          : undefined;
        // Without a proxy there is nothing to carry the grant's opt-in and
        // tag, so credentials are refused here rather than sent directly.
        if (!this.corsProxy) {
          refuseCredentialRequest(method, upstreamUrl, outgoingHeaders, PROXYLESS_CREDENTIAL_REASON);
        }
        // Decided now, at dispatch, outside any kernel entry: this runs on
        // the engine's decrypt continuation, never inside host_net_send.
        // Only a request that carries a grantable credential asks.
        const grant = this.corsProxy && requestCarriesGrantableCredential(outgoingHeaders)
          ? await credentialGrantForRequest(this.attribution, writer, upstreamUrl)
          : null;
        const response = this.corsProxy
          ? await this.corsProxy.fetch({
            method,
            headers: outgoingHeaders,
            body: requestBody,
            // A body sent with GET/HEAD is dropped, but projection still
            // judges the request the guest actually made.
            bodyPresent: outgoingBody !== undefined,
            targetUrl: upstreamUrl,
          }, undefined, grant ?? undefined)
          : await fetch(url, {
            method,
            headers: headersFromOccurrences(outgoingHeaders),
            body: requestBody,
          });

        // Write the plaintext response to server downstream piece by piece —
        // the TLS engine encrypts each as it arrives and it appears on
        // clientEnd.downstream.readable for the guest's recv().
        for await (const piece of httpResponseBytes(response, method, version)) {
          await conn.serverDownstreamWriter.write(piece);
          responseStarted = true;
        }
        // Keep the MITM connection open for a keep-alive client so it can send
        // the next request on the same socket. Closing after every response
        // (the earlier single-shot behavior) broke git's smart-HTTP clone,
        // which reuses one connection for info/refs then git-upload-pack.
        if (!keepAlive) {
          await conn.serverDownstreamWriter.close();
        }
      } catch (err) {
        if (responseStarted) {
          // The head (and maybe part of the body) is already on its way, so a
          // 502 can no longer be sent. Closing mid-body is how the guest
          // learns the transfer failed: its chunked decoder sees no final
          // zero-length chunk.
          try {
            await conn.serverDownstreamWriter.close();
          } catch {
            // Ignore write errors
          }
          conn.httpResponsePending = false;
          return;
        }
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
    const { method, path, version, headers, body } = parseHttpRequest(conn.sendBuf, headerEnd);
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

    const generation = ++conn.requestGeneration;
    const doFetch = async () => {
      try {
        // The guest wrote this request in cleartext, so no grant covers it,
        // even when an HTTPS alias makes the upstream URL HTTPS: credentials
        // are refused with or without a proxy.
        refuseCredentialRequest(method, upstreamUrl, browserHeaders, CLEARTEXT_CREDENTIAL_REASON);
        const response = this.corsProxy
          ? await this.corsProxy.fetch({
            method,
            headers: browserHeaders,
            body: fetchBody,
            targetUrl: upstreamUrl,
          })
          : await fetch(url, {
            method,
            headers: headersFromOccurrences(browserHeaders),
            body: fetchBody,
          });

        // Hand each piece to recv() as it arrives (see httpResponseBytes).
        for await (const piece of httpResponseBytes(response, method, version)) {
          if (conn.requestGeneration !== generation) return;
          appendHttpResponse(conn, piece);
        }
        if (conn.requestGeneration !== generation) return;
        conn.fetchDone = true;
        notifyReadiness(conn, 0);
      } catch (e) {
        if (conn.requestGeneration !== generation) return;
        conn.fetchError = e as Error;
        conn.fetchDone = true;
        notifyReadiness(conn, 0);
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
    // Bytes that have arrived are delivered first, even while the rest of the
    // response is still streaming (or after it failed partway).
    const remaining = conn.responseBuf ? conn.responseBuf.length - conn.responseOffset : 0;
    if (remaining > 0 && maxLen > 0) {
      const len = Math.min(maxLen, remaining);
      const result = conn.responseBuf!.slice(conn.responseOffset, conn.responseOffset + len);
      if ((flags & MSG_PEEK) === 0) {
        conn.responseOffset += len;
      }
      return result;
    }

    if (!conn.fetchDone) {
      throw new EagainError();
    }

    if (conn.fetchError) throw conn.fetchError;

    return new Uint8Array(0); // EOF
  }

  /**
   * Report what each transport makes observable. No POSIX readiness decision
   * is made here — `runtime_core::net_readiness` makes it.
   */
  readinessGeneration(handle: number, direction: number): bigint {
    const conn = this.connections.get(handle);
    return conn ? readinessGeneration(conn, direction) : -1n;
  }

  readiness(handle: number): number {
    const conn = this.connections.get(handle);
    if (!conn) throw Object.assign(new Error("ENOTCONN"), { errno: 107 });

    let facts = 0;

    if (conn.kind === "http") {
      // Bytes that already arrived stay readable even after the stream
      // failed partway: the error is reported only once
      // they are drained, and EOF only after a complete response.
      const unread = conn.responseBuf !== null && conn.responseOffset < conn.responseBuf.length;
      if (conn.fetchError && !unread) facts |= NET_READINESS.ERROR;
      if (unread) facts |= NET_READINESS.RECV_READY;
      if (conn.fetchDone && !conn.fetchError && !unread) {
        facts |= NET_READINESS.RECV_EOF;
      }
      // `send` buffers the request and dispatches when it is complete.
      return facts | NET_READINESS.SEND_READY;
    }

    if (conn.error) facts |= NET_READINESS.ERROR;
    if (conn.clientDownstreamBuf.length > 0) facts |= NET_READINESS.RECV_READY;
    if (conn.closed && conn.clientDownstreamBuf.length === 0) {
      facts |= NET_READINESS.RECV_EOF | NET_READINESS.HANGUP;
    }
    if (conn.closed) {
      facts |= NET_READINESS.SEND_CLOSED;
    } else {
      facts |= NET_READINESS.SEND_READY;
    }
    return facts;
  }
}
