import { describe, it, expect } from "vitest";
import { SharedPipeBuffer } from "../src/shared-pipe-buffer";

describe("SharedPipeBuffer", () => {
  it("should create with correct capacity", () => {
    const pipe = SharedPipeBuffer.create(1024);
    expect(pipe.capacity()).toBe(1024);
    expect(pipe.available()).toBe(0);
    expect(pipe.isReadOpen()).toBe(true);
    expect(pipe.isWriteOpen()).toBe(true);
  });

  it("should write and read data", () => {
    const pipe = SharedPipeBuffer.create(1024);
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const written = pipe.write(data);
    expect(written).toBe(5);
    expect(pipe.available()).toBe(5);

    const buf = new Uint8Array(10);
    const read = pipe.read(buf);
    expect(read).toBe(5);
    expect(buf.slice(0, 5)).toEqual(data);
    expect(pipe.available()).toBe(0);
  });

  it("should handle partial writes when buffer is nearly full", () => {
    const pipe = SharedPipeBuffer.create(8);
    const written1 = pipe.write(new Uint8Array([1, 2, 3, 4, 5]));
    expect(written1).toBe(5);
    const written2 = pipe.write(new Uint8Array([6, 7, 8, 9, 10]));
    expect(written2).toBe(3);
  });

  it("should return 0 when reading empty buffer", () => {
    const pipe = SharedPipeBuffer.create(1024);
    const buf = new Uint8Array(10);
    const read = pipe.read(buf);
    expect(read).toBe(0);
  });

  it("should handle ring buffer wraparound", () => {
    const pipe = SharedPipeBuffer.create(8);
    pipe.write(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    const buf1 = new Uint8Array(4);
    pipe.read(buf1);
    expect(buf1).toEqual(new Uint8Array([1, 2, 3, 4]));
    pipe.write(new Uint8Array([9, 10, 11, 12]));
    const buf2 = new Uint8Array(8);
    const read = pipe.read(buf2);
    expect(read).toBe(8);
    expect(buf2).toEqual(new Uint8Array([5, 6, 7, 8, 9, 10, 11, 12]));
  });

  it("should close read end", () => {
    const pipe = SharedPipeBuffer.create(1024);
    pipe.closeRead();
    expect(pipe.isReadOpen()).toBe(false);
    expect(pipe.isWriteOpen()).toBe(true);
  });

  it("should close write end", () => {
    const pipe = SharedPipeBuffer.create(1024);
    pipe.closeWrite();
    expect(pipe.isWriteOpen()).toBe(false);
    expect(pipe.isReadOpen()).toBe(true);
  });

  it("should create from existing SharedArrayBuffer", () => {
    const pipe1 = SharedPipeBuffer.create(1024);
    pipe1.write(new Uint8Array([1, 2, 3]));
    const pipe2 = SharedPipeBuffer.fromSharedBuffer(pipe1.getBuffer());
    expect(pipe2.available()).toBe(3);
    const buf = new Uint8Array(3);
    pipe2.read(buf);
    expect(buf).toEqual(new Uint8Array([1, 2, 3]));
  });
});
