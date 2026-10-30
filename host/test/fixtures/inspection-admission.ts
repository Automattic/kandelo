import type { CentralizedKernelWorker } from "../../src/kernel-worker";

export async function exerciseInspectionAdmission(worker: CentralizedKernelWorker, variant: "directory" | "resources") {
  worker.rootfsReadDirectory("/");
  worker.rootfsLazyResourceLimits().dispose();
  const budget = worker.rootfsTransportMetadataBudget();
  const before = budget.used;
  const ioBefore = worker.rootfsIoMemory().used;
  const held = budget.reserve(budget.limit - before);
  let failure: { code?: unknown; errno?: unknown; message: string } | undefined;
  try {
    if (variant === "directory") worker.rootfsReadDirectory("/");
    else worker.rootfsLazyResourceLimits().dispose();
  } catch (error) {
    const detail = error as { code?: unknown; errno?: unknown };
    failure = { code: detail.code, errno: detail.errno, message: String(error) };
  } finally { held.release(); }
  await Promise.resolve();
  const ioAfter = worker.rootfsIoMemory().used;
  const state = new TextDecoder().decode(worker.rootfsReadFile("/state"));
  const mode = worker.rootfsStatMode("/state") & 0o7777;
  const entries = worker.rootfsReadDirectory("/").length;
  const resources = worker.rootfsLazyResourceLimits();
  let urls: number;
  try { urls = resources.size; } finally { resources.dispose(); }
  worker.rootfsWriteFile("/after-inspection-refusal", new TextEncoder().encode("usable journal"), 0o640);
  worker.syncRootfsPersistence();
  return { failure, before, remaining: budget.used, ioBefore, ioAfter, state, mode, entries, urls };
}
