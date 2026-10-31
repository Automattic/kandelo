import { expect } from "@playwright/test";
import { test } from "./support/persistent-page";
import { resolve } from "node:path";

const urls = {
  store: "/@fs/" + resolve(import.meta.dirname, "../../../web-libs/kandelo-session/src/browser-computer-store.ts"),
  storage: "/@fs/" + resolve(import.meta.dirname, "../../../host/src/browser-computer-storage.ts"),
  lease: "/@fs/" + resolve(import.meta.dirname, "../../../host/src/browser-persistence-computer-lease.ts"),
};

test("the computer namespace starts fresh without reading, migrating or cleaning the old machine storage", async ({ page }) => {
  await page.goto("/trap-signal-test.html");
  const result = await page.evaluate(async urls => {
    const { BrowserComputerStore } = await import(urls.store);
    const { browserComputerDirectory, browserComputerStorageName } = await import(urls.storage);
    const root = await navigator.storage.getDirectory();
    const kandelo = await root.getDirectoryHandle("kandelo", { create: true });
    const oldComputers = await kandelo.getDirectoryHandle("machines", { create: true });
    const id = crypto.randomUUID();
    const oldComputer = await oldComputers.getDirectoryHandle(id, { create: true });
    const oldRecord = await oldComputer.getFileHandle("machine.json", { create: true });
    const writer = await oldRecord.createWritable();
    await writer.write("old metadata must stay untouched"); await writer.close();
    const store = new BrowserComputerStore();
    const before = await store.list();
    await store.cleanup(Number.MAX_SAFE_INTEGER);
    const descriptor = { version: 1, id: "shell", title: "Shell", base: "kandelo:shell@local",
      runtime: { arch: "wasm32", kernel: "kernel@local", features: [] }, packages: [],
      mounts: [], boot: { argv: ["/usr/bin/login"], cwd: "/root", env: {} } };
    const created = await store.create(descriptor);
    try {
      const directory = await browserComputerDirectory(created.id, false);
      const path = await root.resolve(directory);
      const metadata = JSON.parse(await (await (await directory.getFileHandle("computer.json")).getFile()).text());
      const oldText = await (await oldRecord.getFile()).text();
      return { before, path, storedId: metadata.id, id: created.id, name: browserComputerStorageName(created.id), oldText };
    } finally {
      await store.remove(created.id);
      await oldComputers.removeEntry(id, { recursive: true });
    }
  }, urls);
  expect(result.before).toEqual([]);
  expect(result.path).toEqual(["kandelo", "computers", result.id]);
  expect(result.storedId).toBe(result.id);
  expect(result.name).toBe(`computer-${result.id}`);
  expect(result.oldText).toBe("old metadata must stay untouched");
});

