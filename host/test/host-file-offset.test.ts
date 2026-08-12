import {
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NativePositionedWriteHandles } from "../src/native-positioned-write";
import { NodePlatformIO } from "../src/platform/node";
import type { HostFileOffset } from "../src/types";
import { DeviceFileSystem } from "../src/vfs/device-fs";
import { HostFileSystem } from "../src/vfs/host-fs";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import { OPFS_CHANNEL_SIZE } from "../src/vfs/opfs-channel";
import { OpfsFileSystem } from "../src/vfs/opfs";
import type { FileSystemBackend } from "../src/vfs/types";
import { VirtualPlatformIO } from "../src/vfs/vfs";

const TWO_TO_53 = 1n << 53n;
const MIN_I64 = -(1n << 63n);
const MAX_I64 = (1n << 63n) - 1n;
const O_WRONLY = 0o1;
const O_RDWR = 0o2;
const O_APPEND = 0o2000;
const SEEK_SET = 0;
const SEEK_CUR = 1;
const SEEK_END = 2;

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function linuxOpenFileDescriptionCount(
  target: { dev: bigint; ino: bigint },
): number | null {
  if (process.platform !== "linux") return null;
  let count = 0;
  for (const entry of readdirSync("/proc/self/fd")) {
    const fd = Number(entry);
    if (!Number.isInteger(fd)) continue;
    try {
      const candidate = fstatSync(fd, { bigint: true });
      if (candidate.dev === target.dev && candidate.ino === target.ino) {
        count++;
      }
    } catch {
      // The directory enumeration itself can briefly occupy a descriptor.
    }
  }
  return count;
}

describe("HostFileOffset VFS contract", () => {
  it("forwards exact positioned and seek offsets without narrowing", () => {
    const reads: HostFileOffset[] = [];
    const writes: HostFileOffset[] = [];
    const seeks: HostFileOffset[] = [];
    const backend = {
      open: () => 7,
      close: () => 0,
      read: (
        _handle: number,
        _buffer: Uint8Array,
        offset: HostFileOffset | null,
      ) => {
        if (offset !== null) reads.push(offset);
        return 0;
      },
      write: (
        _handle: number,
        _buffer: Uint8Array,
        offset: HostFileOffset | null,
      ) => {
        if (offset !== null) writes.push(offset);
        return 0;
      },
      seek: (
        _handle: number,
        offset: HostFileOffset,
      ): HostFileOffset => {
        seeks.push(offset);
        return offset;
      },
      statfs: () => ({
        type: 0,
        bsize: 4096,
        blocks: 1,
        bfree: 0,
        bavail: 0,
        files: 1,
        ffree: 0,
        fsid: 0,
        namelen: 255,
        frsize: 4096,
        flags: 0,
      }),
    } as unknown as FileSystemBackend;
    const io = new VirtualPlatformIO(
      [{ mountPoint: "/", backend }],
      {
        clockGettime: () => ({ sec: 0, nsec: 0 }),
        nanosleep: () => {},
      },
    );
    const handle = io.open("/file", O_RDWR, 0);
    const byte = new Uint8Array(1);

    expect(io.read(handle, byte, TWO_TO_53 + 1n, 1)).toBe(0);
    expect(io.write(handle, byte, MAX_I64, 1)).toBe(0);
    expect(io.seek(handle, MIN_I64, SEEK_CUR)).toBe(MIN_I64);
    expect(reads).toEqual([TWO_TO_53 + 1n]);
    expect(writes).toEqual([MAX_I64]);
    expect(seeks).toEqual([MIN_I64]);
  });
});

describe("native positioned-write route ownership", () => {
  it("fails closed for a regular file without an established route", () => {
    const root = tempRoot("kandelo-missing-write-route-");
    const path = join(root, "file");
    writeFileSync(path, "abcdef");

    // Use a fresh descriptor that deliberately bypasses the owner registration
    // path to prove the helper never silently uses an unknown O_APPEND state.
    const rawHandle = openSync(path, "r+");
    const routes = new NativePositionedWriteHandles();
    try {
      expect(() => routes.forWrite(rawHandle, true)).toThrow(/EOPNOTSUPP/);
    } finally {
      routes.close(rawHandle);
    }
  });
});

