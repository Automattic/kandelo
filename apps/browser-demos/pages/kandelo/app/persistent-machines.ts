// Persistent machines on this page — save the running machine, and open,
// rename, or delete a saved one.
//
// The list lives in this browser profile's localStorage and each machine's
// home directory in its OPFS workspace; the session library owns both shapes.
// This hook is the page's use of them: it reads the running machine's home
// tree through the KernelHost, seeds a workspace with it, reboots the machine
// on that workspace, and keeps the list current across tabs through the
// storage event.
import * as React from "react";
import { useKernelHost, useStatus } from "../kernel-host/react";
import { replaceBareUrl } from "../url-state";
import {
  presentableMachineName,
  randomMachineName,
} from "../../../../../web-libs/kandelo-session/src/machine-name";
import {
  deleteWorkspace,
  openWorkspaceContainer,
  withWorkspaceHeld,
  writeTreeIntoWorkspace,
  type WorkspaceCopyReport,
} from "../../../../../web-libs/kandelo-session/src/opfs-workspace";
import {
  homeDirectoryOf,
  PERSISTENT_MACHINES_STORAGE_KEY,
  PersistentMachineRegistry,
  persistentMachineDescriptor,
  persistentMachineIdOf,
  type PersistentMachine,
} from "../../../../../web-libs/kandelo-session/src/persistent-machine";

export type PersistentMachinesBusy = "saving" | "opening" | "deleting";

export interface PersistentMachines {
  /** Every saved machine, most recently opened first. */
  readonly machines: readonly PersistentMachine[];
  /** Why the list could not be read, or null. A corrupt list is shown, not hidden. */
  readonly listFailure: string | null;
  /** The saved machine this page runs, or null for a machine on memory. */
  readonly current: PersistentMachine | null;
  readonly busy: PersistentMachinesBusy | null;
  /** Why the last action failed, or null. */
  readonly failure: string | null;
  /** What the last save copied, and what it could not. */
  readonly lastSave: WorkspaceCopyReport | null;
  /** Copy the running machine's home directory into a workspace and reboot on it. */
  save(): Promise<void>;
  open(machine: PersistentMachine): Promise<void>;
  rename(id: string, name: string): void;
  /** Delete the workspace and forget the machine. Refused while it runs anywhere. */
  remove(id: string): Promise<void>;
}

export function usePersistentMachines(): PersistentMachines {
  const host = useKernelHost();
  const status = useStatus();
  const registry = React.useMemo(
    () => new PersistentMachineRegistry(window.localStorage),
    [],
  );
  const [version, setVersion] = React.useState(0);
  const [busy, setBusy] = React.useState<PersistentMachinesBusy | null>(null);
  const [failure, setFailure] = React.useState<string | null>(null);
  const [lastSave, setLastSave] = React.useState<WorkspaceCopyReport | null>(null);
  const refresh = React.useCallback(() => setVersion((v) => v + 1), []);

  React.useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === PERSISTENT_MACHINES_STORAGE_KEY) refresh();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [refresh]);

  const { machines, listFailure } = React.useMemo(() => {
    try {
      return { machines: registry.list(), listFailure: null };
    } catch (error) {
      return { machines: [], listFailure: describe(error) };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registry, version]);

  const current = React.useMemo(() => {
    const id = persistentMachineIdOf(host.getBootDescriptor());
    return id === null ? null : machines.find((machine) => machine.id === id) ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, machines, status]);

  const run = React.useCallback(async (
    kind: PersistentMachinesBusy,
    action: () => Promise<void>,
  ) => {
    setBusy(kind);
    setFailure(null);
    try {
      await action();
    } catch (error) {
      setFailure(describe(error));
      throw error;
    } finally {
      setBusy(null);
      refresh();
    }
  }, [refresh]);

  const save = React.useCallback(() => run("saving", async () => {
    const descriptor = host.getBootDescriptor();
    if (persistentMachineIdOf(descriptor) !== null) return;
    const home = homeDirectoryOf(descriptor);
    const id = crypto.randomUUID();
    const name = randomMachineName(registry.list().map((machine) => machine.name));
    const tree = await host.readTree(home);
    const report = await withWorkspaceHeld(id, async () => {
      const container = await openWorkspaceContainer();
      const workspace = await container.getDirectoryHandle(id, { create: true });
      return writeTreeIntoWorkspace(tree, workspace);
    });
    const now = new Date().toISOString();
    const machine: PersistentMachine = {
      id,
      name,
      descriptor: persistentMachineDescriptor(descriptor, id),
      createdAt: now,
      openedAt: now,
    };
    registry.save(machine);
    setLastSave(report);
    await host.applyBootDescriptor(machine.descriptor);
    replaceBareUrl();
  }), [host, registry, run]);

  const open = React.useCallback((machine: PersistentMachine) => run("opening", async () => {
    registry.touch(machine.id);
    setLastSave(null);
    await host.applyBootDescriptor(machine.descriptor);
    replaceBareUrl();
  }), [host, registry, run]);

  const rename = React.useCallback((id: string, name: string) => {
    setFailure(null);
    const presentable = presentableMachineName(name);
    if (presentable === null) {
      setFailure("A machine name cannot be empty.");
      return;
    }
    try {
      registry.rename(id, presentable);
    } catch (error) {
      setFailure(describe(error));
    }
    refresh();
  }, [refresh, registry]);

  const remove = React.useCallback((id: string) => run("deleting", async () => {
    await withWorkspaceHeld(id, async () => {
      await deleteWorkspace(await openWorkspaceContainer(), id);
    });
    registry.remove(id);
  }), [registry, run]);

  return { machines, listFailure, current, busy, failure, lastSave, save, open, rename, remove };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
