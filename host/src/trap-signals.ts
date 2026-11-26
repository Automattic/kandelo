import { WASM_INDIRECT_CALL_TRAPS } from "./generated/abi";

export const SIGILL = 4;
export const SIGFPE = 8;
export const SIGSEGV = 11;

export type WasmIndirectCallTrap =
  typeof WASM_INDIRECT_CALL_TRAPS[keyof typeof WASM_INDIRECT_CALL_TRAPS];

const NULL_OR_SIGNATURE_MISMATCH = /\bnull function or function signature mismatch\b/i;
const INDIRECT_CALL_SIGNATURE_MISMATCH = /\b(?:indirect call (?:type|signature) mismatch|call_indirect (?:type mismatch|to a signature that does not match)|function signature mismatch)\b/i;

/** Observe the engine's message while the error still has its Wasm type. */
export function observeWasmIndirectCallTrap(reason: unknown): WasmIndirectCallTrap | undefined {
  if (!(reason instanceof WebAssembly.RuntimeError)) return undefined;
  const [message = ""] = reason.message.split("\n", 1);
  if (NULL_OR_SIGNATURE_MISMATCH.test(message)) {
    return WASM_INDIRECT_CALL_TRAPS.nullOrSignatureMismatch;
  }
  if (INDIRECT_CALL_SIGNATURE_MISMATCH.test(message)) {
    return WASM_INDIRECT_CALL_TRAPS.signatureMismatch;
  }
  return undefined;
}

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
      NULL_OR_SIGNATURE_MISMATCH,
      INDIRECT_CALL_SIGNATURE_MISMATCH,
      /indirect call.*null/i,
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
