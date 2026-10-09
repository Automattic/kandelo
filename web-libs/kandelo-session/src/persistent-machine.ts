// Persistent machines — a machine whose home directory this browser profile
// keeps, and the list of them.
//
// A machine is its boot descriptor plus the home directory its files belong
// to. The files themselves live in IndexedDB under the machine's id (see
// saved-machine.ts); booting the descriptor with them as the home's seed brings
// the files back, and the processes do not, because nothing here saves them.
// The list is the browser profile's own: it lives in localStorage, and the
// browser clears it and the files with this origin's site data. Neither is
// synced, verified, or shared by the browser.

import { canonicalAbsolutePath, validateBootDescriptor } from "./boot-descriptor";
import type { BootDescriptor } from "./kernel-host";
import { MACHINE_NAME_MAX_LENGTH } from "./machine-name";

export const PERSISTENT_MACHINES_STORAGE_KEY = "kandelo.persistent-machines.v1";

const MACHINE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface PersistentMachine {
  /** Names the machine's files in IndexedDB; never shown, never changes. */
  id: string;
  name: string;
  /** The login home directory whose files the machine keeps. */
  home: string;
  /** Boots the machine; mounts no browser storage. */
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
  if (typeof machine.id !== "string" || !MACHINE_ID_RE.test(machine.id)) {
    throw new PersistentMachineError(
      "E_MACHINE_ID",
      `saved machine id is not a machine id: ${JSON.stringify(machine.id)}`,
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
  if (
    typeof machine.home !== "string" || machine.home === "/" ||
    !canonicalAbsolutePath(machine.home)
  ) {
    throw new PersistentMachineError(
      "E_MACHINE_HOME",
      `saved machine ${machine.id} has no canonical home directory: ${JSON.stringify(machine.home)}`,
    );
  }
  validateBootDescriptor(machine.descriptor);
  if (machine.descriptor.mounts.some((m) => m.source === "opfs")) {
    throw new PersistentMachineError(
      "E_MACHINE_DESCRIPTOR",
      `saved machine ${machine.id} mounts browser storage; its files live in IndexedDB`,
    );
  }
  if (machine.descriptor.boot.inputs !== undefined || machine.descriptor.boot.parameters !== undefined) {
    throw new PersistentMachineError(
      "E_MACHINE_DESCRIPTOR",
      `saved machine ${machine.id} carries a link's boot inputs; a saved machine never runs a link's script`,
    );
  }
}

/**
 * The descriptor a saved machine boots: `ephemeralDescriptor(descriptor)`
 * without the boot inputs and parameters a link may carry. A link's script
 * runs without asking only because the machine it runs in is on memory, so a
 * machine whose files persist never takes one along.
 */
export function savedMachineDescriptor(descriptor: BootDescriptor): BootDescriptor {
  const ephemeral = ephemeralDescriptor(descriptor);
  const { inputs: _inputs, parameters: _parameters, ...boot } = ephemeral.boot;
  return { ...ephemeral, boot };
}

/**
 * `descriptor` with no browser-storage workspace: what a pasted link boots,
 * because a link must never mount this browser's storage.
 */
export function ephemeralDescriptor(descriptor: BootDescriptor): BootDescriptor {
  return {
    ...descriptor,
    mounts: descriptor.mounts.filter((m) => m.source !== "opfs").map((m) => ({ ...m })),
  };
}
