export function browserPersistenceJournalLockName(name: string): string {
  return `kandelo-rootfs-journal:${name}`;
}

export type BrowserPersistenceJournalLease = (() => Promise<void>) & {
  readonly journalName: string;
};

const activeLeases = new WeakMap<BrowserPersistenceJournalLease, { claimed: boolean; released: boolean }>();

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
  const state = { claimed: false, released: false };
  const release = Object.assign(async () => {
    if (state.claimed) throw new Error("browser rootfs persistence journal lease is still claimed");
    if (!state.released) {
      state.released = true;
      signalRelease();
    }
    await holding;
  }, { journalName: name });
  activeLeases.set(release, state);
  return release;
}

function claimBrowserPersistenceJournalLease(lease: BrowserPersistenceJournalLease): () => void {
  const state = activeLeases.get(lease);
  if (state === undefined || state.released || state.claimed) {
    throw new Error("browser rootfs persistence journal lease is unavailable");
  }
  state.claimed = true;
  let didRelease = false;
  return () => {
    if (!didRelease) {
      didRelease = true;
      state.claimed = false;
    }
  };
}

export async function withHeldBrowserPersistenceJournal<T>(
  lease: BrowserPersistenceJournalLease,
  name: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (lease.journalName !== name) throw new Error("browser rootfs persistence journal lease does not match the snapshot");
  const releaseClaim = claimBrowserPersistenceJournalLease(lease);
  try { return await operation(); }
  finally { releaseClaim(); }
}

export async function withHeldBrowserPersistenceJournals<T>(
  source: BrowserPersistenceJournalLease,
  target: BrowserPersistenceJournalLease,
  sourceName: string,
  targetName: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (source.journalName !== sourceName || target.journalName !== targetName || source === target) {
    throw new Error("browser rootfs persistence journal leases do not match the replacement");
  }
  const releaseSourceClaim = claimBrowserPersistenceJournalLease(source);
  try {
    const releaseTargetClaim = claimBrowserPersistenceJournalLease(target);
    try {
      return await operation();
    } finally {
      releaseTargetClaim();
    }
  } finally {
    releaseSourceClaim();
  }
}

export async function withIdleBrowserPersistenceJournals<T>(
  source: string,
  target: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (typeof navigator === "undefined" || !navigator.locks) {
    throw new Error("browser rootfs persistence requires Web Locks");
  }
  const locked = (name: string, next: () => Promise<T>) => navigator.locks.request(
    browserPersistenceJournalLockName(name),
    { mode: "exclusive", ifAvailable: true },
    (lock) => {
      if (lock === null) throw new Error("experimental persistence journal is already open");
      return next();
    },
  );
  return locked(source, () => locked(target, operation));
}
