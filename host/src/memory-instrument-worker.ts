import { instrumentProgram } from "./memory-instrument.ts";

export interface ProgramRewriteRequest {
  instrumenter: WebAssembly.Module;
  program: ArrayBuffer;
}

export type ProgramRewriteResponse =
  | { kind: "rewritten"; program: ArrayBuffer }
  | { kind: "failure"; detail: string };

export function rewriteProgramInWorker(request: ProgramRewriteRequest): ProgramRewriteResponse {
  try {
    const rewritten = instrumentProgram(request.instrumenter, new Uint8Array(request.program));
    return { kind: "rewritten", program: rewritten.buffer as ArrayBuffer };
  } catch (error) {
    return { kind: "failure", detail: error instanceof Error ? error.message : String(error) };
  }
}
