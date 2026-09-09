import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const PACKAGE_DIR = path.resolve(__dirname, "..");
const DIST = path.join(PACKAGE_DIR, "dist");

const WORKER_FILES = [
  "worker-entry-browser.js",
  "browser-kernel-worker-entry.js",
];

function distFile(name: string): string {
  return readFileSync(path.join(DIST, name), "utf8");
}

function staticImportSpecifiers(code: string): string[] {
  return [...code.matchAll(/^import\b[^;]*?from\s*"([^"]+)"/gm)].map(
    (m) => m[1],
  );
}

function dynamicImportSpecifiers(code: string): string[] {
  return [...code.matchAll(/\bimport\("([^"]+)"\)/g)].map((m) => m[1]);
}

describe("dist contract", () => {
  beforeAll(() => {
    execFileSync(path.join(PACKAGE_DIR, "node_modules", ".bin", "tsdown"), [], {
      cwd: PACKAGE_DIR,
      stdio: "pipe",
    });
  }, 120_000);

  it("emits the three entries and the declaration", () => {
    for (const name of ["index.js", "index.d.ts", ...WORKER_FILES]) {
      expect(distFile(name).length).toBeGreaterThan(0);
    }
  });

  it("index.js resolves both worker entries against dist via new URL", () => {
    const index = distFile("index.js");
    for (const worker of WORKER_FILES) {
      expect(index).toContain(`new URL("./${worker}", import.meta.url)`);
    }
  });

  it("index.js imports only the declared runtime dependencies", () => {
    expect(staticImportSpecifiers(distFile("index.js")).sort()).toEqual([
      "fflate",
      "fzstd",
    ]);
  });

  it("worker entries are self-contained module-worker assets", () => {
    for (const worker of WORKER_FILES) {
      const code = distFile(worker);
      expect(staticImportSpecifiers(code)).toEqual([]);
      const dynamic = dynamicImportSpecifiers(code).filter(
        (specifier) => specifier !== "net",
      );
      expect(dynamic).toEqual([]);
    }
  });

  it("ships the PCM worklet at the bundle's default URL", () => {
    const worklet = distFile("audio/pcm-audio-worklet.js");
    expect(worklet.length).toBeGreaterThan(0);
    expect(staticImportSpecifiers(worklet)).toEqual([]);
    expect(distFile("index.js")).toContain(
      'new URL("./audio/pcm-audio-worklet.js", import.meta.url)',
    );
  });

  it("no Vite-only specifier survives as an import", () => {
    for (const name of ["index.js", ...WORKER_FILES]) {
      const code = distFile(name);
      const specifiers = [
        ...staticImportSpecifiers(code),
        ...dynamicImportSpecifiers(code),
      ];
      for (const specifier of specifiers) {
        expect(specifier).not.toMatch(/\?worker&url|@kernel-wasm|@rootfs-vfs/);
      }
    }
  });

  it("index.d.ts declares the public API", () => {
    const dts = distFile("index.d.ts");
    for (const name of [
      "declare class BrowserKernel",
      "interface BrowserKernelAssets",
      "declare function fetchKandeloBinaries",
      "ABI_VERSION",
    ]) {
      expect(dts).toContain(name);
    }
  });
});
