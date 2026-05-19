/**
 * TLS-intercepting fetch network backend.
 *
 * Implements the NetworkIO interface by delegating:
 *   - Port 80  (HTTP)  : buffered fetch, same approach as FetchNetworkBackend
 *   - Port 443 (HTTPS) : TLS MITM via a worker thread running the vendored
 *                         WordPress Playground TLS 1.2 library
 *
 * The worker handles all async TLS / crypto / fetch operations on its own
 * event loop.  The main thread communicates using SharedArrayBuffer + Atomics.
 */

import { Worker } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { NetworkIO } from "../../../../host/src/types";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ------------------------------------------------------------------ types

interface HttpConnectionState {
    kind: "http";
    ip: Uint8Array;
    port: number;
    hostname: string;
    sendBuf: Uint8Array;
    responseBuf: Uint8Array | null;
    responseOffset: number;
    fetchDone: boolean;
    fetchError: Error | null;
}

interface TlsConnectionState {
    kind: "tls";
    ip: Uint8Array;
    port: number;
    hostname: string;
}

type ConnectionState = HttpConnectionState | TlsConnectionState;

// ------------------------------------------------------------------ helpers

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
            headers.set(lines[i].substring(0, colon).trim(), lines[i].substring(colon + 1).trim());
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
        if (key.toLowerCase() === "transfer-encoding") return;
        headerStr += `${key}: ${value}\r\n`;
    });
    if (!headers.has("content-length")) {
        headerStr += `Content-Length: ${bodyBytes.length}\r\n`;
    }
    headerStr += "\r\n";

    const headerBytes = new TextEncoder().encode(headerStr);
    const result = new Uint8Array(headerBytes.length + bodyBytes.length);
    result.set(headerBytes);
    result.set(bodyBytes, headerBytes.length);
    return result;
}

// ------------------------------------------------------------------ backend

export interface TlsFetchBackendOptions {
    fetchFn?: typeof fetch;
}

export class TlsFetchBackend implements NetworkIO {
    private connections = new Map<number, ConnectionState>();
    private hostnameToIp = new Map<string, Uint8Array>();
    private ipToHostname = new Map<string, string>();
    private fetchFn: typeof fetch;

    // Worker communication
    private worker: Worker;
    private cmdBuf: SharedArrayBuffer;
    private cmdView: Int32Array;
    private dataBuf: SharedArrayBuffer;
    private dataView: Uint8Array;

    private caCertPEM = "";
    private initialized = false;

    constructor(options?: TlsFetchBackendOptions) {
        this.fetchFn = options?.fetchFn ?? globalThis.fetch;

        // 32 bytes for command metadata (5 Int32s + padding)
        this.cmdBuf = new SharedArrayBuffer(32);
        this.cmdView = new Int32Array(this.cmdBuf);
        // 256 KB for data transfer
        this.dataBuf = new SharedArrayBuffer(262144);
        this.dataView = new Uint8Array(this.dataBuf);

        // Load bundled worker code
        const workerBundlePath = join(__dirname, "tls-worker-bundle.js");
        const workerCode = readFileSync(workerBundlePath, "utf-8");

        this.worker = new Worker(workerCode, { eval: true });
        this.worker.postMessage({ cmdBuf: this.cmdBuf, dataBuf: this.dataBuf });
    }

    /**
     * Initialize the MITM CA. Must be called before any TLS connections.
     * Blocks until the CA keypair and certificate are generated.
     */
    init(): void {
        if (this.initialized) return;
        const pemLen = this.execCommand(6, 0, 0, 30000);
        this.caCertPEM = new TextDecoder().decode(this.dataView.slice(0, pemLen));
        this.initialized = true;
    }

    /**
     * Returns the PEM-encoded CA certificate for loading into the wasm VFS.
     * Call init() first.
     */
    getCACertPEM(): string {
        if (!this.initialized) {
            this.init();
        }
        return this.caCertPEM;
    }

    // ---- NetworkIO implementation ----

    getaddrinfo(hostname: string): Uint8Array {
        // Generate synthetic IP
        const ip = this.syntheticIp(hostname);
        this.hostnameToIp.set(hostname, ip);
        this.ipToHostname.set(this.ipKey(ip), hostname);
        return ip;
    }

