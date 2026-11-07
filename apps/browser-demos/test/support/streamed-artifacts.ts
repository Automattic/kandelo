import { createReadStream, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test as base } from "@playwright/test";

type Artifact = { contentType: string } & ({ path: string } | { bytes: Uint8Array });
export type ServeArtifacts = (artifacts: Record<string, Artifact>) => Promise<Record<string, string>>;

// Large route.fulfill bodies are base64-encoded on the debugging protocol.
// Stream bytes over HTTP so a large Wasm fixture never fills that transport.
export const test = base.extend<{ serveArtifacts: ServeArtifacts }>({
  serveArtifacts: async ({ baseURL }, use) => {
    if (!baseURL) throw new Error("streamed artifacts require a browser base URL");
    const servers: Server[] = [];
    try {
      await use(async artifacts => {
        const routes = new Map(Object.entries(artifacts).map(([name, artifact]) =>
          [`/fixture/${encodeURIComponent(name)}`, artifact] as const));
        const server = createServer((request, response) => {
          const artifact = routes.get(request.url ?? "");
          if (!artifact) { response.writeHead(404).end(); return; }
          response.writeHead(200, {
            "Content-Type": artifact.contentType,
            "Content-Length": "path" in artifact ? statSync(artifact.path).size : artifact.bytes.byteLength,
            "Access-Control-Allow-Origin": new URL(baseURL).origin,
            "Cross-Origin-Resource-Policy": "cross-origin",
          });
          if ("path" in artifact) {
            createReadStream(artifact.path).on("error", error => response.destroy(error)).pipe(response);
          } else { response.end(artifact.bytes); }
        });
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
        servers.push(server);
        const port = (server.address() as AddressInfo).port;
        return Object.fromEntries([...routes.keys()].map(path => [
          decodeURIComponent(path.slice("/fixture/".length)), `http://127.0.0.1:${port}${path}`,
        ]));
      });
    } finally {
      for (const server of servers) {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
    }
  },
});
