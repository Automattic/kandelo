import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { NodeKernelHost } from "../src/node-kernel-host";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";

describe("native deferred content integrity", () => {
  it("rejects corrupt bytes without mutation and permits a deliberate later read to fetch again", async () => {
    const good = new TextEncoder().encode("verified bytes");
    const bad = good.slice();
    bad[0] ^= 0xff;
    let fetches = 0;
    const server = createServer((_request, response) => {
      const bytes = ++fetches === 1 ? bad : good;
      response.writeHead(200, { "content-length": bytes.length });
      response.end(bytes);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/data`;
    const fs = KandeloImageFs.create();
    fs.registerLazyFile("/data", url, good.length, 0o644, createHash("sha256").update(good).digest("hex"));
    const host = new NodeKernelHost({ rootfsImage: await fs.saveImage() });
    try {
      await host.init();
      const before = await host.statVfsPath("/data");
      await expect(host.readFileFromVfs("/data")).rejects.toThrow();
      expect(fetches, "integrity failure must not trigger an automatic retry").toBe(1);
      expect(await host.statVfsPath("/data")).toEqual(before);
      const recovered = await host.readFileFromVfs("/data");
      expect(Buffer.compare(recovered!, good)).toBe(0);
      expect(fetches).toBe(2);
    } finally {
      await host.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }, 60_000);
});
