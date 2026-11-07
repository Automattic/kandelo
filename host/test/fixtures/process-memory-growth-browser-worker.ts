import { runGrowthInterleaving, type GrowthInterleavingRequest } from "../support/process-memory-growth-interleaving";

const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<GrowthInterleavingRequest>) => void;
  postMessage: (value: unknown) => void;
};
scope.onmessage = ({ data }) => {
  scope.postMessage(runGrowthInterleaving(data, () => scope.postMessage({ type: "paused" })));
};
