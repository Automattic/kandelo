import {
  ForkHostImportOwnerRuntime,
  type ForkHostImportOwnerWorker,
  type ForkHostImportWorkerInit,
} from "../src/fork-host-import-runtime";
import { ForkExternrefProcessOwner } from "../src/fork-externref-process-owner";
import type { ForkExternrefGeneration } from "../src/fork-reference-broker";
import type { WorkerHandle } from "../src/worker-adapter";
import type { WorkerToHostMessage } from "../src/worker-protocol";

export interface TestProcessReferenceInit {
  readonly externrefGenerationId: number;
  readonly forkHostImports: ForkHostImportWorkerInit;
}

interface TestProcessReferenceRecord {
  readonly generation: ForkExternrefGeneration;
  readonly imports: ForkHostImportOwnerWorker;
  worker?: WorkerHandle;
  messageHandler?: (message: unknown) => void;
}

/**
 * Process-owned reference authority for tests that spawn process Workers
 * directly instead of using NodeKernelHost or BrowserKernelHost.
 */
export class TestProcessReferenceOwners {
  private readonly owner = new ForkExternrefProcessOwner();
  private readonly runtime = new ForkHostImportOwnerRuntime(this.owner);
  private readonly records = new Map<number, TestProcessReferenceRecord>();

  start(pid: number): TestProcessReferenceInit {
    return this.install(this.owner.startGeneration(pid));
  }

  fork(
    parentPid: number,
    childPid: number,
    memory: WebAssembly.Memory,
    ptrWidth: 4 | 8,
    moduleBufferAddress: number,
  ): TestProcessReferenceInit {
    const parent = this.records.get(parentPid);
    if (!parent) {
      throw new Error(
        `missing test reference owner for fork parent ${parentPid}`,
      );
    }
    const child = this.owner.forkGenerationFromContinuation(
      parent.generation,
      childPid,
      memory,
      ptrWidth,
      moduleBufferAddress,
      `direct-worker test fork child pid=${childPid}`,
    ).generation;
    return this.install(child);
  }

  attach(pid: number, worker: WorkerHandle): void {
    const record = this.requireRecord(pid);
    if (record.worker !== undefined) {
      throw new Error(
        `test reference owner for pid=${pid} is already attached`,
      );
    }
    record.worker = worker;
    const messageHandler = (raw: unknown): void => {
      const message = raw as WorkerToHostMessage;
      if (
        message.type === "fork_host_import" &&
        this.records.get(pid) === record &&
        record.worker === worker
      ) {
        record.imports.dispatch(message.wake);
      }
    };
    record.messageHandler = messageHandler;
    worker.on("message", messageHandler);
  }

  release(pid: number): void {
    const record = this.records.get(pid);
    if (!record) return;
    this.records.delete(pid);
    if (record.worker && record.messageHandler) {
      record.worker.off("message", record.messageHandler);
    }
    record.imports.close();
    this.owner.releaseGeneration(record.generation);
  }

  close(): void {
    for (const pid of [...this.records.keys()]) this.release(pid);
  }

  private install(
    generation: ForkExternrefGeneration,
  ): TestProcessReferenceInit {
    const pid = generation.pid;
    if (this.records.has(pid)) {
      this.owner.releaseGeneration(generation);
      throw new Error(`duplicate test reference owner for pid=${pid}`);
    }
    let record: TestProcessReferenceRecord;
    const imports = this.runtime.createWorker({
      pid,
      generationId: generation.id,
      authorizeSender: () => {
        // WHY: numeric PID/generation/sender fields arrive through shared
        // memory. The independently observed Worker object is the authority.
        if (this.records.get(pid) !== record || record.worker === undefined) {
          throw new Error(`stale direct-worker test sender for pid=${pid}`);
        }
      },
    });
    record = { generation, imports };
    this.records.set(pid, record);
    return {
      externrefGenerationId: generation.id,
      forkHostImports: imports.init,
    };
  }

  private requireRecord(pid: number): TestProcessReferenceRecord {
    const record = this.records.get(pid);
    if (!record) throw new Error(`missing test reference owner for pid=${pid}`);
    return record;
  }
}
