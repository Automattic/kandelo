import { BrowserWorkerAdapter } from "../../src/worker-adapter-browser";
import { VirtualPlatformIO } from "../../src/vfs/vfs";
import { BrowserTimeProvider } from "../../src/vfs/time";
import { runSdkExecution } from "./grouped-sdk-execution";
import { installBrowserSetImmediatePolyfill } from "../../src/browser-immediate-polyfill";

installBrowserSetImmediatePolyfill();

// Fetch executable bytes inside this disposable kernel realm. The page only
// supplies a mode, and receives owned output/scalars after exact quiescence.
self.onmessage = async (event: MessageEvent<{ grouped: boolean; probe?: "mapping" | "private-file" | "fork" }>) => {
  self.onmessage = null;
  try {
    const grouped = event.data.grouped;
    const probe = event.data.probe ?? "mapping";
    if (probe !== "mapping" && probe !== "private-file" && probe !== "fork") throw new Error("unknown SDK probe");
    const read = async (path: string) => {
      const response = await fetch(path);
      if (!response.ok) throw new Error(`fixture fetch ${path}: ${response.status}`);
      return response.arrayBuffer();
    };
    const [kernelBytes, imageModuleBytes, ordinaryBytes, programBytes] = await Promise.all([
      read("/kernel.wasm"), read("/image-module.wasm"), read(`/${probe}/ordinary.wasm`),
      read(`/${probe}/${grouped ? "grouped" : "ordinary"}.wasm`),
    ]);
    self.postMessage(await runSdkExecution({ kernelBytes, imageModuleBytes, ordinaryBytes, programBytes, grouped,
      io: new VirtualPlatformIO([], new BrowserTimeProvider()),
      adapter: new BrowserWorkerAdapter(new URL("/process.mjs", self.location.href)), joinOnExit: false,
    }));
  } catch (error) {
    self.postMessage({ failure: error instanceof Error ? error.stack : String(error) });
  } finally { self.close(); }
};