describe.each([
  [
    "NodePlatformIO",
    () => {
      const root = tempRoot("kandelo-node-offset-");
      const path = join(root, "file");
      writeFileSync(path, "abcdef");
      return {
        io: new NodePlatformIO(),
        path,
        nativePath: path,
      };
    },
  ],
  [
    "HostFileSystem",
    () => {
      const root = tempRoot("kandelo-host-fs-offset-");
      const nativePath = join(root, "file");
      writeFileSync(nativePath, "abcdef");
      return {
        io: new HostFileSystem(root),
        path: "/file",
        nativePath,
      };
    },
  ],
] as const)("%s exact offsets", (_name, makeCase) => {
  it("keeps bigint seeks and positioned reads exact at and above 2^53", () => {
    const { io, path } = makeCase();
    const handle = io.open(path, O_RDWR, 0);
    try {
      expect(io.seek(handle, TWO_TO_53, SEEK_SET)).toBe(TWO_TO_53);
      expect(io.seek(handle, 1n, SEEK_CUR)).toBe(TWO_TO_53 + 1n);
      expect(io.read(handle, new Uint8Array(1), TWO_TO_53 + 1n, 1)).toBe(0);
      expect(io.seek(handle, 0n, SEEK_CUR)).toBe(TWO_TO_53 + 1n);

      expect(io.seek(handle, MAX_I64, SEEK_SET)).toBe(MAX_I64);
      expect(io.read(handle, new Uint8Array(0), MAX_I64, 0)).toBe(0);
      expect(() => {
        io.read(handle, new Uint8Array(1), MAX_I64, 1);
      }).toThrow(/EOVERFLOW/);
      expect(() => io.seek(handle, 1n, SEEK_CUR)).toThrow(/EOVERFLOW/);
      expect(io.seek(handle, 0n, SEEK_CUR)).toBe(MAX_I64);
    } finally {
      io.close(handle);
    }
  });

  it("fails before a bigint position could be silently lost by writeSync", () => {
    const { io, path, nativePath } = makeCase();
    const handle = io.open(path, O_RDWR, 0);
    try {
      expect(() => {
        io.write(handle, new Uint8Array([0x7a]), TWO_TO_53, 1);
      }).toThrow(/EOVERFLOW/);
      expect(readFileSync(nativePath, "utf8")).toBe("abcdef");

      expect(io.write(handle, new Uint8Array([0x5a]), 1n, 1)).toBe(1);
      expect(readFileSync(nativePath, "utf8")).toBe("aZcdef");
    } finally {
      io.close(handle);
    }
  });

  it("checks negative and out-of-i64 offsets without changing seek state", () => {
    const { io, path } = makeCase();
    const handle = io.open(path, O_RDWR, 0);
    try {
      expect(io.seek(handle, 2, SEEK_SET)).toBe(2);
      expect(() => {
        io.read(handle, new Uint8Array(1), MIN_I64, 1);
      }).toThrow(/EINVAL/);
      expect(() => io.seek(handle, MIN_I64, SEEK_SET)).toThrow(/EINVAL/);
      expect(() => {
        io.read(handle, new Uint8Array(1), MAX_I64 + 1n, 1);
      }).toThrow(/EOVERFLOW/);
      expect(() => {
        io.write(handle, new Uint8Array(1), MIN_I64 - 1n, 1);
      }).toThrow(/EOVERFLOW/);
      expect(io.seek(handle, 0, SEEK_CUR)).toBe(2);
    } finally {
      io.close(handle);
    }
  });

  it("rejects externally mutable append before writing any bytes", () => {
    const { io, path, nativePath } = makeCase();
    const handle = io.open(path, O_RDWR, 0);
    try {
      for (const limit of [null, 7] as const) {
        expect(() => {
          io.append(handle, new Uint8Array([0x21]), 1, limit);
        }).toThrow(/EOPNOTSUPP/);
        expect(readFileSync(nativePath, "utf8")).toBe("abcdef");
      }
    } finally {
      io.close(handle);
    }
  });

  it("positions writes independently of O_APPEND and preserves the cursor", () => {
    const { io, path, nativePath } = makeCase();
    const handle = io.open(path, O_RDWR | O_APPEND, 0);
    try {
      expect(io.seek(handle, 4, SEEK_SET)).toBe(4);
      expect(io.write(handle, new Uint8Array([0x5a]), 1, 1)).toBe(1);
      expect(readFileSync(nativePath, "utf8")).toBe("aZcdef");
      expect(io.seek(handle, 0, SEEK_CUR)).toBe(4);

      expect(() => {
        io.append(handle, new Uint8Array([0x21]), 1, null);
      }).toThrow(/EOPNOTSUPP/);
      expect(readFileSync(nativePath, "utf8")).toBe("aZcdef");
    } finally {
      io.close(handle);
    }
  });

  it("keeps positioned writes bound to the opened inode after rename", () => {
    const { io, path, nativePath } = makeCase();
    const handle = io.open(path, O_RDWR, 0);
    const renamedPath = `${nativePath}.renamed`;
    try {
      renameSync(nativePath, renamedPath);
      writeFileSync(nativePath, "replacement");

      expect(() => {
        io.append(handle, new Uint8Array([0x21]), 1, null);
      }).toThrow(/EOPNOTSUPP/);
      expect(io.write(handle, new Uint8Array([0x58]), 2, 1)).toBe(1);
      expect(readFileSync(renamedPath, "utf8")).toBe("abXdef");
      expect(readFileSync(nativePath, "utf8")).toBe("replacement");
    } finally {
      io.close(handle);
    }
  });

  it("supports positioned writes after the opened file is unlinked", () => {
    const { io, path, nativePath } = makeCase();
    const handle = io.open(path, O_RDWR, 0);
    try {
      unlinkSync(nativePath);

      expect(() => {
        io.append(handle, new Uint8Array([0x21]), 1, null);
      }).toThrow(/EOPNOTSUPP/);
      expect(io.write(handle, new Uint8Array([0x51]), 3, 1)).toBe(1);
      const result = new Uint8Array(6);
      expect(io.read(handle, result, 0, result.byteLength)).toBe(6);
      expect(new TextDecoder().decode(result)).toBe("abcQef");
    } finally {
      io.close(handle);
    }
  });

  it("closes the Linux companion together with the primary descriptor", () => {
    const { io, path } = makeCase();
    const handle = io.open(path, O_RDWR | O_APPEND, 0);
    const target = fstatSync(handle, { bigint: true });
    let closed = false;
    try {
      expect(linuxOpenFileDescriptionCount(target)).toBe(
        process.platform === "linux" ? 2 : null,
      );
      expect(io.write(handle, new Uint8Array([0x58]), 0, 1)).toBe(1);
      expect(linuxOpenFileDescriptionCount(target)).toBe(
        process.platform === "linux" ? 2 : null,
      );

      expect(io.close(handle)).toBe(0);
      closed = true;
      expect(linuxOpenFileDescriptionCount(target)).toBe(
        process.platform === "linux" ? 0 : null,
      );
      expect(() => {
        io.write(handle, new Uint8Array([0x59]), 0, 1);
      }).toThrow(/EBADF|bad file descriptor/i);
    } finally {
      if (!closed) io.close(handle);
    }
  });

  it("keeps O_WRONLY positioned writes while append stays unsupported", () => {
    const { io, path, nativePath } = makeCase();
    const handle = io.open(path, O_WRONLY, 0);
    try {
      expect(io.write(handle, new Uint8Array([0x58]), 1, 1)).toBe(1);
      expect(() => {
        io.append(handle, new Uint8Array([0x21]), 1, null);
      }).toThrow(/EOPNOTSUPP/);
      expect(readFileSync(nativePath, "utf8")).toBe("aXcdef");
    } finally {
      io.close(handle);
    }
  });

  it("keeps positioned writes attached to the opened inode across fchmod", () => {
    const { io, path, nativePath } = makeCase();
    const handle = io.open(path, O_WRONLY, 0);
    try {
      io.fchmod(handle, 0o640);
      expect(io.fstat(handle).mode & 0o777).toBe(0o640);

      expect(io.write(handle, new Uint8Array([0x58]), 2, 1)).toBe(1);
      expect(() => {
        io.append(handle, new Uint8Array([0x21]), 1, null);
      }).toThrow(/EOPNOTSUPP/);
      expect(readFileSync(nativePath, "utf8")).toBe("abXdef");
    } finally {
      io.close(handle);
    }
  });
});

