import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";
import { ensureDirRecursive, writeVfsBinary } from "../../host/src/vfs/image-helpers";
import type { ZipEntry } from "../../host/src/vfs/zip";
import {
  IMAGE_EAGER_BUDGET_KIND,
  measureEagerContent,
  parseImageEagerBudget,
  readImageEagerBudget,
  requireCompressedImageWithinBudget,
  requireEagerContentWithinBudget,
  type EagerContent,
} from "../../images/vfs/scripts/image-eager-budget";

const repoRoot = resolve(import.meta.dirname, "..", "..");
const canonicalShellBudget = join(repoRoot, "packages/registry/shell/eager-budget.json");

function budgetDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: IMAGE_EAGER_BUDGET_KIND,
    version: 1,
    image: "fixture",
    why: "fixture reason",
    measurement: "fixture method",
    raising: "fixture procedure",
    maxEagerBytes: 1_000,
    maxEagerFiles: 10,
    maxCompressedBytes: 500,
    measured: { eagerBytes: 980, eagerFiles: 8, compressedBytes: 490 },
    ...overrides,
  };
}

function parse(document: Record<string, unknown>) {
  return parseImageEagerBudget(JSON.stringify(document), "fixture-budget.json");
}

function bytes(length: number, fill = 0x61): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

describe("image eager-content budget", () => {
  it("counts only regular files whose bytes are stored in the image", () => {
    const fs = KandeloImageFs.create();
    ensureDirRecursive(fs, "/usr/bin");
    ensureDirRecursive(fs, "/usr/share/data");
    writeVfsBinary(fs, "/usr/bin/eager", bytes(300), 0o755);
    writeVfsBinary(fs, "/usr/share/data/a", bytes(40), 0o644);
    writeVfsBinary(fs, "/usr/share/data/b", bytes(60), 0o644);
    writeVfsBinary(fs, "/usr/share/data/empty", bytes(0), 0o644);
    fs.symlink("/usr/bin/eager", "/usr/bin/alias");
    // A standalone lazy file and a lazy-archive member both report a real
    // size through stat but carry no bytes in the image.
    fs.registerLazyFile("/usr/bin/lazy", "https://example.invalid/lazy.wasm", 50_000, 0o755);
    const member: ZipEntry = {
      fileName: "usr/share/archive/member.txt",
      fileNameBytes: new TextEncoder().encode("usr/share/archive/member.txt"),
      compressedSize: 100,
      uncompressedSize: 70_000,
      compressionMethod: 8,
      localHeaderOffset: 0,
      mode: 0o644,
      isDirectory: false,
      isSymlink: false,
      externalAttrs: 0,
      creatorOS: 3,
    };
    fs.registerLazyArchive({
      url: "https://example.invalid/archive.zip",
      entries: [member],
      mountPrefix: "/",
      integrity: { sha256: "e".repeat(64), bytes: 4_096 },
    });
    expect(fs.isPathDeferred("/usr/share/archive/member.txt")).toBe(true);

    const content = measureEagerContent(fs);

    expect(content.eagerBytes).toBe(400);
    expect(content.eagerFiles).toBe(4);
    expect(content.files).toEqual([
      { path: "/usr/bin/eager", bytes: 300 },
      { path: "/usr/share/data/b", bytes: 60 },
      { path: "/usr/share/data/a", bytes: 40 },
      { path: "/usr/share/data/empty", bytes: 0 },
    ]);
  });

  it("accepts a budget that records its measurement within the headroom", () => {
    expect(parse(budgetDocument())).toEqual({
      image: "fixture",
      maxEagerBytes: 1_000,
      maxEagerFiles: 10,
      maxCompressedBytes: 500,
      measured: { eagerBytes: 980, eagerFiles: 8, compressedBytes: 490 },
    });
  });

  it("rejects a budget that does not explain itself or carries unknown keys", () => {
    expect(() => parse(budgetDocument({ why: " " }))).toThrow(
      "fixture-budget.json why must be a non-empty string",
    );
    const { raising: _raising, ...withoutRaising } = budgetDocument();
    expect(() => parse(withoutRaising)).toThrow("missing raising");
    expect(() => parse(budgetDocument({ maxLazyBytes: 1 }))).toThrow(
      "unexpected maxLazyBytes",
    );
    expect(() => parse(budgetDocument({ kind: "other" }))).toThrow(
      `must be ${IMAGE_EAGER_BUDGET_KIND} version 1`,
    );
    expect(() => parse(budgetDocument({ maxEagerBytes: 1.5 }))).toThrow(
      "maxEagerBytes must be a positive integer",
    );
  });

  it("rejects a budget far above the image it records, which would hide growth", () => {
    expect(() => parse(budgetDocument({ maxEagerBytes: 1_030 }))).toThrow(
      "maxEagerBytes 1030 is more than 5% above the measured 980",
    );
    expect(() => parse(budgetDocument({ maxCompressedBytes: 520 }))).toThrow(
      "maxCompressedBytes 520 is more than 5% above the measured 490",
    );
    // A small count gets a few files of slack rather than none.
    expect(parse(budgetDocument({ maxEagerFiles: 12 })).maxEagerFiles).toBe(12);
    expect(() => parse(budgetDocument({ maxEagerFiles: 13 }))).toThrow(
      "maxEagerFiles 13 is more than 5% above the measured 8",
    );
    expect(() =>
      parse(budgetDocument({ measured: { eagerBytes: 1_001, eagerFiles: 8, compressedBytes: 490 } })),
    ).toThrow("records a measurement above its own maxEagerBytes");
  });

  it("names the budget file, the totals, and the largest contributors when over budget", () => {
    const budget = parse(budgetDocument());
    const content: EagerContent = {
      files: [
        { path: "/usr/share/X11/xkb/rules/evdev.xml", bytes: 700 },
        { path: "/usr/bin/bash", bytes: 400 },
        { path: "/usr/share/X11/xkb/rules/base.xml", bytes: 300 },
      ],
      eagerBytes: 1_400,
      eagerFiles: 3,
    };
    const budgetPath = join(repoRoot, "packages/registry/shell/eager-budget.json");
    let message = "";
    try {
      requireEagerContentWithinBudget(budget, budgetPath, content);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(
      "fixture image exceeds its eager-content budget in packages/registry/shell/eager-budget.json",
    );
    expect(message).toContain(
      "eager bytes: 1,400 exceeds the budget of 1,000 (recorded 980 when the budget was set; +420 since)",
    );
    expect(message).toContain("current: 1,400 eager bytes in 3 files");
    // Grouped by directory first, so a whole new tree reads as one line.
    expect(message).toMatch(/1,000 +2 +\/usr\/share\/X11\/xkb\/rules/);
    expect(message).toMatch(/700 +\/usr\/share\/X11\/xkb\/rules\/evdev\.xml/);
    expect(message).toContain("raise the budget in packages/registry/shell/eager-budget.json");
    expect(message).not.toContain("eager files:");

    expect(() =>
      requireEagerContentWithinBudget(budget, budgetPath, { ...content, eagerBytes: 1_000 }),
    ).not.toThrow();
    expect(() =>
      requireEagerContentWithinBudget(budget, budgetPath, {
        ...content,
        eagerBytes: 100,
        eagerFiles: 11,
      }),
    ).toThrow("eager files: 11 exceeds the budget of 10");
  });

  it("checks the compressed image size against its own limit", () => {
    const budget = parse(budgetDocument());
    const content: EagerContent = { files: [], eagerBytes: 0, eagerFiles: 0 };
    expect(() =>
      requireCompressedImageWithinBudget(budget, canonicalShellBudget, 500, content),
    ).not.toThrow();
    expect(() =>
      requireCompressedImageWithinBudget(budget, canonicalShellBudget, 501, content),
    ).toThrow("compressed image bytes: 501 exceeds the budget of 500");
  });

  it("keeps the shell's checked-in budget valid", () => {
    const budget = readImageEagerBudget(canonicalShellBudget);
    expect(budget.image).toBe("shell");
    const document = JSON.parse(readFileSync(canonicalShellBudget, "utf8"));
    expect(document.raising).toContain("docs/package-management.md");
  });
});
