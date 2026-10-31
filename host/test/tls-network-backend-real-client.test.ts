import { Duplex } from "node:stream";
import { gzipSync } from "node:zlib";
import {
  connect as tlsConnect,
  createServer as createTlsServer,
} from "node:tls";
import { afterEach, expect, it, vi } from "vitest";
import { CredentialGrants } from "../src/credential-grants";
import { EagainError } from "../src/networking/fetch-backend";
import { DEFAULT_BROWSER_CORS_PROXY_CONFIG } from "../../apps/browser-demos/lib/browser-cors-proxy";
import { CODEX_OBSERVED_REQUESTS } from "./fixtures/codex-observed-requests";
import {
  TlsNetworkBackend,
  type TlsMitmConnection,
} from "../src/networking/tls-network-backend";
import {
  certificateToPEM,
  generateCertificate,
  privateKeyToPEM,
} from "../../packages/registry/openssl/src/tls/certificates";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function appendBytes(existing: Uint8Array, incoming: Uint8Array): Uint8Array {
  const combined = new Uint8Array(existing.length + incoming.length);
  combined.set(existing);
  combined.set(incoming, existing.length);
  return combined;
}

function observeClientHelloSessionId(
  onSessionIdLength: (length: number) => void,
): (chunk: Uint8Array) => void {
  let pendingRecords = new Uint8Array();
  let handshakeBytes = new Uint8Array();
  let observed = false;

  return (chunk) => {
    if (observed) return;
    pendingRecords = appendBytes(pendingRecords, chunk);

    while (pendingRecords.length >= 5) {
      const recordLength = (pendingRecords[3] << 8) | pendingRecords[4];
      const recordEnd = 5 + recordLength;
      if (pendingRecords.length < recordEnd) return;

      if (pendingRecords[0] === 22) {
        handshakeBytes = appendBytes(
          handshakeBytes,
          pendingRecords.subarray(5, recordEnd),
        );
        if (handshakeBytes.length >= 39 && handshakeBytes[0] === 1) {
          // ClientHello starts with a four-byte handshake header, followed by
          // the two-byte version and 32-byte random. The next byte is the
          // session ID length that this regression specifically exercises.
          onSessionIdLength(handshakeBytes[38]);
          observed = true;
          return;
        }
      }

      pendingRecords = pendingRecords.slice(recordEnd);
    }
  };
}

function createTransport(
  backend: TlsNetworkBackend,
  handle: number,
  onClientBytes: (chunk: Uint8Array) => void,
): Duplex {
  let ended = false;
  let pumping = false;
  return new Duplex({
    read() {
      if (pumping) return;
      pumping = true;
      const pump = () => {
        if (ended) return;
        try {
          const bytes = backend.recv(handle, 64 * 1024, 0);
          if (bytes.length === 0) {
            ended = true;
            this.push(null);
            return;
          }
          this.push(Buffer.from(bytes));
        } catch (error) {
          if (!(error instanceof EagainError)) {
            this.destroy(error as Error);
            return;
          }
        }
        setImmediate(pump);
      };
      setImmediate(pump);
    },
    write(chunk, _encoding, callback) {
      try {
        onClientBytes(new Uint8Array(chunk));
        backend.send(handle, new Uint8Array(chunk), 0);
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
    destroy(error, callback) {
      ended = true;
      backend.close(handle);
      callback(error);
    },
  });
}

async function requestThroughBackend(
  backend: TlsNetworkBackend,
  handle: number,
  maxVersion: "TLSv1.2" | "TLSv1.3",
  session?: Buffer,
  requestHeaders = "",
): Promise<{
  response: string;
  clientHelloSessionIdLength: number;
}> {
  backend.connect(handle, backend.getaddrinfo("example.test"), 443);
  let clientHelloSessionIdLength: number | undefined;
  const transport = createTransport(
    backend,
    handle,
    observeClientHelloSessionId((length) => {
      clientHelloSessionIdLength = length;
    }),
  );

  const client = tlsConnect({
    socket: transport,
    servername: "example.test",
    rejectUnauthorized: false,
    minVersion: "TLSv1.2",
    maxVersion,
    session,
  });

  const response = await new Promise<string>((resolve, reject) => {
    let body = "";
    client.setEncoding("utf8");
    client.on("secureConnect", () => {
      client.write(
          "GET /proof HTTP/1.1\r\n" +
          "Host: example.test\r\n" +
          "Connection: close\r\n" +
          requestHeaders +
          "\r\n",
      );
    });
    client.on("data", (chunk) => {
      body += chunk;
    });
    client.on("end", () => resolve(body));
    client.on("error", reject);
  });
  if (clientHelloSessionIdLength === undefined) {
    throw new Error("OpenSSL ClientHello was not observed");
  }
  return { response, clientHelloSessionIdLength };
}

it.each([
  ["TLS 1.2 only", "TLSv1.2" as const, false],
  ["a TLS 1.3-capable ClientHello", "TLSv1.3" as const, true],
])(
  "completes a handshake with %s",
  async (_label, maxVersion, expectsCompatibilityId) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("hello from fetch")),
    );

    const backend = new TlsNetworkBackend();
    await backend.init();
    const { response, clientHelloSessionIdLength } =
      await requestThroughBackend(backend, 1, maxVersion);

    expect(response).toContain("HTTP/1.1 200");
    expect(response).toContain("hello from fetch");
    expect(clientHelloSessionIdLength > 0).toBe(expectsCompatibilityId);
  },
);

