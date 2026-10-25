import { describe, expect, it } from "vitest";
import {
  batchedFsServePath,
  devLazyAssetRequest,
} from "../../apps/browser-demos/vite/dev-lazy-assets";

/**
 * The dev server's lazy-asset route serves whatever package member a built
 * image references. The route chooses nothing itself: it validates the member
 * path and hands it to the binary resolver, whose exact answer alone is
 * approved for Vite's `/@fs/` transport.
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

  it("serves only the resolver's approved file through /@fs/, resolving in batches", () => {
    let identity: string | null = "v1";
    const batches: string[][] = [];
    const single: string[] = [];
    const approved: string[] = [];
    const servePath = batchedFsServePath({
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
    expect(servePath("programs/wasm32/tmux.wasm", "/kandelo/"))
      .toBe("/kandelo/@fs/canonical/repo/v1/tmux.wasm");
    expect(servePath("programs/wasm32/tmux.wasm", "/")).toBe("/@fs/canonical/repo/v1/tmux.wasm");
    // A listed member nothing published stays absent; it is not re-resolved.
    expect(servePath("programs/wasm32/gone.wasm", "/")).toBeNull();
    // A path the projection does not list is resolved alone.
    expect(servePath("programs/wasm32/extra.wasm", "/")).toBe("/@fs/canonical/mirror/extra.wasm");
    // A path nothing serves is resolved once, not on every request.
    expect(servePath("programs/wasm32/absent.wasm", "/")).toBeNull();
    expect(servePath("programs/wasm32/absent.wasm", "/")).toBeNull();
    expect(servePath("programs/wasm32/extra.wasm", "/")).toBe("/@fs/canonical/mirror/extra.wasm");
    expect(batches).toHaveLength(1);
    expect(single).toEqual(["programs/wasm32/extra.wasm", "programs/wasm32/absent.wasm"]);
    // A republished projection is resolved again.
    identity = "v2";
    expect(servePath("programs/wasm32/tmux.wasm", "/")).toBe("/@fs/canonical/repo/v2/tmux.wasm");
    expect(batches).toHaveLength(2);
    expect(approved).toContain("/repo/v1/tmux.wasm");
  });

  it("encodes the checkout path the way Vite's /@fs/ route decodes it", () => {
    const servePath = batchedFsServePath({
      projectionPath: "/p.json",
      identity: () => "v1",
      listMembers: () => ["programs/wasm32/tmux.wasm"],
      resolveBatch: () => ["/Users/me/My Repo/100%/tmux.wasm"],
      resolveOne: () => null,
      approve: (file) => file,
    });
    const served = servePath("programs/wasm32/tmux.wasm", "/")!;
    expect(served).toBe("/@fs/Users/me/My%20Repo/100%25/tmux.wasm");
    expect(decodeURI(new URL(served, "http://x").pathname)).toBe("/@fs/Users/me/My Repo/100%/tmux.wasm");
  });
});
