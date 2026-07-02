import { expect, test } from "@playwright/test";
import { attachBridgeToKernel } from "../lib/init/sw-bridge-fetch";
import { HttpBridgeHost, type HttpResponse } from "../lib/http-bridge";

test("service-worker fetch bridge reports pending request counts", async () => {
  const bridge = new HttpBridgeHost();
  let resolveFetch: ((response: HttpResponse) => void) | null = null;
  const kernel = {
    fetchInKernel: () => new Promise<HttpResponse>((resolve) => {
      resolveFetch = resolve;
    }),
  };
  const counts: number[] = [];

  attachBridgeToKernel(
    bridge,
    kernel as Parameters<typeof attachBridgeToKernel>[1],
    8080,
    { onPendingRequests: (count) => counts.push(count) },
  );

  const swPort = bridge.getSwPort();
  const replies: unknown[] = [];
  swPort.onmessage = (event) => {
    replies.push(event.data);
  };
  swPort.start?.();
  swPort.postMessage({
    type: "http-request",
    requestId: 7,
    method: "GET",
    url: "/app/",
    headers: {},
    body: null,
  });

  await expect.poll(() => counts).toEqual([1]);

  resolveFetch?.({
    status: 200,
    headers: { "content-type": "text/plain" },
    body: new Uint8Array([111, 107]),
  });

  await expect.poll(() => counts).toEqual([1, 0]);
  await expect.poll(() => replies.length).toBe(1);
  expect(replies).toEqual([
    expect.objectContaining({
      type: "http-response",
      requestId: 7,
      status: 200,
    }),
  ]);

  swPort.close();
});
