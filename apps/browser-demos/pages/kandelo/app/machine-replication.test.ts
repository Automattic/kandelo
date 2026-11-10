import assert from "node:assert/strict";
import test from "node:test";
import { missedRequest } from "./machine-replication.ts";

const page = "https://foo.example/kandelo/";
const preview = "/kandelo/preview/";

test("a miss key names a request inside the machine's preview", () => {
  const request = missedRequest(preview, "GET /bar?baz=1", page);
  assert.equal(request?.method, "GET");
  assert.equal(request?.target.href, "https://foo.example/kandelo/preview/bar?baz=1");
});

test("a miss key that leaves the preview names nothing", () => {
  for (const key of [
    "GET https://qux.example/admin",
    "GET //qux.example/admin",
    "GET ../settings",
    "GET /%2e%2e/settings",
    "POST /bar",
    "GET",
  ]) {
    assert.equal(missedRequest(preview, key, page), null, key);
  }
});

test("a machine without a preview serves no miss", () => {
  assert.equal(missedRequest(undefined, "GET /bar", page), null);
  assert.equal(missedRequest("about:blank", "GET /bar", page), null);
});
