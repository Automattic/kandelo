/**
 * TLS MITM Worker
 *
 * Runs in a separate worker thread with its own event loop, enabling
 * async TLS handshake / Web Crypto / fetch operations while the main
 * thread blocks on Atomics.wait.
 *
 * Protocol (SharedArrayBuffer):
 *   Int32[0]  flag   0=idle, 1=cmd-ready, 2=result-ready, -1=error
 *   Int32[1]  cmd    1=connect, 2=send, 3=recv, 4=close, 5=getaddrinfo, 6=init
 *   Int32[2]  handle
 *   Int32[3]  param  (port / len / maxLen / nameLen)
 *   Int32[4]  result (length or error code)
 *   Data buffer: separate 256 KB SharedArrayBuffer
 */

import { parentPort } from "node:worker_threads";
import { TLS_1_2_Connection } from "./tls/1_2/connection";
import {
    generateCertificate,
    certificateToPEM,
    type GeneratedCertificate,
} from "./tls/certificates";

// ------------------------------------------------------------------ types

interface ConnectionState {
    tls: TLS_1_2_Connection;
    hostname: string;
    port: number;
    handshakeDone: boolean;
    serverCertPrivateKey: CryptoKey;
    serverCertDER: Uint8Array;
    /** Encrypted data produced by TLS engine, waiting to be sent to client via recv() */
    clientDownstreamBuf: Uint8Array;
    /** Decrypted plaintext HTTP data received from client */
    plaintextBuf: Uint8Array;
    /** Whether the TLS connection has been closed */
    closed: boolean;
    /** Pending HTTP response being streamed back through TLS */
    httpResponsePending: boolean;
}

// ------------------------------------------------------------------ state

const connections = new Map<number, ConnectionState>();
let caKeyPair: CryptoKeyPair | null = null;
let caCert: GeneratedCertificate | null = null;
let caCertPEM = "";

/** Custom fetch function — can be overridden from the main thread */
let fetchFn: typeof globalThis.fetch = globalThis.fetch;

// Hostname <-> synthetic IP mapping (mirrors the main thread's map)
const hostnameToIp = new Map<string, Uint8Array>();
const ipToHostname = new Map<string, string>();

// ------------------------------------------------------------------ helpers

function concatBuffers(a: Uint8Array, b: Uint8Array): Uint8Array {
    const result = new Uint8Array(a.length + b.length);
    result.set(a);
    result.set(b, a.length);
    return result;
}

function ipKey(ip: Uint8Array): string {
    return `${ip[0]}.${ip[1]}.${ip[2]}.${ip[3]}`;
}

function syntheticIp(hostname: string): Uint8Array {
    let hash = 0;
    for (let i = 0; i < hostname.length; i++) {
        hash = ((hash << 5) - hash + hostname.charCodeAt(i)) | 0;
    }
    return new Uint8Array([10, (hash >> 16) & 0xff, (hash >> 8) & 0xff, hash & 0xff]);
}

/** Find \r\n\r\n in a buffer */
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

/** Wait for a condition with a timeout, allowing the event loop to run */
function waitForCondition(
    predicate: () => boolean,
    timeoutMs: number,
): Promise<boolean> {
    return new Promise((resolve) => {
        const start = Date.now();
        function check() {
            if (predicate()) {
                resolve(true);
                return;
            }
            if (Date.now() - start > timeoutMs) {
                resolve(false);
                return;
            }
            setTimeout(check, 1);
        }
        check();
    });
}

// ------------------------------------------------------------------ TLS connection setup

async function generateServerCert(hostname: string): Promise<{
    privateKey: CryptoKey;
    certDER: Uint8Array;
}> {
    if (!caKeyPair || !caCert) throw new Error("CA not initialized");

    const serverCert = await generateCertificate(
        {
            subject: { commonName: hostname },
            issuer: caCert.tbsDescription.subject,
            subjectAltNames: { dnsNames: [hostname] },
            keyUsage: { digitalSignature: true, keyEncipherment: true },
            extKeyUsage: { serverAuth: true },
            basicConstraints: { ca: false },
        },
        caKeyPair,
    );

    return {
        privateKey: serverCert.keyPair.privateKey,
        certDER: serverCert.certificate,
    };
}

