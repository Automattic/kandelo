import { setTimeout } from "node:timers/promises";
import { ownedBrowserStorageRoot, removeBrowserStorageRoot, removeNewWritableStreams,
  webkitBrowsersRunning, webkitTemporaryDirectory, writableStreamFiles } from "./playwright-storage";

export default function setup() {
  if (process.platform !== "darwin") return;
  const root = ownedBrowserStorageRoot();
  const temporary = webkitTemporaryDirectory();
  const baseline = temporary === undefined ? new Set<string>() : writableStreamFiles(temporary);
  return async () => {
    if (process.env.KANDELO_PLAYWRIGHT_KEEP_STORAGE === "1") {
      console.log(`[browser-storage] retained ${root}`);
      return;
    }
    try {
      const deadline = Date.now() + 5000;
      while (webkitBrowsersRunning() && Date.now() < deadline) await setTimeout(100);
      if (webkitBrowsersRunning()) {
        console.warn("[browser-storage] cleanup skipped: a Playwright WebKit browser is still running");
        return;
      }
      if (temporary !== undefined) {
        const removed = removeNewWritableStreams(temporary, baseline);
        console.log(`[browser-storage] removed ${removed.files} staging files (${removed.bytes} allocated bytes)`);
      }
      if (root !== undefined) {
        await removeBrowserStorageRoot(root);
        console.log(`[browser-storage] removed run-owned home ${root}`);
      }
    } catch (error) {
      console.warn("[browser-storage] cleanup skipped:", error);
    }
  };
}
