import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
    expect(() =>
      parseFlatHomebrewVfsArgs([
        ...validArgs().slice(0, -2),
        "--report",
        "kandelo-homebrew-experimental-abi42-wasm32.vfs.zst",
      ])
    ).toThrow(/must be different/);
  });

  it("reads only the exact digest-keyed regular bottle without symlinks", () => {
    const directory = mkdtempSync(join(tmpdir(), "flat-homebrew-cache-"));
    try {
      const bytes = new TextEncoder().encode("bottle bytes\n");
      const sha256 = sha(bytes);
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
      const actualSha = sha(actual);
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

  it("rejects an unread FIFO immediately instead of blocking on open", () => {
    const directory = mkdtempSync(join(tmpdir(), "flat-homebrew-fifo-"));
    try {
      const fifo = join(directory, "input.fifo");
      const mkfifo = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
      expect(mkfifo.status, mkfifo.stderr).toBe(0);
      const moduleUrl = new URL(
        "../../images/vfs/scripts/build-homebrew-flat-vfs-image.ts",
        import.meta.url,
      ).href;
      const child = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "--eval",
          `import { readBoundedRegularFileNoFollow } from ${JSON.stringify(moduleUrl)};
try {
  readBoundedRegularFileNoFollow(${JSON.stringify(fifo)}, "FIFO fixture", 1);
  process.exitCode = 2;
} catch (error) {
  if (!/must be a regular file/.test(String(error))) process.exitCode = 3;
}`,
        ],
        { encoding: "utf8", timeout: 1_500 },
      );

      expect(child.error).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("publishes exact image and report bytes through distinct inodes", () => {
    const directory = mkdtempSync(join(tmpdir(), "flat-homebrew-output-"));
    try {
      const image = join(directory, "image.vfs.zst");
      const report = join(directory, "report.json");
      publishFlatHomebrewVfsOutputs([
        output(image, "image\n"),
        output(report, "report\n"),
      ]);

      expect(readFileSync(image, "utf8")).toBe("image\n");
      expect(readFileSync(report, "utf8")).toBe("report\n");
      expect(lstatSync(image).ino).not.toBe(lstatSync(report).ino);
      expect(stagingEntries(directory)).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(["bytes", "sha256"] as const)(
    "rejects generated output with the wrong expected %s",
    (kind) => {
      const directory = mkdtempSync(
        join(tmpdir(), `flat-homebrew-output-${kind}-`),
      );
      try {
        const image = join(directory, "image.vfs.zst");
        const report = join(directory, "report.json");
        const imageOutput = output(image, "image\n");
        if (kind === "bytes") imageOutput.expectedBytes += 1;
        else imageOutput.expectedSha256 = "a".repeat(64);

        expect(() => publishFlatHomebrewVfsOutputs([
          imageOutput,
          output(report, "report\n"),
        ])).toThrow(kind === "bytes" ? /expected 7 bytes/ : /expected a{64}/);
        expect(existsSync(image)).toBe(false);
        expect(existsSync(report)).toBe(false);
        expect(stagingEntries(directory)).toEqual([]);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("rejects duplicate resolved final paths and different final parents", () => {
    const directory = mkdtempSync(join(tmpdir(), "flat-homebrew-paths-"));
    try {
      const subdirectory = join(directory, "subdirectory");
      const other = join(directory, "other");
      mkdirSync(subdirectory);
      mkdirSync(other);
      const alias = join(directory, "alias");
      symlinkSync(directory, alias);
      const finalPath = join(directory, "same");

      expect(() => publishFlatHomebrewVfsOutputs([
        output(finalPath, "image\n"),
        output(join(subdirectory, "..", "same"), "report\n"),
      ])).toThrow(/paths must be different/);
      expect(() => publishFlatHomebrewVfsOutputs([
        output(finalPath, "image\n"),
        output(join(alias, "same"), "report\n"),
      ])).toThrow(/paths must be different/);
      expect(() => publishFlatHomebrewVfsOutputs([
        output(join(directory, "image"), "image\n"),
        output(join(other, "report"), "report\n"),
      ])).toThrow(/share one final directory/);
      expect(stagingEntries(directory)).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not replace a pre-existing first output", () => {
    const directory = mkdtempSync(join(tmpdir(), "flat-homebrew-no-clobber-"));
    try {
      const image = join(directory, "image.vfs.zst");
      const report = join(directory, "report.json");
      writeFileSync(image, "existing\n");

      expect(() => publishFlatHomebrewVfsOutputs([
        output(image, "image\n"),
        output(report, "report\n"),
      ])).toThrow(/already exists/);
      expect(readFileSync(image, "utf8")).toBe("existing\n");
      expect(existsSync(report)).toBe(false);
      expect(stagingEntries(directory)).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rolls back the first link when the second output already exists", () => {
    const directory = mkdtempSync(join(tmpdir(), "flat-homebrew-rollback-"));
    try {
      const image = join(directory, "image.vfs.zst");
      const report = join(directory, "report.json");
      writeFileSync(report, "existing\n");

      expect(() => publishFlatHomebrewVfsOutputs([
        output(image, "image\n"),
        output(report, "report\n"),
      ])).toThrow(/already exists/);
      expect(existsSync(image)).toBe(false);
      expect(readFileSync(report, "utf8")).toBe("existing\n");
      expect(stagingEntries(directory)).toEqual([]);
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

function output(finalPath: string, contents: string): {
  finalPath: string;
  bytes: Uint8Array;
  expectedSha256: string;
  expectedBytes: number;
} {
  const bytes = new TextEncoder().encode(contents);
  return {
    finalPath,
    bytes,
    expectedSha256: sha(bytes),
    expectedBytes: bytes.byteLength,
  };
}

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function stagingEntries(directory: string): string[] {
  return readdirSync(directory).filter((name) =>
    name.startsWith(".kandelo-homebrew-vfs-")
  );
}