describe("number-only VFS backends", () => {
  it.each([
    [
      "MemoryFileSystem",
      () => {
        const io = MemoryFileSystem.create(
          new SharedArrayBuffer(4 * 1024 * 1024),
        );
        return {
          io,
          handle: io.open("/file", 0o100 | O_RDWR, 0o600),
        };
      },
    ],
    [
      "OpfsFileSystem",
      () => {
        const io = OpfsFileSystem.create(
          new SharedArrayBuffer(OPFS_CHANNEL_SIZE),
        );
        // Unsafe offsets are rejected before OPFS tries to use the channel.
        return { io, handle: 7 };
      },
    ],
  ] as const)("%s reports EOVERFLOW instead of narrowing bigint", (_name, makeCase) => {
    const { io, handle } = makeCase();
    const byte = new Uint8Array(1);

    expect(() => io.read(handle, byte, TWO_TO_53, 1)).toThrow(/EOVERFLOW/);
    expect(() => io.write(handle, byte, TWO_TO_53, 1)).toThrow(/EOVERFLOW/);
    expect(() => io.seek(handle, TWO_TO_53, SEEK_SET)).toThrow(/EOVERFLOW/);
    expect(() => io.read(handle, byte, MAX_I64, 1)).toThrow(/EOVERFLOW/);
    expect(() => io.seek(handle, MIN_I64, SEEK_SET)).toThrow(/EOVERFLOW/);
    expect(() => io.read(handle, byte, MAX_I64 + 1n, 1)).toThrow(/EOVERFLOW/);
    expect(() => io.write(handle, byte, MIN_I64, 1)).toThrow(/EINVAL/);
  });
});

describe("DeviceFileSystem exact offsets", () => {
  it("validates signed i64 input without narrowing ignored device offsets", () => {
    const io = new DeviceFileSystem();
    const handle = io.open("/null", O_RDWR, 0);
    const byte = new Uint8Array(1);

    expect(io.read(handle, byte, MAX_I64, 1)).toBe(0);
    expect(io.write(handle, byte, MAX_I64, 1)).toBe(1);
    expect(io.seek(handle, MIN_I64, SEEK_SET)).toBe(0);
    expect(() => io.read(handle, byte, MAX_I64 + 1n, 1))
      .toThrow(/EOVERFLOW/);
  });
});
