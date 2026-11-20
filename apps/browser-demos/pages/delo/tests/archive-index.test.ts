import assert from "node:assert/strict";
import test from "node:test";
import { zipSync } from "fflate";

import { fetchArchiveIndex } from "../src/archive-index";

const ARCHIVE = zipSync({
  "bin/": new Uint8Array(),
  "bin/foo": new TextEncoder().encode("foo program"),
  "bin/bar": [new TextEncoder().encode("foo"), { os: 3, attrs: 0o120777 << 16 }],
});

test("lists the members and reads only the directory and the symlink targets", async (t) => {
  const ranges: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => {
    if (init?.method === "HEAD") {
      return new Response(null, { headers: { "content-length": String(ARCHIVE.byteLength), "accept-ranges": "bytes" } });
    }
    const range = new Headers(init?.headers).get("range")!;
    ranges.push(range);
    const [start, end] = range.slice("bytes=".length).split("-").map(Number);
    return new Response(ARCHIVE.slice(start, end + 1), {
      status: 206,
      headers: { "content-range": `bytes ${start}-${end}/${ARCHIVE.byteLength}` },
    });
  });
  const { entries, symlinkTargets, bytes } = await fetchArchiveIndex("https://foo.test/baz.zip");
  assert.deepEqual(entries.map((entry) => entry.fileName), ["bin/", "bin/foo", "bin/bar"]);
  assert.deepEqual([...symlinkTargets], [["bin/bar", "foo"]]);
  assert.equal(bytes, ARCHIVE.byteLength);
  assert.equal(ranges.length, 2);
});
