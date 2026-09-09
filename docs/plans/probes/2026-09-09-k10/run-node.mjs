// K10 I0 probes on Node. Probes 1 + 3 run inline; probe 2 needs a blocking
// agent, so its waiter runs in a worker_thread.
import { readFile } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import { setTimeout as sleep } from "node:timers/promises";
import { runProbes } from "./probe-core.js";
import { runProbe4 } from "./probe4-core.js";
import { driveProbe } from "./chan-core.js";

const load = async (f) => new Uint8Array(await readFile(new URL(f, import.meta.url)));

const results = await runProbes(load);

// ---- probe 4 (the guest-defines-its-own-memory category)
try {
  Object.assign(results, await runProbe4(load));
} catch (e) {
  results["P4.FATAL"] = String((e && e.stack) || e);
}

// ---- probe 2
try {
  const bytes = await load("p2-chan.wasm");
  const memory = new WebAssembly.Memory({ initial: 8, maximum: 256, shared: true });
  const base = 4 * 65536;
  const p2 = await driveProbe({
    memory,
    bytes,
    base,
    sleep,
    spawn: (onMessage) => {
      const w = new Worker(new URL("./chan-waiter-node.mjs", import.meta.url), {
        workerData: { memory, bytes, base },
      });
      w.on("message", (m) => { onMessage(m); if (m.phase === "end") w.terminate(); });
      w.on("error", (e) => onMessage({ phase: "end", error: String(e) }));
    },
  });
  for (const [k, v] of Object.entries(p2)) results["P2." + k] = v;
} catch (e) {
  results["P2.ERROR"] = String((e && e.stack) || e);
}

console.log(JSON.stringify({ engine: `node ${process.version}`, results }, null, 2));
process.exit(0);
