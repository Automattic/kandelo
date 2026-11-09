/**
 * The kernel and the host each publish a file's MAP_SHARED mappings before a
 * syscall touches the file's content: the kernel for files it owns
 * (`descriptor_fence_for` in crates/runtime-core/src/memory.rs), the host for
 * files on a host-mounted directory (`flushSharedMappingsBeforeFileSyscall`
 * in host/src/kernel-worker.ts). A syscall on one list and not the other
 * would leave one kind of file reading stale bytes, so the lists are checked
 * against each other here.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const repo = new URL("../../", import.meta.url);

function body(source: string, start: string): string {
  const begin = source.indexOf(start);
  expect(begin, `missing ${start}`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = source.indexOf("{", begin); i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(begin, i + 1);
  }
  throw new Error(`unterminated ${start}`);
}

function names(text: string): Set<string> {
  return new Set(text.match(/\bSYS_[A-Z0-9_]+\b/g) ?? []);
}

describe("descriptor fence syscall lists", () => {
  it("fence every syscall the host fences, plus only the path-named ones", () => {
    const host = readFileSync(new URL("host/src/kernel-worker.ts", repo), "utf8");
    const kernel = readFileSync(
      new URL("crates/runtime-core/src/memory.rs", repo),
      "utf8",
    );
    const hostNames = names(
      body(host, "private syscallTouchesFdStorageBeforeKernel("),
    );
    for (const name of ["SYS_SENDFILE", "SYS_COPY_FILE_RANGE", "SYS_SPLICE"]) {
      expect(
        body(host, "private flushSharedMappingsBeforeFileSyscall(").includes(name),
        `host fences ${name}`,
      ).toBe(true);
      hostNames.add(name);
    }
    const kernelNames = names(
      body(kernel, "pub fn descriptor_fence_for("),
    );
    expect([...hostNames].filter((name) => !kernelNames.has(name))).toEqual([]);
    // The host resolves these by path (`flushSharedBackingForPath`); the
    // kernel fences every mapped file for them instead.
    expect([...kernelNames].filter((name) => !hostNames.has(name)).sort())
      .toEqual(["SYS_OPEN", "SYS_OPENAT", "SYS_TRUNCATE"]);
  });
});
