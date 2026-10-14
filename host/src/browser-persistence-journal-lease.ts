export function browserPersistenceJournalLockName(name: string): string {
  return `kandelo-rootfs-journal:${name}`;
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
