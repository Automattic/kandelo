// Browser waiter worker for K10 probe 2.
import { runWaiter } from "./chan-core.js";

self.onmessage = async (ev) => {
  const { memory, bytes, base } = ev.data;
  await runWaiter({ memory, bytes, base, post: (m) => self.postMessage(m) });
};
