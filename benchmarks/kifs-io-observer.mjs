// Test workers expose cumulative positioned I/O counts for one disposable computer.
export function observeComputer(name) {
  const counts = { flushes: 0, flushMs: 0, readCalls: 0, bytesRead: 0, writeCalls: 0, bytesWritten: 0, rootWrites: 0 };
  const preparation = { ...counts, calls: 0, ms: 0 };
  let staging;
  const channel = new BroadcastChannel("kifs-benchmark-" + name);
  channel.onmessage = ({ data }) => {
    if (data === "read") channel.postMessage({ ...counts, preparation });
  };
  channel.unref?.();
  return {
    beginPreparation() {
      if (staging) throw new Error("Overlapping KIFS staging intervals");
      staging = { before: { ...counts }, start: performance.now() };
    },
    endPreparation() {
      if (!staging) return;
      preparation.calls++;
      preparation.ms += performance.now() - staging.start;
      for (const key of Object.keys(counts)) preparation[key] += counts[key] - staging.before[key];
      staging = undefined;
    },
    flush(operation) {
      const start = performance.now();
      try { return operation(); }
      finally { counts.flushMs += performance.now() - start; counts.flushes++; }
    },
    read(bytes) { counts.readCalls++; counts.bytesRead += bytes; },
    written(bytes, rootWrite = false) { counts.writeCalls++; counts.bytesWritten += bytes; if (rootWrite) counts.rootWrites++; },
  };
}
