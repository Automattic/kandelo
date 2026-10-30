import { MessageChannel } from "node:worker_threads";
/**
 * External HTTP request interface — prototype test.
 *
 * Boots NodeKernelHost with `tiny-http-server.wasm` (a single-shot HTTP/1.1
 * server in C) and uses `host.fetchInKernel(port, request)` to send a
 * request and verify the response. Bypasses real TCP — exercises the
 * `kernel_inject_connection` path directly through the host API.
 *
 * See docs/plans/2026-04-30-external-kernel-http-request-interface.md.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { NodeKernelHost } from "../src/node-kernel-host";
import { tryResolveBinary } from "../src/binary-resolver";
import {
  buildRawHttpRequest,
  parseRawHttpResponse,
  type HttpRequest,
} from "../src/networking";

const tinyServerPath = tryResolveBinary("programs/tiny-http-server.wasm");

function loadWasm(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/** Wait until the in-kernel server has bound + listened on `port`. The
 *  kernel-worker only registers a listener target after the user program
 *  reaches its `listen()` syscall, so `pickListenerTarget` is the readiness
 *  signal. Bridging via `fetchInKernel` retries the underlying lookup,
 *  so we just retry the whole call below. */
async function waitMs(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe.skipIf(!tinyServerPath)("external HTTP request interface", () => {
  it("sends a request to an in-kernel server and parses the response", async () => {
    const host = new NodeKernelHost({ maxWorkers: 4 });
    await host.init();

    const programBytes = loadWasm(tinyServerPath!);
    const PORT = 8085;

    // Spawn the server. We don't await its exit — it accepts one request
    // then exits. The fetchInKernel call is what drives that one request.
    const exitPromise = host.spawn(programBytes, ["tiny-http-server", String(PORT)]);

    try {
      // Poll fetchInKernel until the listener is ready (server hasn't
      // reached listen() yet on first try).
      let response: Awaited<ReturnType<typeof host.fetchInKernel>> | null = null;
      let lastError: unknown = null;
      for (let i = 0; i < 50; i++) {
        try {
          response = await host.fetchInKernel(
            PORT,
            {
              method: "GET",
              url: "/hello",
              headers: { Host: "kernel.local" },
              body: null,
            } satisfies HttpRequest,
            { timeoutMs: 5000 },
          );
          break;
        } catch (e) {
          lastError = e;
          await waitMs(100);
        }
      }
      if (!response) throw new Error(`fetchInKernel never succeeded: ${lastError}`);

      expect(response.status).toBe(200);
      expect(response.headers["X-Tiny-Server"]).toBe("1");
      expect(response.headers["Content-Type"]).toBe("application/json");

      const body = new TextDecoder().decode(response.body);
      expect(body).toBe('{"hello":"from-the-kernel","path":"/hello"}');

      // The server is single-shot — it should now exit cleanly.
      const exitCode = await Promise.race([
        exitPromise,
        new Promise<number>((_, rej) =>
          setTimeout(() => rej(new Error("server didn't exit after request")), 5000),
        ),
      ]);
      expect(exitCode).toBe(0);
    } finally {
      await host.destroy().catch(() => {});
    }
  }, 30_000);

  it("routes HTTP through a Kandelo peer and preserves the local listener path", async () => {
    const server = new NodeKernelHost({ maxWorkers: 4 });
    const client = new NodeKernelHost({ maxWorkers: 4 });
    try {
      await Promise.all([server.init(), client.init()]);
      await server.hostRemoteNetwork();
      const { port1, port2 } = new MessageChannel();
      await Promise.all([
        server.attachRemotePeer({ port: port1, maxPayload: 1200, maxControlBytes: 65536 }),
        client.joinRemoteNetwork({ port: port2, maxPayload: 1200, maxControlBytes: 65536 }),
      ]);
      for (const [destination, hostname, path] of [[server, "host", "/remote-peer"], [client, undefined, "/local-listener"]] as const) {
        const exit = destination.spawn(loadWasm(tinyServerPath!), ["tiny-http-server", "8086"]);
        await expect.poll(() => destination.pickListenerTarget(8086), { timeout: 10_000 }).not.toBeNull();
        const response = await client.fetchInKernel(8086, { method: "GET", url: path, headers: { Host: "host" }, body: null }, { hostname, timeoutMs: 10_000 });
        expect(response.status).toBe(200);
        expect(JSON.parse(new TextDecoder().decode(response.body)).path).toBe(path);
        expect(await exit).toBe(0);
      }
      await client.leaveRemoteNetwork();
      await expect(client.fetchInKernel(8086, { method: "GET", url: "/", headers: {}, body: null }, { hostname: "host" })).rejects.toThrow(/No Kandelo network session/);
    } finally { await Promise.all([server.destroy(), client.destroy()]); }
  }, 45_000);

  it("rejects with a clear error when no listener is bound on the port", async () => {
    const host = new NodeKernelHost({ maxWorkers: 4 });
    await host.init();
    try {
      await expect(
        host.fetchInKernel(
          59999,
          { method: "GET", url: "/", headers: {}, body: null },
        ),
      ).rejects.toThrow(/No in-kernel listener/);
    } finally {
      await host.destroy().catch(() => {});
    }
  }, 15_000);

  it("receives an early server response while a request exceeds the TCP pipe capacity", async () => {
    let listening!: () => void;
    const ready = new Promise<void>(resolve => { listening = resolve; });
    const host = new NodeKernelHost({
      maxWorkers: 4,
      onStderr: (_pid, bytes) => {
        if (new TextDecoder().decode(bytes).includes("tiny-http-server: listening")) listening();
      },
    });
    await host.init();
    try {
      const exited = host.spawn(loadWasm(tinyServerPath!), ["tiny-http-server", "8086"]);
      await ready;
      const response = await host.fetchInKernel(8086, {
        method: "POST", url: "/large", headers: { Host: "kernel.local" },
        body: new Uint8Array(300_000),
      }, { timeoutMs: 5000 });
      expect(response.status).toBe(200);
      expect(JSON.parse(new TextDecoder().decode(response.body)).path).toBe("/large");
      expect(await exited).toBe(0);
    } finally {
      await host.destroy();
    }
  }, 30_000);
});

describe("buildRawHttpRequest / parseRawHttpResponse", () => {
  it("round-trips a fixed-length response", () => {
    const req: HttpRequest = {
      method: "POST",
      url: "/x?y=1",
      headers: { Host: "h", "X-Custom": "ok" },
      body: new TextEncoder().encode("payload"),
    };
    const raw = buildRawHttpRequest(req);
    const text = new TextDecoder().decode(raw);
    expect(text.startsWith("POST /x?y=1 HTTP/1.1\r\n")).toBe(true);
    expect(text).toContain("Host: h\r\n");
    expect(text).toContain("X-Custom: ok\r\n");
    expect(text).toContain("Content-Length: 7\r\n");
    expect(text).toContain("Connection: close\r\n");
    expect(text.endsWith("payload")).toBe(true);
  });

  it("decodes a chunked response body", () => {
    const raw = new TextEncoder().encode(
      "HTTP/1.1 200 OK\r\n" +
        "Transfer-Encoding: chunked\r\n" +
        "\r\n" +
        "5\r\nhello\r\n" +
        "6\r\n world\r\n" +
        "0\r\n\r\n",
    );
    const resp = parseRawHttpResponse(raw);
    expect(resp.status).toBe(200);
    expect(resp.headers["Transfer-Encoding"]).toBeUndefined();
    expect(new TextDecoder().decode(resp.body)).toBe("hello world");
  });

  it("merges multiple Set-Cookie headers", () => {
    const raw = new TextEncoder().encode(
      "HTTP/1.1 200 OK\r\n" +
        "Content-Length: 0\r\n" +
        "Set-Cookie: a=1\r\n" +
        "Set-Cookie: b=2\r\n" +
        "\r\n",
    );
    const resp = parseRawHttpResponse(raw);
    expect(resp.headers["Set-Cookie"]).toBe("a=1\nb=2");
  });

  it("rejects an unframed or malformed HTTP response", () => {
    expect(() => parseRawHttpResponse(
      new TextEncoder().encode("expected body without HTTP framing"),
    )).toThrow(/header terminator/);
    expect(() => parseRawHttpResponse(
      new TextEncoder().encode("not-http 200 maybe\r\nContent-Length: 0\r\n\r\n"),
    )).toThrow(/status line/);
  });
});