test("computer directories, retention changes, ownership and interrupted deletion", async ({ page }) => {
  await page.goto("/trap-signal-test.html");
  const result = await page.evaluate(async urls => {
    const { BrowserComputerStore, TEMPORARY_COMPUTER_LIFETIME_MS } = await import(urls.store);
    const { browserComputerDirectory, browserComputerStorageName, browserPersistenceDirectory, browserReplacementJournalName, browserComputersDirectory } = await import(urls.storage);
    const { acquireBrowserPersistenceComputerLease } = await import(urls.lease);
    const store = new BrowserComputerStore();
    const descriptor = {
      version: 1, id: "shell", title: "Shell", base: "kandelo:shell@local",
      runtime: { arch: "wasm32", kernel: "kernel@local", memoryPages: 2048, features: [] },
      packages: [], mounts: [{ path: "/", source: "image", ref: "https://example.com/shell.vfs" }],
      boot: { argv: ["/usr/bin/login"], cwd: "/root", env: {} },
    };
    const saved = await store.create(descriptor, "saved");
    const defaultComputer = await store.create(descriptor, "saved", null);
    if (!/^[a-z]+-[a-z]+-[a-z]+$/.test(saved.title) || !/^[a-z]+-[a-z]+-[a-z]+$/.test(defaultComputer.title)
      || saved.title === defaultComputer.title) throw new Error("Default computers did not receive distinct three-word names");
    await store.update(defaultComputer.id, { profileId: "node" });
    await store.update(defaultComputer.id, { profileId: "shell" });
    const changedProfile = await store.read(defaultComputer.id);
    if (changedProfile.title !== defaultComputer.title) throw new Error("Changing boot profile renamed the computer");
    if (changedProfile.filesystemProfileId !== null || changedProfile.profileId !== "shell") throw new Error("Boot selection changed the default-profile filesystem identity");
    await store.remove(defaultComputer.id);
    const temporary = await store.create(descriptor);
    if (temporary.retention !== "temporary" || temporary.expiresAt !== temporary.lastOpenedAt + TEMPORARY_COMPUTER_LIFETIME_MS) throw new Error("New computers must default to expiring temporary storage");
    const savedDirectory = await browserPersistenceDirectory(browserComputerStorageName(saved.id));
    const otherDirectory = await browserPersistenceDirectory(browserComputerStorageName(temporary.id));
    const replacementDirectory = await browserPersistenceDirectory(browserReplacementJournalName(browserComputerStorageName(saved.id)));
    const separated = !(await savedDirectory.isSameEntry(otherDirectory));
    const replacementOwned = await savedDirectory.isSameEntry(replacementDirectory);
    const sentinel = await savedDirectory.getFileHandle("sentinel", { create: true });
    const writer = await sentinel.createWritable(); await writer.write("unchanged"); await writer.close();
    const before = (await store.list()).length;
    await store.update(saved.id, { title: "My computer" });
    await store.update(temporary.id, { retention: "saved" });
    const kept = await store.read(temporary.id);
    const expired = await store.create(descriptor, "temporary");
    const opening = await store.create(descriptor, "temporary");
    const active = await store.create(descriptor, "temporary");
    const lease = await acquireBrowserPersistenceComputerLease(browserComputerStorageName(active.id));
    let deleteRefused = false;
    try { await store.remove(active.id); } catch (error) { deleteRefused = String(error).includes("already running"); }
    await store.cleanup(Date.now() + TEMPORARY_COMPUTER_LIFETIME_MS + 1, opening.id);
    const surviving = (await store.list()).map(computer => computer.id);
    await lease();
    await store.cleanup(Date.now() + TEMPORARY_COMPUTER_LIFETIME_MS + 1);
    const after = (await store.list()).map(computer => computer.id);
    const sentinelText = await (await sentinel.getFile()).text();
    const deletion = await store.create(descriptor);
    const directoryPrototype = Object.getPrototypeOf(await browserComputersDirectory());
    const originalRemove = directoryPrototype.removeEntry;
    let interrupted = false;
    directoryPrototype.removeEntry = async function(name: string, options: unknown) {
      if (name === deletion.id) throw new DOMException("injected deletion failure", "UnknownError");
      return originalRemove.call(this, name, options);
    };
    try { await store.remove(deletion.id); } catch { interrupted = true; }
    finally { directoryPrototype.removeEntry = originalRemove; }
    let tombstone = false;
    try { await (await browserComputerDirectory(deletion.id, false)).getDirectoryHandle("retained"); }
    catch (error) { tombstone = error instanceof DOMException && error.name === "NotFoundError"; }
    const hidden = !(await store.list()).some(computer => computer.id === deletion.id);
    await store.cleanup();
    let deleted = false;
    try { await browserComputerDirectory(deletion.id, false); } catch { deleted = true; }
    const filePrototype = Object.getPrototypeOf(sentinel);
    const originalWritable = filePrototype.createWritable;
    filePrototype.createWritable = async () => { throw new DOMException("injected full quota", "QuotaExceededError"); };
    let quotaSafeDeletion = false;
    try { await store.remove(temporary.id); quotaSafeDeletion = true; }
    finally { filePrototype.createWritable = originalWritable; }
    await store.remove(saved.id);
    return { separated, replacementOwned, before, kept: { id: kept.id, retention: kept.retention, expiresAt: kept.expiresAt }, temporaryId: temporary.id,
      deleteRefused, expiredRemoved: !surviving.includes(expired.id), activePreserved: surviving.includes(active.id), openingPreserved: surviving.includes(opening.id),
      inactiveRemoved: !after.includes(active.id) && !after.includes(opening.id), sentinelText, interrupted, tombstone, hidden, deleted, quotaSafeDeletion };
  }, urls);
  expect(result).toEqual({ separated: true, replacementOwned: true, before: 2,
    kept: { id: result.temporaryId, retention: "saved", expiresAt: null }, temporaryId: result.temporaryId,
    deleteRefused: true, expiredRemoved: true, activePreserved: true, openingPreserved: true, inactiveRemoved: true,
    sentinelText: "unchanged", interrupted: true, tombstone: true, hidden: true, deleted: true, quotaSafeDeletion: true });
});

