import { afterEach, expect, it, vi } from "vitest";
import {
  assertBrowserComputerId,
  browserComputerIdForStorageName,
  browserComputerStorageName,
  browserComputersDirectory,
  browserJournalBelongsToComputer,
  browserPersistenceDirectory,
  browserReplacementJournalName,
} from "../src/browser-computer-storage";

const id = "12345678-1234-1234-1234-123456789abc";
const other = "87654321-4321-4321-4321-cba987654321";

afterEach(() => vi.unstubAllGlobals());

it("uses computer-prefixed names and binds replacement journals to exactly one computer", () => {
  const name = browserComputerStorageName(id);
  expect(name).toBe(`computer-${id}`);
  expect(browserComputerIdForStorageName(name)).toBe(id);
  const replacement = browserReplacementJournalName(name);
  expect(replacement).toMatch(new RegExp(`^computer-${id}_j-[0-9a-f-]{36}$`));
  expect(browserComputerIdForStorageName(replacement)).toBe(id);
  expect(browserJournalBelongsToComputer(name, replacement)).toBe(true);
  expect(browserJournalBelongsToComputer(browserComputerStorageName(other), replacement)).toBe(false);
  expect(browserJournalBelongsToComputer(name, `machine-${id}`)).toBe(false);
  expect(browserComputerIdForStorageName(`machine-${id}`)).toBeNull();
  expect(browserComputerIdForStorageName(`${name}_j-invalid`)).toBeNull();
  expect(() => assertBrowserComputerId("../outside")).toThrow("Invalid computer ID");
});

it("routes managed filesystem storage only through kandelo/computers and leaves the old tree alone", async () => {
  const filesystem = {};
  const computer = { getDirectoryHandle: vi.fn(async () => filesystem) };
  const computers = { getDirectoryHandle: vi.fn(async () => computer) };
  const kandelo = { getDirectoryHandle: vi.fn(async () => computers) };
  const root = { getDirectoryHandle: vi.fn(async () => kandelo) };
  vi.stubGlobal("navigator", { storage: { getDirectory: async () => root } });
  expect(await browserPersistenceDirectory(browserComputerStorageName(id))).toBe(filesystem);
  expect(root.getDirectoryHandle).toHaveBeenCalledExactlyOnceWith("kandelo", { create: false });
  expect(kandelo.getDirectoryHandle).toHaveBeenCalledExactlyOnceWith("computers", { create: false });
  expect(computers.getDirectoryHandle).toHaveBeenCalledExactlyOnceWith(id, { create: false });
  expect(computer.getDirectoryHandle).toHaveBeenCalledExactlyOnceWith("filesystem", { create: true });
  expect(await browserComputersDirectory()).toBe(computers);
  expect(kandelo.getDirectoryHandle).toHaveBeenLastCalledWith("computers", { create: true });
});