async function setupTlsConnection(handle: number, hostname: string, port: number): Promise<void> {
    const { privateKey, certDER } = await generateServerCert(hostname);

    const tls = new TLS_1_2_Connection();
    const conn: ConnectionState = {
        tls,
        hostname,
        port,
        handshakeDone: false,
        serverCertPrivateKey: privateKey,
        serverCertDER: certDER,
        clientDownstreamBuf: new Uint8Array(0),
        plaintextBuf: new Uint8Array(0),
        closed: false,
        httpResponsePending: false,
    };
    connections.set(handle, conn);

    // Read encrypted data produced by the TLS engine (destined for client)
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
            // Stream closed or errored
        }
    })();

    // Read decrypted plaintext from the TLS engine (HTTP requests from client)
    const upstreamReader = tls.serverEnd.upstream.readable.getReader();
    (async () => {
        try {
            while (true) {
                const { value, done } = await upstreamReader.read();
                if (done) break;
                if (value && value.length > 0) {
                    conn.plaintextBuf = concatBuffers(conn.plaintextBuf, value);
                    // Check if we have a complete HTTP request
                    await tryProcessHttpRequest(handle);
                }
            }
        } catch {
            // Stream closed or errored
        }
    })();

    // Start TLS handshake (this will wait for ClientHello from the upstream writer)
    const handshakePromise = tls.TLSHandshake(
        privateKey,
        [certDER, caCert!.certificate],
    );

    handshakePromise.then(() => {
        conn.handshakeDone = true;
    }).catch((err) => {
        console.error(`[tls-worker] Handshake error for handle ${handle}:`, err);
        conn.closed = true;
    });
}

