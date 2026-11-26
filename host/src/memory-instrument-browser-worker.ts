import { rewriteProgramInWorker, type ProgramRewriteRequest } from "./memory-instrument-worker";

self.addEventListener("message", (event: MessageEvent<ProgramRewriteRequest>) => {
  const response = rewriteProgramInWorker(event.data);
  self.postMessage(response, { transfer: response.kind === "rewritten" ? [response.program] : [] });
}, { once: true });