it("refuses resumption and gives OpenSSL a complete fresh handshake", async () => {
  const generated = await generateCertificate({
    subject: { commonName: "session-source.test" },
    keyUsage: { digitalSignature: true, keyEncipherment: true },
    extKeyUsage: { serverAuth: true },
    basicConstraints: { ca: false },
  });
  const key = await privateKeyToPEM(generated.keyPair.privateKey);
  const cert = certificateToPEM(generated.certificate);
  const server = createTlsServer(
    {
      key,
      cert,
      minVersion: "TLSv1.2",
      maxVersion: "TLSv1.2",
      ciphers: "ECDHE-RSA-AES128-GCM-SHA256",
    },
    (socket) => socket.end(),
  );
  const session = await (async () => {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("test TLS server did not bind a TCP port");
      }
      return await new Promise<Buffer>((resolve, reject) => {
        const client = tlsConnect({
          host: "127.0.0.1",
          port: address.port,
          servername: "example.test",
          rejectUnauthorized: false,
          minVersion: "TLSv1.2",
          maxVersion: "TLSv1.2",
          ciphers: "ECDHE-RSA-AES128-GCM-SHA256",
        });
        client.on("secureConnect", () => {
          const current = client.getSession();
          client.end();
          if (current === undefined) {
            reject(new Error("OpenSSL did not expose its TLS session"));
            return;
          }
          resolve(current);
        });
        client.on("error", reject);
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  })();

  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response("hello after resumption refusal")),
  );
  const backend = new TlsNetworkBackend();
  await backend.init();

  const { response, clientHelloSessionIdLength } = await requestThroughBackend(
    backend,
    2,
    "TLSv1.2",
    session,
  );
  expect(response).toContain("hello after resumption refusal");
  expect(clientHelloSessionIdLength).toBeGreaterThan(0);
});

it("serves multiple keep-alive requests over one MITM connection (git smart-HTTP shape)", async () => {
  // git-remote-http / libcurl reuse one HTTPS connection for ref discovery
  // (GET /info/refs) followed by the upload-pack POST. The MITM backend must
  // keep the connection open between responses instead of closing after the
  // first, or the second request is never answered and the clone stalls.
  const bodies = ["first-refs-advertisement", "second-pack-response"];
  let call = 0;
  const fetchMock = vi.fn().mockImplementation(() =>
    Promise.resolve(new Response(bodies[Math.min(call++, bodies.length - 1)])),
  );
  vi.stubGlobal("fetch", fetchMock);

  const backend = new TlsNetworkBackend();
  await backend.init();
  const handle = 7;
  backend.connect(handle, backend.getaddrinfo("example.test"), 443);
  const transport = createTransport(backend, handle, () => {});
  const client = tlsConnect({
    socket: transport,
    servername: "example.test",
    rejectUnauthorized: false,
    minVersion: "TLSv1.2",
    maxVersion: "TLSv1.2",
  });

  const combined = await new Promise<string>((resolve, reject) => {
    let buf = "";
    let sentSecond = false;
    client.setEncoding("utf8");
    client.on("secureConnect", () => {
      client.write(
        "GET /info/refs?service=git-upload-pack HTTP/1.1\r\n" +
          "Host: example.test\r\n" +
          "Connection: keep-alive\r\n\r\n",
      );
    });
    client.on("data", (chunk) => {
      buf += chunk;
      if (!sentSecond && buf.includes(bodies[0])) {
        sentSecond = true;
        client.write(
          "POST /git-upload-pack HTTP/1.1\r\n" +
            "Host: example.test\r\n" +
            "Content-Type: application/x-git-upload-pack-request\r\n" +
            "Content-Length: 4\r\n" +
            "Connection: keep-alive\r\n\r\nwant",
        );
      }
      if (buf.includes(bodies[1])) {
        client.end();
        resolve(buf);
      }
    });
    client.on("error", reject);
  });

  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(combined).toContain(bodies[0]);
  expect(combined).toContain(bodies[1]);
  expect(fetchMock.mock.calls[0][0] as string).toContain("/info/refs");
  expect(fetchMock.mock.calls[1][0] as string).toContain("/git-upload-pack");
});

