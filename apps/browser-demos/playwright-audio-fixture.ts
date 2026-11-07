import type { Browser, BrowserContext } from "@playwright/test";
import { SILENT_AUDIO_INIT_SCRIPT } from "./playwright-audio";

export interface KandeloWorkerOptions {
  silentAudio: boolean;
}

/** Every automated browser launch uses this fixture, including tests that
 * create their own contexts or persistent profiles. No OS volume is changed.
 */
export function withSilentAudio(base: typeof import("@playwright/test").test) {
  return base.extend<{}, KandeloWorkerOptions & { _silentBrowsers: void }>({
  silentAudio: [process.env.KANDELO_PLAYWRIGHT_AUDIBLE_AUDIO !== "1", { scope: "worker", option: true }],
  _silentBrowsers: [async ({ playwright, silentAudio }, use) => {
    if (!silentAudio) { await use(); return; }
    const restores: Array<() => void> = [];
    const contexts = new WeakSet<BrowserContext>();
    const browsers = new WeakSet<Browser>();
    const prepareContext = async (context: BrowserContext) => {
      if (contexts.has(context)) return;
      contexts.add(context);
      try {
        await context.addInitScript({ content: SILENT_AUDIO_INIT_SCRIPT });
        // Persistent contexts and browser.newPage() already have a blank page.
        for (const page of context.pages()) {
          if (!page.isClosed()) await page.evaluate(SILENT_AUDIO_INIT_SCRIPT);
        }
      } catch (error) {
        await context.close().catch(() => {});
        throw error;
      }
    };
    const after = <T>(target: object, method: string, prepare: (value: T) => Promise<void>) => {
      const methods = target as Record<string, (...args: unknown[]) => Promise<T>>;
      const original = methods[method];
      const wrapped = async function (this: object, ...args: unknown[]): Promise<T> {
        const result = await original.apply(this, args);
        await prepare(result);
        return result;
      };
      methods[method] = wrapped;
      restores.push(() => { if (methods[method] === wrapped) methods[method] = original; });
    };
    const prepareBrowser = async (browser: Browser) => {
      if (browsers.has(browser)) return;
      browsers.add(browser);
      after(browser, "newContext", prepareContext);
      after(browser, "newPage", async (page: import("@playwright/test").Page) => prepareContext(page.context()));
      // A connected browser can have unrelated existing tabs. Only contexts
      // created by these tests receive the policy; never mute a user's call.
    };
    for (const browserType of [playwright.chromium, playwright.firefox, playwright.webkit]) {
      after(browserType, "launch", prepareBrowser);
      after(browserType, "connect", prepareBrowser);
      after(browserType, "launchPersistentContext", prepareContext);
    }
    after(playwright.chromium, "connectOverCDP", prepareBrowser);
    try { await use(); }
    finally { for (const restore of restores.reverse()) restore(); }
  }, { scope: "worker", auto: true }],
});
}
