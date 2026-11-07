import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  batchedResolverFiles,
  devLazyAssetRequest,
  devLazyAssets,
  type DevLazyAssetOptions,
} from "../../apps/browser-demos/vite/dev-lazy-assets";

/**
 * The dev server's lazy-asset route serves whatever package member a built
 * image references. The route chooses nothing itself: it validates the member
 * path and hands it to the binary resolver, whose exact, approved answer alone
 * is streamed.
 */
describe("dev lazy-asset route", () => {
  it("classifies member requests under the app's base", () => {
    expect(devLazyAssetRequest("/@kandelo-lazy/assets/programs/wasm32/tmux.wasm", "/"))
      .toEqual({ kind: "member", relPath: "programs/wasm32/tmux.wasm" });
    expect(
      devLazyAssetRequest(
        "/kandelo/@kandelo-lazy/assets/programs/wasm32/love/share/love-examples.zip?x=1",
        "/kandelo/",
      ),
    ).toEqual({ kind: "member", relPath: "programs/wasm32/love/share/love-examples.zip" });
    expect(devLazyAssetRequest("/pages/kandelo/", "/")).toEqual({ kind: "not-mine" });
    expect(devLazyAssetRequest("/@kandelo-lazy/assets/programs/x.wasm", "/kandelo/"))
      .toEqual({ kind: "not-mine" });
  });

  it("refuses paths outside the package members", () => {
    for (const url of [
      // URL parsing resolves dot segments, so climbing leaves the members.
      "/@kandelo-lazy/assets/programs/%2e%2e/%2e%2e/escape.wasm",
      "/@kandelo-lazy/assets/programs/wasm32/a%2fb.wasm",
      "/@kandelo-lazy/assets/programs//x.wasm",
      "/@kandelo-lazy/assets/kernel.wasm",
      "/@kandelo-lazy/programs/wasm32/tmux.wasm",
      "/@kandelo-lazy/",
    ]) {
      expect(devLazyAssetRequest(url, "/"), url).toEqual({ kind: "invalid" });
    }
  });

  it("serves only the resolver's approved file, resolving in batches", () => {
    let identity: string | null = "v1";
    const batches: string[][] = [];
    const single: string[] = [];
    const approved: string[] = [];
    const serve = batchedResolverFiles({
      projectionPath: "/repo/projection.json",
      identity: () => identity,
      listMembers: () => ["programs/wasm32/tmux.wasm", "programs/wasm32/gone.wasm"],
      resolveBatch: (relPaths) => {
        batches.push([...relPaths]);
        return relPaths.map((relPath) =>
          relPath === "programs/wasm32/tmux.wasm" ? `/repo/${identity}/tmux.wasm` : null,
        );
      },
      resolveOne: (relPath) => {
        single.push(relPath);
        return relPath === "programs/wasm32/extra.wasm" ? "/mirror/extra.wasm" : null;
      },
      approve: (file) => {
        approved.push(file);
        return `/canonical${file}`;
      },
    });
    const file = (path: string) => ({ kind: "file", file: path });
    expect(serve("programs/wasm32/tmux.wasm", "/kandelo/"))
      .toEqual(file("/canonical/repo/v1/tmux.wasm"));
    expect(serve("programs/wasm32/tmux.wasm", "/")).toEqual(file("/canonical/repo/v1/tmux.wasm"));
    // A listed member nothing published stays absent; it is not re-resolved.
    expect(serve("programs/wasm32/gone.wasm", "/")).toBeNull();
    // A path the projection does not list is resolved alone.
    expect(serve("programs/wasm32/extra.wasm", "/")).toEqual(file("/canonical/mirror/extra.wasm"));
    // A path nothing serves is resolved once, not on every request.
    expect(serve("programs/wasm32/absent.wasm", "/")).toBeNull();
    expect(serve("programs/wasm32/absent.wasm", "/")).toBeNull();
    expect(serve("programs/wasm32/extra.wasm", "/")).toEqual(file("/canonical/mirror/extra.wasm"));
    expect(batches).toHaveLength(1);
    expect(single).toEqual(["programs/wasm32/extra.wasm", "programs/wasm32/absent.wasm"]);
    // A republished projection is resolved again.
    identity = "v2";
    expect(serve("programs/wasm32/tmux.wasm", "/")).toEqual(file("/canonical/repo/v2/tmux.wasm"));
    expect(batches).toHaveLength(2);
    expect(approved).toContain("/repo/v1/tmux.wasm");
  });

  it("isolates stale member failures without approving or hiding them", () => {
    let identity = "old";
    let batches = 0;
    const approved: string[] = [];
    const failure = new Error("Original companion is not owned by the selected package generation");
    const serve = batchedResolverFiles({
      projectionPath: "/projection.json",
      identity: () => identity,
      listMembers: () => ["programs/wasm32/coreutils.wasm", "programs/wasm32/stale.wasm"],
      resolveBatch: () => {
        batches += 1;
        return ["/cache/coreutils.wasm", identity === "old" ? failure : "/cache/rebuilt.wasm"];
      },
      resolveOne: () => null,
      approve: (file) => {
        approved.push(file);
        return file;
      },
    });
    const coreutils = { kind: "file", file: "/cache/coreutils.wasm" };
    expect(serve("programs/wasm32/coreutils.wasm", "/")).toEqual(coreutils);
    expect(() => serve("programs/wasm32/stale.wasm", "/")).toThrow(failure);
    expect(serve("programs/wasm32/coreutils.wasm", "/")).toEqual(coreutils);
    expect(() => serve("programs/wasm32/stale.wasm", "/")).toThrow(failure);
    expect(batches).toBe(1);
    expect(approved).toEqual(["/cache/coreutils.wasm", "/cache/coreutils.wasm"]);
    identity = "rebuilt";
    expect(serve("programs/wasm32/stale.wasm", "/")).toEqual({ kind: "file", file: "/cache/rebuilt.wasm" });
    expect(batches).toBe(2);
  });

  it("keeps approved checkout paths literal for byte streaming", () => {
    const serve = batchedResolverFiles({
      projectionPath: "/p.json",
      identity: () => "v1",
      listMembers: () => ["programs/wasm32/tmux.wasm"],
      resolveBatch: () => ["/Users/me/My Repo/100%/tmux.wasm"],
      resolveOne: () => null,
      approve: (file) => file,
    });
    // The server streams this approved filename directly. Applying URL
    // decoding to it would corrupt percent signs or checkout path spaces.
    expect(serve("programs/wasm32/tmux.wasm", "/")).toEqual({
      kind: "file", file: "/Users/me/My Repo/100%/tmux.wasm",
    });
  });

  it("streams a member's bytes exactly, whatever its name", async () => {
    // An extensionless shell script is the case Vite's `/@fs/` route
    // rewrote into a JavaScript module with an inline source map.
    const root = mkdtempSync(join(tmpdir(), "dev-lazy-assets-"));
    const script = "#!/bin/sh\nexec /usr/bin/sfwbar \"$@\"\n";
    writeFileSync(join(root, "kandelo-sfwbar"), script);
    writeFileSync(join(root, "My Tool.wasm"), new Uint8Array([0, 0x61, 0x73, 0x6d]));
    const listen = (serve: DevLazyAssetOptions["serve"]) => {
      const plugin = devLazyAssets({ serve });
      let middleware!: (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
      (plugin.configureServer as (server: unknown) => void)({
        config: { base: "/" },
        middlewares: { use: (handler: typeof middleware) => { middleware = handler; } },
      });
      const server = createServer((req, res) => middleware(req, res, () => {
        res.statusCode = 418;
        res.end("next");
      }));
      return new Promise<{ url: string; close: () => void }>((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve({
          url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
          close: () => server.close(),
        }));
      });
    };
    const { url, close } = await listen((relPath) => {
      if (relPath === "programs/wasm32/sfwbar/kandelo-sfwbar") {
        return { kind: "file", file: join(root, "kandelo-sfwbar") };
      }
      if (relPath === "programs/wasm32/My Tool.wasm") {
        return { kind: "file", file: join(root, "My Tool.wasm") };
      }
      if (relPath === "programs/wasm32/pinned.wasm") {
        return { kind: "path", path: "/@source-only/abc/pinned.wasm" };
      }
      return null;
    });
    try {
      const shell = await fetch(`${url}/@kandelo-lazy/assets/programs/wasm32/sfwbar/kandelo-sfwbar`);
      expect(shell.status).toBe(200);
      expect(shell.headers.get("content-type")).toBe("application/octet-stream");
      expect(shell.headers.get("content-length")).toBe(String(script.length));
      expect(await shell.text()).toBe(script);

      const wasm = await fetch(`${url}/@kandelo-lazy/assets/programs/wasm32/My%20Tool.wasm`);
      expect(wasm.headers.get("content-type")).toBe("application/wasm");
      expect(new Uint8Array(await wasm.arrayBuffer())).toEqual(new Uint8Array([0, 0x61, 0x73, 0x6d]));

      const head = await fetch(`${url}/@kandelo-lazy/assets/programs/wasm32/sfwbar/kandelo-sfwbar`, { method: "HEAD" });
      expect(head.headers.get("content-length")).toBe(String(script.length));

      // A pinned SourceOnly path is left to the store's middleware.
      expect((await fetch(`${url}/@kandelo-lazy/assets/programs/wasm32/pinned.wasm`)).status).toBe(418);
      expect((await fetch(`${url}/@kandelo-lazy/assets/programs/wasm32/missing.wasm`)).status).toBe(404);
      const post = await fetch(`${url}/@kandelo-lazy/assets/programs/wasm32/sfwbar/kandelo-sfwbar`, { method: "POST" });
      expect(post.status).toBe(405);
    } finally {
      close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
