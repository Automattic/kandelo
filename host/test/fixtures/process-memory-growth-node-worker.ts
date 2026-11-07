import { parentPort } from "node:worker_threads";
import { runGrowthInterleaving, type GrowthInterleavingRequest } from "../support/process-memory-growth-interleaving";

const port = parentPort!;
port.on("message", (request: GrowthInterleavingRequest) => {
  port.postMessage(runGrowthInterleaving(request, () => port.postMessage({ type: "paused" })));
});
