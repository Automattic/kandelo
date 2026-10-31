import { createBrowserPolicyWorkerFactory } from "../../../../host/src/program-policy-browser";
import { ProgramPolicyError, ProgramPolicyInspector } from "../../../../host/src/program-policy";

let inspector: ProgramPolicyInspector | undefined;
let module: WebAssembly.Module | undefined;

export interface ProgramPolicyFixture {
  initialize(): Promise<void>;
  close(): Promise<void>;
  inspect(source: number[], changes?: { heapBytes?: number; metadataBytes?: number; workItems?: number; memoryPages?: number; abort?: boolean }): Promise<{
    reason?: string; detail?: string; record?: number[]; active: { jobs: number; workspace: number };
  }>;
}

const fixture: ProgramPolicyFixture = {
  async initialize() {
    const response = await fetch("/program-policy.wasm");
    if (!response.ok) throw new Error(`Policy module fetch failed: ${response.status}`);
    module = await WebAssembly.compile(await response.arrayBuffer());
    inspector = new ProgramPolicyInspector(await createBrowserPolicyWorkerFactory(), {
      maximumJobs: 1, maximumWorkspace: 64 * 1024 * 1024,
    });
  },
  async close() { await inspector?.close(); },
  async inspect(bytes, changes = {}) {
    if (!module || !inspector) throw new Error("Policy module not initialized");
    const controller = new AbortController();
    try {
      const result = inspector.inspect({
        module, source: Uint8Array.from(bytes).buffer,
        metadataBytes: changes.metadataBytes ?? 1024 * 1024,
        workItems: changes.workItems ?? 1_000_000,
        memoryPages: changes.memoryPages ?? 64,
        heapBytes: changes.heapBytes ?? 2 * 1024 * 1024,
      }, { timeoutMs: 15_000, signal: controller.signal });
      if (changes.abort) controller.abort();
      const record = await result;
      return { record: Array.from(record), active: inspector.active };
    } catch (error) {
      if (!(error instanceof ProgramPolicyError)) throw error;
      return { reason: error.reason, detail: error.message, active: inspector.active };
    }
  },
};

(window as Window & { __programPolicy: ProgramPolicyFixture }).__programPolicy = fixture;