test("computer metadata is bounded, validated, and never silently replaced", async ({ page }) => {
  await page.goto("/trap-signal-test.html");
  const result = await page.evaluate(async urls => {
    const { BrowserComputerStore } = await import(urls.store);
    const { browserComputerDirectory } = await import(urls.storage);
    const store = new BrowserComputerStore();
    const descriptor = { version: 1, id: "shell", title: "Shell", base: "kandelo:shell@local",
      runtime: { arch: "wasm32", kernel: "kernel@local", features: [] }, packages: [],
      mounts: [], boot: { argv: ["/usr/bin/login"], cwd: "/root", env: {} } };
    const computer = await store.create(descriptor);
    const healthy = await store.create(descriptor);
    const file = await (await browserComputerDirectory(computer.id)).getFileHandle("computer.json");
    const original = await (await file.getFile()).text();
    const failures: string[] = [];
    for (const text of ["{broken", JSON.stringify({ ...computer, id: crypto.randomUUID() }), " ".repeat(128 * 1024 + 1)]) {
      const writer = await file.createWritable(); await writer.write(text); await writer.close();
      try { await store.read(computer.id); } catch { failures.push("refused"); }
      if (await (await file.getFile()).text() !== text) throw new Error("Damaged metadata was overwritten");
      await store.cleanup();
      if (!(await store.list()).some(record => record.id === healthy.id) || store.issues.length !== 1) throw new Error("Damaged computer hid healthy computers");
    }
    const writer = await file.createWritable(); await writer.write(original); await writer.close();
    let invalidId = false;
    try { await store.read("../other"); } catch { invalidId = true; }
    let scriptRefused = false;
    try { await store.create({ ...descriptor, boot: { ...descriptor.boot, parameters: { runScript: "script" } } }); }
    catch { scriptRefused = true; }
    await store.remove(computer.id);
    await store.remove(healthy.id);
    return { failures, invalidId, scriptRefused };
  }, urls);
  expect(result).toEqual({ failures: ["refused", "refused", "refused"], invalidId: true, scriptRefused: true });
});

test("provisioning state prevents accidental recreation and abandoned creation is collected", async ({ page }) => {
  await page.goto("/trap-signal-test.html");
  const result = await page.evaluate(async urls => {
    const { BrowserComputerStore } = await import(urls.store);
    const { browserComputerDirectory, browserComputerStorageName, browserPersistenceDirectory } = await import(urls.storage);
    const store = new BrowserComputerStore();
    const descriptor = { version: 1, id: "shell", title: "Shell", base: "kandelo:shell@local",
      runtime: { arch: "wasm32", kernel: "kernel@local", features: [] }, packages: [],
      mounts: [], boot: { argv: ["/usr/bin/login"], cwd: "/root", env: {} } };
    const computer = await store.create(descriptor);
    const before = await store.filesystemInitialized(computer.id);
    await store.markFilesystemInitialized(computer.id);
    const after = await store.filesystemInitialized(computer.id);
    await store.markFilesystemInitialized(computer.id);
    const interruptedId = crypto.randomUUID();
    const interrupted = await browserComputerDirectory(interruptedId);
    const writer = await (await interrupted.getFileHandle("creating", { create: true })).createWritable();
    await writer.write("1"); await writer.close();
    await store.cleanup();
    let abandonedRemoved = false;
    try { await browserComputerDirectory(interruptedId, false); } catch { abandonedRemoved = true; }
    const unregisteredId = crypto.randomUUID();
    let unregisteredRefused = false;
    try { await browserPersistenceDirectory(browserComputerStorageName(unregisteredId)); } catch { unregisteredRefused = true; }
    await store.remove(computer.id);
    return { before, after, abandonedRemoved, unregisteredRefused };
  }, urls);
  expect(result).toEqual({ before: false, after: true, abandonedRemoved: true, unregisteredRefused: true });
});

