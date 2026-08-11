import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createPagesVfsProductLoader,
  type PagesVfsProductEntry,
} from "./pages-vfs-product-loader.ts";

const encoder = new TextEncoder();

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function product(
  id: string,
  load: "eager" | "lazy",
  body = encoder.encode(`${id}\n`),
): PagesVfsProductEntry {
  return {
    bytes: body.byteLength,
    id,
    load,
    path: `/products/${id}/sha256-${sha256(body)}/${id}-42.vfs.zst`,
    sha256: sha256(body),
  };
}

function response(body: Uint8Array, contentLength = body.byteLength): Response {
  const exactBody = new Uint8Array(body.byteLength);
  exactBody.set(body);
  return new Response(exactBody.buffer, {
    headers: { "content-length": String(contentLength) },
    status: 200,
  });
}

test("starts exactly the two eager products and leaves every lazy product dormant", async () => {
  const bodies = new Map<string, Uint8Array>();
  const entries = [
    product("platform-rootfs", "eager"),
    product("browser-main-shell", "eager"),
    product("browser-node", "lazy"),
    product("browser-nginx", "lazy"),
    product("browser-nginx-php", "lazy"),
    product("browser-wordpress", "lazy"),
    product("browser-lamp", "lazy"),
  ];
  for (const entry of entries) bodies.set(entry.path, encoder.encode(`${entry.id}\n`));
  const calls = new Map<string, number>();
  const loader = createPagesVfsProductLoader(entries, async (url) => {
    calls.set(url, (calls.get(url) ?? 0) + 1);
    return response(bodies.get(url)!);
  });

  assert.equal(calls.get(entries[0]!.path), 1);
  assert.equal(calls.get(entries[1]!.path), 1);
  for (const entry of entries.slice(2)) assert.equal(calls.get(entry.path) ?? 0, 0);

  await Promise.all([loader.activate("platform-rootfs"), loader.activate("browser-main-shell")]);
  for (const entry of entries.slice(2)) {
    assert.equal(await loader.activate(entry.id), entry.path);
    assert.equal(calls.get(entry.path), 1);
    for (const other of entries.slice(2)) {
      assert.equal(calls.get(other.path) ?? 0, other.id === entry.id ? 1 : 0);
    }
    calls.delete(entry.path);
  }
});

test("inserts one cached promise before fetch and retains success and failure", async () => {
  const successBody = encoder.encode("success\n");
  const failureBody = encoder.encode("failure\n");
  const entries = [
    product("success", "lazy", successBody),
    product("failure", "lazy", failureBody),
  ];
  const calls = new Map<string, number>();
  let loader: ReturnType<typeof createPagesVfsProductLoader>;
  loader = createPagesVfsProductLoader(entries, async (url) => {
    calls.set(url, (calls.get(url) ?? 0) + 1);
    if (url === entries[1]!.path) throw new Error("one permanent fetch failure");
    // Re-enter while the first activation is still in the fetcher. The cache
    // must already contain the promise or this recursively fetches forever.
    assert.equal(loader.activate("success"), loader.activate("success"));
    return response(successBody);
  });

  const firstSuccess = loader.activate("success");
  assert.equal(firstSuccess, loader.activate("success"));
  assert.equal(await firstSuccess, entries[0]!.path);
  assert.equal(calls.get(entries[0]!.path), 1);

  const firstFailure = loader.activate("failure");
  assert.equal(firstFailure, loader.activate("failure"));
  await assert.rejects(firstFailure, /permanent fetch failure/i);
  await assert.rejects(loader.activate("failure"), /permanent fetch failure/i);
  assert.equal(calls.get(entries[1]!.path), 1);
});

test("rejects wrong declared length, received length, digest, origin, and unknown IDs", async (t) => {
  const body = encoder.encode("validated bytes\n");
  const entry = product("browser-node", "lazy", body);

  await t.test("missing content length", async () => {
    const loader = createPagesVfsProductLoader([entry], async () => new Response(body));
    await assert.rejects(loader.activate(entry.id), /content-length/i);
  });
  await t.test("wrong content length", async () => {
    const loader = createPagesVfsProductLoader(
      [entry],
      async () => response(body, body.byteLength + 1),
    );
    await assert.rejects(loader.activate(entry.id), /content-length/i);
  });
  await t.test("wrong received length", async () => {
    const short = body.subarray(0, body.byteLength - 1);
    const loader = createPagesVfsProductLoader(
      [entry],
      async () => response(short, entry.bytes),
    );
    await assert.rejects(loader.activate(entry.id), /received length/i);
  });
  await t.test("wrong digest", async () => {
    const corrupt = body.slice();
    corrupt[0] ^= 0xff;
    const loader = createPagesVfsProductLoader(
      [entry],
      async () => response(corrupt, corrupt.byteLength),
    );
    await assert.rejects(loader.activate(entry.id), /sha-256/i);
  });
  await t.test("HTTP failure", async () => {
    const loader = createPagesVfsProductLoader(
      [entry],
      async () => new Response(body, { status: 503 }),
    );
    await assert.rejects(loader.activate(entry.id), /http 503/i);
  });
  await t.test("cross-origin path", async () => {
    assert.throws(
      () => createPagesVfsProductLoader(
        [{ ...entry, path: `https://invalid.example${entry.path}` }],
        async () => response(body),
      ),
      /same-origin/i,
    );
  });
  await t.test("unknown product", async () => {
    let fetches = 0;
    const loader = createPagesVfsProductLoader([entry], async () => {
      fetches += 1;
      return response(body);
    });
    await assert.rejects(loader.activate("unknown"), /unknown Pages VFS product/i);
    assert.equal(fetches, 0);
  });
});

test("rejects malformed and duplicate entries before any eager fetch", () => {
  const body = encoder.encode("entry\n");
  const entry = product("platform-rootfs", "eager", body);
  let fetches = 0;
  const fetcher = async () => {
    fetches += 1;
    return response(body);
  };
  assert.throws(
    () => createPagesVfsProductLoader([entry, entry], fetcher),
    /duplicate/i,
  );
  assert.throws(
    () => createPagesVfsProductLoader([
      { ...entry, path: `/legacy/${entry.id}.vfs.zst` },
    ], fetcher),
    /canonical product path/i,
  );
  assert.equal(fetches, 0);
});
