import assert from "node:assert/strict";
import test from "node:test";
import { HttpBridgeHost } from "../http-bridge";
import { attachBridgeToKernel } from "./sw-bridge-fetch";
import type { BrowserKernel } from "@host/browser-kernel-host";

for (const active of [true, false]) {
  test(`a ${active ? "live" : "retired"} bridge only forwards requests for its active kernel`, { timeout: 5_000 }, async () => {
    const bridge = new HttpBridgeHost();
    const port = bridge.getSwPort();
    const pending: number[] = [];
    const completed: Array<number | null> = [];
    let forwarded = 0;
    const kernel = {
      async fetchInKernel() {
        forwarded++;
        return { status: 200, headers: {}, body: new Uint8Array([7]) };
      },
    } as unknown as BrowserKernel;
    try {
      attachBridgeToKernel(bridge, kernel, 80, {
        isActive: () => active,
        onPendingRequests: count => pending.push(count),
        onRequestStart: () => status => completed.push(status),
      });
      const received = new Promise<Record<string, unknown>>(resolve => {
        port.onmessage = event => resolve(event.data);
      });
      port.postMessage({ type: "http-request", requestId: 41, method: "GET", url: "/pending", headers: {}, body: null });
      const response = await received;
      if (active) {
        assert.equal(forwarded, 1);
        assert.deepEqual(response, { type: "http-response", requestId: 41, status: 200,
          headers: {}, body: new Uint8Array([7]) });
        assert.deepEqual(pending, [1, 0]);
        assert.deepEqual(completed, [200]);
      } else {
        assert.equal(forwarded, 0);
        assert.deepEqual(response, { type: "http-error", requestId: 41, error: "HTTP bridge retired" });
        assert.deepEqual(pending, []);
        assert.deepEqual(completed, []);
      }
    } finally {
      bridge.detachHostPort().close();
      port.close();
    }
  });
}

test("an entered request reports kernel shutdown and drains its pending count", { timeout: 5_000 }, async () => {
  const bridge = new HttpBridgeHost();
  const port = bridge.getSwPort();
  let rejectFetch!: (error: Error) => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const fetching = new Promise<never>((_resolve, reject) => { rejectFetch = reject; });
  const kernel = { fetchInKernel() { entered(); return fetching; } } as unknown as BrowserKernel;
  const pending: number[] = [];
  try {
    attachBridgeToKernel(bridge, kernel, 80, { onPendingRequests: count => pending.push(count) });
    const received = new Promise<Record<string, unknown>>(resolve => { port.onmessage = event => resolve(event.data); });
    port.postMessage({ type: "http-request", requestId: 42, method: "GET", url: "/pending", headers: {}, body: null });
    await started;
    rejectFetch(new Error("kernel host destroyed"));
    assert.deepEqual(await received, { type: "http-error", requestId: 42, error: "kernel host destroyed" });
    assert.deepEqual(pending, [1, 0]);
  } finally {
    bridge.detachHostPort().close();
    port.close();
  }
});
