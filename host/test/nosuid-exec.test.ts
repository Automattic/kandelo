import { describe, expect, it } from "vitest";
import {
  DIRENT_TYPES,
  FILE_MODES,
  OPEN_FLAGS,
  PATHCONF_NAMES,
} from "../src/generated/abi";
import { NodePlatformIO } from "../src/platform/node";
import {
  createImmutableProductBackend,
  MemoryFileSystem,
  resolveMountSetIdCapability,
} from "../src/vfs/memory-fs";
import { NodeTimeProvider } from "../src/vfs/time";
import {
  ST_NOSUID,
  type FileSystemBackend,
  type MountSetIdCapability,
} from "../src/vfs/types";
import { VirtualPlatformIO } from "../src/vfs/vfs";

const TRUSTED_ROOT_PRODUCT = {
  kind: "trusted-root-product",
  guestWritable: false,
  stableExecutableIdentity: true,
} as const;

function createSetIdFileSystem(): MemoryFileSystem {
  const fs = MemoryFileSystem.create(
    new SharedArrayBuffer(2 * 1024 * 1024),
  );
  fs.mkdir("/bin", 0o755);
  fs.createFileWithOwner(
    "/bin/tool",
    0o6755,
    0,
    42,
    new Uint8Array([0, 97, 115, 109]),
  );
  return fs;
}

describe("set-ID mount capability validation", () => {
  it("defaults an omitted capability to nosuid", () => {
    const backend = createSetIdFileSystem();

    expect(resolveMountSetIdCapability({ backend })).toEqual({
      kind: "nosuid",
    });
  });

  it("rejects a guest-writable trusted-root-product request", () => {
    const immutableProductBackend = createImmutableProductBackend(
      createSetIdFileSystem(),
    );

    expect(() => resolveMountSetIdCapability({
      backend: immutableProductBackend,
      readonly: true,
      setIdCapability: {
        kind: "trusted-root-product",
        guestWritable: true,
        stableExecutableIdentity: true,
      } as unknown as MountSetIdCapability,
    })).toThrow(/trusted root product mount must not be guest-writable/);
  });

  it("rejects a writable trusted-root-product mount", () => {
    const immutableProductBackend = createImmutableProductBackend(
      createSetIdFileSystem(),
    );

    expect(() => resolveMountSetIdCapability({
      backend: immutableProductBackend,
      readonly: false,
      setIdCapability: TRUSTED_ROOT_PRODUCT,
    })).toThrow(/trusted root product mount must be read-only/);
  });

  it("rejects a trusted request from a backend without stable executable identity", () => {
    const identityUnstableBackend: FileSystemBackend = createSetIdFileSystem();

    expect(() => resolveMountSetIdCapability({
      backend: identityUnstableBackend,
      readonly: true,
      setIdCapability: TRUSTED_ROOT_PRODUCT,
    })).toThrow(/immutable handle generation/);
  });

  it("rejects a caller-defined backend that spoofs every public structural field", () => {
    const writable = createSetIdFileSystem();
    const spoofed = Object.assign(writable, {
      executableIdentityKind: "immutable-handle-generation" as const,
    });

    expect(() => new VirtualPlatformIO(
      [{
        mountPoint: "/",
        backend: spoofed,
        readonly: true,
        setIdCapability: TRUSTED_ROOT_PRODUCT,
      }],
      new NodeTimeProvider(),
    )).toThrow(/immutable product backend/);
  });

  it("rejects a Proxy-wrapped structural source at the product factory", () => {
    const source = createSetIdFileSystem();

    expect(() => createImmutableProductBackend(
      new Proxy(source, {}) as MemoryFileSystem,
    )).toThrow(/genuine MemoryFileSystem/);
  });

  it("keeps admission brands exact under mutable WeakSet hooks", () => {
    const addDescriptor = Object.getOwnPropertyDescriptor(
      WeakSet.prototype,
      "add",
    )!;
    const hasDescriptor = Object.getOwnPropertyDescriptor(
      WeakSet.prototype,
      "has",
    )!;
    const genuineSource = createSetIdFileSystem();
    const spoofed = Object.assign(createSetIdFileSystem(), {
      executableIdentityKind: "immutable-handle-generation" as const,
    });

    try {
      Object.defineProperty(WeakSet.prototype, "add", {
        ...addDescriptor,
        value(this: WeakSet<object>) {
          return this;
        },
      });
      Object.defineProperty(WeakSet.prototype, "has", {
        ...hasDescriptor,
        value() {
          return true;
        },
      });
      const genuine = createImmutableProductBackend(genuineSource);
      expect(() => new VirtualPlatformIO(
        [{
          mountPoint: "/",
          backend: genuine,
          readonly: true,
          setIdCapability: TRUSTED_ROOT_PRODUCT,
        }],
        new NodeTimeProvider(),
      )).not.toThrow();
      expect(() => new VirtualPlatformIO(
        [{
          mountPoint: "/",
          backend: spoofed,
          readonly: true,
          setIdCapability: TRUSTED_ROOT_PRODUCT,
        }],
        new NodeTimeProvider(),
      )).toThrow(/immutable product backend/);
    } finally {
      Object.defineProperty(WeakSet.prototype, "add", addDescriptor);
      Object.defineProperty(WeakSet.prototype, "has", hasDescriptor);
    }
  });

  it("rejects an unknown capability instead of downgrading it", () => {
    const backend = createSetIdFileSystem();

    expect(() => resolveMountSetIdCapability({
      backend,
      readonly: true,
      setIdCapability: {
        kind: "future-capability",
      } as unknown as MountSetIdCapability,
    })).toThrow(/unknown set-ID mount capability/);
  });

  it("rejects a malformed capability while constructing the mount table", () => {
    const backend = createImmutableProductBackend(createSetIdFileSystem());

    expect(() => new VirtualPlatformIO(
      [{
        mountPoint: "/",
        backend,
        readonly: true,
        setIdCapability: {
          kind: "trusted-root-product",
          guestWritable: false,
          stableExecutableIdentity: false,
        } as unknown as MountSetIdCapability,
      }],
      new NodeTimeProvider(),
    )).toThrow(/stable executable identity/);
  });
});

