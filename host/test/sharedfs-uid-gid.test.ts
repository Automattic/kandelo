import { describe, it, expect } from "vitest";
import { MemoryFileSystem } from "../src/vfs/memory-fs";

describe("SharedFS uid/gid", () => {
  it("new file has uid=0 gid=0 by default", () => {
    const sab = new SharedArrayBuffer(1024 * 1024);
    const fs = MemoryFileSystem.create(sab);
    const fd = fs.open("/hello", 0o1101, 0o644); // O_WRONLY|O_CREAT|O_TRUNC
    fs.close(fd);
    const st = fs.stat("/hello");
    expect(st.uid).toBe(0);
    expect(st.gid).toBe(0);
  });
});
