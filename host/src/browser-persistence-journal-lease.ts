export function browserPersistenceJournalLockName(name: string): string {
  return `kandelo-rootfs-journal:${name}`;
}

export type BrowserPersistenceJournalLease = (() => Promise<void>) & {
  readonly journalName: string;
};

export async function acquireBrowserPersistenceJournalLease(name: string): Promise<BrowserPersistenceJournalLease> {
  if (typeof navigator === "undefined" || !navigator.locks) {
    throw new Error("browser rootfs persistence requires Web Locks");
  }
  let signalRelease!: () => void;
  const released = new Promise<void>((resolve) => { signalRelease = resolve; });
  let signalAcquired!: () => void;
  let signalFailed!: (error: unknown) => void;
  const acquired = new Promise<void>((resolve, reject) => {
    signalAcquired = resolve;
    signalFailed = reject;
  });
  const holding = navigator.locks.request(
    browserPersistenceJournalLockName(name),
    { mode: "exclusive", ifAvailable: true },
    async (lock) => {
      if (lock === null) throw new Error("browser rootfs persistence journal is already open");
      signalAcquired();
      await released;
    },
  );
  void holding.catch(signalFailed);
  await acquired;
  let didRelease = false;
  const release = Object.assign(async () => {
    if (!didRelease) {
      didRelease = true;
      signalRelease();
    }
    await holding;
  }, { journalName: name });
  return release;
}
