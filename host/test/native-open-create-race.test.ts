import { afterEach, describe, expect, it, vi } from "vitest";

const openRace = vi.hoisted(() => ({
  armedPath: null as string | null,
  replacement: null as null | {
    path: string;
    retainedPath: string;
    contents: string;
    nativeMode: number;
  },
  afterReplacement: null as null | (() => void),
  failNextFstat: false,
  nativeMode: 0o640,
  captureCompanionOpens: false,
  captureDescriptors: false,
  companionAttempts: [] as Array<"proc" | "path">,
  companionFailures: [] as Array<{
    strategy: "proc" | "path";
    code: "EACCES" | "EROFS" | "EMFILE" | "ENFILE" | "ENOENT";
    errno: number;
  }>,
  companionRedirectPath: null as string | null,
  openedDescriptors: [] as number[],
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const openSync = ((...args: Parameters<typeof actual.openSync>) => {
    const candidate = args[0];
    if (
      openRace.replacement !== null
      && candidate === openRace.replacement.path
    ) {
      const replacement = openRace.replacement;
      openRace.replacement = null;
      actual.renameSync(replacement.path, replacement.retainedPath);
      actual.writeFileSync(replacement.path, replacement.contents, {
        flag: "wx",
        mode: replacement.nativeMode,
      });
      actual.chmodSync(replacement.path, replacement.nativeMode);
      openRace.afterReplacement?.();
    }
    if (
      openRace.armedPath !== null
      && candidate === openRace.armedPath
    ) {
      const racedPath = openRace.armedPath;
      openRace.armedPath = null;
      actual.writeFileSync(racedPath, "racer", {
        flag: "wx",
        mode: openRace.nativeMode,
      });
    }
    const numericFlags = typeof args[1] === "number" ? args[1] : 0;
    const writeOnly = (numericFlags & 0x3) === 0x1;
    if (openRace.captureCompanionOpens && writeOnly) {
      const candidateText = String(candidate);
      const strategy = candidateText.startsWith("/proc/self/fd/")
        ? "proc"
        : "path";
      openRace.companionAttempts.push(strategy);
      const failureIndex = openRace.companionFailures.findIndex(
        (failure) => failure.strategy === strategy,
      );
      if (failureIndex >= 0) {
        const [failure] = openRace.companionFailures.splice(failureIndex, 1);
        throw Object.assign(
          new Error(`${failure.code}: injected companion open failure`),
          {
            code: failure.code,
            errno: failure.errno,
            syscall: "open",
            path: candidateText,
          },
        );
      }
      if (openRace.companionRedirectPath !== null) {
        const fd = actual.openSync(openRace.companionRedirectPath, numericFlags);
        if (openRace.captureDescriptors) openRace.openedDescriptors.push(fd);
        return fd;
      }
    }
    const fd = actual.openSync(...args);
    if (openRace.captureDescriptors) openRace.openedDescriptors.push(fd);
    return fd;
  }) as typeof actual.openSync;

  return {
    ...actual,
    fstatSync: ((...args: Parameters<typeof actual.fstatSync>) => {
      if (openRace.failNextFstat) {
        openRace.failNextFstat = false;
        throw Object.assign(new Error("injected exact-handle stat failure"), {
          code: "EIO",
        });
      }
      return actual.fstatSync(...args);
    }) as typeof actual.fstatSync,
    openSync,
  };
});

import {
  fstatSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodePlatformIO } from "../src/platform/node";
import { NativePositionedWriteHandles } from "../src/native-positioned-write";
import { NativeMetadataOverlay } from "../src/platform/native-metadata";
import type { StatResult } from "../src/types";
import { HostFileSystem } from "../src/vfs/host-fs";

const O_RDWR = 0o2;
const O_CREAT = 0o100;
const O_EXCL = 0o200;
const O_TRUNC = 0o1000;
const O_NOFOLLOW = 0o400000;
const PERMISSION_MASK = 0o777;

interface OpenBackend {
  open(path: string, flags: number, mode: number): number;
  close(handle: number): number;
  chmod(path: string, mode: number): void;
  chown(path: string, uid: number, gid: number): void;
  ftruncate(handle: number, length: number): void;
  fstat(handle: number): StatResult;
  stat(path: string): StatResult;
  lstat(path: string): StatResult;
  write(
    handle: number,
    buffer: Uint8Array,
    offset: number | null,
    length: number,
  ): number;
}

interface BackendCase {
  backend: OpenBackend;
  guestPath: string;
  nativePath: string;
  guestSibling(name: string): string;
  nativeSibling(name: string): string;
}

const roots: string[] = [];

afterEach(() => {
  openRace.armedPath = null;
  openRace.replacement = null;
  openRace.afterReplacement = null;
  openRace.failNextFstat = false;
  openRace.captureCompanionOpens = false;
  openRace.captureDescriptors = false;
  openRace.companionAttempts.length = 0;
  openRace.companionFailures.length = 0;
  openRace.companionRedirectPath = null;
  openRace.openedDescriptors.length = 0;
  vi.restoreAllMocks();
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

function withUmask<T>(mask: number, fn: () => T): T {
  const previous = process.umask(mask);
  try {
    return fn();
  } finally {
    process.umask(previous);
  }
}

function makeRoot(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

function withProcessPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  if (descriptor === undefined) throw new Error("process.platform missing");
  Object.defineProperty(process, "platform", {
    ...descriptor,
    value: platform,
  });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
}

const COMPANION_ERRNOS = [
  ["EACCES", -13],
  ["EROFS", -30],
  ["EMFILE", -24],
  ["ENFILE", -23],
] as const;

function expectDescriptorsClosed(descriptors: readonly number[]): void {
  for (const descriptor of descriptors) {
    expect(() => fstatSync(descriptor)).toThrow(/EBADF|bad file descriptor/i);
  }
}

function expectReadOnlyTruncateFailure(
  c: BackendCase,
  code: string,
  expectedAttempts: ReadonlyArray<"proc" | "path">,
): void {
  const contents = "retain bytes after companion failure";
  writeFileSync(c.nativePath, contents);
  c.backend.chown(c.guestPath, 1234, 5678);
  c.backend.chmod(c.guestPath, 0o6755);
  openRace.captureDescriptors = true;

  let returnedHandle: number | null = null;
  let failure: unknown;
  try {
    returnedHandle = c.backend.open(c.guestPath, O_TRUNC, 0);
  } catch (error) {
    failure = error;
  }
  if (returnedHandle !== null) c.backend.close(returnedHandle);
  const transactionDescriptors = [...openRace.openedDescriptors];
  openRace.captureDescriptors = false;

  expect(failure).toBeInstanceOf(Error);
  expect(failure).toMatchObject({ code });
  expect(failure).not.toHaveProperty("cause");
  expect(failure).not.toHaveProperty("path");
  expect(failure).not.toHaveProperty("syscall");
  expect(openRace.companionAttempts).toEqual(expectedAttempts);
  expect(readFileSync(c.nativePath, "utf8")).toBe(contents);
  expect(c.backend.stat(c.guestPath)).toMatchObject({
    size: contents.length,
    uid: 1234,
    gid: 5678,
  });
  expect(c.backend.stat(c.guestPath).mode & 0o7777).toBe(0o6755);
  expectDescriptorsClosed(transactionDescriptors);

  const probe = c.backend.open(c.guestPath, 0, 0);
  try {
    expect(() =>
      c.backend.write(probe, new Uint8Array([0x78]), null, 1)
    ).toThrow(/EBADF|bad file descriptor|invalid argument/i);
  } finally {
    c.backend.close(probe);
  }
}

const backendFactories: Array<[string, () => BackendCase]> = [
  [
    "HostFileSystem",
    () => {
      const root = makeRoot("kandelo-host-fs-create-race-");
      return {
        backend: new HostFileSystem(root),
        guestPath: "/raced",
        nativePath: join(root, "raced"),
        guestSibling: (name) => `/${name}`,
        nativeSibling: (name) => join(root, name),
      };
    },
  ],
  [
    "NodePlatformIO",
    () => {
      const root = makeRoot("kandelo-node-platform-create-race-");
      const nativePath = join(root, "raced");
      return {
        backend: new NodePlatformIO() as OpenBackend,
        guestPath: nativePath,
        nativePath,
        guestSibling: (name) => join(root, name),
        nativeSibling: (name) => join(root, name),
      };
    },
  ],
];

describe.each(backendFactories)("%s O_CREAT transaction", (_name, makeCase) => {
  it("does not chmod or install create metadata on a race winner", () => {
    const c = makeCase();
    openRace.armedPath = c.nativePath;

    const fd = withUmask(0, () =>
      c.backend.open(c.guestPath, O_RDWR | O_CREAT, 0),
    );
    try {
      expect(c.backend.fstat(fd).mode & PERMISSION_MASK).toBe(0o640);
    } finally {
      c.backend.close(fd);
    }

    expect(c.backend.stat(c.guestPath).mode & PERMISSION_MASK).toBe(0o640);
    expect(statSync(c.nativePath).mode & PERMISSION_MASK).toBe(0o640);
    expect(readFileSync(c.nativePath, "utf8")).toBe("racer");
  });

  it("retains O_TRUNC when opening the race winner", () => {
    const c = makeCase();
    openRace.armedPath = c.nativePath;

    const fd = withUmask(0, () =>
      c.backend.open(c.guestPath, O_RDWR | O_CREAT | O_TRUNC, 0),
    );
    try {
      expect(c.backend.fstat(fd).mode & PERMISSION_MASK).toBe(0o640);
    } finally {
      c.backend.close(fd);
    }

    expect(c.backend.stat(c.guestPath).mode & PERMISSION_MASK).toBe(0o640);
    expect(statSync(c.nativePath).mode & PERMISSION_MASK).toBe(0o640);
    expect(readFileSync(c.nativePath)).toHaveLength(0);
  });

  it("preserves expected missing-path behavior with and without O_CREAT", () => {
    const c = makeCase();
    expect(() => c.backend.open(c.guestPath, O_RDWR | O_TRUNC, 0))
      .toThrow(/ENOENT/);

    const fd = c.backend.open(c.guestPath, O_RDWR | O_CREAT | O_TRUNC, 0o6755);
    try {
      expect(c.backend.fstat(fd).mode & 0o7777).toBe(0o6755);
    } finally {
      c.backend.close(fd);
    }
    expect(readFileSync(c.nativePath)).toHaveLength(0);
    expect(c.backend.stat(c.guestPath).mode & 0o7777).toBe(0o6755);
  });

  it("invalidates only the non-empty inode selected by the open race", () => {
    const c = makeCase();
    const retainedPath = c.nativeSibling("retained-nonempty");
    const retainedGuestPath = c.guestSibling("retained-nonempty");
    writeFileSync(c.nativePath, "original");
    c.backend.chmod(c.guestPath, 0o6755);
    openRace.replacement = {
      path: c.nativePath,
      retainedPath,
      contents: "replacement",
      nativeMode: 0o6755,
    };
    openRace.afterReplacement = () => c.backend.chmod(c.guestPath, 0o6755);

    const fd = c.backend.open(c.guestPath, O_RDWR | O_TRUNC, 0);
    try {
      expect(c.backend.fstat(fd).mode & 0o7777).toBe(0o755);
      expect(c.backend.stat(c.guestPath).mode & 0o7777).toBe(0o755);
    } finally {
      c.backend.close(fd);
    }

    expect(readFileSync(c.nativePath)).toHaveLength(0);
    expect(readFileSync(retainedPath, "utf8")).toBe("original");
    expect(c.backend.stat(retainedGuestPath).mode & 0o7777).toBe(0o6755);
  });

  it("does not invalidate an already-empty inode that replaces the path before open", () => {
    const c = makeCase();
    const retainedPath = c.nativeSibling("retained");
    const retainedGuestPath = c.guestSibling("retained");
    writeFileSync(c.nativePath, "original");
    c.backend.chmod(c.guestPath, 0o6755);
    openRace.replacement = {
      path: c.nativePath,
      retainedPath,
      contents: "",
      nativeMode: 0o6755,
    };
    openRace.afterReplacement = () => c.backend.chmod(c.guestPath, 0o6755);

    const fd = c.backend.open(c.guestPath, O_RDWR | O_TRUNC, 0);
    try {
      expect(c.backend.fstat(fd).mode & 0o7777).toBe(0o6755);
      expect(c.backend.stat(c.guestPath).mode & 0o7777).toBe(0o6755);
    } finally {
      c.backend.close(fd);
    }

    expect(readFileSync(c.nativePath)).toHaveLength(0);
    expect(readFileSync(retainedPath, "utf8")).toBe("original");
    expect(c.backend.stat(retainedGuestPath).mode & 0o7777).toBe(0o6755);
  });

  it("does not truncate when positioned-route setup fails", () => {
    const c = makeCase();
    writeFileSync(c.nativePath, "route-setup");
    c.backend.chmod(c.guestPath, 0o6755);
    vi.spyOn(NativePositionedWriteHandles.prototype, "register")
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("injected route setup failure"), {
          code: "EOPNOTSUPP",
        });
      });

    expect(() => c.backend.open(c.guestPath, O_RDWR | O_TRUNC, 0))
      .toThrow(/injected route setup failure/);
    expect(readFileSync(c.nativePath, "utf8")).toBe("route-setup");
    expect(c.backend.stat(c.guestPath).mode & 0o7777).toBe(0o6755);
  });

  it("does not truncate when a read-only truncate route cannot be established", () => {
    const c = makeCase();
    writeFileSync(c.nativePath, "read-only-route-setup");
    c.backend.chmod(c.guestPath, 0o6755);
    vi.spyOn(NativePositionedWriteHandles.prototype, "forTruncate")
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("injected truncate route failure"), {
          code: "EOPNOTSUPP",
        });
      });

    expect(() => c.backend.open(c.guestPath, O_TRUNC, 0))
      .toThrow(/injected truncate route failure/);
    expect(readFileSync(c.nativePath, "utf8")).toBe("read-only-route-setup");
    expect(c.backend.stat(c.guestPath).mode & 0o7777).toBe(0o6755);
  });

  it.each(COMPANION_ERRNOS)(
    "preserves %s from the authoritative fallback-path open",
    (code, errno) => {
      const c = makeCase();
      openRace.captureCompanionOpens = true;
      openRace.companionFailures.push(
        { strategy: "proc", code: "ENOENT", errno: -2 },
        { strategy: "path", code, errno },
      );

      withProcessPlatform("linux", () => {
        expectReadOnlyTruncateFailure(c, code, ["proc", "path"]);
      });
    },
  );

  it.each(COMPANION_ERRNOS)(
    "does not try a second strategy after authoritative %s",
    (code, errno) => {
      const c = makeCase();
      openRace.captureCompanionOpens = true;
      openRace.companionFailures.push({ strategy: "proc", code, errno });

      withProcessPlatform("linux", () => {
        expectReadOnlyTruncateFailure(c, code, ["proc"]);
      });
    },
  );

  it("falls back only when the live-fd strategy is unavailable", () => {
    const c = makeCase();
    writeFileSync(c.nativePath, "fallback bytes");
    c.backend.chmod(c.guestPath, 0o6755);
    openRace.captureCompanionOpens = true;
    openRace.captureDescriptors = true;
    openRace.companionFailures.push({
      strategy: "proc",
      code: "ENOENT",
      errno: -2,
    });

    withProcessPlatform("linux", () => {
      const fd = c.backend.open(c.guestPath, O_TRUNC, 0);
      try {
        expect(openRace.companionAttempts).toEqual(["proc", "path"]);
        expect(c.backend.fstat(fd).size).toBe(0);
        expect(c.backend.fstat(fd).mode & 0o7777).toBe(0o755);
        expect(() =>
          c.backend.write(fd, new Uint8Array([0x78]), null, 1)
        ).toThrow(/EBADF|bad file descriptor|invalid argument/i);
      } finally {
        c.backend.close(fd);
      }
    });
    expectDescriptorsClosed(openRace.openedDescriptors);
  });

  it("closes a mismatched companion and primary before returning EIO", () => {
    const c = makeCase();
    const otherPath = c.nativeSibling("wrong-companion");
    writeFileSync(c.nativePath, "selected bytes");
    writeFileSync(otherPath, "other bytes");
    c.backend.chown(c.guestPath, 1234, 5678);
    c.backend.chmod(c.guestPath, 0o6755);
    openRace.captureCompanionOpens = true;
    openRace.captureDescriptors = true;
    openRace.companionRedirectPath = otherPath;

    withProcessPlatform("darwin", () => {
      expectReadOnlyTruncateFailure(c, "EIO", ["path"]);
    });
    expect(readFileSync(otherPath, "utf8")).toBe("other bytes");
  });

  it("propagates exact-handle stat failure before truncating", () => {
    const c = makeCase();
    writeFileSync(c.nativePath, "stat-setup");
    c.backend.chmod(c.guestPath, 0o6755);
    openRace.failNextFstat = true;

    expect(() => c.backend.open(c.guestPath, O_RDWR | O_TRUNC, 0))
      .toThrow(/injected exact-handle stat failure/);
    expect(readFileSync(c.nativePath, "utf8")).toBe("stat-setup");
    expect(c.backend.stat(c.guestPath).mode & 0o7777).toBe(0o6755);
  });

  it("does not truncate when metadata preparation fails", () => {
    const c = makeCase();
    writeFileSync(c.nativePath, "metadata-setup");
    c.backend.chmod(c.guestPath, 0o6755);
    vi.spyOn(NativeMetadataOverlay.prototype, "prepareNativeContentChange")
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("injected metadata setup failure"), {
          code: "ENOMEM",
        });
      });

    expect(() => c.backend.open(c.guestPath, O_RDWR | O_TRUNC, 0))
      .toThrow(/injected metadata setup failure/);
    expect(readFileSync(c.nativePath, "utf8")).toBe("metadata-setup");
    expect(c.backend.stat(c.guestPath).mode & 0o7777).toBe(0o6755);
  });

  it("does not ftruncate when exact-handle metadata setup fails", () => {
    const c = makeCase();
    writeFileSync(c.nativePath, "ftruncate-setup");
    c.backend.chmod(c.guestPath, 0o6755);
    const fd = c.backend.open(c.guestPath, O_RDWR, 0);
    try {
      vi.spyOn(NativeMetadataOverlay.prototype, "prepareNativeContentChange")
        .mockImplementationOnce(() => {
          throw Object.assign(new Error("injected ftruncate setup failure"), {
            code: "ENOMEM",
          });
        });

      expect(() => c.backend.ftruncate(fd, 0))
        .toThrow(/injected ftruncate setup failure/);
      expect(readFileSync(c.nativePath, "utf8")).toBe("ftruncate-setup");
      expect(c.backend.fstat(fd).mode & 0o7777).toBe(0o6755);
      expect(c.backend.stat(c.guestPath).mode & 0o7777).toBe(0o6755);
    } finally {
      c.backend.close(fd);
    }
  });

  it("retains O_EXCL when another actor wins creation", () => {
    const c = makeCase();
    openRace.armedPath = c.nativePath;

    expect(() =>
      withUmask(0, () =>
        c.backend.open(c.guestPath, O_RDWR | O_CREAT | O_EXCL, 0),
      ),
    ).toThrow(/EEXIST/);

    expect(statSync(c.nativePath).mode & PERMISSION_MASK).toBe(0o640);
    expect(readFileSync(c.nativePath, "utf8")).toBe("racer");
  });

  it("retains O_NOFOLLOW for an existing final symlink", () => {
    const c = makeCase();
    const target = c.nativeSibling("target");
    symlinkSync("target", c.nativePath);

    expect(() =>
      c.backend.open(c.guestPath, O_RDWR | O_CREAT | O_NOFOLLOW, 0o600),
    ).toThrow(/ELOOP/);
    expect(() => statSync(target)).toThrow();
  });

  it("follows a dangling final symlink for ordinary O_CREAT", () => {
    const c = makeCase();
    const target = c.nativeSibling("target");
    const targetGuestPath = c.guestSibling("target");
    const alias = c.nativeSibling("target-alias");
    const aliasGuestPath = c.guestSibling("target-alias");
    symlinkSync("target", c.nativePath);

    const fd = c.backend.open(c.guestPath, O_RDWR | O_CREAT, 0o620);
    c.backend.close(fd);
    linkSync(target, alias);

    expect(statSync(target).mode & PERMISSION_MASK).toBe(0o600);
    expect(c.backend.stat(c.guestPath).mode & PERMISSION_MASK).toBe(0o620);
    const targetStat = c.backend.stat(targetGuestPath);
    const aliasStat = c.backend.stat(aliasGuestPath);
    expect(targetStat.mode & PERMISSION_MASK).toBe(0o620);
    expect(aliasStat.mode & PERMISSION_MASK).toBe(0o620);
    expect(aliasStat.dev).toBe(targetStat.dev);
    expect(aliasStat.ino).toBe(targetStat.ino);
    expect(c.backend.lstat(c.guestPath).mode & PERMISSION_MASK).toBe(
      lstatSync(c.nativePath).mode & PERMISSION_MASK,
    );
  });
});
