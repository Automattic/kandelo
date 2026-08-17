#!/usr/bin/env -S npx tsx

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

interface ProcessRow {
  pid: number;
  ppid: number;
  rssKiB: number;
  command: string;
}

export interface AppendProcessTreeRssSampleOptions {
  phase: string;
  roots: ReadonlyMap<string, number>;
  out: string;
}

export function appendProcessTreeRssSample(
  options: AppendProcessTreeRssSampleOptions,
): unknown {
  if (!/^[a-z][a-z0-9-]*$/.test(options.phase)) {
    throw new Error("RSS phase must be a lowercase stable identifier");
  }
  if (options.roots.size === 0) {
    throw new Error("RSS sampling requires at least one process root");
  }
  const rows = processRows();
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const byParent = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    const children = byParent.get(row.ppid) ?? [];
    children.push(row);
    byParent.set(row.ppid, children);
  }
  const tree = (rootPid: number): ProcessRow[] => {
    if (!byPid.has(rootPid)) {
      throw new Error(`RSS process root is not live: ${rootPid}`);
    }
    const selected: ProcessRow[] = [];
    const pending = [rootPid];
    const seen = new Set<number>();
    while (pending.length > 0) {
      const pid = pending.pop()!;
      if (seen.has(pid)) continue;
      seen.add(pid);
      const row = byPid.get(pid);
      if (row) selected.push(row);
      for (const child of byParent.get(pid) ?? []) pending.push(child.pid);
    }
    return selected.sort((left, right) => left.pid - right.pid);
  };
  const sample = {
    phase: options.phase,
    sampled_at: new Date().toISOString(),
    roots: [...options.roots].map(([label, pid]) => {
      if (!/^[a-z][a-z0-9_-]*$/.test(label) || !Number.isSafeInteger(pid)) {
        throw new Error("RSS roots require a stable label and integer PID");
      }
      const processes = tree(pid);
      return {
        label,
        pid,
        rss_kib: processes.reduce((sum, process) => sum + process.rssKiB, 0),
        processes: processes.map((process) => ({
          pid: process.pid,
          ppid: process.ppid,
          rss_kib: process.rssKiB,
          command: process.command,
        })),
      };
    }),
  };
  const out = resolve(options.out);
  if (existsSync(out) && lstatSync(out).isSymbolicLink()) {
    throw new Error("RSS report must not be a symbolic link");
  }
  const document = existsSync(out)
    ? JSON.parse(readFileSync(out, "utf8"))
    : {
        schema: 1,
        unit: "KiB",
        scope: "exact sampled process trees",
        provenance: {
          schema: 1,
          provenance_kind: "local-test",
          promotable: false,
          published: false,
        },
        samples: [],
      };
  if (
    document.schema !== 1 ||
    document.unit !== "KiB" ||
    document.scope !== "exact sampled process trees" ||
    JSON.stringify(document.provenance) !==
      JSON.stringify({
        schema: 1,
        provenance_kind: "local-test",
        promotable: false,
        published: false,
      }) ||
    !Array.isArray(document.samples)
  ) {
    throw new Error("existing RSS report has an unexpected schema");
  }
  document.samples.push(sample);
  writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`, { flag: "w" });
  return sample;
}

function processRows(): ProcessRow[] {
  const ps = process.platform === "darwin" ? "/bin/ps" : "/usr/bin/ps";
  if (!existsSync(ps)) {
    throw new Error(`required process inventory tool is unavailable: ${ps}`);
  }
  return execFileSync(ps, ["-axo", "pid=,ppid=,rss=,command="], {
    encoding: "utf8",
  })
    .split("\n")
    .flatMap((line): ProcessRow[] => {
      const match = /^\s*([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+(.*)$/.exec(line);
      return match
        ? [
            {
              pid: Number(match[1]),
              ppid: Number(match[2]),
              rssKiB: Number(match[3]),
              command: match[4]!,
            },
          ]
        : [];
    });
}

function runCli(args: readonly string[]): void {
  let phase = "";
  let out = "";
  const roots = new Map<string, number>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--phase") phase = args[++index] ?? "";
    else if (argument === "--out") out = args[++index] ?? "";
    else if (argument === "--root") {
      const value = args[++index] ?? "";
      const match = /^([a-z][a-z0-9_-]*)=([1-9][0-9]*)$/.exec(value);
      if (!match) throw new Error("--root must use label=pid");
      roots.set(match[1]!, Number(match[2]));
    } else throw new Error(`unknown argument: ${argument}`);
  }
  if (!phase || !out || roots.size === 0) {
    throw new Error(
      "usage: measure-homebrew-vfork-rss.ts --phase <name> " +
        "--root <label=pid> [--root ...] --out <json>",
    );
  }
  console.log(
    JSON.stringify(appendProcessTreeRssSample({ phase, roots, out })),
  );
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  runCli(process.argv.slice(2));
}
