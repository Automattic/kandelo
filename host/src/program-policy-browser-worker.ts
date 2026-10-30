import { inspectPolicyInWorker, type PolicyWorkerRequest } from "./program-policy-worker";

self.addEventListener("message", (event: MessageEvent<PolicyWorkerRequest>) => {
  self.postMessage(inspectPolicyInWorker(event.data));
}, { once: true });
