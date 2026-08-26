import { Duplex } from "node:stream";
import {
  connect as tlsConnect,
  createServer as createTlsServer,
} from "node:tls";
import { afterEach, expect, it, vi } from "vitest";
import { EagainError } from "../src/networking/fetch-backend";
import { TlsNetworkBackend } from "../src/networking/tls-network-backend";
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
