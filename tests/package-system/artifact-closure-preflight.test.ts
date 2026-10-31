import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const roots: string[] = [];

afterEach(() => {
  vi.doUnmock("../../host/src/binary-resolver");
  vi.restoreAllMocks();
  vi.resetModules();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(hasOriginal = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kandelo-closure-preflight-")));
  roots.push(root);
  const registry = join(root, "packages", "registry");
  const outputRoot = join(root, "local-binaries");
  mkdirSync(registry, { recursive: true });
  mkdirSync(outputRoot);
  const executable = join(outputRoot, "program.wasm");
  const original = join(outputRoot, "original:input.wasm");
  const originalBytes = Buffer.from("retained original");
  writeFileSync(executable, "prepared program");
  writeFileSync(original, originalBytes, { mode: 0o444 });
  const timestamp = new Date("2026-01-01T00:00:00Z");
  utimesSync(original, timestamp, timestamp);
  const expected = createHash("sha256").update(originalBytes).digest("hex");
  const executableRequest = "programs/wasm32/program.wasm";
  const originalRequest = "programs/wasm32/.originals/program/cache/original.wasm";
  const closure = hasOriginal ? [executableRequest, originalRequest] : [executableRequest];
  const files = new Map([[executableRequest, executable], [originalRequest, original]]);
  const resolve = vi.fn((paths: string[]) => {
    if (hasOriginal) {
      const stat = lstatSync(original);
      if (!stat.isFile() || (stat.mode & 0o222) !== 0) throw new Error("original mode or type refused");
      if (createHash("sha256").update(readFileSync(original)).digest("hex") !== expected) {
        throw new Error("original digest refused");
      }
    }
    return paths.map((path) => {
      const selected = files.get(path);
      if (!selected) throw new Error(`unexpected resolver request: ${path}`);
      return selected;
    });
  });
  vi.doMock("../../host/src/binary-resolver", () => ({
    BinaryNotFoundError: class BinaryNotFoundError extends Error {},
    findRepoRoot: () => root,
    programOutputClosureRelPaths: () => closure,
    tryResolveBinaries: resolve,
    withProgramIndexFreshness: (callback: () => unknown) => callback(),
  }));
  writeFileSync(join(registry, "program-packages.json"), JSON.stringify({
    packages: {
      program: {
        arches: ["wasm32"],
        members: [{ kind: "output", mirrorPath: "program.wasm" }],
        cacheKeys: { wasm32: "cache" },
        manifestSha256: "manifest",
      },
    },
  }));
  const memoPath = join(outputRoot, ".kandelo-closure-check.json");
  return { root, executable, original, originalBytes, closure, resolve, memoPath };
}

async function runPreflight() {
  vi.resetModules();
  const stop = new Error("preflight completed");
  let status: string | number | null | undefined;
  let output = "";
  const previousArgv = process.argv;
  process.argv = ["node", "check-artifact-closures.ts", "--json"];
  const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
    status = code;
    throw stop;
  });
  try {
    await import("../../scripts/check-artifact-closures");
  } catch (error) {
    if (error !== stop) throw error;
  } finally {
    process.argv = previousArgv;
    write.mockRestore();
    exit.mockRestore();
  }
  return { status, report: JSON.parse(output) };
}

describe("artifact closure preflight memo", () => {
  it("remembers every retained original and safely handles colons in paths", async () => {
    const value = fixture();
    expect((await runPreflight()).status).toBe(0);
    expect(value.resolve).toHaveBeenCalledWith(value.closure);
    const memo = JSON.parse(readFileSync(value.memoPath, "utf8"));
    expect(memo.version).toBe(2);
    expect(memo.entries["program/wasm32"].files.map((file: { path: string }) => file.path))
      .toEqual([value.executable, value.original]);
    expect((await runPreflight()).report.reused).toBe(1);
    expect(value.resolve).toHaveBeenCalledTimes(1);
  });

  it.each(["content", "permissions", "missing", "symlink"])("rechecks an original after %s changes", async (mutation) => {
    const value = fixture();
    expect((await runPreflight()).status).toBe(0);
    if (mutation === "content") {
      const before = lstatSync(value.original);
      const previousMtime = lstatSync(value.original, { bigint: true }).mtimeNs;
      chmodSync(value.original, 0o644);
      writeFileSync(value.original, Buffer.alloc(value.originalBytes.length));
      chmodSync(value.original, 0o444);
      utimesSync(value.original, before.atime, before.mtime);
      expect(lstatSync(value.original, { bigint: true }).mtimeNs).toBe(previousMtime);
    } else if (mutation === "permissions") {
      chmodSync(value.original, 0o644);
    } else if (mutation === "missing") {
      unlinkSync(value.original);
    } else {
      const target = join(value.root, "original-copy.wasm");
      copyFileSync(value.original, target);
      chmodSync(target, 0o444);
      unlinkSync(value.original);
      symlinkSync(target, value.original);
    }
    const result = await runPreflight();
    expect(result.status).toBe(1);
    expect(result.report.reused).toBe(0);
    expect(result.report.failed).toHaveLength(1);
    expect(value.resolve).toHaveBeenCalledTimes(2);
    expect(JSON.parse(readFileSync(value.memoPath, "utf8")).entries).toEqual({});
  });

  it.each(["version", "subset"])("does not reuse an incomplete %s memo", async (mutation) => {
    const value = fixture();
    expect((await runPreflight()).status).toBe(0);
    const memo = JSON.parse(readFileSync(value.memoPath, "utf8"));
    if (mutation === "version") memo.version = 1;
    else memo.entries["program/wasm32"].files.pop();
    writeFileSync(value.memoPath, JSON.stringify(memo));
    unlinkSync(value.original);
    expect((await runPreflight()).status).toBe(1);
    expect(value.resolve).toHaveBeenCalledTimes(2);
  });

  it("preserves memo reuse for a package without retained originals", async () => {
    const value = fixture(false);
    expect((await runPreflight()).status).toBe(0);
    expect((await runPreflight()).report.reused).toBe(1);
    expect(value.resolve).toHaveBeenCalledTimes(1);
  });
});
