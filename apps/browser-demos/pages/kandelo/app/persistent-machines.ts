// Persistent machines on this page — save the running machine, keep its home
// directory saved while it runs, and open, rename, or delete a saved one.
//
// The machine runs on memory. Saving copies its home directory into
// IndexedDB; from then on the page reads the home every second and writes
// what changed, once the changes have stopped for one read or have waited
// MAX_UNSAVED_MS. Opening a saved machine boots its image with the stored
// home as the home directory's seed. The save state says which side of that
// window the machine is on: a crash while it reads "Modified" or "Saving…"
// loses what changed since the last "Saved".
//
// Only a boot this hook starts runs a saved machine. Any other boot — a
// reboot, a gallery launch — ends the session without writing, so a home the
// stored copy never held is never saved over it. One tab runs a saved machine
// at a time: the session holds the machine's Web Lock.
//
// A handover moves the machine but not its saved copy, which stays in the
// browser that saved it. That page keeps the lock and becomes the keeper: it
// offers the other computer the saved state, with no bytes, and the other
// computer — the runner — reads the home against that state every second and
// sends what changed over the peer link, first telling the keeper that a
// change is coming. The keeper writes each change and answers it. The save
// state shows on the keeper's dock only: it is the browser that saves.
// When the machine comes back, the keeper runs it as saved again from the
// state it kept. A closed link ends both sides: changes the runner makes
// after it are not saved anywhere, and its page says so.
import * as React from "react";
import { useKernelHost } from "../kernel-host/react";
import { replaceMachinelessUrl } from "../url-state";
import {
  presentableMachineName,
  randomMachineName,
} from "../../../../../web-libs/kandelo-session/src/machine-name";
import { HomeTracker, type HomeDiff } from "../../../../../web-libs/kandelo-session/src/home-tracker";
import {
  SavedMachines,
  savedMachineSeed,
  type SavedMachineChanges,
} from "../../../../../web-libs/kandelo-session/src/saved-machine";
import {
  parseSavedMachineMessage,
  type SavedMachineMessage,
} from "../../../../../web-libs/kandelo-session/src/saved-machine-message";
import {
  PERSISTENT_MACHINES_STORAGE_KEY,
  PersistentMachineRegistry,
  savedMachineDescriptor,
  type PersistentMachine,
} from "../../../../../web-libs/kandelo-session/src/persistent-machine";
import type { PeerLink } from "../../../lib/peer-link";

export type PersistentMachinesBusy = "saving" | "opening" | "deleting";

/** Where the running saved machine stands against its stored copy. */
export type SaveState = "modified" | "saving" | "saved" | "failed";

const READ_INTERVAL_MS = 1000;
const MAX_UNSAVED_MS = 10_000;
/** How long a keeper waits for the computer it handed the machine to. */
const ACCEPT_TIMEOUT_MS = 180_000;
/** How long a runner waits for the keeper to answer one change. */
const ANSWER_TIMEOUT_MS = 30_000;

export interface PersistentMachines {
  /** Every saved machine, most recently opened first. */
  readonly machines: readonly PersistentMachine[];
  /** Why the list could not be read, or null. A corrupt list is shown, not hidden. */
  readonly listFailure: string | null;
  /** The saved machine of this browser that runs, here or on the other computer. */
  readonly current: PersistentMachine | null;
  /** True while `current` runs on the other computer and this page saves its changes. */
  readonly keeping: boolean;
  /** The name of the other computer's saved machine that runs here, or null. */
  readonly savedElsewhere: string | null;
  /** Where this browser's saved machine stands against its stored copy, or null while this browser saves none. */
  readonly saveState: SaveState | null;
  readonly busy: PersistentMachinesBusy | null;
  /** Why the last action failed, or null. */
  readonly failure: string | null;
  /** Why the last save of the running machine's home failed, or null. */
  readonly saveFailure: string | null;
  /** Home entries a save cannot keep: devices, pipes, sockets. */
  readonly skipped: readonly string[];
  /** Keep the running machine's home directory in this browser from now on. */
  save(): Promise<void>;
  open(machine: PersistentMachine): Promise<void>;
  rename(id: string, name: string): void;
  /** Delete the stored home and forget the machine. Refused while it runs anywhere. */
  remove(id: string): Promise<void>;
  /** This page handed its machine to the other computer. Call before the machine stops here. */
  gaveAway(): void;
  /** This page runs the machine it took from the other computer. */
  took(): void;
}

