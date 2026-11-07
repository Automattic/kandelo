export const POLICY_RECORD_BYTES = 160;
export const POLICY_MAX_INPUT_BYTES = 64 * 1024 * 1024;
export const POLICY_MAX_HEAP_BYTES = 96 * 1024 * 1024;

export interface PolicyWorkerRequest {
  module: WebAssembly.Module;
  source: ArrayBuffer;
  metadataBytes: number;
  workItems: number;
  memoryPages: number;
  heapBytes: number;
}

export type PolicyWorkerFailure = "invalid" | "metadata-limit" | "work-limit" | "allocation" | "trap" | "protocol";
export type PolicyWorkerResponse =
  | { kind: "inspection"; record: Uint8Array }
  | { kind: "failure"; reason: PolicyWorkerFailure; detail?: string };

interface PolicyExports {
  pp_version(): number;
  pp_begin(length: number, budget: number): number;
  pp_inspect(metadata: number, work: number): number;
  pp_result(): number;
  pp_allocation_failed(): number;
}

export function validPolicyRequest(request: PolicyWorkerRequest): boolean {
  return request.module instanceof WebAssembly.Module
    && request.source instanceof ArrayBuffer && request.source.byteLength >= 8
    && request.source.byteLength <= POLICY_MAX_INPUT_BYTES
    && [request.metadataBytes, request.workItems, request.memoryPages, request.heapBytes]
      .every(value => Number.isSafeInteger(value) && value > 0 && value <= 0xffff_ffff)
    && request.memoryPages >= 32 && request.memoryPages <= 2048
    && request.heapBytes >= request.source.byteLength
    && request.heapBytes <= Math.min(POLICY_MAX_HEAP_BYTES, request.memoryPages * 65536 - 2 * 1024 * 1024);
}

export function inspectPolicyInWorker(request: PolicyWorkerRequest): PolicyWorkerResponse {
  if (!validPolicyRequest(request)) return { kind: "failure", reason: "protocol" };
  let exports: PolicyExports | undefined;
  try {
    const memory = new WebAssembly.Memory({ initial: 32, maximum: request.memoryPages });
    const instance = new WebAssembly.Instance(request.module, { env: { memory } });
    exports = instance.exports as unknown as PolicyExports;
    if (exports.pp_version() !== 1) return { kind: "failure", reason: "protocol" };
    const pointer = exports.pp_begin(request.source.byteLength, request.heapBytes);
    if (pointer === 0) return { kind: "failure", reason: exports.pp_allocation_failed() ? "allocation" : "protocol" };
    if (!Number.isSafeInteger(pointer) || pointer < 0 || pointer + request.source.byteLength > memory.buffer.byteLength) {
      return { kind: "failure", reason: "protocol" };
    }
    new Uint8Array(memory.buffer, pointer, request.source.byteLength).set(new Uint8Array(request.source));
    const result = exports.pp_inspect(request.metadataBytes, request.workItems);
    if (result < 0) {
      const reasons: Record<number, PolicyWorkerFailure> = { [-1]: "protocol", [-2]: "invalid", [-3]: "metadata-limit", [-4]: "work-limit", [-5]: "allocation" };
      return { kind: "failure", reason: reasons[result] ?? "protocol" };
    }
    if (result !== POLICY_RECORD_BYTES) return { kind: "failure", reason: "protocol" };
    const output = exports.pp_result();
    if (!Number.isSafeInteger(output) || output <= 0 || output + result > memory.buffer.byteLength) {
      return { kind: "failure", reason: "protocol" };
    }
    return { kind: "inspection", record: new Uint8Array(memory.buffer, output, result).slice() };
  } catch (error) {
    let allocation = false;
    try { allocation = exports?.pp_allocation_failed() === 1; } catch {}
    return { kind: "failure", reason: allocation ? "allocation" : "trap",
      detail: String(error instanceof Error ? error.message : error).slice(0, 512) };
  }
}
