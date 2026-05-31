import { describe, expect, it } from "vitest";
import { MemoryFileSystem } from "../../src/vfs/memory-fs";

const O_RDONLY = 0x0000;
const O_WRONLY = 0x0001;
const O_CREAT = 0x0040;
const O_TRUNC = 0x0200;

describe("SharedFS fd table", () => {
  it("supports substantially more than the legacy 64 open files", () => {
    const fs = MemoryFileSystem.create(new SharedArrayBuffer(1024 * 1024));
    const writeFd = fs.open("/package.json", O_WRONLY | O_CREAT | O_TRUNC, 0o644);
    fs.write(writeFd, new TextEncoder().encode("{}"), null, 2);
    fs.close(writeFd);

    const fds: number[] = [];
    try {
      for (let i = 0; i < 512; i++) {
        fds.push(fs.open("/package.json", O_RDONLY, 0));
      }
      expect(fds).toHaveLength(512);
    } finally {
      for (const fd of fds) fs.close(fd);
    }
  });
});
