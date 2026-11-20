import assert from "node:assert/strict";
import test from "node:test";

import { fetchSourceSize } from "../src/source-size";

const answer = (headers: Record<string, string>, status = 200) => async () => new Response(null, { status, headers });

test("reads the size from a HEAD answer's Content-Length", async (t) => {
  const methods: (string | undefined)[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => {
    methods.push(init?.method);
    return new Response(null, { headers: { "content-length": "42" } });
  });
  assert.equal(await fetchSourceSize("https://foo.test/bar"), 42);
  assert.deepEqual(methods, ["HEAD"]);
});

test("refuses a failed answer, a compressed answer, and an answer without a size", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", answer({}, 404));
  await assert.rejects(fetchSourceSize("https://foo.test/bar"), /^Error: https:\/\/foo\.test\/bar: 404/);
  fetch.mock.mockImplementation(answer({ "content-length": "42", "content-encoding": "gzip" }));
  await assert.rejects(fetchSourceSize("https://foo.test/bar"), { message: "https://foo.test/bar: the server compresses it (gzip), so its size is unknown" });
  fetch.mock.mockImplementation(answer({}));
  await assert.rejects(fetchSourceSize("https://foo.test/bar"), { message: "https://foo.test/bar: the server gives no size for it" });
});
