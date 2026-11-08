import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { fetchRequiredExecutable } from "../pages/test-runner/required-executable";

afterEach(() => mock.restoreAll());
const asset = "https://runner.invalid/required-shell.wasm";

// WHY: a fulfilled fetch is not executable readiness. Exercise the actual
// transport guard without starting a guest or duplicating loader validation.
test("required executable preserves valid Wasm header bytes", async () => {
  const bytes = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 0xde, 0xad]);
  const response = new Response(bytes);
  const fetch = mock.method(globalThis, "fetch", async (input: unknown) => { assert.equal(input, asset); return response; });
  assert.deepEqual(new Uint8Array(await fetchRequiredExecutable(asset)), bytes);
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(fetch.mock.calls[0].arguments[0], asset);
});

test("required executable rejects HTTP failure with asset and status", async () => {
  mock.method(globalThis, "fetch", async () => new Response("unavailable", { status: 503 }));
  await assert.rejects(fetchRequiredExecutable(asset), {
    message: `Test-runner executable ${asset}: HTTP 503`,
  });
});

for (const [name, bytes] of [
  ["empty body", new Uint8Array()],
  ["truncated magic", new Uint8Array([0, 0x61, 0x73])],
  ["HTTP200 HTML body", new TextEncoder().encode("<!doctype html><title>Error</title>")],
] as const) {
  test(`required executable rejects ${name}`, async () => {
    mock.method(globalThis, "fetch", async () => new Response(bytes));
    await assert.rejects(fetchRequiredExecutable(asset), {
      message: `Test-runner executable ${asset}: missing WebAssembly header`,
    });
  });
}

test("required executable preserves the original network failure", async () => {
  const failure = new TypeError("network unavailable");
  mock.method(globalThis, "fetch", async () => { throw failure; });
  await assert.rejects(fetchRequiredExecutable(asset), error => error === failure);
});
