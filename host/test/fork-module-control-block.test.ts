import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The dlopen control-block offsets exist in two places on purpose, and this is
 * what makes that acceptable.
 *
 * `host/src/worker-main.ts` is the source of truth: it lays the block out and
 * calls it "host-private control slots". `crates/fork-module` needs the same
 * numbers, because it reads the published archive head out of that block rather
 * than being told the head by a host call.
 *
 * The obvious alternative -- publishing them as generated ABI constants -- is
 * worse: it would make a host-private layout part of the versioned ABI contract,
 * and every change to it would then need an ABI bump. So the numbers are
 * duplicated and pinned here instead. If they ever disagree, the fork module
 * reads a head from the wrong address and reconciles against garbage, which is
 * the kind of failure that surfaces far from its cause.
 */
const repoRoot = join(import.meta.dirname, "..", "..");

function constantsFrom(
  file: string,
  names: readonly string[],
): Record<string, number> {
  const source = readFileSync(join(repoRoot, file), "utf8");
  const found: Record<string, number> = {};
  for (const name of names) {
    const match = source.match(
      new RegExp(`\\b${name}\\b\\s*(?::\\s*usize)?\\s*=\\s*(\\d+)`),
    );
    if (!match) {
      throw new Error(`${file} no longer defines ${name}`);
    }
    found[name] = Number(match[1]);
  }
  return found;
}

describe("dlopen control-block offsets", () => {
  // The module reads the head and takes the lock, and a table-mutation commit
  // publishes the generation fence; each word it touches is pinned here.
  const names = [
    "DLOPEN_HEAD_OFFSET_WASM32",
    "DLOPEN_HEAD_OFFSET_WASM64",
    "DLOPEN_LOCK_OFFSET_WASM32",
    "DLOPEN_LOCK_OFFSET_WASM64",
    "DLOPEN_GENERATION_OFFSET_WASM32",
    "DLOPEN_GENERATION_OFFSET_WASM64",
  ] as const;

  it("agree between the host layout and the fork module that reads it", () => {
    const host = constantsFrom("host/src/worker-main.ts", names);
    const module = constantsFrom("crates/fork-module/src/lib.rs", names);
    expect(module).toEqual(host);
  });

  it("are distinct per pointer width, so neither copy can be a stale paste", () => {
    // Without this, two copies that BOTH said 12 would agree and both be wrong
    // for a wasm64 guest.
    const host = constantsFrom("host/src/worker-main.ts", names);
    expect(host.DLOPEN_HEAD_OFFSET_WASM64).not.toEqual(
      host.DLOPEN_HEAD_OFFSET_WASM32,
    );
  });
});
