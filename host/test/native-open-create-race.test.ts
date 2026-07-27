import { afterEach, describe, expect, it, vi } from "vitest";

const openRace = vi.hoisted(() => ({
  armedPath: null as string | null,
  nativeMode: 0o640,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const openSync = ((...args: Parameters<typeof actual.openSync>) => {
    const candidate = args[0];
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
    return actual.openSync(...args);
  }) as typeof actual.openSync;

  return {
    ...actual,
    openSync,
  };
});

import {
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodePlatformIO } from "../src/platform/node";
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
  fstat(handle: number): StatResult;
  stat(path: string): StatResult;
  lstat(path: string): StatResult;
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
