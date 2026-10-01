// Persistent machines — a machine whose home directory is a browser-storage
// workspace, and the list of them this browser profile keeps.
//
// A machine is its boot descriptor plus the `opfs` mount that puts its home
// directory in origin storage. Booting the descriptor again mounts the same
// workspace, so the files come back; the processes do not, because nothing
// here saves them. The list is the browser profile's own: it lives in
// localStorage, the workspaces live in OPFS, and the browser clears both with
// this origin's site data. Neither is synced, verified, or shared by the
// browser.

import { validateBootDescriptor } from "./boot-descriptor";
import type { BootDescriptor, DescriptorMount } from "./kernel-host";
import { MACHINE_NAME_MAX_LENGTH } from "./machine-name";

export const PERSISTENT_MACHINES_STORAGE_KEY = "kandelo.persistent-machines.v1";

/** Mirrors OPFS_WORKSPACE_NAME_PATTERN in host/src/vfs/default-mounts.ts. */
const WORKSPACE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface PersistentMachine {
  /** The OPFS workspace name; never shown, never changes. */
  id: string;
  name: string;
  /** Boots the machine, home directory mounted on the workspace `id`. */
  descriptor: BootDescriptor;
  /** ISO 8601 instants. */
  createdAt: string;
  openedAt: string;
}

/** The part of `Storage` the registry uses; a Map-backed fake serves tests. */
export interface MachineStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export class PersistentMachineError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "PersistentMachineError";
  }
}

interface StoredMachines {
  version: 1;
  machines: PersistentMachine[];
}

export class PersistentMachineRegistry {
  constructor(
    private readonly storage: MachineStorage,
    private readonly key = PERSISTENT_MACHINES_STORAGE_KEY,
  ) {}

  /** Every saved machine, most recently opened first. */
  list(): PersistentMachine[] {
    return this.read().machines
      .slice()
      .sort((a, b) => b.openedAt.localeCompare(a.openedAt));
  }

  get(id: string): PersistentMachine | null {
    return this.read().machines.find((machine) => machine.id === id) ?? null;
  }

  /** Add a machine, or replace the one with the same id. */
  save(machine: PersistentMachine): void {
    validateMachine(machine);
    const stored = this.read();
    const taken = stored.machines.find(
      (other) => other.id !== machine.id && other.name === machine.name,
    );
    if (taken) {
      throw new PersistentMachineError(
        "E_NAME_TAKEN",
        `another machine is already named ${JSON.stringify(machine.name)}`,
      );
    }
    const machines = stored.machines.filter((other) => other.id !== machine.id);
    machines.push(machine);
    this.write({ version: 1, machines });
  }

  rename(id: string, name: string): PersistentMachine {
    const machine = this.require(id);
    const renamed = { ...machine, name };
    this.save(renamed);
    return renamed;
  }

  /** Record that the machine was opened now. */
  touch(id: string, openedAt = new Date().toISOString()): PersistentMachine {
    const machine = this.require(id);
    const touched = { ...machine, openedAt };
    this.save(touched);
    return touched;
  }

  remove(id: string): void {
    const stored = this.read();
    this.write({
      version: 1,
      machines: stored.machines.filter((machine) => machine.id !== id),
    });
  }

  private require(id: string): PersistentMachine {
    const machine = this.get(id);
    if (!machine) {
      throw new PersistentMachineError("E_UNKNOWN_MACHINE", `no saved machine ${id}`);
    }
    return machine;
  }