/** A session that reads the home of the machine running on this page. */
interface Reading {
  readonly tracker: HomeTracker;
  pending: { since: number; signature: string } | null;
  reading: Promise<void> | null;
}

/** The machine runs here and this browser saves it. */
interface Here extends Reading {
  readonly kind: "here";
  readonly machine: PersistentMachine;
  readonly release: () => void;
}

/** The machine runs here and the other computer saves it. */
interface Runner extends Reading {
  readonly kind: "runner";
  readonly name: string;
  readonly home: string;
  readonly link: PeerLink;
  readonly answers: Map<number, { saved: () => void; failed: (error: Error) => void }>;
  nextSeq: number;
}

/** The machine runs on the other computer and this browser saves it. */
interface Keeper {
  readonly kind: "keeper";
  readonly machine: PersistentMachine;
  readonly release: () => void;
  readonly tracker: HomeTracker;
  readonly link: PeerLink;
  accepted: boolean;
}

type Session = Here | Runner | Keeper;

export function usePersistentMachines(link: PeerLink | null): PersistentMachines {
  const host = useKernelHost();
  const registry = React.useMemo(
    () => new PersistentMachineRegistry(window.localStorage),
    [],
  );
  const homes = React.useMemo(() => {
    const opened = SavedMachines.open();
    // The first save or open awaits this and reports the failure there.
    opened.catch(() => undefined);
    return opened;
  }, []);
  const session = React.useRef<Session | null>(null);
  const ownBoot = React.useRef(false);
  const [version, setVersion] = React.useState(0);
  const [current, setCurrent] = React.useState<PersistentMachine | null>(null);
  const [keeping, setKeeping] = React.useState(false);
  const [savedElsewhere, setSavedElsewhere] = React.useState<string | null>(null);
  // A take's two halves arrive in either order: this page starts running the
  // machine, and the keeper's offer crosses the link.
  const tookFromPeer = React.useRef(false);
  const offer = React.useRef<Extract<SavedMachineMessage, { type: "offer" }> | null>(null);
  const linkRef = React.useRef(link);
  linkRef.current = link;
  const [saveState, setSaveState] = React.useState<SaveState | null>(null);
  const [busy, setBusy] = React.useState<PersistentMachinesBusy | null>(null);
  const [failure, setFailure] = React.useState<string | null>(null);
  const [saveFailure, setSaveFailure] = React.useState<string | null>(null);
  const [skipped, setSkipped] = React.useState<readonly string[]>([]);
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

  const begin = React.useCallback((
    machine: PersistentMachine,
    tracker: HomeTracker,
    release: () => void,
  ) => {
    session.current = { kind: "here", machine, tracker, release, pending: null, reading: null };
    setCurrent(machine);
    setKeeping(false);
    setSaveState("saved");
  }, []);

  const end = React.useCallback(() => {
    const active = session.current;
    session.current = null;
    if (active?.kind !== "runner") active?.release();
    if (active?.kind === "runner") {
      for (const answer of active.answers.values()) answer.failed(new Error("the save session ended"));
    }
    setCurrent(null);
    setKeeping(false);
    setSavedElsewhere(null);
    setSaveState(null);
    setSaveFailure(null);
    setSkipped([]);
  }, []);

  // A keeper's machine runs on the other computer, so what this page runs —
  // a replica, or nothing — is no reason to stop saving it.
  React.useEffect(() => host.subscribeStatus((status) => {
    if (ownBoot.current || status === "running") return;
    const active = session.current;
    if (active?.kind === "keeper") return;
    if (active?.kind === "runner") active.link.savedMachine.postMessage({ type: "stopped" });
    end();
  }), [end, host]);

  React.useEffect(() => end, [end]);

  const write = React.useCallback(async (active: Here | Runner, changes: SavedMachineChanges) => {
    if (active.kind === "here") {
      await (await homes).apply(active.machine.id, changes);
      return;
    }
    const seq = active.nextSeq++;
    await new Promise<void>((saved, failed) => {
      const timer = window.setTimeout(
        () => failed(new Error("the computer that saved this machine did not answer")),
        ANSWER_TIMEOUT_MS,
      );
      const settle = () => {
        window.clearTimeout(timer);
        active.answers.delete(seq);
      };
      active.answers.set(seq, {
        saved: () => { settle(); saved(); },
        failed: (error) => { settle(); failed(error); },
      });
      active.link.savedMachine.postMessage({ type: "changes", seq, put: changes.put, remove: changes.remove });
    });
  }, [homes]);

  const read = React.useCallback(async (force: boolean) => {
    const active = session.current;
    if (active === null || active.kind === "keeper") return;
    if (active.reading !== null || host.getStatus() !== "running") return;
    const reading = (async () => {
      try {
        const home = active.kind === "here" ? active.machine.home : active.home;
        const now = Date.now();
        const listing = await host.readTree(home, active.tracker.known(now));
        if (session.current !== active) return;
        const diff = await active.tracker.diff(listing);
        setSkipped(diff.skipped);
        if (diff.put.length === 0 && diff.remove.length === 0) {
          await active.tracker.commit(diff);
          active.pending = null;
          setSaveState("saved");
          return;
        }
        const signature = signatureOf(diff);
        const settled = active.pending !== null && active.pending.signature === signature;
        const waited = active.pending !== null && now - active.pending.since >= MAX_UNSAVED_MS;
        if (!force && !settled && !waited) {
          // The keeper shows the save state, and it hears of a change only
          // when the change is sent. Telling it now lets its dock say
          // "Modified" while this computer waits for the change to settle.
          if (active.pending === null && active.kind === "runner") {
            active.link.savedMachine.postMessage({ type: "modified" });
          }
          active.pending = { since: active.pending?.since ?? now, signature };
          setSaveState("modified");
          return;
        }
        setSaveState("saving");
        await write(active, diff);
        await active.tracker.commit(diff);
        active.pending = null;
        if (session.current !== active) return;
        setSaveState("saved");
        setSaveFailure(null);
      } catch (error) {
        if (session.current !== active) return;
        setSaveState("failed");
        setSaveFailure(describe(error));
      }
    })();
    active.reading = reading;
    await reading;
    active.reading = null;
  }, [host, write]);

  const readingHome = saveState !== null;
  React.useEffect(() => {
    if (!readingHome) return;
    const timer = window.setInterval(() => void read(false), READ_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [read, readingHome]);

  React.useEffect(() => {
    // A keeper that closes stops saving what the other computer changes.
    if (!keeping && saveState !== "modified" && saveState !== "saving" && saveState !== "failed") return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [keeping, saveState]);

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
    if (session.current !== null) return;
    const home = host.getHomeDirectory();
    if (home === null) throw new Error("This machine declares no home directory to save.");
    const id = crypto.randomUUID();
    const release = await holdMachine(id);
    if (release === null) throw new Error(`Machine ${id} is already held.`);
    try {
      const tracker = await HomeTracker.from([]);
      const diff = await tracker.diff(await host.readTree(home));
      await (await homes).replace(id, diff.put);
      await tracker.commit(diff);
      const now = new Date().toISOString();
      const machine: PersistentMachine = {
        id,
        name: randomMachineName(registry.list().map((other) => other.name)),
        home,
        descriptor: savedMachineDescriptor(host.getBootDescriptor()),
        createdAt: now,
        openedAt: now,
      };
      registry.save(machine);
      begin(machine, tracker, release);
      setSkipped(diff.skipped);
      replaceMachinelessUrl();
    } catch (error) {
      release();
      throw error;
    }
  }), [begin, homes, host, registry, run]);

  const open = React.useCallback((machine: PersistentMachine) => run("opening", async () => {
    if (runningId(session.current) === machine.id) return;
    await read(true);
    // This boot is this hook's own, so the status change that would tell the
    // keeper the machine stopped is not read: tell it here.
    if (session.current?.kind === "runner") session.current.link.savedMachine.postMessage({ type: "stopped" });
    end();
    const release = await holdMachine(machine.id);
    if (release === null) {
      throw new Error(`${machine.name} is open in another tab. Close it there first.`);
    }
    try {
      const entries = await (await homes).load(machine.id);
      const tracker = await HomeTracker.from(entries);
      ownBoot.current = true;
      try {
        await host.applyBootDescriptor(machine.descriptor, { homeSeed: savedMachineSeed(entries) });
      } finally {
        ownBoot.current = false;
      }
      if (host.getStatus() !== "running") {
        throw new Error(`${machine.name} did not start; its saved files are unchanged.`);
      }
      registry.touch(machine.id);
      begin(machine, tracker, release);
      replaceMachinelessUrl();
    } catch (error) {
      release();
      throw error;
    }
  }), [begin, end, homes, host, read, registry, run]);

  const rename = React.useCallback((id: string, name: string) => {
    setFailure(null);
    const presentable = presentableMachineName(name);
    if (presentable === null) {
      setFailure("A machine name cannot be empty.");
      return;
    }
    try {
      const renamed = registry.rename(id, presentable);
      if (runningId(session.current) === id) setCurrent(renamed);
    } catch (error) {
      setFailure(describe(error));
    }
    refresh();
  }, [refresh, registry]);

  const remove = React.useCallback((id: string) => run("deleting", async () => {
    const release = await holdMachine(id);
    if (release === null) throw new Error("This machine is running. Stop it before deleting it.");
    try {
      await (await homes).delete(id);
      registry.remove(id);
    } finally {
      release();
    }
  }), [homes, registry, run]);

  const startRunner = React.useCallback(() => {
    const offered = offer.current;
    const peer = linkRef.current;
    if (!tookFromPeer.current || offered === null || peer === null) return;
    tookFromPeer.current = false;
    offer.current = null;
    if (session.current !== null || host.getStatus() !== "running") return;
    if (host.getHomeDirectory() !== offered.home) {
      setFailure(`The other computer saves ${offered.home}, but this machine's home is ${host.getHomeDirectory() ?? "not set"}.`);
      peer.savedMachine.postMessage({ type: "stopped" });
      return;
    }
    session.current = {
      kind: "runner",
      name: offered.name,
      home: offered.home,
      link: peer,
      tracker: HomeTracker.fromStates(offered.states),
      answers: new Map(),
      nextSeq: 0,
      pending: null,
      reading: null,
    };
    setSavedElsewhere(offered.name);
    setSaveState("saved");
    peer.savedMachine.postMessage({ type: "accept" });
  }, [host]);

  const gaveAway = React.useCallback(() => {
    const active = session.current;
    const peer = linkRef.current;
    tookFromPeer.current = false;
    offer.current = null;
    if (active?.kind === "runner") {
      // The machine goes back to the keeper, which runs it as saved again.
      end();
      return;
    }
    if (active?.kind !== "here" || peer === null) return;
    const keeper: Keeper = {
      kind: "keeper",
      machine: active.machine,
      release: active.release,
      tracker: active.tracker,
      link: peer,
      accepted: false,
    };
    session.current = keeper;
    setKeeping(true);
    setSaveState("saved");
    setSaveFailure(null);
    setSkipped([]);
    void (async () => {
      // A read already writing must land before the state it changes is sent.
      await active.reading;
      if (session.current !== keeper) return;
      peer.savedMachine.postMessage({
        type: "offer",
        name: keeper.machine.name,
        home: keeper.machine.home,
        states: keeper.tracker.states(),
      });
      window.setTimeout(() => {
        if (session.current === keeper && !keeper.accepted) end();
      }, ACCEPT_TIMEOUT_MS);
    })();
  }, [end]);

  const took = React.useCallback(() => {
    const active = session.current;
    if (active?.kind === "keeper") {
      // The machine came back with every change the runner made. The first read
      // compares the home with the saved copy and writes what it has not seen.
      session.current = {
        kind: "here",
        machine: active.machine,
        release: active.release,
        tracker: active.tracker,
        pending: null,
        reading: null,
      };
      setKeeping(false);
      setSaveState("saved");
      return;
    }
    tookFromPeer.current = true;
    startRunner();
  }, [startRunner]);

  const keep = React.useCallback(async (keeper: Keeper, message: SavedMachineMessage) => {
    if (message.type === "accept") {
      keeper.accepted = true;
      return;
    }
    if (message.type === "stopped") {
      end();
      return;
    }
    if (message.type === "modified") {
      setSaveState("modified");
      return;
    }
    if (message.type !== "changes") return;
    setSaveState("saving");
    try {
      await (await homes).apply(keeper.machine.id, message);
      await keeper.tracker.commit({ ...message, skipped: [], fingerprints: new Map() });
      keeper.link.savedMachine.postMessage({ type: "saved", seq: message.seq });
      if (session.current !== keeper) return;
      setSaveState("saved");
      setSaveFailure(null);
    } catch (error) {
      keeper.link.savedMachine.postMessage({ type: "failed", seq: message.seq, reason: describe(error) });
      if (session.current !== keeper) return;
      setSaveState("failed");
      setSaveFailure(describe(error));
    }
  }, [end, homes]);

  React.useEffect(() => {
    if (link === null) return;
    // One message at a time, in arrival order: a keeper writes each change
    // before the next, and answers them in the order they came.
    let queue = Promise.resolve();
    const onMessage = (event: MessageEvent) => {
      queue = queue.then(async () => {
        let message: SavedMachineMessage;
        try {
          message = parseSavedMachineMessage(event.data);
        } catch (error) {
          const seq = (event.data as { seq?: unknown } | null)?.seq;
          if (typeof seq === "number") {
            link.savedMachine.postMessage({ type: "failed", seq, reason: describe(error) });
          }
          return;
        }
        const active = session.current;
        if (message.type === "offer") {
          offer.current = message;
          startRunner();
          return;
        }
        if (message.type === "saved" || message.type === "failed") {
          if (active?.kind !== "runner") return;
          const answer = active.answers.get(message.seq);
          if (message.type === "saved") answer?.saved();
          else answer?.failed(new Error(message.reason));
          return;
        }
        if (active?.kind === "keeper" && active.link === link) {
          await keep(active, message);
          return;
        }
        if (message.type === "changes") {
          link.savedMachine.postMessage({
            type: "failed",
            seq: message.seq,
            reason: "this computer no longer saves this machine",
          });
        }
      });
    };
    link.savedMachine.addEventListener("message", onMessage);
    return () => {
      link.savedMachine.removeEventListener("message", onMessage);
      tookFromPeer.current = false;
      offer.current = null;
      const active = session.current;
      if (active?.kind !== "keeper" && active?.kind !== "runner") return;
      end();
      if (active.kind === "runner") {
        setFailure(`The link to the computer that saves ${active.name} closed. Changes from now on are not saved.`);
      }
    };
  }, [end, keep, link, startRunner]);

  return {
    machines, listFailure, current, keeping, savedElsewhere,
    // The browser that saved the machine reports its saves; a runner's
    // changes are saved there, so its own state only paces its reads.
    saveState: savedElsewhere === null ? saveState : null,
    busy, failure, saveFailure, skipped,
    save, open, rename, remove, gaveAway, took,
  };
}

/** The id of this browser's saved machine that the session runs, here or elsewhere. */
function runningId(active: Session | null): string | null {
  return active === null || active.kind === "runner" ? null : active.machine.id;
}

/**
 * Take the machine's Web Lock and hold it until the returned function runs.
 * Null when a session in this tab or another already holds it.
 */
function holdMachine(id: string): Promise<(() => void) | null> {
  return new Promise((resolve, reject) => {
    navigator.locks.request(`kandelo-saved-machine:${id}`, { ifAvailable: true }, (lock) => {
      if (lock === null) {
        resolve(null);
        return;
      }
      return new Promise<void>((release) => resolve(release));
    }).catch(reject);
  });
}

function signatureOf(diff: HomeDiff): string {
  const put = diff.put.map((entry) => `${entry.path}\0${diff.fingerprints.get(entry.path)?.fingerprint ?? entry.kind}`);
  return JSON.stringify([put, diff.remove]);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
