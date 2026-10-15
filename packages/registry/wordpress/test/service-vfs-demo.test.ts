import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import { finishWhenDinitExits, waitForHttp } from "../../service-vfs-demo";

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

describe("service VFS supervisor exit", () => {
  it("reports a service log and fails when dinit exits successfully after serving", async () => {
    const serviceLog = new TextEncoder().encode("frankenphp-caddy panic");
    const readFileFromVfs = vi.fn().mockResolvedValue(serviceLog);
    const destroy = vi.fn().mockResolvedValue(undefined);
    const host = { readFileFromVfs, destroy } as unknown as Parameters<typeof finishWhenDinitExits>[0];
    const logError = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation((status) => {
      throw new Error(`exit ${status}`);
    });

    try {
      await expect(finishWhenDinitExits(host, Promise.resolve(0), "/var/log/frankenphp-caddy.log"))
        .rejects.toThrow("exit 1");
      expect(readFileFromVfs).toHaveBeenCalledWith("/var/log/frankenphp-caddy.log");
      expect(logError).toHaveBeenCalledWith("/var/log/frankenphp-caddy.log:\nfrankenphp-caddy panic");
      expect(destroy).toHaveBeenCalledOnce();
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("still fails when the service log is unavailable", async () => {
    const readFileFromVfs = vi.fn().mockRejectedValue(new Error("kernel unavailable"));
    const destroy = vi.fn().mockResolvedValue(undefined);
    const host = { readFileFromVfs, destroy } as unknown as Parameters<typeof finishWhenDinitExits>[0];
    const logError = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation((status) => {
      throw new Error(`exit ${status}`);
    });

    try {
      await expect(finishWhenDinitExits(host, Promise.resolve(0), "/var/log/frankenphp-classic.log"))
        .rejects.toThrow("exit 1");
      expect(logError).toHaveBeenCalledWith("Could not read /var/log/frankenphp-classic.log: Error: kernel unavailable");
      expect(destroy).toHaveBeenCalledOnce();
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
