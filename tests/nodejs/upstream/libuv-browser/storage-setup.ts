// These controls do not consume historical ABI fixtures. Keep run-owned browser
// storage cleanup without the ordinary suite's historical ABI provisioning.
import { setTimeout } from "node:timers/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ownedBrowserStorageRoot, removeBrowserStorageRoot, removeNewWritableStreams,
  webkitBrowsersRunning, webkitTemporaryDirectory, writableStreamFiles,
} from "../../../../apps/browser-demos/playwright-storage";

export default function setup() {
  if (process.platform !== "darwin") return;
  const reportDir = process.env.KANDELO_LIBUV_REPORT_DIR!;
  const root = ownedBrowserStorageRoot();
  const temporary = webkitTemporaryDirectory();
  const baseline = temporary === undefined ? new Set<string>() : writableStreamFiles(temporary);
  return async () => {
    try {
      const deadline = Date.now() + 5000;
      while (webkitBrowsersRunning() && Date.now() < deadline) await setTimeout(100);
      if (webkitBrowsersRunning()) throw new Error("WebKit still running; browser storage retained");
      if (temporary !== undefined) removeNewWritableStreams(temporary, baseline);
      if (root !== undefined) await removeBrowserStorageRoot(root);
      writeFileSync(join(reportDir, "browser-cleanup.json"), JSON.stringify({ status: "completed" }) + "\n");
    } catch (error) {
      // Match the ordinary browser suite's warning policy for run-owned host
      // storage cleanup; retain the warning separately from guest verdicts.
      const message = error instanceof Error ? error.message : String(error);
      writeFileSync(join(reportDir, "browser-cleanup.json"), JSON.stringify({ status: "warning", message, root }) + "\n");
      console.warn("[browser-storage] cleanup skipped: " + message);
    }
  };
}
