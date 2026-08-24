import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { waitForHttp } from "../../service-vfs-demo";

const servers = new Set<Server>();

afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
  servers.clear();
});

describe("service VFS HTTP readiness", () => {
  it("waits past temporary 502 responses until the upstream is ready", async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.statusCode = requests < 3 ? 502 : 200;
      response.end(requests < 3 ? "upstream unavailable" : "ready");
    });
    servers.add(server);

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test HTTP server did not bind a TCP port");
    }

    await waitForHttp(`http://127.0.0.1:${address.port}/`, 5_000);

    expect(requests).toBe(3);
  });
});
