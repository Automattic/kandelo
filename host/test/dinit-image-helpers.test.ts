import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findRepoRoot } from "../src/binary-resolver";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import {
  addDinitBaseSystemFiles,
  addDinitInit,
} from "../../images/vfs/scripts/dinit-image-helpers";
import { ensureDirRecursive, writeVfsBinary } from "../src/vfs/image-helpers";

const O_RDONLY = 0;

function readGuestFile(fs: MemoryFileSystem, path: string): string {
  const size = fs.stat(path).size;
  const fd = fs.open(path, O_RDONLY, 0);
  try {
    const bytes = new Uint8Array(size);
    const count = fs.read(fd, bytes, null, bytes.byteLength);
    return new TextDecoder().decode(bytes.subarray(0, count));
  } finally {
    fs.close(fd);
  }
}

function createFs(): MemoryFileSystem {
  return MemoryFileSystem.create(new SharedArrayBuffer(4 * 1024 * 1024));
}

describe("dinit-derived image system databases", () => {
  it("copies the authoritative rootfs services database without reducing aliases", () => {
    const fs = createFs();
    addDinitBaseSystemFiles(fs);

    const source = readFileSync(
      join(findRepoRoot(), "images", "rootfs", "etc", "services"),
      "utf8",
    );
    const derived = readGuestFile(fs, "/etc/services");

    expect(derived).toBe(source);
    expect(derived).toContain("www www-http");
    expect(derived).toContain("postgresql\t5432/tcp");
  });
});

describe("dinit-derived image binary ownership", () => {
  it("inherits the complete resident Dinit set from the canonical shell", () => {
    const fs = createFs();
    ensureDirRecursive(fs, "/sbin");
    writeVfsBinary(fs, "/sbin/dinit", new TextEncoder().encode("base dinit"));
    writeVfsBinary(
      fs,
      "/sbin/dinitctl",
      new TextEncoder().encode("base dinitctl"),
    );

    addDinitInit(fs, [
      {
        name: "service",
        type: "internal",
      },
    ]);

    expect(readGuestFile(fs, "/sbin/dinit")).toBe("base dinit");
    expect(readGuestFile(fs, "/sbin/dinitctl")).toBe("base dinitctl");
    expect(readGuestFile(fs, "/etc/dinit.d/service")).toContain(
      "type = internal",
    );
  });

  it("rejects a partially inherited Dinit set instead of mixing provenance", () => {
    const fs = createFs();
    ensureDirRecursive(fs, "/sbin");
    writeVfsBinary(fs, "/sbin/dinit", new TextEncoder().encode("base dinit"));

    expect(() => addDinitInit(fs, [])).toThrow(
      "the shell base contains an incomplete resident Dinit binary set",
    );
  });

  it("rejects lazy Dinit executables because service boot always needs them", () => {
    const fs = createFs();
    fs.registerLazyFile("/sbin/dinit", "https://example.test/dinit", 100);
    fs.registerLazyFile("/sbin/dinitctl", "https://example.test/dinitctl", 100);

    expect(() => addDinitInit(fs, [])).toThrow(
      "/sbin/dinit is lazy, but Dinit must be resident before service boot",
    );
  });
});
