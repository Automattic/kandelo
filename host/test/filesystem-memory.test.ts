import { expect, it } from "vitest";
import { parseFilesystemMemory, validateFilesystemMemoryBounds } from "./fixtures/filesystem-memory";

function report(): string {
  const owner = "live=2 temporary=0 limit=10 peak_live=3 peak_temporary=0 peak_total=3";
  return `FS_MEMORY_BEGIN\nversion 1\nunits admission_credits\nlifetime kernel\naggregate current=10 peak=13\n${[
    "namespace", "journal", "journal_writeback", "io", "io_writeback",
  ].map(name => `${name} ${owner}\n`).join("")}FS_MEMORY_END\n`;
}

it("reads simultaneous admission high water without summing unrelated component peaks", () => {
  const usage = parseFilesystemMemory(report());
  expect(usage.current).toBe(10);
  expect(usage.peak).toBe(13);
  expect(Object.values(usage.owners).reduce((sum, owner) => sum + owner.peak_total, 0)).toBe(15);
  expect(() => validateFilesystemMemoryBounds(usage)).not.toThrow();
});

it("refuses missing, duplicated, truncated, overflowing and inconsistent admission reports", () => {
  for (const input of ["", report() + report(), report().replace("FS_MEMORY_END", ""),
    report().replace("current=10", "current=11"), report().replace("peak=13", "peak=16"),
    report().replace("limit=10", "limit=1"), report().replace("current=10", "current=999999999999999999999")]) {
    expect(() => parseFilesystemMemory(input)).toThrow();
  }
});

it("distinguishes lifetime history from a phase's configured allowance", () => {
  const usage = parseFilesystemMemory(report());
  usage.owners.namespace.limit = 2;
  expect(() => validateFilesystemMemoryBounds(usage)).toThrow("configured phase allowance");
});