describe("set-ID execution mount evidence", () => {
  it("keeps the raw Node platform adapter nosuid", () => {
    const io = new NodePlatformIO();

    expect(io.statfs(process.cwd()).flags & ST_NOSUID).toBe(ST_NOSUID);
  });

  it("keeps generic mutable MemoryFS execution nosuid", () => {
    const backend = createSetIdFileSystem();
    const statfs = backend.statfs.bind(backend);
    backend.statfs = (path) => ({ ...statfs(path), flags: 0 });
    const vfs = new VirtualPlatformIO(
      [{ mountPoint: "/", backend }],
      new NodeTimeProvider(),
    );

    expect(vfs.stat("/bin/tool").mode & 0o6000).toBe(0o6000);
    expect(vfs.statfs("/bin/tool").flags & ST_NOSUID).toBe(ST_NOSUID);
    expect(vfs.getMountSetIdCapability("/bin/tool")).toEqual({
      kind: "nosuid",
    });
  });

  it("clears backend ST_NOSUID only from the admitted trusted mount", () => {
    const source = createSetIdFileSystem();
    const backend = createImmutableProductBackend(source);
    expect(backend.statfs("/bin/tool").flags & ST_NOSUID).toBe(ST_NOSUID);
    const vfs = new VirtualPlatformIO(
      [{
        mountPoint: "/",
        backend,
        readonly: true,
        setIdCapability: TRUSTED_ROOT_PRODUCT,
      }],
      new NodeTimeProvider(),
    );

    const stat = vfs.stat("/bin/tool");
    expect(stat.mode & FILE_MODES.S_ISUID).toBe(FILE_MODES.S_ISUID);
    expect(stat.mode & FILE_MODES.S_ISGID).toBe(FILE_MODES.S_ISGID);
    expect(vfs.statfs("/bin/tool").flags & ST_NOSUID).toBe(0);
    expect(vfs.getMountSetIdCapability("/bin/tool")).toEqual(
      TRUSTED_ROOT_PRODUCT,
    );
  });

  it("binds set-ID policy to the exact open route instead of a later path lookup", () => {
    const backend = createImmutableProductBackend(createSetIdFileSystem());
    const vfs = new VirtualPlatformIO(
      [
        {
          mountPoint: "/trusted",
          backend,
          readonly: true,
          setIdCapability: TRUSTED_ROOT_PRODUCT,
        },
        { mountPoint: "/raw", backend, readonly: true },
      ],
      new NodeTimeProvider(),
    );

    const trustedHandle = vfs.open(
      "/trusted/bin/tool",
      OPEN_FLAGS.O_RDONLY,
      0,
    );
    const rawHandle = vfs.open("/raw/bin/tool", OPEN_FLAGS.O_RDONLY, 0);
    expect(vfs.fstatfs(trustedHandle).flags & ST_NOSUID).toBe(0);
    expect(vfs.fstatfs(rawHandle).flags & ST_NOSUID).toBe(ST_NOSUID);
    expect(vfs.statfs("/raw/bin/tool").flags & ST_NOSUID).toBe(ST_NOSUID);
    vfs.close(trustedHandle);
    vfs.close(rawHandle);
  });

  it("snapshots product state away from caller-retained mutation authority", () => {
    const source = createSetIdFileSystem();
    const backend = createImmutableProductBackend(source);
    const before = backend.stat("/bin/tool");

    source.chown("/bin/tool", 501, 502);
    source.chmod("/bin/tool", 0o755);
    const sourceHandle = source.open(
      "/bin/tool",
      OPEN_FLAGS.O_WRONLY | OPEN_FLAGS.O_TRUNC,
      0,
    );
    source.write(
      sourceHandle,
      new Uint8Array([1, 2, 3, 4]),
      0,
      4,
    );
    source.close(sourceHandle);

    const after = backend.stat("/bin/tool");
    expect(after.uid).toBe(before.uid);
    expect(after.gid).toBe(before.gid);
    expect(after.mode).toBe(before.mode);
    const trustedHandle = backend.open("/bin/tool", OPEN_FLAGS.O_RDONLY, 0);
    const bytes = new Uint8Array(4);
    expect(backend.read(trustedHandle, bytes, 0, bytes.byteLength)).toBe(4);
    expect(Array.from(bytes)).toEqual([0, 97, 115, 109]);
    backend.close(trustedHandle);
  });

  it("isolates trusted stat, open, and read from producer backing prototype mutation", () => {
    const source = createSetIdFileSystem();
    const backend = createImmutableProductBackend(source);
    const retainedHandle = backend.open(
      "/bin/tool",
      OPEN_FLAGS.O_RDONLY,
      0,
    );
    const backing = (source as unknown as { fs: object }).fs;
    const prototype = Object.getPrototypeOf(backing) as Record<
      "stat" | "open" | "readAt",
      (...args: unknown[]) => unknown
    >;
    const statDescriptor = Object.getOwnPropertyDescriptor(prototype, "stat")!;
    const openDescriptor = Object.getOwnPropertyDescriptor(prototype, "open")!;
    const readAtDescriptor = Object.getOwnPropertyDescriptor(
      prototype,
      "readAt",
    )!;
    const originalStat = statDescriptor.value as (
      this: object,
      path: string,
    ) => Record<string, unknown>;
    let observedStat: ReturnType<FileSystemBackend["stat"]> | undefined;
    let openedAfterPatch: number | undefined;
    let openError: unknown;
    let bytes = new Uint8Array(4);

    try {
      Object.defineProperty(prototype, "stat", {
        ...statDescriptor,
        value(this: object, path: string) {
          return { ...Reflect.apply(originalStat, this, [path]), uid: 777 };
        },
      });
      Object.defineProperty(prototype, "open", {
        ...openDescriptor,
        value() {
          throw new Error("producer prototype open trap");
        },
      });
      Object.defineProperty(prototype, "readAt", {
        ...readAtDescriptor,
        value(_handle: number, buffer: Uint8Array) {
          buffer.fill(7);
          return buffer.byteLength;
        },
      });

      observedStat = backend.stat("/bin/tool");
      try {
        openedAfterPatch = backend.open(
          "/bin/tool",
          OPEN_FLAGS.O_RDONLY,
          0,
        );
      } catch (error) {
        openError = error;
      }
      expect(backend.read(
        retainedHandle,
        bytes,
        0,
        bytes.byteLength,
      )).toBe(4);
    } finally {
      Object.defineProperty(prototype, "stat", statDescriptor);
      Object.defineProperty(prototype, "open", openDescriptor);
      Object.defineProperty(prototype, "readAt", readAtDescriptor);
      if (openedAfterPatch !== undefined) backend.close(openedAfterPatch);
      backend.close(retainedHandle);
    }

    expect(observedStat?.uid).toBe(0);
    expect(openError).toBeUndefined();
    expect(Array.from(bytes)).toEqual([0, 97, 115, 109]);
  });

  it("isolates trusted helpers from producer MemoryFS prototype mutation", () => {
    const source = createSetIdFileSystem();
    const backend = createImmutableProductBackend(source);
    const prototype = Object.getPrototypeOf(source) as Record<
      "adaptStatWithLazySize" | "guardSynchronousLazyAccess",
      (...args: unknown[]) => unknown
    >;
    const adaptDescriptor = Object.getOwnPropertyDescriptor(
      prototype,
      "adaptStatWithLazySize",
    )!;
    const guardDescriptor = Object.getOwnPropertyDescriptor(
      prototype,
      "guardSynchronousLazyAccess",
    )!;
    const originalAdapt = adaptDescriptor.value as (
      this: object,
      stat: unknown,
    ) => Record<string, unknown>;
    let observedStat: ReturnType<FileSystemBackend["stat"]> | undefined;
    let openError: unknown;
    let handle: number | undefined;

    try {
      Object.defineProperty(prototype, "adaptStatWithLazySize", {
        ...adaptDescriptor,
        value(this: object, stat: unknown) {
          return { ...Reflect.apply(originalAdapt, this, [stat]), uid: 888 };
        },
      });
      Object.defineProperty(prototype, "guardSynchronousLazyAccess", {
        ...guardDescriptor,
        value() {
          throw new Error("producer MemoryFS guard trap");
        },
      });
      observedStat = backend.stat("/bin/tool");
      try {
        handle = backend.open("/bin/tool", OPEN_FLAGS.O_RDONLY, 0);
      } catch (error) {
        openError = error;
      }
    } finally {
      Object.defineProperty(
        prototype,
        "adaptStatWithLazySize",
        adaptDescriptor,
      );
      Object.defineProperty(
        prototype,
        "guardSynchronousLazyAccess",
        guardDescriptor,
      );
      if (handle !== undefined) backend.close(handle);
    }

    expect(observedStat?.uid).toBe(0);
    expect(openError).toBeUndefined();
  });

  it("isolates trusted behavior from producer-reachable class properties", () => {
    const source = createSetIdFileSystem();
    const backend = createImmutableProductBackend(source);
    const handle = backend.open("/bin/tool", OPEN_FLAGS.O_RDONLY, 0);
    const backing = (source as unknown as { fs: object }).fs;
    const sharedConstructor = Object.getPrototypeOf(backing).constructor as
      Record<string, unknown>;
    const memoryConstructor = MemoryFileSystem as unknown as Record<
      string,
      unknown
    >;
    const thresholdDescriptor = Object.getOwnPropertyDescriptor(
      sharedConstructor,
      "DIR_INDEX_MIN_SIZE",
    );
    const inodeKeyDescriptor = Object.getOwnPropertyDescriptor(
      memoryConstructor,
      "inodeKey",
    );
    let pathStatError: unknown;
    let handleStatError: unknown;

    try {
      Object.defineProperty(sharedConstructor, "DIR_INDEX_MIN_SIZE", {
        configurable: true,
        get() {
          throw new Error("producer SharedFS class trap");
        },
      });
      Object.defineProperty(memoryConstructor, "inodeKey", {
        configurable: true,
        get() {
          throw new Error("producer MemoryFS class trap");
        },
      });
      try {
        backend.stat("/bin/tool");
      } catch (error) {
        pathStatError = error;
      }
      try {
        backend.fstat(handle);
      } catch (error) {
        handleStatError = error;
      }
    } finally {
      if (thresholdDescriptor) {
        Object.defineProperty(
          sharedConstructor,
          "DIR_INDEX_MIN_SIZE",
          thresholdDescriptor,
        );
      } else {
        Reflect.deleteProperty(sharedConstructor, "DIR_INDEX_MIN_SIZE");
      }
      if (inodeKeyDescriptor) {
        Object.defineProperty(
          memoryConstructor,
          "inodeKey",
          inodeKeyDescriptor,
        );
      } else {
        Reflect.deleteProperty(memoryConstructor, "inodeKey");
      }
      backend.close(handle);
    }

    expect(pathStatError).toBeUndefined();
    expect(handleStatError).toBeUndefined();
  });

  it("keeps open mutation checks independent from generated flag tables", () => {
    const source = createSetIdFileSystem();
    const backend = createImmutableProductBackend(source);
    const metadataBefore = backend.stat("/bin/tool");
    const mutableFlags = OPEN_FLAGS as unknown as Record<string, number>;
    const keys = ["O_RDONLY", "O_ACCMODE", "O_CREAT", "O_TRUNC"] as const;
    const descriptors = new Map(
      keys.map((key) => [
        key,
        Object.getOwnPropertyDescriptor(mutableFlags, key)!,
      ]),
    );
    const attempts = [
      { path: "/bin/tool", flags: 1 },
      { path: "/bin/tool", flags: 2 },
      { path: "/bin/tool", flags: 512 },
      { path: "/bin/tool", flags: 513 },
      { path: "/bin/created", flags: 64 },
      { path: "/bin/created-truncated", flags: 576 },
      { path: "/bin/created-exclusive", flags: 193 },
      { path: "/bin/tool", flags: 1025 },
    ];
    const outcomes: string[] = [];

    try {
      mutableFlags.O_RDONLY = 0;
      mutableFlags.O_ACCMODE = 0;
      mutableFlags.O_CREAT = 0;
      mutableFlags.O_TRUNC = 0;
      for (const attempt of attempts) {
        try {
          const handle = backend.open(attempt.path, attempt.flags, 0o755);
          outcomes.push("opened");
          backend.close(handle);
        } catch (error) {
          outcomes.push(error instanceof Error ? error.message : String(error));
        }
      }
    } finally {
      for (const [key, descriptor] of descriptors) {
        Object.defineProperty(mutableFlags, key, descriptor);
      }
    }

    expect(outcomes).toEqual(Array(attempts.length).fill(
      "EROFS: Read-only file system",
    ));
    expect(backend.stat("/bin/tool")).toEqual(metadataBefore);
    const handle = backend.open("/bin/tool", OPEN_FLAGS.O_RDONLY, 0);
    const bytes = new Uint8Array(4);
    expect(backend.read(handle, bytes, 0, bytes.byteLength)).toBe(4);
    expect(Array.from(bytes)).toEqual([0, 97, 115, 109]);
    backend.close(handle);
    expect(() => backend.stat("/bin/created")).toThrow(/No such file/);
    expect(() => backend.stat("/bin/created-truncated")).toThrow(
      /No such file/,
    );
    expect(() => backend.stat("/bin/created-exclusive")).toThrow(
      /No such file/,
    );
  });

  it("uses one normalized primitive for the open guard and backend", () => {
    const backend = createImmutableProductBackend(createSetIdFileSystem());
    const metadataBefore = backend.stat("/bin/tool");
    let coercions = 0;
    const changingFlags = {
      [Symbol.toPrimitive]() {
        coercions += 1;
        return coercions <= 2 ? OPEN_FLAGS.O_RDONLY : OPEN_FLAGS.O_TRUNC;
      },
    } as unknown as number;
    const opened = backend.open("/bin/tool", changingFlags, 0);
    backend.close(opened);
    const metadataAfter = backend.stat("/bin/tool");
    const readHandle = backend.open("/bin/tool", OPEN_FLAGS.O_RDONLY, 0);
    const bytes = new Uint8Array(4);
    const bytesRead = backend.read(
      readHandle,
      bytes,
      0,
      bytes.byteLength,
    );
    backend.close(readHandle);

    expect(metadataAfter).toEqual(metadataBefore);
    expect(bytesRead).toBe(4);
    expect(Array.from(bytes)).toEqual([0, 97, 115, 109]);
    expect(coercions).toBe(1);
  });

  it("rejects non-integer values for guarded numeric inputs", () => {
    const backend = createImmutableProductBackend(createSetIdFileSystem());
    let invalidFlagHandle: number | undefined;
    let openError: unknown;
    let accessError: unknown;

    try {
      invalidFlagHandle = backend.open("/bin/tool", 0.5, 0);
    } catch (error) {
      openError = error;
    } finally {
      if (invalidFlagHandle !== undefined) backend.close(invalidFlagHandle);
    }
    try {
      backend.access("/bin/tool", 0.5);
    } catch (error) {
      accessError = error;
    }

    expect(openError).toBeInstanceOf(TypeError);
    expect(accessError).toBeInstanceOf(TypeError);
  });

  it("keeps trusted directory and pathconf results independent from generated tables", () => {
    const backend = createImmutableProductBackend(createSetIdFileSystem());
    const tableEntries = [
      [FILE_MODES, "S_IFMT"],
      [FILE_MODES, "S_IFREG"],
      [DIRENT_TYPES, "DT_UNKNOWN"],
      [DIRENT_TYPES, "DT_REG"],
      [PATHCONF_NAMES, "ASYNC_IO"],
    ] as const;
    const descriptors = tableEntries.map(([table, key]) => [
      table,
      key,
      Object.getOwnPropertyDescriptor(table, key)!,
    ] as const);
    let pathconfResult: number | null | undefined;
    let fpathconfResult: number | null | undefined;
    let toolType: number | undefined;
    const fileHandle = backend.open("/bin/tool", OPEN_FLAGS.O_RDONLY, 0);
    const directoryHandle = backend.opendir("/bin");

    try {
      (FILE_MODES as unknown as Record<string, number>).S_IFMT = 0;
      (FILE_MODES as unknown as Record<string, number>).S_IFREG = 0;
      (DIRENT_TYPES as unknown as Record<string, number>).DT_UNKNOWN = 99;
      (DIRENT_TYPES as unknown as Record<string, number>).DT_REG = 99;
      (PATHCONF_NAMES as unknown as Record<string, number>).ASYNC_IO = 999;
      pathconfResult = backend.pathconf("/bin/tool", 10);
      fpathconfResult = backend.fpathconf(fileHandle, 10);
      for (;;) {
        const entry = backend.readdir(directoryHandle);
        if (!entry) break;
        if (entry.name === "tool") toolType = entry.type;
      }
    } finally {
      for (const [table, key, descriptor] of descriptors) {
        Object.defineProperty(table, key, descriptor);
      }
      backend.closedir(directoryHandle);
      backend.close(fileHandle);
    }

    expect(pathconfResult).toBe(1);
    expect(fpathconfResult).toBe(1);
    expect(toolType).toBe(8);
  });

  it("retains the exact open generation through rename and unlink", () => {
    const source = createSetIdFileSystem();
    const backend = createImmutableProductBackend(source);
    const vfs = new VirtualPlatformIO(
      [{
        mountPoint: "/",
        backend,
        readonly: true,
        setIdCapability: TRUSTED_ROOT_PRODUCT,
      }],
      new NodeTimeProvider(),
    );
    const handle = vfs.open("/bin/tool", OPEN_FLAGS.O_RDONLY, 0);
    const before = vfs.fstat(handle);
    const identity = vfs.fileHandleIdentity!(
      handle,
      BigInt(before.dev),
      BigInt(before.ino),
    );

    source.rename("/bin/tool", "/bin/renamed");
    source.unlink("/bin/renamed");

    const after = vfs.fstat(handle);
    expect(after.ino).toBe(before.ino);
    expect(vfs.fileHandleIdentity!(
      handle,
      BigInt(after.dev),
      BigInt(after.ino),
    )).toBe(identity);
    expect(vfs.read(handle, new Uint8Array(4), 0, 4)).toBe(4);
    vfs.close(handle);
  });

  it("rejects guest mutation through the trusted backend", () => {
    const backend = createImmutableProductBackend(createSetIdFileSystem());

    expect(() => backend.open(
      "/bin/tool",
      OPEN_FLAGS.O_WRONLY | OPEN_FLAGS.O_TRUNC,
      0,
    )).toThrow(/EROFS/);
    expect(() => backend.unlink("/bin/tool")).toThrow(/EROFS/);
    expect(
      (backend as unknown as Record<string, unknown>).createFileWithOwner,
    ).toBeUndefined();
    expect(
      (backend as unknown as Record<string, unknown>).fs,
    ).toBeUndefined();
    expect(Reflect.ownKeys(backend)).toEqual([]);
  });
});