it("decodes a gzip Content-Encoding POST body so it traverses the CORS proxy", async () => {
  // git gzip-compresses the git-upload-pack fetch command and sets
  // Content-Encoding: gzip. A proxy whose profile does not carry that field
  // (the Playground proxy's preflight does not allow it yet) would refuse a
  // faithful pass-through, so the MITM decodes gzip to identity and drops
  // Content-Encoding. Other encodings are relayed verbatim (below).
  const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
  vi.stubGlobal("fetch", fetchMock);
  const backend = new TlsNetworkBackend({
    corsProxy: {
      url: "https://proxy.example/?",
      allowedRequestHeaderNames: ["accept", "content-type", "git-protocol"],
      allowAnonymousGetHeaderOmission: true,
    },
  });
  await backend.init();
  const handle = 11;
  backend.connect(handle, backend.getaddrinfo("example.test"), 443);
  const transport = createTransport(backend, handle, () => {});
  const client = tlsConnect({
    socket: transport,
    servername: "example.test",
    rejectUnauthorized: false,
    minVersion: "TLSv1.2",
    maxVersion: "TLSv1.2",
  });

  const gz = gzipSync(Buffer.from("0011command=fetch0000"));
  await new Promise<void>((resolve, reject) => {
    client.on("secureConnect", () => {
      const head = Buffer.from(
        "POST /git-upload-pack HTTP/1.1\r\n" +
          "Host: example.test\r\n" +
          "Content-Type: application/x-git-upload-pack-request\r\n" +
          "git-protocol: version=2\r\n" +
          "Content-Encoding: gzip\r\n" +
          `Content-Length: ${gz.length}\r\n` +
          "Connection: close\r\n\r\n",
      );
      client.write(Buffer.concat([head, gz]));
    });
    client.on("data", () => {});
    client.on("end", () => resolve());
    client.on("error", reject);
  });

  // No BrowserCorsProxyRequestError — the request reached fetch.
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [fetchUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(fetchUrl).toBe("https://proxy.example/?https://example.test/git-upload-pack");
  expect(new TextDecoder().decode(init.body as Uint8Array)).toBe("0011command=fetch0000");
  expect((init.headers as Headers).has("content-encoding")).toBe(false);
  expect((init.headers as Headers).get("git-protocol")).toBe("version=2");
});

it("reassembles a chunked request body before issuing the fetch", async () => {
  // git streams a large upload-pack negotiation as Transfer-Encoding: chunked.
  // The MITM must dechunk it into a plain body rather than forwarding the raw
  // chunk framing, which the origin would reject.
  const fetchMock = vi.fn().mockResolvedValue(new Response("pack data"));
  vi.stubGlobal("fetch", fetchMock);
  const backend = new TlsNetworkBackend();
  await backend.init();
  const handle = 9;
  backend.connect(handle, backend.getaddrinfo("example.test"), 443);
  const transport = createTransport(backend, handle, () => {});
  const client = tlsConnect({
    socket: transport,
    servername: "example.test",
    rejectUnauthorized: false,
    minVersion: "TLSv1.2",
    maxVersion: "TLSv1.2",
  });

  await new Promise<void>((resolve, reject) => {
    client.setEncoding("utf8");
    client.on("secureConnect", () => {
      // Two chunks ("want" + "-more") then the terminating zero-chunk.
      client.write(
        "POST /git-upload-pack HTTP/1.1\r\n" +
          "Host: example.test\r\n" +
          "Content-Type: application/x-git-upload-pack-request\r\n" +
          "Transfer-Encoding: chunked\r\n" +
          "Connection: close\r\n\r\n" +
          "4\r\nwant\r\n5\r\n-more\r\n0\r\n\r\n",
      );
    });
    client.on("data", () => {});
    client.on("end", () => resolve());
    client.on("error", reject);
  });

  expect(fetchMock).toHaveBeenCalledTimes(1);
  const sentBody = (fetchMock.mock.calls[0][1] as RequestInit).body as Uint8Array;
  expect(new TextDecoder().decode(sentBody)).toBe("want-more");
});

it("preserves repeated decrypted request fields through the real TLS client path", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response("ordered fields"));
  vi.stubGlobal("fetch", fetchMock);
  const backend = new TlsNetworkBackend();
  await backend.init();

  await requestThroughBackend(
    backend,
    3,
    "TLSv1.2",
    undefined,
    "X-Repeat: first\r\nx-repeat: second\r\n",
  );

  expect(((fetchMock.mock.calls[0][1] as RequestInit).headers as Headers).get("x-repeat"))
    .toBe("first, second");
});

