export type BrowserPersistenceComputerLease = (() => Promise<void>) & {
  readonly computerName: string;
};

const activeLeases = new WeakMap<BrowserPersistenceComputerLease, { claimed: boolean; released: boolean }>();

export async function acquireBrowserPersistenceComputerLease(name: string): Promise<BrowserPersistenceComputerLease> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(name)) throw new Error("invalid experimental persistence name");
  if (typeof navigator === "undefined" || !navigator.locks) {
    throw new Error("experimental persistence requires Web Locks");
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
    `kandelo-fixed-rootfs-runtime:${name}`,
    { mode: "exclusive", ifAvailable: true },
    async (lock) => {
      if (lock === null) throw new Error("experimental persistence computer is already running in another tab");
      signalAcquired();
      await released;
    },
  );
  void holding.catch(signalFailed);
  await acquired;
  const state = { claimed: false, released: false };
  const release = Object.assign(async () => {
    if (state.claimed) throw new Error("persistent computer lease is still owned by a kernel");
    if (!state.released) {
      state.released = true;
      signalRelease();
    }
    await holding;
  }, { computerName: name });
  activeLeases.set(release, state);
  return release;
}

export function claimBrowserPersistenceComputerLease(
  lease: BrowserPersistenceComputerLease,
): () => void {
  const state = activeLeases.get(lease);
  if (state === undefined || state.released || state.claimed) {
    throw new Error("persistent computer lease is unavailable");
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

export async function withHeldBrowserPersistenceComputerLease<T>(
  lease: BrowserPersistenceComputerLease,
  name: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (lease.computerName !== name) throw new Error("persistent computer lease belongs to another computer");
  const releaseClaim = claimBrowserPersistenceComputerLease(lease);
  try {
    return await operation();
  } finally {
    releaseClaim();
  }
}
