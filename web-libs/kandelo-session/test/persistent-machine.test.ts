import { describe, expect, it } from "vitest";

import { createInlineBootInput } from "../src/boot-inputs";
import type { BootDescriptor } from "../src/kernel-host";
import {
  ephemeralDescriptor,
  PERSISTENT_MACHINES_STORAGE_KEY,
  PersistentMachineError,
  PersistentMachineRegistry,
  savedMachineDescriptor,
  type MachineStorage,
  type PersistentMachine,
} from "../src/persistent-machine";

const SHELL: BootDescriptor = {
  version: 1,
  id: "shell",
  title: "Shell",
  base: "kandelo:shell@abi8",
  runtime: {
    arch: "wasm32",
    kernel: "kernel@local",
    memoryPages: 2048,
    features: ["shared-array-buffer", "pty"],
    time: "real",
  },
  packages: ["bash@local"],
  mounts: [
    { path: "/", source: "image", ref: "shell.vfs@local", readonly: false },
    { path: "/tmp", source: "scratch", ephemeral: true },
  ],
  boot: {
    argv: ["bash", "-l", "-i"],
    cwd: "/home/maker",
    env: { HOME: "/home/maker", PATH: "/usr/bin:/bin" },
    uid: 1000,
    gid: 1000,
  },
  caps: { network: true },
};

const HOME = "/home/maker";
const FOO_ID = "0f5d2e3a-4b6c-4d7e-8f90-a1b2c3d4e5f6";
const BAR_ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

function machine(id: string, name: string, openedAt: string): PersistentMachine {
  return {
    id,
    name,
    home: HOME,
    descriptor: SHELL,
    createdAt: "2026-09-30T10:00:00.000Z",
    openedAt,
  };
}

class MapStorage implements MachineStorage {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
}

describe("ephemeralDescriptor", () => {
  const WORKSPACE = { path: HOME, source: "opfs" as const, name: FOO_ID };

  it("drops every workspace and keeps the rest of the descriptor", () => {
    const desc = ephemeralDescriptor({ ...SHELL, mounts: [...SHELL.mounts, WORKSPACE] });
    expect(desc).toEqual(SHELL);
  });
});

describe("savedMachineDescriptor", () => {
  it("drops a link's boot inputs and parameters along with every workspace", () => {
    const linked: BootDescriptor = {
      ...SHELL,
      mounts: [...SHELL.mounts, { path: HOME, source: "opfs", name: FOO_ID }],
      boot: {
        ...SHELL.boot,
        inputs: [{ id: "script", path: "/run/kandelo/script.sh", source: { kind: "inline", data: "ZWNobyBmb28K" } }],
        parameters: { runScript: "script" },
      },
    } as BootDescriptor;
    const saved = savedMachineDescriptor(linked);
    expect(saved.mounts).toEqual(SHELL.mounts);
    expect(saved.boot).toEqual(SHELL.boot);
  });
});

