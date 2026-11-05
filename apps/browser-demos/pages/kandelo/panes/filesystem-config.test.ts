import assert from "node:assert/strict";
import test from "node:test";
import { filesystemConfigRows, parseFilesystemMemoryReport } from "./filesystem-config";

const report = "version 1\nunits admission_credits\nlifetime kernel\naggregate current=12 peak=20\nnamespace live=8 temporary=4 limit=16 peak_live=10 peak_temporary=6 peak_total=14\n";

test("filesystem memory preserves actual counters and admission-credit units", () => {
  assert.deepEqual(parseFilesystemMemoryReport(report), {
    current: 12, peak: 20,
    owners: [{ owner: "namespace", live: 8, temporary: 4, limit: 16, peak: 14 }],
  });
});

for (const malformed of [
  report.replace("version 1", "version 2"),
  report.replace("admission_credits", "bytes"),
  report.replace("current=12", "current=-12"),
  report.replace("limit=16", "limit=9007199254740992"),
  report.replace("limit=16 ", ""),
  report.replace("limit=16", "limit=16 limit=20"),
  report + report.split("\n")[4] + "\n",
  report.split("namespace")[0]!,
  "x".repeat(16 * 1024 + 1),
]) test("filesystem memory refuses malformed or unsupported counters", () => {
  assert.throws(() => parseFilesystemMemoryReport(malformed));
});

test("memory-only boots do not claim an OPFS journal, checking policy or cache", () => {
  assert.deepEqual(filesystemConfigRows({ storage: "memory" }, null), [{ label: "Storage", value: "Runtime memory" }]);
});

test("unknown mounted properties stay absent instead of becoming defaults", () => {
  const labels = filesystemConfigRows({ storage: "opfs" }, null).map(row => row.label);
  for (const label of ["Base generation", "Base file size", "Base checking", "Retention", "OPFS directory"]) assert(!labels.includes(label));
});

test("mounted base details reflect supplied generation, size, checking policy and directory", () => {
  const rows = new Map(filesystemConfigRows({ storage: "opfs", baseGeneration: 7, baseBytes: 8192,
    baseFile: "new-base", directory: "actual-directory", verification: "sha256", mode: "fixed" }, null)
    .map(row => [row.label, row.value]));
  assert.equal(rows.get("Base generation"), "7");
  assert.equal(rows.get("Base file size"), "8,192 bytes");
  assert.equal(rows.get("Mounted base file"), "new-base");
  assert.equal(rows.get("OPFS directory"), "actual-directory");
  assert.match(rows.get("Base checking")!, /SHA-256/);
  assert.equal(rows.get("Journal mode"), "Fixed overwrite");
});