  private read(): StoredMachines {
    const raw = this.storage.getItem(this.key);
    if (raw === null) return { version: 1, machines: [] };
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new PersistentMachineError(
        "E_STORAGE_CORRUPT",
        `the saved machine list is not JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (
      !parsed || typeof parsed !== "object" ||
      (parsed as { version?: unknown }).version !== 1 ||
      !Array.isArray((parsed as { machines?: unknown }).machines)
    ) {
      throw new PersistentMachineError(
        "E_STORAGE_CORRUPT",
        "the saved machine list has an unknown layout",
      );
    }
    const machines = (parsed as { machines: unknown[] }).machines;
    for (const machine of machines) validateMachine(machine);
    return { version: 1, machines: machines as PersistentMachine[] };
  }

  private write(stored: StoredMachines): void {
    this.storage.setItem(this.key, JSON.stringify(stored));
  }
}

function validateMachine(value: unknown): asserts value is PersistentMachine {
  if (!value || typeof value !== "object") {
    throw new PersistentMachineError("E_MACHINE", "saved machine is not an object");
  }
  const machine = value as Record<string, unknown>;
  if (typeof machine.id !== "string" || !WORKSPACE_NAME_RE.test(machine.id)) {
    throw new PersistentMachineError(
      "E_MACHINE_ID",
      `saved machine id is not a workspace name: ${JSON.stringify(machine.id)}`,
    );
  }
  if (
    typeof machine.name !== "string" || machine.name.trim() === "" ||
    machine.name.length > MACHINE_NAME_MAX_LENGTH
  ) {
    throw new PersistentMachineError(
      "E_MACHINE_NAME",
      `saved machine ${machine.id} has no usable name`,
    );
  }
  for (const field of ["createdAt", "openedAt"] as const) {
    if (typeof machine[field] !== "string" || Number.isNaN(Date.parse(machine[field]))) {
      throw new PersistentMachineError(
        "E_MACHINE_TIME",
        `saved machine ${machine.id} has no ${field} instant`,
      );
    }
  }
  validateBootDescriptor(machine.descriptor);
  if (persistentMachineIdOf(machine.descriptor) !== machine.id) {
    throw new PersistentMachineError(
      "E_MACHINE_WORKSPACE",
      `saved machine ${machine.id} does not mount its own workspace at home`,
    );
  }
}

/** The home directory a descriptor boots into, from its `HOME`. */
export function homeDirectoryOf(descriptor: BootDescriptor): string {
  const home = descriptor.boot.env.HOME;
  if (typeof home !== "string" || !home.startsWith("/") || home === "/") {
    throw new PersistentMachineError(
      "E_NO_HOME",
      `descriptor ${descriptor.id} sets no home directory to persist`,
    );
  }
  return home;
}

/** The workspace a descriptor mounts at its home directory, or null. */
export function persistentMachineIdOf(descriptor: BootDescriptor): string | null {
  const home = descriptor.boot.env.HOME;
  const mount = descriptor.mounts.find(
    (m) => m.source === "opfs" && m.path === home,
  );
  return typeof mount?.name === "string" ? mount.name : null;
}

/** `descriptor` with its home directory on the workspace `id`. */
export function persistentMachineDescriptor(
  descriptor: BootDescriptor,
  id: string,
): BootDescriptor {
  const home = homeDirectoryOf(descriptor);
  const workspace: DescriptorMount = { path: home, source: "opfs", name: id };
  return {
    ...descriptor,
    mounts: [...withoutWorkspaces(descriptor.mounts), workspace],
    caps: { ...descriptor.caps, persistence: true },
  };
}

/**
 * `descriptor` with no workspace: what a share link carries, because a
 * workspace name means nothing in another browser, and what a copy of a
 * persistent machine boots on memory.
 */
export function ephemeralDescriptor(descriptor: BootDescriptor): BootDescriptor {
  const { caps, ...rest } = descriptor;
  const { persistence: _persistence, ...otherCaps } = caps ?? {};
  return {
    ...rest,
    mounts: withoutWorkspaces(descriptor.mounts),
    ...(Object.keys(otherCaps).length === 0 ? {} : { caps: otherCaps }),
  };
}

function withoutWorkspaces(mounts: DescriptorMount[]): DescriptorMount[] {
  return mounts.filter((m) => m.source !== "opfs").map((m) => ({ ...m }));
}
