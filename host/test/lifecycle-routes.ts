import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const lifecycleSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../src/process-lifecycle.ts"),
  "utf8",
);

/** The body of each function declared inside `createProcessLifecycle`. */
function lifecycleFunctions(): Map<string, string> {
  const pattern = /\n  (?:async )?function (\w+)\(/g;
  const starts = [...lifecycleSource.matchAll(pattern)].map((m) => ({
    name: m[1]!,
    at: m.index!,
  }));
  const bodies = new Map<string, string>();
  starts.forEach((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1]!.at : lifecycleSource.length;
    bodies.set(start.name, lifecycleSource.slice(start.at, end));
  });
  return bodies;
}

const BODIES = lifecycleFunctions();

/**
 * Every lifecycle function reachable from `roots` through their references --
 * a call, or a handler passed as a value (`onResolveSpawn: handlePosixSpawnResolve`).
 */
function reachableFrom(roots: Iterable<string>): Set<string> {
  const seen = new Set<string>(roots);
  const queue = [...seen];
  while (queue.length > 0) {
    const body = BODIES.get(queue.pop()!) ?? "";
    for (const name of BODIES.keys()) {
      if (!seen.has(name) && new RegExp(String.raw`\b${name}\b`).test(body)) {
        seen.add(name);
        queue.push(name);
      }
    }
  }
  return seen;
}

/**
 * Whether an entry routes through the shared lifecycle's `name`.
 *
 * An entry reaches a lifecycle function by binding it from `} = lifecycle;` or
 * by installing the shared kernel callbacks (`...processLifecycleKernelCallbacks()`,
 * how both entries hand the kernel its fork, exec and spawn handlers since
 * they stopped binding them one by one), and from there through the calls
 * those functions make. "Routes through X" means X is in that set.
 */
export function entryRoutesThrough(entrySource: string, name: string): boolean {
  if (!entrySource.includes("} = lifecycle;")) return false;
  const roots = [...BODIES.keys()].filter((fn) =>
    new RegExp(String.raw`^\s*` + fn + String.raw`,\s*$`, "m").test(entrySource),
  );
  if (entrySource.includes("...processLifecycleKernelCallbacks()")) {
    roots.push("processLifecycleKernelCallbacks");
  }
  return reachableFrom(roots).has(name);
}
