import { BrowserWorkerAdapter } from "../../src/worker-adapter-browser";
import { VirtualPlatformIO } from "../../src/vfs/vfs";
import { BrowserTimeProvider } from "../../src/vfs/time";
import { runSdkExecution } from "./grouped-sdk-execution";
import { installBrowserSetImmediatePolyfill } from "../../src/browser-immediate-polyfill";

installBrowserSetImmediatePolyfill();

// Fetch executable bytes inside this disposable kernel realm. The page only
// supplies a mode, and receives owned output/scalars after exact quiescence.
self.onmessage = async (event: MessageEvent<{ grouped: boolean }>) => {
  self.onmessage = null;
  try {
    const grouped = event.data.grouped;
    const read = async (path: string) => {
      const response = await fetch(path);
      if (!response.ok) throw new Error(`fixture fetch ${path}: ${response.status}`);
      return response.arrayBuffer();
    };
    const [kernelBytes, ordinaryBytes, programBytes] = await Promise.all([
      read("/kernel.wasm"), read("/ordinary.wasm"), read(grouped ? "/grouped.wasm" : "/ordinary.wasm"),
    ]);
    self.postMessage(await runSdkExecution({ kernelBytes, ordinaryBytes, programBytes, grouped,
      io: new VirtualPlatformIO([], new BrowserTimeProvider()),
      adapter: new BrowserWorkerAdapter(new URL("/process.mjs", self.location.href)), joinOnExit: false,
    }));
  } catch (error) {
    self.postMessage({ failure: error instanceof Error ? error.stack : String(error) });
  } finally { self.close(); }
};
