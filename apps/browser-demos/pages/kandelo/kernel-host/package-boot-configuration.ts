import type { BrowserKernel } from "../../../../../host/src/browser-kernel-host";
import { browserComputerDirectory } from "../../../../../host/src/browser-computer-storage";
import {
  KANDELO_DEMO_CONFIG_PATH, MAX_KANDELO_DEMO_CONFIG_BYTES, parseKandeloDemoConfig, validateKandeloDemoConfig,
} from "../../../../../web-libs/kandelo-session/src/demo-config";
import {
  EXPERIMENTAL_TERMINAL_SESSION_PATH, MAX_EXPERIMENTAL_TERMINAL_SESSION_BYTES, parseExperimentalTerminalSession,
} from "../../../../../web-libs/kandelo-session/src/experimental-terminal-session";
import { resolveImageProfileId } from "./image-composer";
import type { PackageUpgradeSource } from "./package-upgrade-client";
import { parseStoredComposition, persistentImageServices, type StoredComposition } from "./stored-composition";

// Guests are root in their own computer, so neither /etc/kandelo/demo.json nor
// the installed inventory can vouch for themselves. The configuration of an
// updated computer therefore comes from the verified target image and lives
// here, outside the guest's filesystem, keyed by the inventory that activates
// it. Each record is inert until replay shows its exact inventory installed.

export const INSTALLED_INVENTORY_PATH = "/var/lib/kandelo/packages/installed";
const MAX_INVENTORY_BYTES = 8 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const FILE = "boot-configurations.json";
const MAX_ENTRIES = 2;
const MAX_RECORD_BYTES = 2 * MAX_ENTRIES * (MAX_KANDELO_DEMO_CONFIG_BYTES + MAX_EXPERIMENTAL_TERMINAL_SESSION_BYTES + 32 * 1024);

export interface BootConfiguration {
  inventorySha256: string;
  composition: StoredComposition;
}

type Reader = Pick<BrowserKernel, "readFileRangeFromVfs">;

async function softwareDirectory(computerId: string): Promise<FileSystemDirectoryHandle> {
  return (await browserComputerDirectory(computerId, false)).getDirectoryHandle("software", { create: true });
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}

async function readBounded(read: (offset: number, length: number) => Promise<Uint8Array | null>, maximum: number): Promise<Uint8Array | null> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const chunk = await read(total, Math.min(READ_CHUNK_BYTES, maximum + 1 - total));
    if (chunk === null) return null;
    if (chunk.length === 0) break;
    total += chunk.length;
    if (total > maximum) throw new Error("Software boot configuration input exceeds its bound");
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

async function installedInventorySha256(kernel: Reader): Promise<string | null> {
  const bytes = await readBounded((offset, length) => kernel.readFileRangeFromVfs(INSTALLED_INVENTORY_PATH, offset, length), MAX_INVENTORY_BYTES);
  return bytes === null || bytes.length === 0 ? null : sha256(bytes);
}

function invalid(): Error {
  return new Error("Saved software boot configuration is unsupported or unreadable; preserve this computer and inspect recovery");
}

function parseRecord(value: unknown): BootConfiguration[] {
  const record = value as { version?: unknown; entries?: unknown } | null;
  if (!record || record.version !== 1 || !Array.isArray(record.entries) || record.entries.length > MAX_ENTRIES) throw invalid();
  return record.entries.map(entry => {
    const { inventorySha256, composition } = (entry ?? {}) as Partial<BootConfiguration>;
    if (typeof inventorySha256 !== "string" || !/^[0-9a-f]{64}$/.test(inventorySha256)) throw invalid();
    try { return { inventorySha256, composition: parseStoredComposition(composition, JSON.stringify) }; }
    catch (error) {
      if ((error as { code?: string } | null)?.code === "ENOMEM") throw error;
      throw invalid();
    }
  });
}