describe("PersistentMachineRegistry", () => {
  it("starts empty", () => {
    const registry = new PersistentMachineRegistry(new MapStorage());
    expect(registry.list()).toEqual([]);
    expect(registry.get(FOO_ID)).toBeNull();
  });

  it("saves under the storage key and lists most recently opened first", () => {
    const storage = new MapStorage();
    const registry = new PersistentMachineRegistry(storage);
    registry.save(machine(FOO_ID, "foo", "2026-09-30T10:00:00.000Z"));
    registry.save(machine(BAR_ID, "bar", "2026-09-30T11:00:00.000Z"));
    expect(storage.items.has(PERSISTENT_MACHINES_STORAGE_KEY)).toBe(true);
    expect(registry.list().map((m) => m.name)).toEqual(["bar", "foo"]);
  });

  it("replaces a machine saved twice", () => {
    const registry = new PersistentMachineRegistry(new MapStorage());
    registry.save(machine(FOO_ID, "foo", "2026-09-30T10:00:00.000Z"));
    registry.save(machine(FOO_ID, "foo again", "2026-09-30T10:00:00.000Z"));
    expect(registry.list().map((m) => m.name)).toEqual(["foo again"]);
  });

  it("refuses two machines with one name", () => {
    const registry = new PersistentMachineRegistry(new MapStorage());
    registry.save(machine(FOO_ID, "foo", "2026-09-30T10:00:00.000Z"));
    expect(() => registry.save(machine(BAR_ID, "foo", "2026-09-30T10:00:00.000Z")))
      .toThrow(/already named "foo"/);
  });

  it("renames, touches, and removes", () => {
    const registry = new PersistentMachineRegistry(new MapStorage());
    registry.save(machine(FOO_ID, "foo", "2026-09-30T10:00:00.000Z"));
    expect(registry.rename(FOO_ID, "baz").name).toBe("baz");
    expect(registry.touch(FOO_ID, "2026-09-30T12:00:00.000Z").openedAt)
      .toBe("2026-09-30T12:00:00.000Z");
    expect(registry.get(FOO_ID)?.name).toBe("baz");
    registry.remove(FOO_ID);
    expect(registry.list()).toEqual([]);
  });

  it("refuses to rename or touch an unknown machine", () => {
    const registry = new PersistentMachineRegistry(new MapStorage());
    expect(() => registry.rename(FOO_ID, "x")).toThrow(/no saved machine/);
    expect(() => registry.touch(FOO_ID)).toThrow(PersistentMachineError);
  });

  it("refuses a machine whose descriptor mounts browser storage", () => {
    const registry = new PersistentMachineRegistry(new MapStorage());
    const wrong = {
      ...machine(FOO_ID, "foo", "2026-09-30T10:00:00.000Z"),
      descriptor: { ...SHELL, mounts: [...SHELL.mounts, { path: HOME, source: "opfs" as const, name: FOO_ID }] },
    };
    expect(() => registry.save(wrong)).toThrow(/mounts browser storage/);
  });

  it("refuses a machine whose descriptor would run a link's script", async () => {
    const registry = new PersistentMachineRegistry(new MapStorage());
    const scripted = {
      ...machine(FOO_ID, "foo", "2026-09-30T10:00:00.000Z"),
      descriptor: { ...SHELL, boot: { ...SHELL.boot, parameters: { runScript: "script" } } },
    };
    expect(() => registry.save(scripted)).toThrow(/never runs a link's script/);
    const inputs = [await createInlineBootInput({
      id: "script",
      filename: "foo.sh",
      bytes: new TextEncoder().encode("echo foo"),
      compression: "gzip",
    })];
    const carried = {
      ...machine(FOO_ID, "foo", "2026-09-30T10:00:00.000Z"),
      descriptor: { ...SHELL, boot: { ...SHELL.boot, inputs } },
    };
    expect(() => registry.save(carried)).toThrow(/never runs a link's script/);
  });

  it("refuses a home that is not a canonical absolute directory", () => {
    const registry = new PersistentMachineRegistry(new MapStorage());
    for (const home of ["", "/", "home/maker", "/home/maker/", "/home/../root", "/home//maker"]) {
      expect(() => registry.save({ ...machine(FOO_ID, "foo", "2026-09-30T10:00:00.000Z"), home }))
        .toThrow(/no canonical home directory/);
    }
  });

  it("refuses a blank or overlong name and a bad id", () => {
    const registry = new PersistentMachineRegistry(new MapStorage());
    expect(() => registry.save(machine(FOO_ID, "  ", "2026-09-30T10:00:00.000Z")))
      .toThrow(/no usable name/);
    expect(() => registry.save(machine(FOO_ID, "x".repeat(65), "2026-09-30T10:00:00.000Z")))
      .toThrow(/no usable name/);
    expect(() => registry.save(machine("../escape", "foo", "2026-09-30T10:00:00.000Z")))
      .toThrow(/not a machine id/);
  });

  it("fails loudly on a corrupt list instead of showing an empty one", () => {
    const storage = new MapStorage();
    storage.setItem(PERSISTENT_MACHINES_STORAGE_KEY, "{not json");
    expect(() => new PersistentMachineRegistry(storage).list()).toThrow(/not JSON/);
    storage.setItem(PERSISTENT_MACHINES_STORAGE_KEY, JSON.stringify({ version: 2, machines: [] }));
    expect(() => new PersistentMachineRegistry(storage).list()).toThrow(/unknown layout/);
    storage.setItem(
      PERSISTENT_MACHINES_STORAGE_KEY,
      JSON.stringify({ version: 1, machines: [{ id: FOO_ID }] }),
    );
    expect(() => new PersistentMachineRegistry(storage).list()).toThrow(PersistentMachineError);
  });

  it("refuses a record whose instants do not parse", () => {
    const registry = new PersistentMachineRegistry(new MapStorage());
    expect(() => registry.save(machine(FOO_ID, "foo", "yesterday"))).toThrow(/openedAt instant/);
  });
});
