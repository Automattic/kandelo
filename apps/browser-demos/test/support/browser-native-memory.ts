import type { Page } from "@playwright/test";

/** Optional read-only macOS sampling installed by the WebKit observer. */
export async function sampleBrowserNativeMemory(page: Page): Promise<unknown> {
  const sample = (globalThis as typeof globalThis & {
    [key: symbol]: ((page: Page) => Promise<unknown>) | undefined;
  })[Symbol.for("kandelo.webKitNativeProcessMemory")];
  return sample?.(page);
}
