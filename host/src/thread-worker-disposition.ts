import {
  classifiedTrapExitStatus,
  SIGSEGV,
} from "./trap-signals";

export type ThreadWorkerFailureDisposition =
  | {
    kind: "guest-fatal-trap";
    exitStatus: number;
    signum: number;
  }
  | {
    kind: "host-thread-failure";
  };

/** Remove one worker generation and retire an empty per-process registry slot. */
export function removeThreadWorkerRegistryEntry<T>(
  registry: Map<number, T[]>,
  pid: number,
  entry: T,
): boolean {
  const entries = registry.get(pid);
  if (!entries) return false;
  const index = entries.indexOf(entry);
  if (index < 0) return false;
  entries.splice(index, 1);
  if (entries.length === 0) registry.delete(pid);
  return true;
}

function signalFromExitStatus(exitStatus: number): number | null {
  return exitStatus >= 128 ? (exitStatus - 128) & 0x7f : null;
}

export function threadWorkerFailureDisposition(reason: unknown): ThreadWorkerFailureDisposition {
  const exitStatus = classifiedTrapExitStatus(reason);
  if (exitStatus === null) {
    return { kind: "host-thread-failure" };
  }
  return {
    kind: "guest-fatal-trap",
    exitStatus,
    signum: signalFromExitStatus(exitStatus) ?? SIGSEGV,
  };
}
