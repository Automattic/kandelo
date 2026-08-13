import { describe, expect, it, vi } from "vitest";
import {
  prefetchHomebrewPackageClosures,
} from "../src/homebrew-package-prefetch";
import { MemoryFileSystem } from "../src/vfs/memory-fs";

const O_WRONLY = 0x0001;
const O_CREAT = 0x0040;
const O_TRUNC = 0x0200;
const COMPOSITION_PATH = "/etc/kandelo/homebrew-vfs.json";

const packages = [
  {
    full_name: "kandelo-dev/tap-core/libcxx",
    keg: "/opt/kandelo/homebrew/Cellar/libcxx/21.1.7_1",
    dependencies: [],
  },
  {
    full_name: "kandelo-dev/tap-core/clang",
    keg: "/opt/kandelo/homebrew/Cellar/clang/21.1.7",
    dependencies: ["kandelo-dev/tap-core/libcxx"],
  },
  {
    full_name: "kandelo-dev/tap-core/kandelo-sdk",
    keg: "/opt/kandelo/homebrew/Cellar/kandelo-sdk/0.1.0",
    dependencies: [
      "kandelo-dev/tap-core/clang",
      "kandelo-dev/tap-core/libcxx",
    ],
  },
] as const;

function fixture() {
  const fs = MemoryFileSystem.create(new SharedArrayBuffer(4 * 1024 * 1024));
  fs.mkdir("/etc", 0o755);
  fs.mkdir("/etc/kandelo", 0o755);
  writeFile(fs, COMPOSITION_PATH, JSON.stringify({
    schema: 1,
    created_by: "homebrew-package-prefetch.test.ts",
    packages,
  }));
  const prepared: string[] = [];
  vi.spyOn(fs, "preparePath").mockImplementation(async (path) => {
    prepared.push(path);
    return true;
  });
  return { fs, prepared };
}

describe("Homebrew package prefetch", () => {
  it("prefetches a sealed dependency closure in dependency order", async () => {
    const { fs, prepared } = fixture();
    const result = await prefetchHomebrewPackageClosures(
      fs,
      ["kandelo-dev/tap-core/kandelo-sdk"],
    );

    expect(result).toEqual({
      roots: ["kandelo-dev/tap-core/kandelo-sdk"],
      packages: [
        "kandelo-dev/tap-core/libcxx",
        "kandelo-dev/tap-core/clang",
        "kandelo-dev/tap-core/kandelo-sdk",
      ],
      materializedPackages: [
        "kandelo-dev/tap-core/libcxx",
        "kandelo-dev/tap-core/clang",
        "kandelo-dev/tap-core/kandelo-sdk",
      ],
      alreadyMaterializedPackages: [],
    });
    expect(prepared).toEqual(packages.map((pkg) => pkg.keg));
  });

  it("rejects a package absent from the sealed composition", async () => {
    const { fs } = fixture();
    await expect(prefetchHomebrewPackageClosures(
      fs,
      ["kandelo-dev/tap-core/not-selected"],
    )).rejects.toThrow("is absent from the Homebrew composition");
  });

  it("validates the complete graph before preparing a tree", async () => {
    const { fs, prepared } = fixture();
    writeFile(fs, COMPOSITION_PATH, JSON.stringify({
      schema: 1,
      created_by: "homebrew-package-prefetch.test.ts",
      packages: packages.map((pkg) => pkg.full_name === "kandelo-dev/tap-core/clang"
        ? { ...pkg, dependencies: ["kandelo-dev/tap-core/missing"] }
        : pkg),
    }));

    await expect(prefetchHomebrewPackageClosures(
      fs,
      ["kandelo-dev/tap-core/kandelo-sdk"],
    )).rejects.toThrow("missing dependency");
    expect(prepared).toEqual([]);
  });

  it("retries after a tree preparation fails", async () => {
    const { fs } = fixture();
    const prepared: string[] = [];
    let failed = false;
    vi.mocked(fs.preparePath).mockImplementation(async (path) => {
      prepared.push(path);
      if (!failed && path.includes("/clang/")) {
        failed = true;
        throw new Error("clang download failed");
      }
      return failed ? !prepared.slice(0, -1).includes(path) : true;
    });

    await expect(prefetchHomebrewPackageClosures(
      fs,
      ["kandelo-dev/tap-core/kandelo-sdk"],
    )).rejects.toThrow("clang download failed");
    await expect(prefetchHomebrewPackageClosures(
      fs,
      ["kandelo-dev/tap-core/kandelo-sdk"],
    )).resolves.toMatchObject({
      packages: [
        "kandelo-dev/tap-core/libcxx",
        "kandelo-dev/tap-core/clang",
        "kandelo-dev/tap-core/kandelo-sdk",
      ],
    });
  });
});

function writeFile(fs: MemoryFileSystem, path: string, text: string): void {
  const bytes = new TextEncoder().encode(text);
  const fd = fs.open(path, O_WRONLY | O_CREAT | O_TRUNC, 0o644);
  fs.write(fd, bytes, null, bytes.byteLength);
  fs.close(fd);
}
