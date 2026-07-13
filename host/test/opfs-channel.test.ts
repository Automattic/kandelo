import { describe, it, expect } from "vitest";
import { OpfsChannel, OpfsChannelStatus, OpfsOpcode, OPFS_CHANNEL_SIZE } from "../src/vfs/opfs-channel";
import { OpfsFileSystem } from "../src/vfs/opfs";

describe("OpfsChannel", () => {
  function makeChannel(): OpfsChannel {
    return new OpfsChannel(new SharedArrayBuffer(OPFS_CHANNEL_SIZE));
  }

  it("initializes with Idle status", () => {
    const ch = makeChannel();
    expect(ch.status).toBe(OpfsChannelStatus.Idle);
  });

  it("reads and writes opcode", () => {
    const ch = makeChannel();
    ch.opcode = OpfsOpcode.OPEN;
    expect(ch.opcode).toBe(OpfsOpcode.OPEN);

    ch.opcode = OpfsOpcode.READ;
    expect(ch.opcode).toBe(OpfsOpcode.READ);
  });

  it("reads and writes args", () => {
    const ch = makeChannel();
    ch.setArg(0, 42);
    ch.setArg(5, -1);
    ch.setArg(11, 0x7fffffff);

    expect(ch.getArg(0)).toBe(42);
    expect(ch.getArg(5)).toBe(-1);
    expect(ch.getArg(11)).toBe(0x7fffffff);
  });

  it("reads and writes result and result2", () => {
    const ch = makeChannel();
    ch.result = 123;
    ch.result2 = 456;
    expect(ch.result).toBe(123);
    expect(ch.result2).toBe(456);

    ch.result = -2; // ENOENT
    expect(ch.result).toBe(-2);
  });

  it("round-trips exactly representable signed i64 arguments and results", () => {
    const ch = makeChannel();
    for (const value of [
      Number.MIN_SAFE_INTEGER,
      -0x1_0000_0001,
      -1,
      0,
      0x1_0000_0001,
      Number.MAX_SAFE_INTEGER,
    ]) {
      ch.setI64Arg(0, value);
      ch.i64Result = value;
      expect(ch.getI64Arg(0)).toBe(value);
      expect(ch.i64Result).toBe(value);
    }
  });

  it("rejects i64 values that JavaScript cannot represent exactly", () => {
    const ch = makeChannel();
    expect(() => ch.setI64Arg(0, 2 ** 53)).toThrow(RangeError);

    ch.result = -1;
    ch.result2 = 0x7fffffff;
    expect(() => ch.i64Result).toThrow(RangeError);

    const fs = OpfsFileSystem.create(ch.buffer);
    expect(() => fs.seek(7, 2 ** 53, 0)).toThrow(/EOVERFLOW/);
  });

  it("writes and reads strings in data section", () => {
    const ch = makeChannel();
    const len = ch.writeString("/tmp/hello.txt");
    expect(len).toBeGreaterThan(0);

    const str = ch.readString(len);
    expect(str).toBe("/tmp/hello.txt");
  });

  it("writes and reads UTF-8 strings", () => {
    const ch = makeChannel();
    const len = ch.writeString("héllo wörld");
    const str = ch.readString(len);
    expect(str).toBe("héllo wörld");
  });

  it("writes and reads two null-separated strings", () => {
    const ch = makeChannel();
    const totalLen = ch.writeTwoStrings("/old/path", "/new/path");

    const [s1, s2] = ch.readTwoStrings(totalLen);
    expect(s1).toBe("/old/path");
    expect(s2).toBe("/new/path");
  });

  it("writes and reads stat results", () => {
    const ch = makeChannel();
    const stat = {
      dev: 1, ino: 42, mode: 0o100644, nlink: 1,
      uid: 1000, gid: 1000, size: 4096,
      atimeMs: 1700000000000, mtimeMs: 1700000001000, ctimeMs: 1700000002000,
    };
    ch.writeStatResult(stat);

    const result = ch.readStatResult();
    expect(result.dev).toBe(1);
    expect(result.ino).toBe(42);
    expect(result.mode).toBe(0o100644);
    expect(result.nlink).toBe(1);
    expect(result.uid).toBe(1000);
    expect(result.gid).toBe(1000);
    expect(result.size).toBe(4096);
    expect(result.atimeMs).toBe(1700000000000);
    expect(result.mtimeMs).toBe(1700000001000);
    expect(result.ctimeMs).toBe(1700000002000);
  });

  it("notifyComplete sets status to Complete", () => {
    const ch = makeChannel();
    ch.status = OpfsChannelStatus.Pending;
    ch.notifyComplete();
    expect(ch.status).toBe(OpfsChannelStatus.Complete);
  });

  it("notifyError sets status to Error", () => {
    const ch = makeChannel();
    ch.status = OpfsChannelStatus.Pending;
    ch.notifyError();
    expect(ch.status).toBe(OpfsChannelStatus.Error);
  });

  it("setPending sets status to Pending", () => {
    const ch = makeChannel();
    ch.setPending();
    expect(ch.status).toBe(OpfsChannelStatus.Pending);
  });

  it("data section has expected capacity", () => {
    const ch = makeChannel();
    // 4MB total - 64B header
    expect(ch.dataCapacity).toBe(OPFS_CHANNEL_SIZE - 64);
  });

  it("two channels sharing same SAB see each other's writes", () => {
    const sab = new SharedArrayBuffer(OPFS_CHANNEL_SIZE);
    const ch1 = new OpfsChannel(sab);
    const ch2 = new OpfsChannel(sab);

    ch1.opcode = OpfsOpcode.WRITE;
    ch1.setArg(0, 99);
    ch1.result = 42;
    ch1.writeString("shared");

    expect(ch2.opcode).toBe(OpfsOpcode.WRITE);
    expect(ch2.getArg(0)).toBe(99);
    expect(ch2.result).toBe(42);
    expect(ch2.readString(6)).toBe("shared");
  });

  it("status transitions are visible across channels via atomics", () => {
    const sab = new SharedArrayBuffer(OPFS_CHANNEL_SIZE);
    const ch1 = new OpfsChannel(sab);
    const ch2 = new OpfsChannel(sab);

    expect(ch2.status).toBe(OpfsChannelStatus.Idle);
    ch1.setPending();
    expect(ch2.status).toBe(OpfsChannelStatus.Pending);
    ch1.notifyComplete();
    expect(ch2.status).toBe(OpfsChannelStatus.Complete);
  });
});
