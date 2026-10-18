import { expect, test } from "@playwright/test";

for (const ptrWidth of [4, 8] as const) {
  test(`fresh allocation workers preserve a memory${ptrWidth * 8} fork snapshot`, async ({ page }) => {
    await page.goto("/trap-signal-test.html");
    const result = await page.evaluate(async width => {
      const worker = new Worker(new URL(
        "/test/fixtures/browser-process-memory-worker.ts", location.href,
      ), { type: "module" });
      try {
        return await new Promise((resolve, reject) => {
          worker.onmessage = event => resolve(event.data);
          worker.onerror = event => reject(new Error(event.message));
          worker.postMessage(width);
        });
      } finally {
        worker.terminate();
      }
    }, ptrWidth);
    expect(result).toEqual({ captured: true, oldPages: 1, bytes: 2 * 65536 });
  });
}
