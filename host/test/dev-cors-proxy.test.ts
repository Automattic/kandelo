import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import {
  type DevCorsProxyFetch,
  DEV_CORS_PROXY_MAX_REQUEST_BYTES,
  DEV_CORS_PROXY_MAX_RESPONSE_BYTES,
  devCorsProxyRequestHeaders,
  handleDevCorsProxyRequest,
} from "../../apps/browser-demos/vite/dev-cors-proxy";

interface HttpResult {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

interface ObservedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeIdleConnections();
  });
}

function sendRequest(options: {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: Buffer;
}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      options.url,
      {
        agent: false,
        method: options.method,
        headers: {
          Connection: "close",
          ...options.headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    request.once("error", reject);
    request.end(options.body);
  });
}

function proxyUrl(relayRoot: string, target: string): string {
  return `${relayRoot}/__kandelo_cors_proxy?url=${encodeURIComponent(target)}`;
}

function relayServer(fetchImpl?: DevCorsProxyFetch): Server {
  return createServer((request, response) => {
    void handleDevCorsProxyRequest(
      request,
      response,
      "/__kandelo_cors_proxy",
      fetchImpl,
    ).then((handled) => {
      if (handled) return;
      response.statusCode = 404;
      response.end("Not Found");
    }).catch((error) => response.destroy(error));
  });
}

