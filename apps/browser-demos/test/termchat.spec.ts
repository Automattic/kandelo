import { expect, test } from "@playwright/test";
import { resolve } from "node:path";
import { termchatImage, transferBytes } from "../../../packages/registry/termchat/test/image";

test("termchat discovers, chats, transfers a file and restores browser terminals", async ({ page, baseURL, browserName }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const image = await termchatImage();
  await page.goto("/trap-signal-test.html");
  try {
    await page.evaluate(async ({ url, image }) => {
      const { startTermchatBrowserTest } = await import(/* @vite-ignore */ url);
      await startTermchatBrowserTest(image);
    }, { url: new URL(`/@fs/${resolve("test/termchat-browser.ts")}`, baseURL).href, image: Array.from(image) });
    await page.evaluate(() => (window as any).__termchatHarness.send(0, "hello-from-alice"));
    await expect.poll(() => page.evaluate(() => (window as any).__termchatHarness.text(1))).toContain("hello-from-alice");
    await page.evaluate(() => (window as any).__termchatHarness.send(1, "hello-from-bob"));
    await expect.poll(() => page.evaluate(() => (window as any).__termchatHarness.text(0))).toContain("hello-from-bob");
    await page.evaluate(() => (window as any).__termchatHarness.send(0, "?send /usr/share/probe.bin"));
    await expect.poll(() => page.evaluate(async () => {
      const data = await (window as any).__termchatHarness.kernels[1].readFileFromVfs("/tmp/termchat/alice/probe.bin");
      return data ? Array.from(data) : null;
    }), { timeout: 30_000 }).toEqual(Array.from(transferBytes));
    await page.evaluate(() => { const h = (window as any).__termchatHarness; h.resize(0); h.resize(1); h.send(1, "after-resize"); });
    await expect.poll(() => page.evaluate(() => (window as any).__termchatHarness.text(0))).toContain("after-resize");
    await page.screenshot({ path: resolve(`../../.context/termchat-browser-${browserName}.png`), fullPage: true });
    expect(await page.evaluate(() => (window as any).__termchatHarness.stop(1))).toBe(0);
    await expect.poll(() => page.evaluate(() => (window as any).__termchatHarness.text(0))).toContain("bob is offline");
    expect(await page.evaluate(() => (window as any).__termchatHarness.stop(0))).toBe(0);
    const result = await page.evaluate(async () => {
      const h = (window as any).__termchatHarness;
      return { stderr: h.stderr, diagnostics: h.diagnostics,
        restored: h.raw.map((s: string) => s.includes("\x1b[?1049l")),
        procs: await Promise.all(h.kernels.map(async (k: any) => (await k.enumProcs()).filter((p: any) => p.pid !== 1))),
      };
    });
    expect(result).toEqual({ stderr: [], diagnostics: [], restored: [true, true], procs: [[], []] });
    expect(errors).toEqual([]);
  } finally { await page.evaluate(async () => { await (window as any).__termchatHarness?.destroy(); }); }
});
