import assert from "node:assert/strict";
import { holdObservation } from "./observer-promises.js";

const failure = new Error("recorded frame failure while input dispatch is in flight");
const frame = process.env.KPERF_UNHANDLED_CONTROL === "1"
  ? Promise.reject(failure)
  : holdObservation(Promise.reject(failure));
// Reproduce the real ordering: the frame fails before keyboard.down resolves.
// Raw rejection must terminate under Node's strict unhandled-rejection policy.
await new Promise<void>(resolve => setImmediate(resolve));
await assert.rejects(frame, error => error === failure);
console.log("frame failure remains handled during input dispatch and propagates unchanged: PASS");
