import { BrowserKernel } from "./lib/browser-kernel";
import kernelWasmUrl from "@kernel-wasm?url";

const output = document.getElementById("output") as HTMLPreElement;
const programSelect = document.getElementById("program") as HTMLSelectElement;
const runButton = document.getElementById("run") as HTMLButtonElement;
const forkCountDebug = document.getElementById("fork-count-debug") as HTMLDivElement;

const decoder = new TextDecoder();

function appendOutput(text: string, className?: string) {
  const span = document.createElement("span");
  if (className) span.className = className;
  span.textContent = text;
  output.appendChild(span);
  output.scrollTop = output.scrollHeight;
}

/**
 * Pre-stage state required by certain demo programs before they run.
 *
 * `spawn-smoke` is a tiny posix_spawn smoke test: it spawns the program at
 * `argv[1]` and waits for it. To exercise the non-forking spawn path on
 * the browser host we register `/usr/bin/hello` as a lazy file pointing at
 * the same `hello.wasm` URL the simple page already serves. When the
 * spawned child resolves the path, the browser kernel-worker fetches the
 * binary on demand via `MemoryFileSystem.ensureMaterialized`. No new
 * binary built, no separate VFS image.
 */
function prestageForProgram(
  kernel: BrowserKernel,
  programName: string,
): { argv: string[] } {
  if (programName !== "spawn-smoke") {
    return { argv: [programName] };
  }
  const helloUrl = new URL("../hello.wasm", import.meta.url).href;
  // We don't know the exact size up-front without an HTTP HEAD; pass a
  // generous overestimate and let the lazy materializer fetch the actual
  // bytes. The size is only used as a stat hint, not for buffer sizing.
  kernel.registerLazyFiles([
    { path: "/usr/bin/hello", url: helloUrl, size: 1 << 20, mode: 0o755 },
  ]);
  return { argv: ["spawn-smoke", "/usr/bin/hello"] };
}

async function run() {
  runButton.disabled = true;
  output.textContent = "";
  forkCountDebug.dataset.forkCount = "";

  const programName = programSelect.value;
  appendOutput(`Loading ${programName}...\n`, "info");

  try {
    // Fetch kernel and program wasm in parallel
    const programWasmUrl = new URL(`../${programName}.wasm`, import.meta.url)
      .href;
    const [kernelBytes, programBytes] = await Promise.all([
      fetch(kernelWasmUrl).then((r) => r.arrayBuffer()),
      fetch(programWasmUrl).then((r) => r.arrayBuffer()),
    ]);

    const kernel = new BrowserKernel({
      onStdout: (data) => appendOutput(decoder.decode(data)),
      onStderr: (data) => appendOutput(decoder.decode(data), "stderr"),
    });

    await kernel.init(kernelBytes);

    const { argv } = prestageForProgram(kernel, programName);

    appendOutput(`Running ${programName}...\n\n`, "info");

    // Capture the spawned pid via onStarted so we can read the kernel's
    // fork counter after exit. For non-spawn programs this is harmless
    // bookkeeping; for spawn-smoke it's the load-bearing assertion the
    // Playwright test reads through `data-fork-count`.
    let capturedPid: number | undefined;
    const exitCode = await kernel.spawn(programBytes, argv, {
      onStarted: (pid: number) => {
        capturedPid = pid;
      },
    });
    appendOutput(`\nExited with code ${exitCode}\n`, "info");

    if (capturedPid !== undefined) {
      const forkCount = await kernel.getForkCount(capturedPid);
      forkCountDebug.dataset.forkCount = forkCount.toString();
    }
  } catch (e) {
    appendOutput(`\nError: ${e}\n`, "stderr");
    console.error(e);
  } finally {
    runButton.disabled = false;
  }
}

runButton.addEventListener("click", run);