async function readBody(request: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe("development CORS proxy", () => {
  it("derives its request-header boundary from the application-owned profile", () => {
    const source = readFileSync(
      new URL("../../apps/browser-demos/vite/dev-cors-proxy.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain("DEFAULT_BROWSER_CORS_PROXY_CONFIG");
    expect(source).not.toMatch(
      /const ALLOWED_REQUEST_HEADERS = new Set\(\[[\s\S]*?\]\);/,
    );
  });

  it("enforces the application-owned production request-header profile", () => {
    const projected = devCorsProxyRequestHeaders({
      accept: "application/json",
      "content-type": "application/json",
      "git-protocol": "version=2",
      wp_blog: "https://blog.example/",
      wp_install: "yes",
      authorization: "Bearer secret",
      "cache-control": "no-cache",
      range: "bytes=0-9",
      "if-range": '"v1"',
      "accept-encoding": "gzip, br",
      "x-arbitrary-metadata": "not transport authority",
    });

    expect(Object.fromEntries(projected.entries())).toEqual({
      accept: "application/json",
      "accept-encoding": "identity",
      "content-type": "application/json",
      "git-protocol": "version=2",
      "if-range": '"v1"',
      range: "bytes=0-9",
      wp_blog: "https://blog.example/",
      wp_install: "yes",
    });
  });

  it("leaves content negotiation to Fetch when no range is requested", () => {
    const projected = devCorsProxyRequestHeaders({
      accept: "text/plain",
      "accept-encoding": "identity",
    });
    expect(Object.fromEntries(projected.entries())).toEqual({
      accept: "text/plain",
    });
  });

  it("preserves Git smart-HTTP GET, HEAD, and POST", async () => {
    const observed: ObservedRequest[] = [];
    const upstream = createServer(async (request, response) => {
      observed.push({
        method: request.method ?? "",
        url: request.url ?? "",
        headers: request.headers,
        body: await readBody(request),
      });
      if (request.method === "HEAD") {
        response.writeHead(200, {
          "Content-Length": "17",
          "Content-Type": "application/x-git-upload-pack-advertisement",
        });
        response.end();
        return;
      }
      response.writeHead(200, {
        "Alt-Svc": 'h3=":443"',
        "Access-Control-Allow-Origin": "https://ambient.invalid",
        "Clear-Site-Data": '"cache"',
        "Content-Type": request.method === "POST"
          ? "application/x-git-upload-pack-result"
          : "application/x-git-upload-pack-advertisement",
        "Report-To": '{"group":"upstream"}',
        "Set-Cookie": "upstream=secret",
      });
      response.end(request.method === "POST" ? "0008NAK\n" : "001e# service=git-upload-pack\n0000");
    });
    const upstreamRoot = await listen(upstream);
    let postRedirectMode: RequestRedirect | undefined;
    const relay = relayServer((target, init) => {
      if (target.origin !== "https://github.com") {
        return fetch(target, init);
      }
      postRedirectMode = init.redirect;
      return fetch(
        new URL(`${target.pathname}${target.search}`, upstreamRoot),
        init,
      );
    });
    const relayRoot = await listen(relay);

    try {
      const infoRefs = `${upstreamRoot}/repo.git/info/refs?service=git-upload-pack`;
      const get = await sendRequest({
        url: proxyUrl(relayRoot, infoRefs),
        method: "GET",
        headers: { "Git-Protocol": "version=2" },
      });
      expect(get.status).toBe(200);
      expect(get.body.toString()).toContain("service=git-upload-pack");

      const head = await sendRequest({
        url: proxyUrl(relayRoot, infoRefs),
        method: "HEAD",
      });
      expect(head.status).toBe(200);
      expect(head.body).toHaveLength(0);
      expect(head.headers["content-length"]).toBe("17");

      const uploadPack =
        "https://github.com/example/sample-tap.git/git-upload-pack";
      const gitBody = Buffer.from("0014command=ls-refs\n0000");
      const post = await sendRequest({
        url: proxyUrl(relayRoot, uploadPack),
        method: "POST",
        headers: {
          Accept: "application/x-git-upload-pack-result",
          Authorization: "Bearer browser-secret",
          "Content-Type": "application/x-git-upload-pack-request",
          Cookie: "ambient_session=browser-secret",
          "Git-Protocol": "version=2",
          Origin: "http://127.0.0.1:5401",
          Referer: "http://127.0.0.1:5401/private",
          "X-Forwarded-For": "127.0.0.1",
          "X-Guest-Probe": "preserved",
        },
        body: gitBody,
      });
      expect(post.status).toBe(200);
      expect(post.body.toString()).toBe("0008NAK\n");
      expect(post.headers["content-type"]).toContain(
        "application/x-git-upload-pack-result",
      );
      expect(post.headers["set-cookie"]).toBeUndefined();
      expect(post.headers["access-control-allow-origin"]).toBeUndefined();
      expect(post.headers["alt-svc"]).toBeUndefined();
      expect(post.headers["clear-site-data"]).toBeUndefined();
      expect(post.headers["report-to"]).toBeUndefined();
      expect(post.headers["cross-origin-resource-policy"]).toBe("same-origin");
      expect(postRedirectMode).toBe("manual");

      expect(observed.map(({ method }) => method)).toEqual([
        "GET",
        "HEAD",
        "POST",
      ]);
      expect(observed[0]!.url).toBe(
        "/repo.git/info/refs?service=git-upload-pack",
      );
      expect(observed[0]!.headers["git-protocol"]).toBe("version=2");
      expect(observed[2]!.url).toBe(
        "/example/sample-tap.git/git-upload-pack",
      );
      expect(observed[2]!.body).toEqual(gitBody);
      expect(observed[2]!.headers.accept).toBe(
        "application/x-git-upload-pack-result",
      );
      expect(observed[2]!.headers["content-type"]).toBe(
        "application/x-git-upload-pack-request",
      );
      expect(observed[2]!.headers["git-protocol"]).toBe("version=2");
      expect(observed[2]!.headers["x-guest-probe"]).toBeUndefined();
      expect(observed[2]!.headers.authorization).toBeUndefined();
      expect(observed[2]!.headers.cookie).toBeUndefined();
      expect(observed[2]!.headers.origin).toBeUndefined();
      expect(observed[2]!.headers.referer).toBeUndefined();
      expect(observed[2]!.headers["x-forwarded-for"]).toBeUndefined();
    } finally {
      await Promise.all([close(relay), close(upstream)]);
    }
  });

  it("rejects unsupported methods and oversized request bodies", async () => {
    let forwardedRequests = 0;
    const relay = relayServer(async () => {
      forwardedRequests += 1;
      return new Response("unexpected");
    });
    const relayRoot = await listen(relay);

    try {
      const unrelated = await sendRequest({
        url: `${relayRoot}/ordinary-vite-path`,
        method: "GET",
      });
      expect(unrelated.status).toBe(404);
      const missingTarget = await sendRequest({
        url: `${relayRoot}/__kandelo_cors_proxy`,
        method: "GET",
      });
      expect(missingTarget.status).toBe(400);

      const target = proxyUrl(
        relayRoot,
        "https://github.com/example/repo.git/git-upload-pack",
      );
      const put = await sendRequest({ url: target, method: "PUT" });
      expect(put.status).toBe(405);

      const oversized = await sendRequest({
        url: target,
        method: "POST",
        // Keep the socket open while the relay drains the rejected body. A
        // client-requested close can race the intentional early 413 response
        // and report ECONNRESET instead of the response status.
        headers: {
          Connection: "keep-alive",
          "Content-Type": "application/x-git-upload-pack-request",
        },
        body: Buffer.alloc(DEV_CORS_PROXY_MAX_REQUEST_BYTES + 1),
      });
      expect(oversized.status).toBe(413);
      expect(forwardedRequests).toBe(0);
    } finally {
      await close(relay);
    }
  });

  it("keeps POST inside anonymous GitHub upload-pack", async () => {
    let forwardedRequests = 0;
    const relay = relayServer(async () => {
      forwardedRequests += 1;
      return new Response("unexpected");
    });
    const relayRoot = await listen(relay);

    try {
      const cases = [
        {
          target: "http://github.com/example/repo.git/git-upload-pack",
          contentType: "application/x-git-upload-pack-request",
        },
        {
          target: "https://127.0.0.1/repo.git/git-upload-pack",
          contentType: "application/x-git-upload-pack-request",
        },
        {
          target: "https://github.com/example/repo.git/git-receive-pack",
          contentType: "application/x-git-upload-pack-request",
        },
        {
          target: "https://github.com/example/repo.git/git-upload-pack",
          contentType: "application/json",
        },
      ];
      for (const unsafe of cases) {
        const result = await sendRequest({
          url: proxyUrl(relayRoot, unsafe.target),
          method: "POST",
          headers: { "Content-Type": unsafe.contentType },
          body: Buffer.from("0014command=ls-refs\n0000"),
        });
        expect(result.status).toBe(403);
      }
      expect(forwardedRequests).toBe(0);
    } finally {
      await close(relay);
    }
  });

  it("keeps default-following outer fetches inside the relay", async () => {
    let redirectedRequests = 0;
    const redirectedTarget = createServer((_request, response) => {
      redirectedRequests += 1;
      response.end("unexpected private target");
    });
    const redirectedRoot = await listen(redirectedTarget);
    const redirector = createServer((_request, response) => {
      response.writeHead(302, { Location: `${redirectedRoot}/private` });
      response.end();
    });
    const redirectorRoot = await listen(redirector);
    const relay = relayServer((target, init) =>
      fetch(
        new URL(`${target.pathname}${target.search}`, redirectorRoot),
        init,
      )
    );
    const relayRoot = await listen(relay);

    try {
      const result = await fetch(
        proxyUrl(
          relayRoot,
          "https://github.com/example/repo.git/git-upload-pack",
        ),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-git-upload-pack-request",
          },
          body: Buffer.from("0014command=ls-refs\n0000"),
        },
      );
      expect(result.status).toBe(502);
      expect(result.headers.get("location")).toBeNull();
      expect(redirectedRequests).toBe(0);
    } finally {
      await Promise.all([
        close(relay),
        close(redirector),
        close(redirectedTarget),
      ]);
    }
  });

  it("rejects recursive and oversized upstream responses", async () => {
    const upstream = createServer((_request, response) => {
      response.writeHead(200, {
        "Content-Length": String(DEV_CORS_PROXY_MAX_RESPONSE_BYTES + 1),
      });
      response.end();
    });
    const relay = relayServer();
    const upstreamRoot = await listen(upstream);
    const relayRoot = await listen(relay);

    try {
      const recursive = await sendRequest({
        url: proxyUrl(relayRoot, `${relayRoot}/__kandelo_cors_proxy`),
        method: "GET",
      });
      expect(recursive.status).toBe(400);
      for (const unsafeTarget of [
        "file:///tmp/private",
        "https://user:secret@example.com/repo.git",
        "https://example.com/repo.git#hidden",
      ]) {
        const unsafe = await sendRequest({
          url: proxyUrl(relayRoot, unsafeTarget),
          method: "GET",
        });
        expect(unsafe.status).toBe(400);
      }

      const oversized = await sendRequest({
        url: proxyUrl(relayRoot, `${upstreamRoot}/large`),
        method: "GET",
      });
      expect(oversized.status).toBe(413);
    } finally {
      await Promise.all([close(relay), close(upstream)]);
    }
  });

  it("relays a real ranged read as the exact requested bytes", async () => {
    // Byte N of the entity is N mod 251, so a slice from the wrong offset
    // cannot match the expected bytes.
    const entity = Buffer.from(
      Array.from({ length: 4096 }, (_, index) => index % 251),
    );
    const observed: IncomingHttpHeaders[] = [];
    const upstream = createServer((request, response) => {
      observed.push(request.headers);
      const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? "");
      if (match === null) {
        response.writeHead(200, {
          "Accept-Ranges": "bytes",
          "Content-Length": String(entity.byteLength),
        });
        response.end(entity);
        return;
      }
      const start = Number(match[1]);
      const end = Math.min(Number(match[2]), entity.byteLength - 1);
      response.writeHead(206, {
        "Accept-Ranges": "bytes",
        "Content-Length": String(end - start + 1),
        "Content-Range": `bytes ${start}-${end}/${entity.byteLength}`,
        "Content-Type": "application/zip",
        ETag: '"v1"',
      });
      response.end(entity.subarray(start, end + 1));
    });
    const relay = relayServer();
    const upstreamRoot = await listen(upstream);
    const relayRoot = await listen(relay);

    try {
      const tail = await sendRequest({
        url: proxyUrl(relayRoot, `${upstreamRoot}/archive.zip`),
        method: "GET",
        headers: { Range: "bytes=4074-4095", "If-Range": '"v1"' },
      });
      expect(tail.status).toBe(206);
      expect(tail.headers["content-range"]).toBe("bytes 4074-4095/4096");
      expect(tail.headers["content-length"]).toBe("22");
      expect(tail.headers["accept-ranges"]).toBe("bytes");
      expect(tail.body).toEqual(entity.subarray(4074, 4096));
      expect(tail.body).not.toEqual(entity.subarray(0, 22));

      expect(observed[0]!.range).toBe("bytes=4074-4095");
      expect(observed[0]!["if-range"]).toBe('"v1"');
      // Fetch appends its own `identity` for a ranged request, so the field
      // may list it twice; every listed coding must be identity.
      expect(
        observed[0]!["accept-encoding"]!.split(",").map((coding) =>
          coding.trim()
        ),
      ).toSatisfy((codings: string[]) =>
        codings.length > 0 && codings.every((coding) => coding === "identity")
      );

      const whole = await sendRequest({
        url: proxyUrl(relayRoot, `${upstreamRoot}/archive.zip`),
        method: "GET",
      });
      expect(whole.status).toBe(200);
      expect(whole.headers["content-range"]).toBeUndefined();
      expect(whole.body).toEqual(entity);
    } finally {
      await Promise.all([close(relay), close(upstream)]);
    }
  });

  it("relays a small slice of an entity larger than the response cap", async () => {
    const entityLength = 4 * 1024 * 1024 * 1024;
    const sliceStart = entityLength - 16;
    const slice = Buffer.from("PK\u0005\u0006-end-of-4GiB");
    expect(slice.byteLength).toBe(16);
    const upstream = createServer((request, response) => {
      if (request.headers.range === `bytes=${sliceStart}-${entityLength - 1}`) {
        response.writeHead(206, {
          "Content-Length": "16",
          "Content-Range": `bytes ${sliceStart}-${entityLength - 1}/${entityLength}`,
        });
        response.end(slice);
        return;
      }
      // Declaring the whole entity is enough; never send 4 GiB.
      response.writeHead(200, { "Content-Length": String(entityLength) });
      response.end();
    });
    const relay = relayServer();
    const upstreamRoot = await listen(upstream);
    const relayRoot = await listen(relay);

    try {
      expect(entityLength).toBeGreaterThan(DEV_CORS_PROXY_MAX_RESPONSE_BYTES);
      const ranged = await sendRequest({
        url: proxyUrl(relayRoot, `${upstreamRoot}/huge.zip`),
        method: "GET",
        headers: { Range: `bytes=${sliceStart}-${entityLength - 1}` },
      });
      expect(ranged.status).toBe(206);
      expect(ranged.headers["content-range"]).toBe(
        `bytes ${sliceStart}-${entityLength - 1}/${entityLength}`,
      );
      expect(ranged.body).toEqual(slice);

      const whole = await sendRequest({
        url: proxyUrl(relayRoot, `${upstreamRoot}/huge.zip`),
        method: "GET",
      });
      expect(whole.status).toBe(413);
    } finally {
      await Promise.all([close(relay), close(upstream)]);
    }
  });

  it("relays a range-ignoring 200 verbatim instead of shaping a 206", async () => {
    const entity = Buffer.from("0123456789abcdef");
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { "Content-Length": String(entity.byteLength) });
      response.end(entity);
    });
    const relay = relayServer();
    const upstreamRoot = await listen(upstream);
    const relayRoot = await listen(relay);

    try {
      const result = await sendRequest({
        url: proxyUrl(relayRoot, `${upstreamRoot}/no-ranges`),
        method: "GET",
        headers: { Range: "bytes=8-11" },
      });
      expect(result.status).toBe(200);
      expect(result.headers["content-range"]).toBeUndefined();
      expect(result.body).toEqual(entity);
    } finally {
      await Promise.all([close(relay), close(upstream)]);
    }
  });

  it("streams the body instead of buffering the whole response", async () => {
    let finishUpstream!: () => void;
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/octet-stream" });
      response.write("first chunk");
      finishUpstream = () => response.end("last chunk");
    });
    const relay = relayServer();
    const upstreamRoot = await listen(upstream);
    const relayRoot = await listen(relay);

    try {
      const response = await fetch(proxyUrl(relayRoot, `${upstreamRoot}/slow`));
      const reader = response.body!.getReader();
      const first = await reader.read();
      // The relay delivered bytes while upstream is still holding its body
      // open, which a buffering relay cannot do.
      expect(Buffer.from(first.value!).toString()).toBe("first chunk");
      finishUpstream();
      let rest = "";
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        rest += Buffer.from(next.value).toString();
      }
      expect(rest).toBe("last chunk");
    } finally {
      await Promise.all([close(relay), close(upstream)]);
    }
  });

  it("cancels the upstream request when the client aborts", async () => {
    const upstreamClosed: string[] = [];
    let requestSeen!: () => void;
    const seen = new Promise<void>((resolve) => {
      requestSeen = resolve;
    });
    const upstream = createServer((request, response) => {
      response.once("close", () => upstreamClosed.push(request.url ?? ""));
      requestSeen();
      if (request.url === "/streaming") {
        response.writeHead(200);
        response.write("partial");
      }
      // Otherwise hold the request open without ever answering.
    });
    const relay = relayServer();
    const upstreamRoot = await listen(upstream);
    const relayRoot = await listen(relay);

    try {
      // Before headers: only the relay's abort signal can reach upstream.
      const beforeHeaders = new AbortController();
      const pending = fetch(proxyUrl(relayRoot, `${upstreamRoot}/stalled`), {
        signal: beforeHeaders.signal,
      });
      await seen;
      beforeHeaders.abort();
      await expect(pending).rejects.toThrow();
      await expect.poll(() => upstreamClosed).toContain("/stalled");

      // Mid-body: dropping the client response cancels the upstream body.
      const midBody = new AbortController();
      const response = await fetch(
        proxyUrl(relayRoot, `${upstreamRoot}/streaming`),
        { signal: midBody.signal },
      );
      await response.body!.getReader().read();
      midBody.abort();
      await expect.poll(() => upstreamClosed).toContain("/streaming");
    } finally {
      upstream.closeAllConnections();
      relay.closeAllConnections();
      await Promise.all([close(relay), close(upstream)]);
    }
  });

  it("truncates an undeclared body that outgrows the cap mid-stream", async () => {
    const chunk = Buffer.alloc(1024 * 1024);
    const chunkCount = DEV_CORS_PROXY_MAX_RESPONSE_BYTES / chunk.byteLength + 1;
    const upstream = createServer((_request, response) => {
      // Chunked, so no Content-Length lets the relay reject it up front.
      response.writeHead(200, { "Content-Type": "application/octet-stream" });
      Readable.from(
        (function* () {
          for (let index = 0; index < chunkCount; index += 1) yield chunk;
        })(),
      ).pipe(response);
    });
    const relay = relayServer();
    const upstreamRoot = await listen(upstream);
    const relayRoot = await listen(relay);

    try {
      const outcome = await new Promise<{ status: number; complete: boolean }>(
        (resolve, reject) => {
          const request = httpRequest(
            proxyUrl(relayRoot, `${upstreamRoot}/unbounded`),
            { agent: false, headers: { Connection: "close" } },
            (response) => {
              response.resume();
              response.once("end", () =>
                resolve({ status: response.statusCode ?? 0, complete: true }));
              response.once("error", () =>
                resolve({ status: response.statusCode ?? 0, complete: false }));
              response.once("aborted", () =>
                resolve({ status: response.statusCode ?? 0, complete: false }));
            },
          );
          request.once("error", reject);
          request.end();
        },
      );
      expect(outcome).toEqual({ status: 200, complete: false });
    } finally {
      upstream.closeAllConnections();
      await Promise.all([close(relay), close(upstream)]);
    }
  });
});
