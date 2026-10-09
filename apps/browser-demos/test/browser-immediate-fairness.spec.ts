import { expect, test } from "@playwright/test";

test("continuous browser immediates admit worker input and timers", async ({ page }) => {
  await page.goto("/trap-signal-test.html");
  const result = await page.evaluate(async () => {
    const worker = new Worker(
      "/test/fixtures/browser-immediate-fairness-worker.ts",
      { type: "module" },
    );
    const messages: { type: string; ticks: number }[] = [];
    return new Promise<typeof messages>((resolve, reject) => {
      const finish = () => {
        clearTimeout(timeout);
        worker.terminate();
        resolve(messages);
      };
      const timeout = setTimeout(finish, 2_000);
      worker.onerror = (event) => {
        clearTimeout(timeout);
        worker.terminate();
        reject(new Error(event.message));
      };
      worker.onmessage = (event: MessageEvent<{ type: string; ticks: number }>) => {
        messages.push(event.data);
        if (event.data.type === "started") worker.postMessage("ping");
        if (messages.some((message) => message.type === "pong") &&
            messages.some((message) => message.type === "timer")) finish();
      };
      worker.postMessage("start");
    });
  });
  expect(result).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: "pong" }),
    expect.objectContaining({ type: "timer" }),
  ]));
});
