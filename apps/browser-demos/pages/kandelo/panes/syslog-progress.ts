import type { DmesgLine } from "../../../../../web-libs/kandelo-session/src/kernel-host";

export function syslogRows(lines: readonly DmesgLine[], raw: boolean): DmesgLine[] {
  if (raw) return [...lines];
  const rows: DmesgLine[] = [];
  const operations = new Map<string, number>();
  for (const line of lines) {
    if (line.progress?.status === "error") {
      const previous = operations.get(line.progress.id);
      if (previous !== undefined) { rows[previous] = line; operations.delete(line.progress.id); }
      else rows.push(line);
      continue;
    }
    if (!line.progress || line.level !== "info") { rows.push(line); continue; }
    const previous = operations.get(line.progress.id);
    if (previous !== undefined) rows[previous] = line;
    else { operations.set(line.progress.id, rows.length); rows.push(line); }
  }
  return rows;
}