test("storage format identification is explicit and unsupported formats are preserved", async ({ page }) => {
  await page.goto("/trap-signal-test.html");
  await page.evaluate(async urls => {
    const { BrowserComputerStore, TEMPORARY_COMPUTER_LIFETIME_MS } = await import(urls.store);
    const { browserComputerDirectory } = await import(urls.storage);
    const store = new BrowserComputerStore();
    const descriptor = { version: 1, id: "shell", title: "Shell", base: "kandelo:shell@local",
      runtime: { arch: "wasm32", kernel: "kernel@local", features: [] }, packages: [],
      mounts: [], boot: { argv: ["/usr/bin/login"], cwd: "/root", env: {} } };
    const saved = await store.create(descriptor, "saved");
    const temporary = await store.create(descriptor, "temporary");
    const format = "kandelo-opfs-image-v1";
    for (const computer of [saved, temporary]) {
      const record = await store.read(computer.id);
      if (record.version !== 2 || record.storageFormat !== format) throw new Error("Computer storage format was not recorded");
    }
    const directory = await browserComputerDirectory(temporary.id);
    const metadata = await directory.getFileHandle("computer.json");
    const sentinel = await directory.getFileHandle("format-sentinel", { create: true });
    const writer = await sentinel.createWritable(); await writer.write("preserved"); await writer.close();
    for (const [version, storageFormat] of [[2, "kandelo-opfs-files-v1"], [1, "kandelo-opfs-image-v2"], [2, null], [2, undefined]]) {
      const contents = JSON.stringify({ ...temporary, version, storageFormat,
        descriptor: storageFormat === "kandelo-opfs-files-v1" ? { ...descriptor, version: 99 } : descriptor });
      const writer = await metadata.createWritable(); await writer.write(contents); await writer.close();
      for (const creating of [false, true]) {
        if (creating) await directory.getFileHandle("creating", { create: true });
        let refused = false;
        try { await store.read(temporary.id); }
        catch (error) { refused = error instanceof Error && error.message.includes("Unsupported computer storage format"); }
        if (!refused) throw new Error("Unsupported storage format was accepted");
        try { await store.update(temporary.id, { title: "Do not write" }); throw new Error("Unsupported format was updated"); }
        catch (error) { if (!(error instanceof Error) || !error.message.includes("Unsupported computer storage format")) throw error; }
        await store.cleanup(Date.now() + TEMPORARY_COMPUTER_LIFETIME_MS + 1);
        if (await (await metadata.getFile()).text() !== contents || await (await sentinel.getFile()).text() !== "preserved") {
          throw new Error("Unsupported storage format was modified or garbage-collected");
        }
        if (!(await store.list()).some(computer => computer.id === saved.id) || store.issues.length !== 1) {
          throw new Error("Unsupported storage format hid healthy computers or lost its diagnostic");
        }
        if (creating) await directory.removeEntry("creating");
      }
    }
    const marker = await directory.getFileHandle("creating", { create: true });
    const markerWriter = await marker.createWritable(); await markerWriter.write("1"); await markerWriter.close();
    for (const contents of [JSON.stringify({ ...temporary, version: 3 }),
      JSON.stringify({ ...temporary, descriptor: { ...descriptor, version: 99 } }), "{broken metadata"]) {
      const writer = await metadata.createWritable(); await writer.write(contents); await writer.close();
      const failures = await store.cleanup(Date.now() + TEMPORARY_COMPUTER_LIFETIME_MS + 1);
      if (failures.length !== 1 || await (await metadata.getFile()).text() !== contents
        || await (await sentinel.getFile()).text() !== "preserved" || await (await marker.getFile()).text() !== "1") {
        throw new Error("Unrecognized metadata was modified during interrupted creation cleanup");
      }
      if (!(await store.list()).some(computer => computer.id === saved.id) || store.issues.length !== 1) {
        throw new Error("Unrecognized metadata hid healthy computers or lost its diagnostic");
      }
    }
    const metadataWriter = await metadata.createWritable(); await metadataWriter.write(JSON.stringify(temporary)); await metadataWriter.close();
    const filePrototype = Object.getPrototypeOf(metadata);
    const getFile = filePrototype.getFile;
    filePrototype.getFile = function (this: FileSystemFileHandle) {
      if (this.name === "computer.json") throw new DOMException("injected unavailable metadata", "NotReadableError");
      return getFile.call(this);
    };
    try {
      if ((await store.cleanup(Number.MAX_SAFE_INTEGER)).length !== 1) throw new Error("Read failure lost its cleanup diagnostic");
    } finally { filePrototype.getFile = getFile; }
    if (await (await metadata.getFile()).text() !== JSON.stringify(temporary)
      || await (await sentinel.getFile()).text() !== "preserved") throw new Error("Read failure deleted computer data");
    await directory.removeEntry("creating");
    const earlier = { ...temporary, version: 1, storageFormat: undefined };
    const earlierText = JSON.stringify(earlier);
    const earlierWriter = await metadata.createWritable(); await earlierWriter.write(earlierText); await earlierWriter.close();
    const normalized = await store.read(temporary.id);
    if (normalized.version !== 2 || normalized.storageFormat !== format || await (await metadata.getFile()).text() !== earlierText) {
      throw new Error("Known prototype schema was not read without modifying storage");
    }
    await store.update(temporary.id, { title: "Kept computer", retention: "saved", opened: true, profileId: "node" });
    const updated = JSON.parse(await (await metadata.getFile()).text());
    if (updated.version !== 2 || updated.storageFormat !== format || await (await sentinel.getFile()).text() !== "preserved") {
      throw new Error("Normal metadata update changed the format or filesystem data");
    }
    await store.remove(saved.id);
    await store.remove(temporary.id);
  }, urls);
});
