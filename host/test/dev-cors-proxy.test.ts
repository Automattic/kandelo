import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

import {
  type DevCorsProxyFetch,
  DEV_CORS_PROXY_MAX_REQUEST_BYTES,
  DEV_CORS_PROXY_MAX_RESPONSE_BYTES,
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
        "Access-Control-Allow-Origin": "https://ambient.invalid",
        "Content-Type": request.method === "POST"
          ? "application/x-git-upload-pack-result"
          : "application/x-git-upload-pack-advertisement",
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
        "https://github.com/example/homebrew-tap.git/git-upload-pack";
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
        "/example/homebrew-tap.git/git-upload-pack",
      );
      expect(observed[2]!.body).toEqual(gitBody);
      expect(observed[2]!.headers.accept).toBe(
        "application/x-git-upload-pack-result",
      );
      expect(observed[2]!.headers["content-type"]).toBe(
        "application/x-git-upload-pack-request",
      );
      expect(observed[2]!.headers["git-protocol"]).toBe("version=2");
      expect(observed[2]!.headers["x-guest-probe"]).toBe("preserved");
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

  it("returns only safe POST redirects without following them", async () => {
    let redirectedRequests = 0;
    const redirectedTarget = createServer((_request, response) => {
      redirectedRequests += 1;
      response.end("unexpected private target");
    });
    const redirectedRoot = await listen(redirectedTarget);
    const safeLocation =
      "https://github.com/example/renamed.git/git-upload-pack";
    const redirector = createServer((request, response) => {
      response.writeHead(302, {
        Location: request.url?.includes("/safe.git/")
          ? safeLocation
          : `${redirectedRoot}/private`,
      });
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
      const result = await sendRequest({
        url: proxyUrl(
          relayRoot,
          "https://github.com/example/repo.git/git-upload-pack",
        ),
        method: "POST",
        headers: {
          "Content-Type": "application/x-git-upload-pack-request",
        },
        body: Buffer.from("0014command=ls-refs\n0000"),
      });
      expect(result.status).toBe(502);
      expect(result.headers.location).toBeUndefined();
      expect(redirectedRequests).toBe(0);

      const safeResult = await sendRequest({
        url: proxyUrl(
          relayRoot,
          "https://github.com/example/safe.git/git-upload-pack",
        ),
        method: "POST",
        headers: {
          "Content-Type": "application/x-git-upload-pack-request",
        },
        body: Buffer.from("0014command=ls-refs\n0000"),
      });
      expect(safeResult.status).toBe(302);
      expect(safeResult.headers.location).toBe(safeLocation);
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
});