// ---------------------------------------------------------------------------
// Credential grants: a request belongs to the process whose system call wrote
// its bytes, and to the grant that process held when it wrote them, never to
// the process that opened the connection.

const GRANTED_PID = 41;
const OTHER_PID = 42;
const CODEX_DESTINATIONS = ["https://chatgpt.com"];
const TLS_APPLICATION_DATA = 23;

/** Kernel stand-in for the grant id each pid holds (0 = none). */
function grantTable(): CredentialGrants {
  const ids = new Map<number, number>();
  return new CredentialGrants({
    setCredentialGrant: (pid, grant) => {
      ids.set(pid, grant);
      return true;
    },
    getCredentialGrant: (pid) => ids.get(pid) ?? 0,
  });
}

function tlsRecords(bytes: Uint8Array): Array<{ type: number; record: Uint8Array }> {
  const records: Array<{ type: number; record: Uint8Array }> = [];
  let offset = 0;
  while (offset + 5 <= bytes.length) {
    const end = offset + 5 + ((bytes[offset + 3] << 8) | bytes[offset + 4]);
    records.push({ type: bytes[offset], record: bytes.subarray(offset, end) });
    offset = end;
  }
  if (offset !== bytes.length) throw new Error("transport chunk split a TLS record");
  return records;
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface CredentialedRun {
  /** Everything the guest client received. */
  response: Promise<string>;
  fetchMock: ReturnType<typeof vi.fn>;
  grants: CredentialGrants;
  /** Application-data records the guest has sent so far. */
  applicationRecordsSent: () => number;
}

/**
 * Drive OpenSSL through the backend while `writerFor` names the process the
 * kernel is serving for each record the client writes: the test plays the
 * kernel, whose `send` the backend sees with the writer's pid current.
 */
async function startCredentialedRequest(options: {
  host: string;
  requestParts: ReadonlyArray<string | Uint8Array>;
  writerFor: (recordType: number) => number;
  /** Grant GRANTED_PID before any byte is written (default true). */
  grantFirst?: boolean;
  fetchImpl?: () => Promise<Response>;
  /** The proxy profile's relayed fields (default: accept, content-type). */
  allowedRequestHeaderNames?: readonly string[];
}): Promise<CredentialedRun> {
  const fetchMock = vi.fn(options.fetchImpl ?? (async () => new Response("granted reply")));
  vi.stubGlobal("fetch", fetchMock);
  const grants = grantTable();
  if (options.grantFirst ?? true) grants.issue(GRANTED_PID, CODEX_DESTINATIONS);
  let servingPid = 0;
  let applicationRecords = 0;
  const backend = new TlsNetworkBackend({
    corsProxy: {
      url: "https://proxy.example/?",
      allowedRequestHeaderNames: options.allowedRequestHeaderNames ?? ["accept", "content-type"],
      allowAnonymousGetHeaderOmission: true,
    },
    currentPid: () => servingPid,
    peekCredentialGrantId: (pid) => grants.peekGrantId(pid),
    credentialGrantFor: (pid, grantId, origin) => grants.tagFor(pid, grantId, origin),
  });
  await backend.init();
  const handle = 21;
  // The granted process opens the connection and does the handshake.
  servingPid = GRANTED_PID;
  backend.connect(handle, backend.getaddrinfo(options.host), 443);
  servingPid = 0;
  let ended = false;
  const transport = new Duplex({
    read() {
      const pump = () => {
        if (ended) return;
        try {
          const bytes = backend.recv(handle, 64 * 1024, 0);
          if (bytes.length === 0) {
            ended = true;
            this.push(null);
            return;
          }
          this.push(Buffer.from(bytes));
        } catch (error) {
          if (!(error instanceof EagainError)) {
            this.destroy(error as Error);
            return;
          }
          setImmediate(pump);
        }
      };
      setImmediate(pump);
    },
    write(chunk, _encoding, callback) {
      try {
        for (const { type, record } of tlsRecords(new Uint8Array(chunk))) {
          servingPid = options.writerFor(type);
          backend.send(handle, new Uint8Array(record), 0);
          servingPid = 0;
          if (type === TLS_APPLICATION_DATA) applicationRecords += 1;
        }
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
    destroy(error, callback) {
      ended = true;
      backend.close(handle);
      callback(error);
    },
  });
  const client = tlsConnect({
    socket: transport,
    servername: options.host,
    rejectUnauthorized: false,
    minVersion: "TLSv1.2",
    maxVersion: "TLSv1.2",
  });
  const response = new Promise<string>((resolve, reject) => {
    let body = "";
    client.setEncoding("utf8");
    client.on("secureConnect", () => {
      for (const part of options.requestParts) client.write(part);
    });
    client.on("data", (chunk) => {
      body += chunk;
    });
    client.on("end", () => resolve(body));
    client.on("error", reject);
  });
  return {
    response,
    fetchMock,
    grants,
    applicationRecordsSent: () => applicationRecords,
  };
}

async function credentialedRequest(
  host: string,
  requestParts: readonly string[],
  writerFor: (recordType: number) => number,
): Promise<{ response: string; fetchMock: ReturnType<typeof vi.fn>; token: string }> {
  const run = await startCredentialedRequest({ host, requestParts, writerFor });
  const response = await run.response;
  return {
    response,
    fetchMock: run.fetchMock,
    token: run.grants.grantFor(GRANTED_PID)!.token,
  };
}

function codexRequest(host: string, connection = "close"): string {
  return (
    "POST /backend-api/codex/responses HTTP/1.1\r\n" +
    `Host: ${host}\r\n` +
    "Authorization: Bearer secret\r\n" +
    "ChatGPT-Account-ID: account-1\r\n" +
    "Content-Type: application/json\r\n" +
    "Content-Length: 2\r\n" +
    `Connection: ${connection}\r\n\r\n{}`
  );
}

function plainRequest(host: string): string {
  return `GET /models HTTP/1.1\r\nHost: ${host}\r\nConnection: keep-alive\r\n\r\n`;
}

it("sends a granted process's credentials to its destination with the opt-in and the tag", async () => {
  const { response, fetchMock, token } = await credentialedRequest(
    "chatgpt.com",
    [codexRequest("chatgpt.com")],
    () => GRANTED_PID,
  );
  expect(response).toContain("HTTP/1.1 200");
  expect(response).toContain("granted reply");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("https://proxy.example/?https://chatgpt.com/backend-api/codex/responses");
  const headers = new Headers(init.headers);
  expect(headers.get("authorization")).toBe("Bearer secret");
  expect(headers.get("chatgpt-account-id")).toBe("account-1");
  expect(headers.get("x-cors-proxy-allowed-request-headers")).toBe("Authorization");
  expect(headers.get("x-kandelo-credential-grant")).toBe(token);
});

it("refuses a granted process's credentials to an origin it was not granted", async () => {
  const { response, fetchMock } = await credentialedRequest(
    "example.com",
    [codexRequest("example.com")],
    () => GRANTED_PID,
  );
  expect(fetchMock).not.toHaveBeenCalled();
  expect(response).toContain("HTTP/1.1 502");
  expect(response).toContain("unsupported request headers: authorization, chatgpt-account-id");
});

it("refuses credentials from a process that holds no grant", async () => {
  const { response, fetchMock } = await credentialedRequest(
    "chatgpt.com",
    [codexRequest("chatgpt.com")],
    () => OTHER_PID,
  );
  expect(fetchMock).not.toHaveBeenCalled();
  expect(response).toContain("HTTP/1.1 502");
});

it("attributes a request to the process that wrote it, not the one that connected", async () => {
  // The granted process connected and completed the handshake; another
  // process (a child holding the inherited socket) writes the request.
  const { response, fetchMock } = await credentialedRequest(
    "chatgpt.com",
    [codexRequest("chatgpt.com")],
    (type) => type === TLS_APPLICATION_DATA ? OTHER_PID : GRANTED_PID,
  );
  expect(fetchMock).not.toHaveBeenCalled();
  expect(response).toContain("HTTP/1.1 502");
});

it("refuses credentials for a request whose bytes more than one process wrote", async () => {
  const request = codexRequest("chatgpt.com");
  const split = request.indexOf("ChatGPT-Account-ID");
  const writers = [GRANTED_PID, OTHER_PID];
  const { response, fetchMock } = await credentialedRequest(
    "chatgpt.com",
    [request.slice(0, split), request.slice(split)],
    (type) => type === TLS_APPLICATION_DATA ? writers.shift() ?? OTHER_PID : GRANTED_PID,
  );
  expect(fetchMock).not.toHaveBeenCalled();
  expect(response).toContain("HTTP/1.1 502");
});

it("judges each keep-alive request on one connection by its own writer", async () => {
  // Pipelined: the second request waits in the backend's plaintext buffer
  // while the first is answered.
  const writers = [GRANTED_PID, OTHER_PID];
  const { response, fetchMock } = await credentialedRequest(
    "chatgpt.com",
    [codexRequest("chatgpt.com", "keep-alive"), codexRequest("chatgpt.com")],
    (type) => type === TLS_APPLICATION_DATA ? writers.shift() ?? OTHER_PID : GRANTED_PID,
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(response).toContain("HTTP/1.1 200");
  expect(response).toContain("HTTP/1.1 502");
});

/**
 * A request written while another response is pending waits in the
 * plaintext buffer. Hold the first response, let `change` run after the
 * second request's bytes were written but before it is dispatched, then
 * release the first response.
 */
async function grantChangesBeforeDispatch(
  writer: number,
  grantFirst: boolean,
  change: (grants: CredentialGrants) => void,
): Promise<{ response: string; fetchMock: ReturnType<typeof vi.fn> }> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const writers = [GRANTED_PID, writer];
  const run = await startCredentialedRequest({
    host: "chatgpt.com",
    requestParts: [plainRequest("chatgpt.com"), codexRequest("chatgpt.com")],
    writerFor: (type) => type === TLS_APPLICATION_DATA ? writers.shift() ?? writer : GRANTED_PID,
    grantFirst,
    fetchImpl: async () => {
      if (calls++ === 0) await held;
      return new Response("reply");
    },
  });
  await until(() => run.fetchMock.mock.calls.length === 1 && run.applicationRecordsSent() >= 2);
  change(run.grants);
  release();
  return { response: await run.response, fetchMock: run.fetchMock };
}

it("refuses a request whose writer gained a grant after writing it (exec into a declared program)", async () => {
  // OTHER_PID wrote the credentialed request holding no grant, then exec'd
  // a declared program (same pid) and was granted before dispatch.
  const { response, fetchMock } = await grantChangesBeforeDispatch(
    OTHER_PID,
    true,
    (grants) => { grants.issue(OTHER_PID, CODEX_DESTINATIONS); },
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(response).toContain("HTTP/1.1 502");
});

it("refuses a request whose writer's grant was replaced after writing it", async () => {
  const { response, fetchMock } = await grantChangesBeforeDispatch(
    GRANTED_PID,
    true,
    (grants) => { grants.issue(GRANTED_PID, CODEX_DESTINATIONS); },
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(response).toContain("HTTP/1.1 502");
});

it("sends a queued request under the grant its writer held when writing it", async () => {
  const { response, fetchMock } = await grantChangesBeforeDispatch(
    GRANTED_PID,
    true,
    () => {},
  );
  expect(fetchMock).toHaveBeenCalledTimes(2);
  const headers = new Headers((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].headers);
  expect(headers.get("authorization")).toBe("Bearer secret");
  expect(response).not.toContain("HTTP/1.1 502");
});

function tlsRecord(type: number, payload: ArrayLike<number>): Uint8Array {
  const bytes = new Uint8Array(5 + payload.length);
  bytes.set([type, 3, 3, payload.length >> 8, payload.length & 0xff]);
  bytes.set(payload, 5);
  return bytes;
}

/**
 * A ServerHello handshake record. `supportedVersion` adds the
 * supported_versions extension, which is how a TLS 1.3 server says it
 * chose 1.3 (its legacy version field still reads TLS 1.2).
 */
function serverHelloRecord(supportedVersion?: number): Uint8Array {
  const extensions = supportedVersion === undefined
    ? []
    : [0x00, 0x2b, 0x00, 0x02, supportedVersion >> 8, supportedVersion & 0xff];
  const body = [
    0x03, 0x03, ...new Array<number>(32).fill(7), 0, 0x13, 0x01, 0,
    extensions.length >> 8, extensions.length & 0xff, ...extensions,
  ];
  return tlsRecord(22, [2, 0, body.length >> 8, body.length & 0xff, ...body]);
}

/**
 * A TLS engine stand-in that frames without encrypting: it sends the guest
 * `serverRecords` as its handshake, then hands the backend each
 * application-data record's payload as one plaintext chunk, as the TLS 1.2
 * engine does after decrypting. It shows what the backend does with the
 * version the engine negotiated, which the real TLS 1.2 engine cannot vary.
 */
class FramingOnlyTls implements TlsMitmConnection {
  clientEnd = {
    upstream: new TransformStream<Uint8Array, Uint8Array>(),
    downstream: new TransformStream<Uint8Array, Uint8Array>(),
  };
  serverEnd = {
    upstream: new TransformStream<Uint8Array, Uint8Array>(),
    downstream: new TransformStream<Uint8Array, Uint8Array>(),
  };

  constructor(serverRecords: Uint8Array) {
    const toGuest = this.clientEnd.downstream.writable.getWriter();
    if (serverRecords.length > 0) void toGuest.write(serverRecords);
    const plaintext = this.serverEnd.upstream.writable.getWriter();
    let pending = new Uint8Array();
    void this.clientEnd.upstream.readable.pipeTo(new WritableStream({
      async write(chunk) {
        pending = appendBytes(pending, chunk);
        while (pending.length >= 5) {
          const end = 5 + ((pending[3] << 8) | pending[4]);
          if (pending.length < end) break;
          if (pending[0] === TLS_APPLICATION_DATA) await plaintext.write(pending.slice(5, end));
          pending = pending.slice(end);
        }
      },
    })).catch(() => {});
    void this.serverEnd.downstream.readable.pipeTo(new WritableStream({
      async write(chunk) {
        await toGuest.write(tlsRecord(TLS_APPLICATION_DATA, chunk));
      },
    })).catch(() => {});
  }

  async TLSHandshake(): Promise<void> {}
  async close(): Promise<void> {}
}

it.each([
  ["TLS 1.2", serverHelloRecord(), true],
  ["TLS 1.3 (supported_versions)", serverHelloRecord(0x0304), false],
  ["a ServerHello the backend cannot read", tlsRecord(22, [2, 0, 0, 3, 3, 3, 0]), false],
  ["no ServerHello at all", new Uint8Array(), false],
])(
  "grants a request only on a connection the engine negotiated as TLS 1.2: %s",
  async (_label, serverRecords, granted) => {
    const fetchMock = vi.fn(async () => new Response("granted reply"));
    vi.stubGlobal("fetch", fetchMock);
    const grants = grantTable();
    grants.issue(GRANTED_PID, CODEX_DESTINATIONS);
    let servingPid = 0;
    const backend = new TlsNetworkBackend({
      corsProxy: {
        url: "https://proxy.example/?",
        allowedRequestHeaderNames: ["accept", "content-type"],
        allowAnonymousGetHeaderOmission: true,
      },
      currentPid: () => servingPid,
      peekCredentialGrantId: (pid) => grants.peekGrantId(pid),
      credentialGrantFor: (pid, grantId, origin) => grants.tagFor(pid, grantId, origin),
      createTlsConnection: () => new FramingOnlyTls(serverRecords),
    });
    await backend.init();
    const handle = 31;
    backend.connect(handle, backend.getaddrinfo("chatgpt.com"), 443);
    await new Promise((resolve) => setTimeout(resolve, 0));
    servingPid = GRANTED_PID;
    backend.send(
      handle,
      tlsRecord(TLS_APPLICATION_DATA, new TextEncoder().encode(codexRequest("chatgpt.com"))),
      0,
    );
    servingPid = 0;
    let received = "";
    await until(() => {
      try {
        received += new TextDecoder("latin1").decode(backend.recv(handle, 64 * 1024, 0));
      } catch (error) {
        if (!(error instanceof EagainError)) throw error;
      }
      return received.includes("HTTP/1.1 ");
    });
    if (granted) {
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer secret");
      expect(received).toContain("HTTP/1.1 200");
    } else {
      expect(fetchMock).not.toHaveBeenCalled();
      expect(received).toContain("HTTP/1.1 502");
    }
    backend.close(handle);
  },
);

it("refuses credentials on a TLS connection when no CORS proxy is configured", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response("must not be sent"));
  vi.stubGlobal("fetch", fetchMock);
  const backend = new TlsNetworkBackend();
  await backend.init();
  const { response } = await requestThroughBackend(
    backend,
    22,
    "TLSv1.2",
    undefined,
    "Authorization: Bearer secret\r\n",
  );
  expect(fetchMock).not.toHaveBeenCalled();
  expect(response).toContain("HTTP/1.1 502");
  expect(response).toContain("credential request headers: authorization");
});

/** Codex's observed request as the guest writes it, with `body` sent as is. */
function codexObservedRequest(
  request: (typeof CODEX_OBSERVED_REQUESTS)[keyof typeof CODEX_OBSERVED_REQUESTS],
  body: Uint8Array = new Uint8Array(),
): Uint8Array {
  const url = new URL(request.url);
  let head = `${request.method} ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\n`;
  let hasConnection = false;
  for (const [name, value] of request.headers) {
    if (name.toLowerCase() === "content-length") continue;
    if (name.toLowerCase() === "connection") hasConnection = true;
    head += `${name}: ${value}\r\n`;
  }
  if (body.length > 0) head += `Content-Length: ${body.length}\r\n`;
  if (!hasConnection) head += "Connection: close\r\n";
  return Buffer.concat([Buffer.from(`${head}\r\n`), body]);
}

it("relays a granted Codex turn's zstd body byte-for-byte with its Content-Encoding", async () => {
  // Codex compresses every signed-in model turn with zstd. Kandelo relays
  // the compressed bytes and their encoding as written; it never decodes or
  // re-encodes them. The bytes include CR, LF, NUL and 0xFF, and the zstd
  // frame magic, to catch any text or framing treatment.
  const body = new Uint8Array([
    0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x0d, 0x0a, 0xff, 0x0d, 0x0a, 0x0d, 0x0a,
    0x30, 0x0d, 0x0a, 0x00, 0x7f, 0x80, 0xfe, 0x01,
  ]);
  const run = await startCredentialedRequest({
    host: "chatgpt.com",
    requestParts: [codexObservedRequest(CODEX_OBSERVED_REQUESTS.responses, body)],
    writerFor: () => GRANTED_PID,
    allowedRequestHeaderNames: DEFAULT_BROWSER_CORS_PROXY_CONFIG.allowedRequestHeaderNames,
  });
  const response = await run.response;
  const { fetchMock } = run;
  const token = run.grants.grantFor(GRANTED_PID)!.token;
  expect(response).toContain("HTTP/1.1 200");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("https://proxy.example/?https://chatgpt.com/backend-api/codex/responses");
  expect(init.method).toBe("POST");
  const sent = new Uint8Array(await new Response(init.body).arrayBuffer());
  expect(sent.length).toBe(body.length);
  expect([...sent]).toEqual([...body]);
  const headers = new Headers(init.headers);
  expect(headers.get("content-encoding")).toBe("zstd");
  // fetch() derives Content-Length from the body it is given.
  expect(headers.has("content-length")).toBe(false);
  for (const name of [
    "session-id", "thread-id", "x-codex-window-id", "x-codex-beta-features",
    "x-codex-routing-hint", "x-codex-turn-metadata", "x-codex-turn-state",
    "x-client-request-id", "originator", "version", "accept", "content-type",
  ]) {
    expect(headers.has(name), name).toBe(true);
  }
  expect(headers.get("authorization")).toBe("Bearer synthetic-access-token");
  expect(headers.get("x-kandelo-credential-grant")).toBe(token);
});

it("answers Codex's granted WebSocket handshake with 502 and sends nothing", async () => {
  const run = await startCredentialedRequest({
    host: "chatgpt.com",
    requestParts: [codexObservedRequest(CODEX_OBSERVED_REQUESTS.websocketHandshake)],
    writerFor: () => GRANTED_PID,
    allowedRequestHeaderNames: DEFAULT_BROWSER_CORS_PROXY_CONFIG.allowedRequestHeaderNames,
  });
  const response = await run.response;
  expect(run.fetchMock).not.toHaveBeenCalled();
  expect(response).toContain("HTTP/1.1 502");
  expect(response).toContain("upgrade the connection to WebSocket");
});
