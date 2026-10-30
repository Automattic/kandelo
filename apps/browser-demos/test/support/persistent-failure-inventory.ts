import type { Page } from "@playwright/test";
import { MAX_IMAGE_MANIFEST_BYTES } from "../../../../host/src/vfs/image-manifest-memory";

export function planPersistentFailureCapture(
  files: readonly { name: string; size: number }[],
  maximumBytes = 1024 * 1024 * 1024,
) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new Error("failure capture requires a nonnegative safe byte limit");
  }
  let remainingBytes = maximumBytes;
  const selected: { name: string; size: number }[] = [];
  const omitted: { name: string; size: number; reason: string }[] = [];
  for (const file of files) {
    if (!Number.isSafeInteger(file.size) || file.size < 0) {
      throw new Error("failure capture requires nonnegative safe file sizes");
    }
    if (!/\.(?:journal|index|seal|json|vfs|base|activation[01])$/.test(file.name)) {
      omitted.push({ ...file, reason: "unsupported capture filename" });
    } else if (file.size > remainingBytes) {
      omitted.push({ ...file, reason: "capture byte limit" });
    } else {
      selected.push(file);
      remainingBytes -= file.size;
    }
  }
  return { selected, omitted, maximumBytes, plannedBytes: maximumBytes - remainingBytes };
}

export async function persistentFailureInventory(page: Page, prefix: string) {
  if (!/^wordpress-workload-[a-zA-Z0-9_-]+$/.test(prefix)) {
    throw new Error("failure capture requires its owned workload computer");
  }
  return page.evaluate(async ({ prefix, manifestLimit }) => {
    const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle("kandelo-persistent-overlay");
    const namespaces = new Set([prefix]);
    const diagnostics: string[] = [];
    for (const control of ["base.json", "previous.base.json", "active.base.json"]) {
      const name = `${prefix}.${control}`;
      try {
        const file = await (await directory.getFileHandle(name)).getFile();
        if (file.size > manifestLimit) {
          diagnostics.push(`${name}: manifest exceeds capture limit`);
          continue;
        }
        const record = JSON.parse(await file.text());
        const manifests = control === "active.base.json" ? [record?.target, record?.source] : [record];
        for (const manifest of manifests) {
          if (!/^kandelo-fixed-rootfs-image-v[1-6]$/.test(manifest?.format ?? "")) continue;
          const journalName = manifest?.journalName;
          if (journalName === prefix || typeof journalName === "string"
            && /^j-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(journalName)) {
            namespaces.add(journalName);
          }
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "NotFoundError") continue;
        diagnostics.push(`${name}: ${String(error).slice(0, 512)}`);
      }
    }
    const files: { name: string; size: number; modified: number }[] = [];
    for await (const [name, entry] of directory.entries()) {
      if (entry.kind !== "file") continue;
      const ownedImage = name.startsWith(`${prefix}.`);
      const ownedJournal = [...namespaces].some(namespace => {
        if (!name.startsWith(`${namespace}.`)) return false;
        return /^(?:journal|activation[01]|g(?:0|[1-9][0-9]*)\.(?:journal|index|seal))$/.test(name.slice(namespace.length + 1));
      });
      if (!ownedImage && !ownedJournal) continue;
      if (files.length >= 256) throw new Error("owned failure inventory exceeds 256 files");
      const file = await (entry as FileSystemFileHandle).getFile();
      files.push({ name, size: file.size, modified: file.lastModified });
    }
    return { files: files.sort((left, right) => left.size - right.size), diagnostics };
  }, { prefix, manifestLimit: MAX_IMAGE_MANIFEST_BYTES });
}