async function tryProcessHttpRequest(handle: number): Promise<void> {
    const conn = connections.get(handle);
    if (!conn || conn.httpResponsePending) return;

    const headerEnd = findHeaderEnd(conn.plaintextBuf);
    if (headerEnd === -1) return;

    const headerStr = new TextDecoder().decode(conn.plaintextBuf.subarray(0, headerEnd));
    const contentLength = parseContentLength(headerStr);
    const bodyStart = headerEnd + 4;
    const bodyReceived = conn.plaintextBuf.length - bodyStart;

    if (contentLength > 0 && bodyReceived < contentLength) return;

    // We have a complete HTTP request
    conn.httpResponsePending = true;

    const { method, path, headers, body } = parseHttpRequest(conn.plaintextBuf, headerEnd);

    // Consume the request from the buffer
    const totalRequestLen = headerEnd + 4 + Math.max(contentLength, 0);
    conn.plaintextBuf = conn.plaintextBuf.subarray(totalRequestLen);

    const host = headers.get("Host") || headers.get("host") || conn.hostname;
    const url = `https://${host}${path}`;

    const fetchHeaders = new Headers();
    for (const [key, value] of headers) {
        const lower = key.toLowerCase();
        if (lower !== "host" && lower !== "connection") {
            fetchHeaders.set(key, value);
        }
    }

    const fetchBody: Uint8Array<ArrayBuffer> | undefined =
        body && body.length > 0 ? new Uint8Array(body) as Uint8Array<ArrayBuffer> : undefined;

    try {
        const response = await fetchFn(url, {
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

        // Write the response to the server end downstream (gets TLS-encrypted automatically)
        const writer = conn.tls.serverEnd.downstream.writable.getWriter();
        await writer.write(responseBytes);
        writer.releaseLock();
    } catch (err) {
        // Send a 502 Bad Gateway response
        const errorBody = `Error fetching ${url}: ${err}`;
        const errorResponse = formatHttpResponse(
            502,
            "Bad Gateway",
            new Headers({ "Content-Type": "text/plain" }),
            new TextEncoder().encode(errorBody).buffer as ArrayBuffer,
        );

        try {
            const writer = conn.tls.serverEnd.downstream.writable.getWriter();
            await writer.write(errorResponse);
            writer.releaseLock();
        } catch {
            // Ignore write errors
        }
    }

    conn.httpResponsePending = false;
}

// ------------------------------------------------------------------ command loop

parentPort!.on("message", (msg: {
    cmdBuf: SharedArrayBuffer;
    dataBuf: SharedArrayBuffer;
    fetchFn?: string;
}) => {
    const cmd = new Int32Array(msg.cmdBuf);
    const data = new Uint8Array(msg.dataBuf);

    function signalResult(resultLen: number) {
        cmd[4] = resultLen;
        Atomics.store(cmd, 0, 2);
        Atomics.notify(cmd, 0);
    }

    function signalError(code: number = -1) {
        cmd[4] = code;
        Atomics.store(cmd, 0, -1);
        Atomics.notify(cmd, 0);
    }

    function loop() {
        Atomics.wait(cmd, 0, 0);
        if (cmd[0] !== 1) {
            if (cmd[0] === 2) Atomics.store(cmd, 0, 0);
            setImmediate(loop);
            return;
        }

        const command = cmd[1];
        const handle = cmd[2];
        const param = cmd[3];

        switch (command) {
            case 6: { // init — generate CA keypair and certificate
                (async () => {
                    try {
                        caCert = await generateCertificate({
                            subject: {
                                commonName: "WASM POSIX MITM CA",
                                organizationName: "WASM POSIX Kernel",
                            },
                            basicConstraints: { ca: true },
                            keyUsage: { keyCertSign: true, cRLSign: true },
                        });
                        caKeyPair = caCert.keyPair;
                        caCertPEM = certificateToPEM(caCert.certificate);
                        // Write PEM to data buffer
                        const pemBytes = new TextEncoder().encode(caCertPEM);
                        data.set(pemBytes, 0);
                        signalResult(pemBytes.length);
                    } catch (err) {
                        console.error("[tls-worker] init error:", err);
                        signalError();
                    }
                    setImmediate(loop);
                })();
                break;
            }

            case 5: { // getaddrinfo
                const nameLen = param;
                const hostname = new TextDecoder().decode(data.slice(0, nameLen));
                const ip = syntheticIp(hostname);
                hostnameToIp.set(hostname, ip);
                ipToHostname.set(ipKey(ip), hostname);
                data[0] = ip[0];
                data[1] = ip[1];
                data[2] = ip[2];
                data[3] = ip[3];
                signalResult(4);
                setImmediate(loop);
                break;
            }

            case 1: { // connect
                const port = param;
                const ip = new Uint8Array([data[0], data[1], data[2], data[3]]);
                const nameLen = (data[4] << 8) | data[5];
                const hostname = nameLen > 0
                    ? new TextDecoder().decode(data.slice(6, 6 + nameLen))
                    : ipToHostname.get(ipKey(ip)) || `${ip[0]}.${ip[1]}.${ip[2]}.${ip[3]}`;

                (async () => {
                    try {
                        await setupTlsConnection(handle, hostname, port);
                        signalResult(0);
                    } catch (err) {
                        console.error("[tls-worker] connect error:", err);
                        signalError();
                    }
                    setImmediate(loop);
                })();
                break;
            }

            case 2: { // send — write encrypted data from client into TLS engine
                const len = param;
                const sendData = new Uint8Array(data.slice(0, len));
                const conn = connections.get(handle);
                if (!conn) {
                    signalError();
                    setImmediate(loop);
                    break;
                }

                (async () => {
                    try {
                        // Write encrypted data from client into the TLS engine's client upstream
                        const writer = conn.tls.clientEnd.upstream.writable.getWriter();
                        await writer.write(sendData);
                        writer.releaseLock();

                        // Allow the event loop to process TLS streams
                        await new Promise((r) => setTimeout(r, 5));

                        signalResult(len);
                    } catch (err) {
                        console.error("[tls-worker] send error:", err);
                        signalError();
                    }
                    setImmediate(loop);
                })();
                break;
            }

            case 3: { // recv — return encrypted TLS data for the client
                const maxLen = param;
                const conn = connections.get(handle);
                if (!conn) {
                    signalError();
                    setImmediate(loop);
                    break;
                }

                (async () => {
                    try {
                        // Wait for data to become available (with timeout)
                        if (conn.clientDownstreamBuf.length === 0 && !conn.closed) {
                            await waitForCondition(
                                () => conn.clientDownstreamBuf.length > 0 || conn.closed,
                                10000,
                            );
                        }

                        const available = conn.clientDownstreamBuf.length;
                        const n = Math.min(maxLen, available);
                        if (n > 0) {
                            data.set(conn.clientDownstreamBuf.subarray(0, n), 0);
                            conn.clientDownstreamBuf = conn.clientDownstreamBuf.subarray(n);
                        }
                        signalResult(n);
                    } catch (err) {
                        console.error("[tls-worker] recv error:", err);
                        signalError();
                    }
                    setImmediate(loop);
                })();
                break;
            }

            case 4: { // close
                const conn = connections.get(handle);
                if (conn) {
                    conn.closed = true;
                    conn.tls.close().catch(() => {});
                    connections.delete(handle);
                }
                signalResult(0);
                setImmediate(loop);
                break;
            }

            default: {
                signalError();
                setImmediate(loop);
            }
        }
    }

    loop();
});
