export interface OpfsFileReference {
  path: readonly string[];
}

export function snapshotOpfsFileReference(value: unknown): OpfsFileReference {
  const path = (value as Partial<OpfsFileReference> | null)?.path;
  if (!Array.isArray(path) || path.length === 0 || path.length > 32
    || path.some(part => typeof part !== "string" || !part || part.length > 255 || part === "." || part === ".."
      || /[\/\\\0]/.test(part) || new TextEncoder().encode(part).length > 255)
    || new TextEncoder().encode(path.join("/")).length > 4096) {
    throw new Error("Invalid OPFS file reference");
  }
  return { path: [...path] };
}

export async function referenceOpfsFile(file: FileSystemFileHandle): Promise<OpfsFileReference> {
  const root = await navigator.storage.getDirectory();
  return snapshotOpfsFileReference({ path: await root.resolve(file) });
}

export async function openOpfsFileReference(reference: OpfsFileReference): Promise<FileSystemFileHandle> {
  const { path } = snapshotOpfsFileReference(reference);
  let directory = await navigator.storage.getDirectory();
  for (const component of path.slice(0, -1)) directory = await directory.getDirectoryHandle(component);
  return directory.getFileHandle(path[path.length - 1]);
}
