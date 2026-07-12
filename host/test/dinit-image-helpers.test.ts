import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findRepoRoot } from "../src/binary-resolver";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import { addDinitBaseSystemFiles } from "../../images/vfs/scripts/dinit-image-helpers";

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

describe("dinit-derived image system databases", () => {
  it("copies the authoritative rootfs services database without reducing aliases", () => {
    const fs = MemoryFileSystem.create(
      new SharedArrayBuffer(4 * 1024 * 1024),
    );
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
