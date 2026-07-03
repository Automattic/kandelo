export const SIGILL = 4;
export const SIGFPE = 8;
export const SIGSEGV = 11;

export type WasmCrashCategory =
  | "memory"
  | "bounds"
  | "stack"
  | "arithmetic"
  | "illegal-instruction";

export interface WasmCrashSignalClassification {
  category: WasmCrashCategory;
  signum: number;
  signalName: "SIGILL" | "SIGFPE" | "SIGSEGV";
  matched: string;
}

interface TrapPattern {
  category: WasmCrashCategory;
  signum: number;
  signalName: WasmCrashSignalClassification["signalName"];
  patterns: RegExp[];
}

const TRAP_PATTERNS: TrapPattern[] = [
  {
    category: "arithmetic",
    signum: SIGFPE,
    signalName: "SIGFPE",
    patterns: [
      /divide by zero/i,
      /division by zero/i,
      /remainder by zero/i,
      /integer overflow/i,
      /integer divide by zero/i,
    ],
  },
  {
    category: "memory",
    signum: SIGSEGV,
    signalName: "SIGSEGV",
    patterns: [
      /memory access out of bounds/i,
      /out of bounds memory access/i,
      /out-of-bounds memory/i,
      /index out of bounds.*memory/i,
      /memory out of bounds/i,
      /unaligned accesses?/i,
    ],
  },
  {
    category: "bounds",
    signum: SIGSEGV,
    signalName: "SIGSEGV",
    patterns: [
      /RuntimeError:[^\n]*\bindex out of bounds\b/i,
      /table index (?:is )?out of bounds/i,
      /table index (?:is )?outside/i,
      /out of bounds call_indirect/i,
      /indirect call.*out of bounds/i,
    ],
  },
  {
    category: "illegal-instruction",
    signum: SIGILL,
    signalName: "SIGILL",
    patterns: [
      /\bunreachable\b/i,
      /call_indirect.*null/i,
      /call_indirect.*type mismatch/i,
      /call_indirect.*signature.*does not match/i,
      /indirect call.*null/i,
      /indirect call.*type mismatch/i,
      /function signature mismatch/i,
      /signature mismatch/i,
      /signature.*does not match/i,
      /type mismatch/i,
      /null function/i,
      /undefined element/i,
      /uninitialized element/i,
    ],
  },
  {
    category: "stack",
    signum: SIGSEGV,
    signalName: "SIGSEGV",
    patterns: [
      /maximum call stack/i,
      /call stack size exceeded/i,
      /call stack exhausted/i,
      /stack overflow/i,
      /stack exhausted/i,
    ],
  },
];

function crashText(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.stack ? `${reason.message}\n${reason.stack}` : reason.message;
  }
  return String(reason ?? "");
}

export function classifyWasmCrashSignal(reason: unknown): WasmCrashSignalClassification | null {
  const text = crashText(reason);
  if (!text) return null;

  for (const group of TRAP_PATTERNS) {
    for (const pattern of group.patterns) {
      const match = pattern.exec(text);
      if (!match) continue;
      return {
        category: group.category,
        signum: group.signum,
        signalName: group.signalName,
        matched: match[0],
      };
    }
  }

  return null;
}

export function signalExitStatus(signum: number): number {
  return 128 + signum;
}

export function classifiedSignalOrFallback(
  reason: unknown,
  fallback: number = SIGSEGV,
): number {
  return classifyWasmCrashSignal(reason)?.signum ?? fallback;
}

export function classifiedTrapExitStatus(reason: unknown): number | null {
  const classification = classifyWasmCrashSignal(reason);
  return classification ? signalExitStatus(classification.signum) : null;
}
