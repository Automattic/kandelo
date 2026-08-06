import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  parseFlatHomebrewVfsArgs,
  publishFlatHomebrewVfsOutputs,
  readFlatHomebrewBottleCacheEntry,
} from "../../images/vfs/scripts/build-homebrew-flat-vfs-image";

describe("flat Homebrew VFS image filesystem boundary", () => {
  it("accepts exactly one value for each of the six CLI flags", () => {
    expect(parseFlatHomebrewVfsArgs(validArgs())).toEqual({
      selection: "selection.json",
      baseImage: "base.vfs.zst",
      bottleCache: "bottles",
      shellConfig: "shell.json",
      out: "kandelo-homebrew-experimental-abi42-wasm32.vfs.zst",
      report: "report.json",
    });

    for (const args of [
      [...validArgs(), "--metadata", "metadata.json"],
      [...validArgs(), "--selection", "other.json"],
      validArgs().slice(0, -1),
      validArgs().filter((value) => value !== "shell.json"),
    ]) {
      expect(() => parseFlatHomebrewVfsArgs(args)).toThrow();
    }
    expect(() => parseFlatHomebrewVfsArgs([
      ...validArgs().slice(0, -2),
      "--report",
      "kandelo-homebrew-experimental-abi42-wasm32.vfs.zst",
    ])).toThrow(/must be different/);
  });

  it("reads only the exact digest-keyed regular bottle without following symlinks", () => {
    const directory = mkdtempSync(join(tmpdir(), "flat-homebrew-cache-"));
    try {
      const bytes = new TextEncoder().encode("bottle bytes\n");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const path = join(directory, `${sha256}.tar.gz`);
      writeFileSync(path, bytes);
      writeFileSync(join(directory, "unrelated.tar.gz"), "ignored\n");

      expect(readFlatHomebrewBottleCacheEntry(directory, {
        fullName: "kandelo-dev/tap-core/example",
        sha256,
        bytes: bytes.byteLength,
      })).toEqual(bytes);

      rmSync(path);
      expect(() => readFlatHomebrewBottleCacheEntry(directory, {
        fullName: "kandelo-dev/tap-core/example",
        sha256,
        bytes: bytes.byteLength,
      })).toThrow(new RegExp(`example.*${sha256}.*${basename(path)}`, "s"));

      symlinkSync("unrelated.tar.gz", path);
      expect(() => readFlatHomebrewBottleCacheEntry(directory, {
        fullName: "kandelo-dev/tap-core/example",
        sha256,
        bytes: bytes.byteLength,
      })).toThrow(/regular non-symlink/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects wrong bottle size and digest before returning bytes", () => {
    const directory = mkdtempSync(join(tmpdir(), "flat-homebrew-cache-drift-"));
    try {
      const actual = new TextEncoder().encode("actual\n");
      const actualSha = createHash("sha256").update(actual).digest("hex");
      const expectedSha = "a".repeat(64);
      writeFileSync(join(directory, `${expectedSha}.tar.gz`), actual);

      expect(() => readFlatHomebrewBottleCacheEntry(directory, {
        fullName: "kandelo-dev/tap-core/example",
        sha256: expectedSha,
        bytes: actual.byteLength + 1,
      })).toThrow(/expected 8 bytes/);
      expect(() => readFlatHomebrewBottleCacheEntry(directory, {
        fullName: "kandelo-dev/tap-core/example",
        sha256: expectedSha,
        bytes: actual.byteLength,
      })).toThrow(new RegExp(`expected ${expectedSha}.*got ${actualSha}`, "s"));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("publishes staged image and report without replacing existing paths", () => {
    const directory = mkdtempSync(join(tmpdir(), "flat-homebrew-output-"));
    try {
      const imageStage = join(directory, ".image-stage.vfs.zst");
      const reportStage = join(directory, ".report-stage.json");
      const image = join(directory, "image.vfs.zst");
      const report = join(directory, "report.json");
      writeFileSync(imageStage, "image\n");
      writeFileSync(reportStage, "report\n");

      publishFlatHomebrewVfsOutputs([
        { stagedPath: imageStage, finalPath: image },
        { stagedPath: reportStage, finalPath: report },
      ]);
      expect(readFileSync(image, "utf8")).toBe("image\n");
      expect(readFileSync(report, "utf8")).toBe("report\n");

      expect(() => publishFlatHomebrewVfsOutputs([
        { stagedPath: imageStage, finalPath: image },
      ])).toThrow(/already exists/);
      expect(readFileSync(image, "utf8")).toBe("image\n");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rolls back the first output if a later no-clobber link fails", () => {
    const directory = mkdtempSync(join(tmpdir(), "flat-homebrew-rollback-"));
    try {
      const firstStage = join(directory, ".first-stage");
      const secondStage = join(directory, ".second-stage");
      const finalPath = join(directory, "shared-final");
      writeFileSync(firstStage, "first\n");
      writeFileSync(secondStage, "second\n");

      expect(() => publishFlatHomebrewVfsOutputs([
        { stagedPath: firstStage, finalPath },
        { stagedPath: secondStage, finalPath },
      ])).toThrow();
      expect(existsSync(finalPath)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects staged directories before publishing any output", () => {
    const directory = mkdtempSync(join(tmpdir(), "flat-homebrew-stage-kind-"));
    try {
      const validStage = join(directory, ".valid-stage");
      const directoryStage = join(directory, ".directory-stage");
      const first = join(directory, "first");
      const second = join(directory, "second");
      writeFileSync(validStage, "valid\n");
      mkdirSync(directoryStage);

      expect(() => publishFlatHomebrewVfsOutputs([
        { stagedPath: validStage, finalPath: first },
        { stagedPath: directoryStage, finalPath: second },
      ])).toThrow(/staged output.*regular file/);
      expect(existsSync(first)).toBe(false);
      expect(existsSync(second)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function validArgs(): string[] {
  return [
    "--selection",
    "selection.json",
    "--base-image",
    "base.vfs.zst",
    "--bottle-cache",
    "bottles",
    "--shell-config",
    "shell.json",
    "--out",
    "kandelo-homebrew-experimental-abi42-wasm32.vfs.zst",
    "--report",
    "report.json",
  ];
}
