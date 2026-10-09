import { installBrowserSetImmediatePolyfill } from "../../../../host/src/browser-immediate-polyfill";
installBrowserSetImmediatePolyfill();
const schedule = (callback: () => void) => {
  const target = globalThis as typeof globalThis & {
    setImmediate: (callback: () => void) => unknown;
  };
  target.setImmediate(callback);
};
let running = false;
let ticks = 0;
function tick() {
  ticks++;
  // Syscall notifications arrive as promise continuations between scheduler
  // flushes. A temporarily empty queue must not reset the fairness budget.
  if (running) Promise.resolve().then(() => schedule(tick));
}
self.onmessage = e => {
  if (e.data === "start") {
    running = true;
    schedule(tick);
    setTimeout(() => postMessage({ type: "timer", ticks }), 20);
    postMessage({ type: "started" });
  } else if (e.data === "ping") {
    postMessage({ type: "pong", ticks });
  } else running = false;
};
