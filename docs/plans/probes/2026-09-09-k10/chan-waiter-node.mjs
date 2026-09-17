// Node waiter worker for K10 probe 2.
import { parentPort, workerData } from "node:worker_threads";
import { runWaiter } from "./chan-core.js";

await runWaiter({
  memory: workerData.memory,
  bytes: workerData.bytes,
  base: workerData.base,
  post: (m) => parentPort.postMessage(m),
});
