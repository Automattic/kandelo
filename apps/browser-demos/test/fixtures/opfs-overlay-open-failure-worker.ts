import { OpfsOverlayStorageFile } from "../../../../host/src/vfs/overlay-storage";

async function run(): Promise<Record<string, unknown>> {
  const root = await navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle("kandelo-persistent-overlay", { create: true });
  const probeName = `overlay-probe-${crypto.randomUUID()}`;
  const probeFile = await directory.getFileHandle(probeName, { create: true });
  const probeAccess = await probeFile.createSyncAccessHandle();
  const rootPrototype = Object.getPrototypeOf(root) as any;
  const directoryPrototype = Object.getPrototypeOf(directory) as any;
  const filePrototype = Object.getPrototypeOf(probeFile) as any;
  probeAccess.close();
  await directory.removeEntry(probeName);

  const originalGetDirectoryHandle = rootPrototype.getDirectoryHandle;
  const originalGetFileHandle = directoryPrototype.getFileHandle;
  const originalCreateSyncAccessHandle = filePrototype.createSyncAccessHandle;
  const journalName = `overlay-quota-${crypto.randomUUID()}`;
  const filename = `${journalName}.g0.journal`;
  let failDirectory = false;
  let failFile = false;
  let accessFailure: "quota" | "not-found" | null = null;
  const quotaError = () => new DOMException("injected quota exhaustion", "QuotaExceededError");

  rootPrototype.getDirectoryHandle = async function (name: string, options?: FileSystemGetDirectoryOptions) {
    if (failDirectory && name === "kandelo-persistent-overlay") throw quotaError();
    return originalGetDirectoryHandle.call(this, name, options);
  };
  directoryPrototype.getFileHandle = async function (name: string, options?: FileSystemGetFileOptions) {
    if (failFile && name === filename) throw quotaError();
    return originalGetFileHandle.call(this, name, options);
  };
  filePrototype.createSyncAccessHandle = async function (...args: unknown[]) {
    if (this.name === filename && accessFailure !== null) {
      throw accessFailure === "quota"
        ? quotaError()
        : new DOMException("file disappeared", "NotFoundError");
    }
    return originalCreateSyncAccessHandle.apply(this, args);
  };

  const open = async (create: boolean) => {
    try {
      const storage = await OpfsOverlayStorageFile.openFile(journalName, "g0", "journal", create);
      storage?.close();
      return { resolved: true, missing: storage === null };
    } catch (error) {
      return {
        resolved: false,
        code: error instanceof Error && "code" in error ? error.code : null,
        message: String(error),
      };
    }
  };

  try {
    failDirectory = true;
    const directoryFailure = await open(true);
    failDirectory = false;
    failFile = true;
    const fileFailure = await open(true);
    failFile = false;
    accessFailure = "quota";
    const accessFailureResult = await open(true);
    accessFailure = "not-found";
    const disappeared = await open(false);
    accessFailure = null;
    await directory.removeEntry(filename);
    const missing = await open(false);
    return { directoryFailure, fileFailure, accessFailureResult, disappeared, missing };
  } finally {
    rootPrototype.getDirectoryHandle = originalGetDirectoryHandle;
    directoryPrototype.getFileHandle = originalGetFileHandle;
    filePrototype.createSyncAccessHandle = originalCreateSyncAccessHandle;
  }
}

self.onmessage = () => {
  void run().then(
    (result) => self.postMessage({ type: "result", result }),
    (error) => self.postMessage({ type: "error", message: String(error) }),
  );
};
