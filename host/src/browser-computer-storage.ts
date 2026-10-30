const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const COMPUTER_ID = new RegExp(`^${UUID}$`);
const STORAGE_NAME = new RegExp(`^computer-(${UUID})(?:_j-${UUID})?$`);

export function assertBrowserComputerId(id: string): void {
  if (!COMPUTER_ID.test(id)) throw new Error("Invalid computer ID");
}

export function browserComputerStorageName(id: string): string {
  assertBrowserComputerId(id);
  return `computer-${id}`;
}

export function browserComputerIdForStorageName(name: string): string | null {
  return STORAGE_NAME.exec(name)?.[1] ?? null;
}

export async function browserComputersDirectory(create = true): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  const kandelo = await root.getDirectoryHandle("kandelo", { create });
  return kandelo.getDirectoryHandle("computers", { create });
}

export async function browserComputerDirectory(id: string, create = true): Promise<FileSystemDirectoryHandle> {
  assertBrowserComputerId(id);
  return (await browserComputersDirectory(create)).getDirectoryHandle(id, { create });
}

export async function browserPersistenceDirectory(name: string): Promise<FileSystemDirectoryHandle> {
  const id = browserComputerIdForStorageName(name);
  if (id !== null) return (await browserComputerDirectory(id, false)).getDirectoryHandle("filesystem", { create: true });
  return (await navigator.storage.getDirectory()).getDirectoryHandle("kandelo-persistent-overlay", { create: true });
}

export function browserReplacementJournalName(name: string): string {
  return browserComputerIdForStorageName(name) === null ? `j-${crypto.randomUUID()}` : `${name}_j-${crypto.randomUUID()}`;
}

export function browserJournalBelongsToComputer(name: string, journal: string): boolean {
  if (journal === name) return true;
  return browserComputerIdForStorageName(name) === null
    ? new RegExp(`^j-${UUID}$`).test(journal)
    : new RegExp(`^${name}_j-${UUID}$`).test(journal);
}
