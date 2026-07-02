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