export async function readBootConfigurations(computerId: string): Promise<BootConfiguration[]> {
  const directory = await softwareDirectory(computerId);
  let file: File;
  try { file = await (await directory.getFileHandle(FILE)).getFile(); }
  catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return [];
    throw error;
  }
  if (file.size > MAX_RECORD_BYTES) throw new Error("Saved software boot configuration exceeds its bound");
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer())); }
  catch { throw invalid(); }
  return parseRecord(value);
}

async function writeRecord(computerId: string, entries: BootConfiguration[]): Promise<void> {
  const bytes = new TextEncoder().encode(JSON.stringify({ version: 1, entries }));
  if (bytes.length > MAX_RECORD_BYTES) throw new Error("Software boot configuration exceeds its bound");
  const directory = await softwareDirectory(computerId);
  const writer = await (await directory.getFileHandle(FILE, { create: true })).createWritable();
  try { await writer.write(bytes); await writer.close(); }
  catch (error) {
    try { await writer.abort(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "Software boot configuration publication failed"); }
    throw error;
  }
}

async function targetComposition(source: PackageUpgradeSource, profileId: string): Promise<StoredComposition> {
  const text = async (path: string, maximum: number) => {
    const bytes = await readBounded((offset, length) => source.readFile(path, offset, length), maximum);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes!);
  };
  const imageConfig = parseKandeloDemoConfig(await text(KANDELO_DEMO_CONFIG_PATH, MAX_KANDELO_DEMO_CONFIG_BYTES));
  if (imageConfig === null) throw new Error("The update's boot configuration is unsupported");
  validateKandeloDemoConfig(imageConfig);
  resolveImageProfileId(imageConfig, profileId, "This computer");
  const terminalSession = parseExperimentalTerminalSession(await text(EXPERIMENTAL_TERMINAL_SESSION_PATH, MAX_EXPERIMENTAL_TERMINAL_SESSION_BYTES));
  const requiredServices = await persistentImageServices(
    { readFileRangeFromVfs: (path, offset, length) => source.readFile(path, offset, Math.min(length, READ_CHUNK_BYTES)) },
    imageConfig, profileId,
  );
  return { imageConfig, profileId, terminalSession, requiredServices };
}

/**
 * Publish the target's configuration before the native commit. Doing this
 * first is safe because a record stays inert until its inventory is installed,
 * so a crash on either side of the commit leaves the correct record selected.
 */
export async function recordBootConfiguration(computerId: string, kernel: Reader, base: StoredComposition, source: PackageUpgradeSource): Promise<void> {
  const installed = await installedInventorySha256(kernel);
  if (installed === null) throw new Error("This computer has no readable installed software inventory");
  const inventory = await readBounded((offset, length) => source.readInventory(offset, length), MAX_INVENTORY_BYTES);
  const inventorySha256 = await sha256(inventory!);
  const entries = await readBootConfigurations(computerId);
  const current = entries.find(entry => entry.inventorySha256 === installed)?.composition ?? base;
  await writeRecord(computerId, [
    { inventorySha256: installed, composition: current },
    { inventorySha256, composition: await targetComposition(source, current.profileId) },
  ]);
}

/** The configuration authorized by the inventory replay actually left installed. */
export async function selectBootComposition(kernel: Reader, entries: readonly BootConfiguration[], base: StoredComposition): Promise<StoredComposition> {
  if (entries.length === 0) return base;
  const installed = await installedInventorySha256(kernel);
  return entries.find(entry => entry.inventorySha256 === installed)?.composition ?? base;
}

export function bootCompositionMatchesInstalled(assumed: StoredComposition, selected: StoredComposition): boolean {
  return JSON.stringify(assumed) === JSON.stringify(selected);
}

/** Keep the installed record last, the one the next boot assumes before replay. */
export async function promoteBootConfiguration(computerId: string, inventorySha256: string): Promise<void> {
  const entries = await readBootConfigurations(computerId);
  const selected = entries.find(entry => entry.inventorySha256 === inventorySha256);
  if (selected === undefined || entries.at(-1) === selected) return;
  await writeRecord(computerId, [...entries.filter(entry => entry !== selected), selected]);
}

export async function installedBootConfigurationSha256(kernel: Reader): Promise<string | null> {
  return installedInventorySha256(kernel);
}
