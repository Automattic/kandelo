import type { FilesystemConfiguration } from "../../../../../web-libs/kandelo-session/src/kernel-host";
import type { ComputerLibrarySnapshot } from "../../../../../web-libs/kandelo-session/src/computer-library";

export function filesystemConfigRows(
  configuration: FilesystemConfiguration,
  library: ComputerLibrarySnapshot | null,
): Array<{ label: string; value: string }> {
  const rows = [{ label: "Storage", value: configuration.storage === "opfs" ? "OPFS-backed journaled image" : "Runtime memory" }];
  const computer = library?.current;
  if (computer && computer.id === configuration.computerId) {
    rows.push({ label: "Retention", value: computer.retention === "saved" ? "Saved computer" : "Temporary — eligible for cleanup after 24 hours idle" });
    rows.push({ label: "Browser eviction protection", value: library!.storageProtected ? "Granted" : "Not granted" });
  }
  if (configuration.format) rows.push({ label: "Storage format", value: configuration.format });
  if (configuration.directory) rows.push({ label: "OPFS directory", value: configuration.directory });
  if (configuration.baseFile) rows.push({ label: "Mounted base file", value: configuration.baseFile });
  if (configuration.baseGeneration !== undefined) rows.push({ label: "Base generation", value: String(configuration.baseGeneration) });
  if (configuration.baseBytes !== undefined) rows.push({ label: "Base file size", value: `${configuration.baseBytes.toLocaleString()} bytes` });
  if (configuration.verification) rows.push({ label: "Base checking", value: configuration.verification === "sha256" ? "SHA-256 content binding, on demand" : "CRC32C accidental-corruption checks, on demand" });
  if (configuration.mode) rows.push({ label: "Journal mode", value: configuration.mode === "resizable" ? "Resizable filesystem" : "Fixed overwrite" });
  if (configuration.journalNamespace) rows.push({ label: "Journal namespace", value: configuration.journalNamespace });
  if (configuration.storage === "opfs") {
    rows.push({ label: "Data access", value: "On-demand blocks with bounded Rust read/writeback caches" });
    rows.push({ label: "Write durability", value: "Journaled writeback; fsync/sync commits pending writes" });
  }
  return rows;
}

export interface FilesystemMemoryReport {
  current: number;
  peak: number;
  owners: Array<{ owner: string; live: number; temporary: number; limit: number; peak: number }>;
}

export function parseFilesystemMemoryReport(text: string): FilesystemMemoryReport {
  if (text.length > 16 * 1024) throw new Error("Filesystem memory report exceeds its display limit");
  const lines = text.trim().split("\n");
  if (lines[0] !== "version 1" || lines[1] !== "units admission_credits" || lines[2] !== "lifetime kernel") {
    throw new Error("Unsupported filesystem memory report format");
  }
  const counters = (line: string | undefined, expected: string) => {
    const [name, ...fields] = (line ?? "").split(" ");
    if (name !== expected) throw new Error("Invalid filesystem memory report");
    const values = new Map<string, number>();
    for (const field of fields) {
      const match = /^([a-z_]+)=([0-9]+)$/.exec(field);
      if (!match || values.has(match[1]!)) throw new Error("Invalid filesystem memory counter");
      const value = Number(match[2]);
      if (!Number.isSafeInteger(value)) throw new Error("Invalid filesystem memory counter");
      values.set(match[1]!, value);
    }
    return (key: string) => {
      const value = values.get(key);
      if (value === undefined) throw new Error(`Missing filesystem memory counter: ${key}`);
      return value;
    };
  };
  const aggregate = counters(lines[3], "aggregate");
  const seen = new Set<string>();
  const owners = lines.slice(4).map(line => {
    const owner = line.split(" ", 1)[0]!;
    if (!/^[a-z_]+$/.test(owner) || seen.has(owner)) throw new Error("Invalid filesystem memory owner");
    seen.add(owner);
    const values = counters(line, owner);
    return { owner, live: values("live"), temporary: values("temporary"), limit: values("limit"), peak: values("peak_total") };
  });
  if (owners.length === 0) throw new Error("Filesystem memory owners are missing");
  return { current: aggregate("current"), peak: aggregate("peak"), owners };
}
