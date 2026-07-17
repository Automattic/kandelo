const params = new URL(self.location.href).searchParams;
const mode = params.get("mode");
let createCalls = 0;
let flushCalls = 0;
let moveCalls = 0;
let injected = false;
let flushFailureArmed = mode === "flush-once";
let reopenFailureHandle: FileSystemFileHandle | null = null;

async function initialize(initEvent: MessageEvent): Promise<void> {
  if (initEvent.data?.type !== "init") return;

  const root = await navigator.storage.getDirectory();
  const probeName = `.kandelo-opfs-fault-probe-${crypto.randomUUID()}`;
  const probeFile = await root.getFileHandle(probeName, { create: true });
  const probeAccess = await probeFile.createSyncAccessHandle();
  const fileHandlePrototype = Object.getPrototypeOf(probeFile) as any;
  const accessHandlePrototype = Object.getPrototypeOf(probeAccess) as any;
  probeAccess.close();
  await root.removeEntry(probeName);

  const originalMove = fileHandlePrototype.move;
  const originalCreateSyncAccessHandle =
    fileHandlePrototype.createSyncAccessHandle;
  const originalFlush = accessHandlePrototype.flush;

  fileHandlePrototype.move = async function (...args: unknown[]): Promise<void> {
    await originalMove.apply(this, args);
    moveCalls++;
    if (mode === "reopen-once" && moveCalls === 2) {
      reopenFailureHandle = this as FileSystemFileHandle;
    }
  };

  fileHandlePrototype.createSyncAccessHandle = async function (
    ...args: unknown[]
  ): Promise<FileSystemSyncAccessHandle> {
    createCalls++;
    if (
      mode === "reopen-once" &&
      !injected &&
      this === reopenFailureHandle
    ) {
      injected = true;
      throw new DOMException(
        "injected access-handle reopen failure",
        "NoModificationAllowedError",
      );
    }
    return originalCreateSyncAccessHandle.apply(this, args);
  };

  accessHandlePrototype.flush = function (...args: unknown[]): void {
    flushCalls++;
    if (flushFailureArmed) {
      flushFailureArmed = false;
      injected = true;
      throw new DOMException("injected flush failure", "QuotaExceededError");
    }
    originalFlush.apply(this, args);
  };

  await import("../../../../host/src/vfs/opfs-worker");
  const productionOnMessage = self.onmessage;
  self.onmessage = (event: MessageEvent) => {
    if (event.data?.type === "fault-stats") {
      self.postMessage({
        type: "fault-stats",
        injected,
        createCalls,
        flushCalls,
        moveCalls,
      });
      return;
    }
    return productionOnMessage?.call(self, event);
  };

  await productionOnMessage?.call(self, initEvent);
}

self.onmessage = (event: MessageEvent) => {
  void initialize(event).catch((error) => {
    self.postMessage({
      type: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  });
};
