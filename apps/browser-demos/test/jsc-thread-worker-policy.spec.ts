import { expect, test } from "@playwright/test";
import { resolve } from "node:path";

// [RUNTIME-WORKAROUND: JSC-SHARED-MEMORY-GROW-INSTANCE-TEARDOWN]
// Browser workers choose the thread-worker lifetime from their own user
// agent: on JavaScriptCore exited thread workers keep their instances until
// their process ends; elsewhere they are terminated at once. Check that each
// engine's real user agent, in the page and in a Worker, selects its policy,
// so a detection change cannot silently move WebKit back onto the path that
// crashes it, or other engines onto the workaround.
test("each engine selects its thread-worker lifetime from its own user agent", async ({
  browserName,
  page,
  baseURL,
}) => {
  await page.goto(new URL("/trap-signal-test.html", baseURL).href);
  const selected = await page.evaluate(async (moduleUrl) => {
    const { isJavaScriptCoreUserAgent } = await import(/* @vite-ignore */ moduleUrl);
    const worker = new Worker(URL.createObjectURL(new Blob(
      ["postMessage(navigator.userAgent)"],
      { type: "text/javascript" },
    )));
    const workerUserAgent = await new Promise<string>((done) => {
      worker.onmessage = ({ data }) => done(data as string);
    });
    worker.terminate();
    return {
      page: isJavaScriptCoreUserAgent(navigator.userAgent) as boolean,
      worker: isJavaScriptCoreUserAgent(workerUserAgent) as boolean,
    };
  }, new URL(
    `/@fs/${resolve(import.meta.dirname, "../../../host/src/runtime-memory-profile.ts")}`,
    baseURL,
  ).href);
  const javaScriptCore = browserName === "webkit";
  expect(selected).toEqual({ page: javaScriptCore, worker: javaScriptCore });
});
