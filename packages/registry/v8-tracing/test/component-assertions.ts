export const expectedCases = [
  "disabled-category-real-state", "enabled-category-flags-and-observer",
  "copied-event-payload-and-native-identities", "convertable-value-ownership",
  "actual-duration-clocks", "concurrent-guest-thread-recording",
  "stop-restart-flags-and-observers", "original-json-writer-and-guest-file",
  "ring-buffer-handle-retirement",
];
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
export function assertTracingOutput(stdout: string) {
  const rows = stdout.trim().split("\n").map((line) => JSON.parse(line));
  const summary = rows.pop();
  check(summary.kind === "v8-tracing-component-controls" && summary.cases === 9 && summary.failures === 0, "component summary");
  check(rows.length === 9 && rows.every((r, i) => r.case === expectedCases[i] && r.status === "pass"), "component case inventory");
  const events = rows.find((r) => r.case === "original-json-writer-and-guest-file").trace.traceEvents;
  check(events.length === 20, "lost or duplicated serialized events");
  const named = (name: string) => events.filter((r: any) => r.name === name);
  const copied = named("copied-name");
  check(copied.length === 1 && copied[0].args.value === -7 && copied[0].ph === "B" && copied[0].id === "0x11", "copied event fields or signed data");
  const json = named("json-data");
  check(json.length === 1 && json[0].args.data.nested === "中" && json[0].args.data.number === 42, "native convertable JSON serialization");
  const duration = named("duration");
  check(duration.length === 1 && duration[0].dur > 0 && duration[0].ts > 0 && duration[0].tts >= 0, "actual duration fields");
  const workers = named("worker");
  check(workers.length === 16, "concurrent event count");
  const tids = new Set(workers.map((r: any) => r.tid));
  check(tids.size === 2 && !tids.has(copied[0].tid), "guest thread identities");
  check([...tids].every((id) => workers.filter((r: any) => r.tid === id).length === 8), "worker event attribution");
  check(events.every((r: any) => r.pid === copied[0].pid && r.pid > 0 && r.tid > 0 && r.cat === "node.kandelo,other"), "native process/category identities");
  check(named("restart").length === 1 && named("disabled").length === 0 && named("Xopied-name").length === 0, "restart/stop/copy effects");
  const ring = rows.find((r) => r.case === "ring-buffer-handle-retirement").trace.traceEvents;
  check(ring.length === 1 && ring[0].name === "wrap" && ring[0].cat === "ring", "ring overwrite and original writer effects");
  return { cases: 9, serializedEvents: events.length, workerThreads: tids.size, ringEvents: ring.length };
}
