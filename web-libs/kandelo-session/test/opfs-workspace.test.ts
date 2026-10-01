import { describe, expect, it } from "vitest";

import type { VfsTreeEntry } from "../src/kernel-host";
import {
  deleteWorkspace,
  opfsWorkspaceLockName,
  writeTreeIntoWorkspace,
  type WorkspaceDirectory,
  type WorkspaceFile,
} from "../src/opfs-workspace";

type FakeEntry = FakeDirectory | Uint8Array;

class FakeFile implements WorkspaceFile {
  constructor(private readonly store: (bytes: Uint8Array) => void) {}
  async createWritable() {
    const chunks: Uint8Array[] = [];
    return {
      write: async (data: Uint8Array<ArrayBuffer>) => {
        chunks.push(Uint8Array.from(data));
      },
      close: async () => {
        const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
        const joined = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          joined.set(chunk, offset);
          offset += chunk.byteLength;
        }
        this.store(joined);
      },
    };
  }
}

class FakeDirectory implements WorkspaceDirectory {
  readonly entries = new Map<string, FakeEntry>();

  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    const existing = this.entries.get(name);
    if (existing instanceof FakeDirectory) return existing;
    if (existing !== undefined) throw typeMismatch();
    if (!options?.create) throw notFound();
    const created = new FakeDirectory();
    this.entries.set(name, created);
    return created;
  }

  async getFileHandle(name: string, options?: { create?: boolean }) {
    const existing = this.entries.get(name);
    if (existing instanceof FakeDirectory) throw typeMismatch();
    if (existing === undefined && !options?.create) throw notFound();
    return new FakeFile((bytes) => this.entries.set(name, bytes));
  }

  async removeEntry(name: string, options?: { recursive?: boolean }) {
    const existing = this.entries.get(name);
    if (existing === undefined) throw notFound();
    if (existing instanceof FakeDirectory && existing.entries.size > 0 && !options?.recursive) {
      throw new DOMException("directory not empty", "InvalidModificationError");
    }
    this.entries.delete(name);
  }
}

function notFound(): DOMException {
  return new DOMException("not found", "NotFoundError");
}

function typeMismatch(): DOMException {
  return new DOMException("type mismatch", "TypeMismatchError");
}

const text = (value: string) => new TextEncoder().encode(value);

const HOME: VfsTreeEntry[] = [
  { path: ".bash_history", kind: "file", mode: 0o600, bytes: text("ls\n") },
  { path: "empty", kind: "directory", mode: 0o755 },
  { path: "fifo", kind: "other", mode: 0o644 },
  { path: "hello.txt", kind: "file", mode: 0o644, bytes: text("world\n") },
  { path: "notes", kind: "directory", mode: 0o700 },
  { path: "notes/foo.md", kind: "file", mode: 0o600, bytes: text("foo") },
  { path: "notes/link", kind: "symlink", mode: 0o777, target: "../hello.txt" },
];

const decode = (bytes: FakeEntry | undefined) =>
  bytes instanceof Uint8Array ? new TextDecoder().decode(bytes) : undefined;

describe("writeTreeIntoWorkspace", () => {
  it("writes regular files and directories, and reports what it cannot hold", async () => {
    const workspace = new FakeDirectory();
    const report = await writeTreeIntoWorkspace(HOME, workspace);

    expect(report).toEqual({
      files: 3,
      directories: 2,
      skipped: [
        { path: "fifo", kind: "other" },
        { path: "notes/link", kind: "symlink" },
      ],
    });
    expect(decode(workspace.entries.get("hello.txt"))).toBe("world\n");
    expect(decode(workspace.entries.get(".bash_history"))).toBe("ls\n");
    const notes = await workspace.getDirectoryHandle("notes");
    expect(decode(notes.entries.get("foo.md"))).toBe("foo");
    expect(notes.entries.has("link")).toBe(false);
    expect((await workspace.getDirectoryHandle("empty")).entries.size).toBe(0);
  });

  it("writes an empty tree as nothing", async () => {
    const workspace = new FakeDirectory();
    expect(await writeTreeIntoWorkspace([], workspace))
      .toEqual({ files: 0, directories: 0, skipped: [] });
    expect(workspace.entries.size).toBe(0);
  });

  it("refuses a file whose directory was not listed first", async () => {
    const orphan: VfsTreeEntry[] = [
      { path: "notes/foo.md", kind: "file", mode: 0o600, bytes: text("foo") },
    ];
    await expect(writeTreeIntoWorkspace(orphan, new FakeDirectory()))
      .rejects.toThrow(/before its directory/);
  });

  it("surfaces a write failure instead of finishing quietly", async () => {
    const failing = {
      ...new FakeDirectory(),
      getFileHandle: async () => {
        throw new DOMException("quota", "QuotaExceededError");
      },
    } as unknown as WorkspaceDirectory;
    await expect(writeTreeIntoWorkspace(HOME, failing)).rejects.toThrow("quota");
  });
});

describe("deleteWorkspace", () => {
  it("removes the named workspace with everything in it", async () => {
    const container = new FakeDirectory();
    const workspace = await container.getDirectoryHandle("foo", { create: true });
    await writeTreeIntoWorkspace(HOME, workspace);
    await deleteWorkspace(container, "foo");
    expect(container.entries.has("foo")).toBe(false);
  });

  it("treats a workspace already gone as deleted", async () => {
    await expect(deleteWorkspace(new FakeDirectory(), "foo")).resolves.toBeUndefined();
  });

  it("surfaces any other failure", async () => {
    const container = {
      ...new FakeDirectory(),
      removeEntry: async () => {
        throw new DOMException("busy", "NoModificationAllowedError");
      },
    } as unknown as WorkspaceDirectory;
    await expect(deleteWorkspace(container, "foo")).rejects.toThrow("busy");
  });
});

describe("opfsWorkspaceLockName", () => {
  it("names the lock the host takes for a boot", () => {
    expect(opfsWorkspaceLockName("foo")).toBe("kandelo-opfs-workspace:foo");
  });
});
