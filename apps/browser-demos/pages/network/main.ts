import "./styles.css";

type WorkerEvent =
  | { type: "ready" }
  | { type: "status"; status: string }
  | { type: "machine"; machine: string; status: string }
  | { type: "step"; step: string; status: "running" | "passed" | "failed" }
  | { type: "log"; machine: string; stream: "stdout" | "stderr" | "stdin" | "system"; text: string }
  | { type: "result"; step: string; title: string; ok: boolean; detail: string }
  | { type: "done"; ok: boolean }
  | { type: "error"; message: string };

const runButton = document.getElementById("run") as HTMLButtonElement;
const clearButton = document.getElementById("clear") as HTMLButtonElement;
const transcript = document.getElementById("transcript") as HTMLPreElement;
const overallStatus = document.getElementById("overall-status") as HTMLSpanElement;
const resultCount = document.getElementById("result-count") as HTMLSpanElement;
const results = document.getElementById("results") as HTMLDivElement;

const worker = new Worker(new URL("./network-demo-worker.ts", import.meta.url), { type: "module" });
let passedResults = 0;
let totalResults = 0;

function appendLog(machine: string, stream: string, text: string): void {
  const prefix = `[${machine}:${stream}] `;
  const normalized = text.endsWith("\n") ? text : `${text}\n`;
  transcript.textContent += normalized
    .split("\n")
    .filter((line, index, arr) => line.length > 0 || index < arr.length - 1)
    .map((line) => `${prefix}${line}`)
    .join("\n");
  if (!transcript.textContent.endsWith("\n")) transcript.textContent += "\n";
  transcript.scrollTop = transcript.scrollHeight;
}

function setMachine(machine: string, status: string): void {
  const el = document.getElementById(`machine-${machine}`);
  if (!el) return;
  el.textContent = status;
  const card = el.closest<HTMLElement>(".machine");
  card?.setAttribute("data-state", status.includes("running") ? "running" : status.includes("pass") ? "passed" : status.includes("fail") ? "failed" : "idle");
}

function setStep(step: string, status: "running" | "passed" | "failed"): void {
  document.querySelector<HTMLElement>(`[data-step="${step}"]`)?.setAttribute("data-state", status);
}

function resetUi(): void {
  transcript.textContent = "";
  results.textContent = "";
  passedResults = 0;
  totalResults = 0;
  resultCount.textContent = "0/3";
  overallStatus.textContent = "starting";
  for (const machine of ["alpha", "beta", "gamma"]) setMachine(machine, "booting");
  for (const step of ["udp", "tcp", "curl"]) {
    document.querySelector<HTMLElement>(`[data-step="${step}"]`)?.removeAttribute("data-state");
  }
}

function addResult(event: Extract<WorkerEvent, { type: "result" }>): void {
  totalResults += 1;
  if (event.ok) passedResults += 1;
  resultCount.textContent = `${passedResults}/3`;
  const item = document.createElement("div");
  item.className = "result";
  item.setAttribute("data-state", event.ok ? "passed" : "failed");
  item.innerHTML = `<strong></strong><p></p>`;
  item.querySelector("strong")!.textContent = event.title;
  item.querySelector("p")!.textContent = event.detail;
  results.appendChild(item);
}

worker.onmessage = (message: MessageEvent<WorkerEvent>) => {
  const event = message.data;
  switch (event.type) {
    case "ready":
      overallStatus.textContent = "ready";
      break;
    case "status":
      overallStatus.textContent = event.status;
      break;
    case "machine":
      setMachine(event.machine, event.status);
      break;
    case "step":
      setStep(event.step, event.status);
      break;
    case "log":
      appendLog(event.machine, event.stream, event.text);
      break;
    case "result":
      addResult(event);
      break;
    case "done":
      overallStatus.textContent = event.ok ? "complete" : "failed";
      runButton.disabled = false;
      break;
    case "error":
      overallStatus.textContent = "failed";
      appendLog("runner", "system", event.message);
      runButton.disabled = false;
      break;
  }
};

worker.onerror = (event) => {
  overallStatus.textContent = "failed";
  appendLog("runner", "system", event.message);
  runButton.disabled = false;
};

runButton.addEventListener("click", () => {
  resetUi();
  runButton.disabled = true;
  worker.postMessage({ type: "run" });
});

clearButton.addEventListener("click", () => {
  transcript.textContent = "";
});
