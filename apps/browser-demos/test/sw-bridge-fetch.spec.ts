import { expect, test } from "@playwright/test";
import { PreviewBridgeHost, type KernelHttpResponse } from "../lib/preview/preview-bridge";
import { PREVIEW_PROTOCOL_VERSION } from "../lib/preview/protocol";

// The preview service worker's requests reach the owning tab's
// PreviewBridgeHost, which reports how many are waiting on the kernel so the
// URL bar can show the preview is loading.
test("preview bridge reports pending request counts", async () => {
  let resolveFetch: ((response: KernelHttpResponse) => void) | null = null;
  const counts: number[] = [];
  let workerPort: MessagePort | null = null;

  const bridge = await PreviewBridgeHost.open({
    relay: {
      bind: async (_name, _secret, port) => {
        workerPort = port;
      },
      closing: () => {},
      onNeedBridge: () => () => {},
      onWorkerChanged: () => () => {},
    },
    previewOrigin: "http://127.0.0.1:5402",
    scope: "/",
    appOrigin: "http://127.0.0.1:5401",
    port: 8080,
    kernel: {
      fetchInKernel: () => new Promise<KernelHttpResponse>((resolve) => {
        resolveFetch = resolve;
      }),
    },
    onPendingRequests: (count) => counts.push(count),
  });

  const replies: unknown[] = [];
  const port = workerPort!;
  port.onmessage = (event) => {
    replies.push(event.data);
  };
  port.start?.();
  port.postMessage({
    type: "http-request",
    v: PREVIEW_PROTOCOL_VERSION,
    id: 7,
    method: "GET",
    url: "/",
    headers: [],
    body: null,
    mode: "navigate",
    destination: "iframe",
    navigation: true,
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
      v: PREVIEW_PROTOCOL_VERSION,
      id: 7,
      status: 200,
    }),
  ]);

  bridge.dispose();
  port.close();
});
