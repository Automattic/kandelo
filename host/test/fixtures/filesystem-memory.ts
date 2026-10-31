export interface FilesystemOwnerMemory {
  live: number;
  temporary: number;
  limit: number;
  peak_live: number;
  peak_temporary: number;
  peak_total: number;
}

export interface FilesystemAdmissionMemory {
  current: number;
  peak: number;
  owners: Record<string, FilesystemOwnerMemory>;
}

const ownerNames = ["namespace", "journal", "journal_writeback", "io", "io_writeback"];

export function parseFilesystemMemory(output: string): FilesystemAdmissionMemory {
  const reports = [...output.replaceAll("\r\n", "\n").matchAll(/FS_MEMORY_BEGIN\n([\s\S]*?)FS_MEMORY_END/g)];
  if (reports.length !== 1) throw new Error("Expected one filesystem memory report");
  const lines = reports[0][1].trimEnd().split("\n");
  if (lines.length !== 9 || lines[0] !== "version 1" || lines[1] !== "units admission_credits" || lines[2] !== "lifetime kernel") {
    throw new Error("Invalid filesystem memory report header");
  }
  const aggregate = /^aggregate current=(\d+) peak=(\d+)$/.exec(lines[3]);
  if (aggregate === null) throw new Error("Invalid aggregate admission report");
  const current = Number(aggregate[1]);
  const peak = Number(aggregate[2]);
  const owners: Record<string, FilesystemOwnerMemory> = {};
  for (const [index, name] of ownerNames.entries()) {
    const match = /^(\w+) live=(\d+) temporary=(\d+) limit=(\d+) peak_live=(\d+) peak_temporary=(\d+) peak_total=(\d+)$/.exec(lines[index + 4]);
    if (match === null || match[1] !== name) throw new Error("Invalid filesystem owner report");
    const [live, temporary, limit, peak_live, peak_temporary, peak_total] = match.slice(2).map(Number);
    const owner = { live, temporary, limit, peak_live, peak_temporary, peak_total };
    if (!Object.values(owner).every(Number.isSafeInteger) || live > limit || temporary > 2 * limit ||
      peak_live < live || peak_temporary < temporary || peak_total < live + temporary ||
      peak_total < Math.max(peak_live, peak_temporary) ||
      peak_total > peak_live + peak_temporary) throw new Error("Inconsistent filesystem admission accounting");
    owners[name] = owner;
  }
  if (!Number.isSafeInteger(current) || !Number.isSafeInteger(peak) || peak < current ||
    current !== Object.values(owners).reduce((total, owner) => total + owner.live + owner.temporary, 0) ||
    Object.values(owners).some(owner => owner.peak_total > peak) ||
    peak > Object.values(owners).reduce((total, owner) => total + owner.peak_total, 0)) {
    throw new Error("Inconsistent aggregate admission accounting");
  }
  return { current, peak, owners };
}

export function validateFilesystemMemoryBounds(report: FilesystemAdmissionMemory): void {
  let allowance = 0;
  for (const [name, owner] of Object.entries(report.owners)) {
    if (owner.peak_live > owner.limit || owner.peak_temporary > 2 * owner.limit) {
      throw new Error("Filesystem admission peak exceeds the configured phase allowance");
    }
    if (name !== "namespace" && owner.peak_temporary !== 0) {
      throw new Error("Unexpected temporary ownership outside namespace admission");
    }
    allowance += owner.limit * (name === "namespace" ? 3 : 1);
  }
  if (report.peak > allowance) throw new Error("Aggregate filesystem admission exceeds its combined allowances");
}
