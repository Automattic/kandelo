import { afterEach, describe, expect, it } from "vitest";
import * as net from "node:net";
import { TcpNetworkBackend } from "../src/networking/tcp-backend";

const LOOPBACK = new Uint8Array([127, 0, 0, 1]);

async function listenLoopback(): Promise<{
  server: net.Server;
  port: number;
  accepted: Promise<{ data: string; ended: boolean }>;
}> {
  let resolveAccepted!: (value: { data: string; ended: boolean }) => void;
  let rejectAccepted!: (error: unknown) => void;
  const accepted = new Promise<{ data: string; ended: boolean }>((resolve, reject) => {
    resolveAccepted = resolve;
    rejectAccepted = reject;
  });

  const server = net.createServer((socket) => {
    const chunks: Buffer[] = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () => {
      resolveAccepted({ data: Buffer.concat(chunks).toString("utf8"), ended: true });
    });
    socket.on("error", rejectAccepted);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  return {
    server,
    port: (server.address() as net.AddressInfo).port,
    accepted,
  };
}

async function waitForConnected(backend: TcpNetworkBackend, handle: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const status = backend.connectStatus(handle);
    if (status === 0) return;
    if (status > 0) throw new Error(`connect failed with errno ${status}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("connect timed out");
}

describe("TcpNetworkBackend hostname parsing", () => {
  it.each([
    ["2130706433", [127, 0, 0, 1]],
    ["127.1", [127, 0, 0, 1]],
    ["127.1.1", [127, 1, 0, 1]],
    ["127.0.0.1", [127, 0, 0, 1]],
  ])("resolves the decimal IPv4 form %s without DNS", (hostname, expected) => {
    const backend = new TcpNetworkBackend();
    expect(Array.from(backend.getaddrinfo(hostname))).toEqual(expected);
  });

  it.each([
    "4294967296",
    "1..2",
    "1.2.3.256",
    ".example.com",
    "foo_bar.localhost",
    `www.${"x".repeat(64)}.com`,
  ])("rejects the invalid hostname %s before DNS", (hostname) => {
    const backend = new TcpNetworkBackend();
    expect(() => backend.getaddrinfo(hostname)).toThrow("ENOENT");
  });
});

describe("TcpNetworkBackend", () => {
  const servers: net.Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
      server.close(() => resolve());
    })));
  });

  it("closes TCP sockets with an orderly FIN after queued bytes", async () => {
    const { server, port, accepted } = await listenLoopback();
    servers.push(server);

    const backend = new TcpNetworkBackend();
    backend.connect(7, LOOPBACK, port);
    await waitForConnected(backend, 7);

    expect(backend.send(7, new TextEncoder().encode("hello"), 0)).toBe(5);
    backend.close(7);

    await expect(accepted).resolves.toEqual({ data: "hello", ended: true });
  });
});