    connect(handle: number, addr: Uint8Array, port: number): void {
        const hostname = this.ipToHostname.get(this.ipKey(addr)) ||
            `${addr[0]}.${addr[1]}.${addr[2]}.${addr[3]}`;

        if (port === 443) {
            // Ensure CA is initialized
            if (!this.initialized) {
                this.init();
            }

            // Store connection metadata
            this.connections.set(handle, {
                kind: "tls",
                ip: new Uint8Array(addr),
                port,
                hostname,
            });

            // Send connect to worker with hostname
            const hostnameBytes = new TextEncoder().encode(hostname);
            this.dataView[0] = addr[0];
            this.dataView[1] = addr[1];
            this.dataView[2] = addr[2];
            this.dataView[3] = addr[3];
            // Encode hostname length as 2 bytes at offset 4
            this.dataView[4] = (hostnameBytes.length >> 8) & 0xff;
            this.dataView[5] = hostnameBytes.length & 0xff;
            this.dataView.set(hostnameBytes, 6);
            this.execCommand(1, handle, port, 30000);
        } else {
            // HTTP — local handling
            this.connections.set(handle, {
                kind: "http",
                ip: new Uint8Array(addr),
                port,
                hostname,
                sendBuf: new Uint8Array(0),
                responseBuf: null,
                responseOffset: 0,
                fetchDone: false,
                fetchError: null,
            });
        }
    }

    send(handle: number, data: Uint8Array, flags: number): number {
        const conn = this.connections.get(handle);
        if (!conn) throw new Error("ENOTCONN");

        if (conn.kind === "tls") {
            // Forward encrypted data to worker
            this.dataView.set(data, 0);
            return this.execCommand(2, handle, data.length, 30000);
        }

        // HTTP: buffer raw request and issue fetch when complete
        return this.httpSend(conn, data);
    }

    recv(handle: number, maxLen: number, flags: number): Uint8Array {
        const conn = this.connections.get(handle);
        if (!conn) throw new Error("ENOTCONN");

        if (conn.kind === "tls") {
            // Read encrypted data from worker
            const n = this.execCommand(3, handle, maxLen, 30000);
            if (n <= 0) return new Uint8Array(0);
            return new Uint8Array(this.dataView.slice(0, n));
        }

        // HTTP
        return this.httpRecv(conn, maxLen);
    }

    close(handle: number): void {
        const conn = this.connections.get(handle);
        if (!conn) return;

        if (conn.kind === "tls") {
            this.execCommand(4, handle, 0, 5000);
        }

        this.connections.delete(handle);
    }

    /** Terminate the worker thread. Call when the backend is no longer needed. */
    terminate(): void {
        this.worker.terminate();
    }

    // ---- Shared command execution ----

    private execCommand(command: number, handle: number, param: number, timeoutMs = 30000): number {
        Atomics.store(this.cmdView, 1, command);
        Atomics.store(this.cmdView, 2, handle);
        Atomics.store(this.cmdView, 3, param);
        Atomics.store(this.cmdView, 4, 0);
        // Signal command ready
        Atomics.store(this.cmdView, 0, 1);
        Atomics.notify(this.cmdView, 0);

        // Wait for result
        const result = Atomics.wait(this.cmdView, 0, 1, timeoutMs);
        const flag = Atomics.load(this.cmdView, 0);
        const retVal = this.cmdView[4];

        // Reset to idle
        Atomics.store(this.cmdView, 0, 0);

        if (flag === -1) throw new Error(`Worker command ${command} failed`);
        if (flag !== 2 && result === "timed-out") throw new Error(`Worker command ${command} timed out`);
        return retVal;
    }

    // ---- HTTP handling (port 80) ----

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

        // Complete request — parse and fetch
        const { method, path, headers, body } = parseHttpRequest(conn.sendBuf, headerEnd);
        const host = headers.get("host") || headers.get("Host") || conn.hostname;
        const url = `http://${host}${path}`;

        const fetchHeaders = new Headers();
        for (const [key, value] of headers) {
            const lower = key.toLowerCase();
            if (lower !== "host" && lower !== "connection") {
                fetchHeaders.set(key, value);
            }
        }

        const fetchBody: Uint8Array<ArrayBuffer> | undefined =
            body && body.length > 0 ? new Uint8Array(body) as Uint8Array<ArrayBuffer> : undefined;

        // Synchronous fetch using Atomics.wait
        const sab = new SharedArrayBuffer(4);
        const flag = new Int32Array(sab);

        const doFetch = async () => {
            try {
                const response = await this.fetchFn(url, {
                    method,
                    headers: fetchHeaders,
                    body: method !== "GET" && method !== "HEAD" ? fetchBody : undefined,
                });

                conn.responseBuf = formatHttpResponse(
                    response.status,
                    response.statusText,
                    response.headers,
                    await response.arrayBuffer(),
                );
                conn.fetchDone = true;
            } catch (e) {
                conn.fetchError = e as Error;
                conn.fetchDone = true;
            }
            Atomics.store(flag, 0, 1);
            Atomics.notify(flag, 0);
        };

        doFetch();
        Atomics.wait(flag, 0, 0, 30000);

        if (conn.fetchError) throw conn.fetchError;

        return data.length;
    }

    private httpRecv(conn: HttpConnectionState, maxLen: number): Uint8Array {
        if (!conn.responseBuf) {
            if (conn.fetchError) throw conn.fetchError;
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
