import { WasmPosixKernel, type KernelCallbacks } from "../../host/src/kernel";
import { ProgramRunner } from "../../host/src/program-runner";
import { VirtualPlatformIO } from "../../host/src/vfs/vfs";
import { MemoryFileSystem } from "../../host/src/vfs/memory-fs";
import { BrowserTimeProvider } from "../../host/src/vfs/time";
import kernelWasmUrl from "../../host/wasm/wasm_posix_kernel.wasm?url";

const output = document.getElementById("output") as HTMLPreElement;
const programSelect = document.getElementById("program") as HTMLSelectElement;
const runButton = document.getElementById("run") as HTMLButtonElement;

function appendOutput(text: string, className?: string) {
  const span = document.createElement("span");
  if (className) span.className = className;
  span.textContent = text;
  output.appendChild(span);
  output.scrollTop = output.scrollHeight;
}

const decoder = new TextDecoder();

async function run() {
  runButton.disabled = true;
  output.textContent = "";

  const programName = programSelect.value;
  appendOutput(`Loading ${programName}...\n`, "info");

  try {
    // Fetch kernel and program wasm in parallel
    const programWasmUrl = new URL(`../${programName}.wasm`, import.meta.url).href;
    const [kernelBytes, programBytes] = await Promise.all([
      fetch(kernelWasmUrl).then((r) => r.arrayBuffer()),
      fetch(programWasmUrl).then((r) => r.arrayBuffer()),
    ]);

    // Set up virtual filesystem
    const memfs = MemoryFileSystem.create(new SharedArrayBuffer(16 * 1024 * 1024));
    const io = new VirtualPlatformIO(
      [{ mountPoint: "/", backend: memfs }],
      new BrowserTimeProvider(),
    );

    // Pre-create common directories that example programs expect
    memfs.mkdir("/tmp", 0o777);
    memfs.mkdir("/home", 0o755);

    // Create kernel with stdout/stderr callbacks
    const callbacks: KernelCallbacks = {
      onStdout: (data) => appendOutput(decoder.decode(data)),
      onStderr: (data) => appendOutput(decoder.decode(data), "stderr"),
    };

    const kernel = new WasmPosixKernel(
      { maxWorkers: 1, dataBufferSize: 65536, useSharedMemory: true },
      io,
      callbacks,
    );

    await kernel.init(kernelBytes);

    appendOutput(`Running ${programName}...\n\n`, "info");

    const runner = new ProgramRunner(kernel);
    const exitCode = await runner.run(programBytes);

    appendOutput(`\nExited with code ${exitCode}\n`, "info");
  } catch (e) {
    appendOutput(`\nError: ${e}\n`, "stderr");
    console.error(e);
  } finally {
    runButton.disabled = false;
  }
}

runButton.addEventListener("click", run);
