import { BrowserKernel } from "./lib/browser-kernel";
import kernelWasmUrl from "@kernel-wasm?url";

const output = document.getElementById("output") as HTMLPreElement;
const programSelect = document.getElementById("program") as HTMLSelectElement;
const runButton = document.getElementById("run") as HTMLButtonElement;

const decoder = new TextDecoder();

function appendOutput(text: string, className?: string) {
  const span = document.createElement("span");
  if (className) span.className = className;
  span.textContent = text;
  output.appendChild(span);
  output.scrollTop = output.scrollHeight;
}

async function run() {
  runButton.disabled = true;
  output.textContent = "";

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

    appendOutput(`Running ${programName}...\n\n`, "info");

    const exitCode = await kernel.spawn(programBytes, [programName]);
    appendOutput(`\nExited with code ${exitCode}\n`, "info");
  } catch (e) {
    appendOutput(`\nError: ${e}\n`, "stderr");
    console.error(e);
  } finally {
    runButton.disabled = false;
  }
}

runButton.addEventListener("click", run);
