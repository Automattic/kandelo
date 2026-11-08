import type { DmesgProgress } from "../../../../../web-libs/kandelo-session/src/kernel-host";
import type { ImageCodecProgress } from "./persistent-image-codec-protocol";

export type PersistentImageProgress = ImageCodecProgress & { status: "loading" | "complete" | "error" };

export async function runWithPersistentImageProgress<Result>(
  operation: (update: (progress: ImageCodecProgress) => void) => Promise<Result>,
  report: (progress: PersistentImageProgress) => void,
): Promise<Result> {
  let current: ImageCodecProgress | undefined;
  try {
    const result = await operation(progress => {
      if (current && current.phase !== progress.phase) report({ ...current, status: "complete" });
      current = progress;
      report({ ...progress, status: "loading" });
    });
    if (current) report({ ...current, status: "complete" });
    return result;
  } catch (error) {
    if (current) {
      try { report({ ...current, status: "error" }); } catch {}
    }
    throw error;
  }
}

export function persistentImageProgress(operationId: string, progress: PersistentImageProgress): DmesgProgress {
  return {
    id: `${operationId}/persistent-image/${progress.phase}`,
    label: `${progress.phase === "write" ? "Writing" : "Verifying"} persistent image`,
    completed: progress.bytes,
    total: progress.total,
    unit: "bytes",
    status: progress.status,
  };
}
