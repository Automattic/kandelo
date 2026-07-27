import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  auditKernelExportFailureCatches,
  formatKernelExportFailureAudit,
  type KernelExportFailureCatchAllowance,
} from "./support/kernel-export-failure-audit";

const reservationSettlementAllowances = [
  {
    owner:
      "CentralizedKernelWorker.#executeReservedChannelDispatch",
    why:
      "The catch records the branded execute trap, then its finally revokes "
      + "the lease and deliberately skips cancellation because Rust settlement "
      + "is unknown before throwing one fatal wrapper.",
  },
  {
    owner:
      "CentralizedKernelWorker.#executeReservedScratchTransfer",
    why:
      "The catch records the branded execute trap, then its finally revokes "
      + "the lease and deliberately skips cancellation because Rust settlement "
      + "is unknown before throwing one fatal wrapper.",
  },
  {
    owner:
      "CentralizedKernelWorker.#handleSpawnAfterResolve",
    why:
      "The reserved spawn catch records the branded commit trap, then its "
      + "finally revokes the lease and skips cancellation because Rust "
      + "settlement is unknown before throwing one fatal wrapper.",
  },
  {
    owner:
      "CentralizedKernelWorker.#readKernelOwnedPath",
    why:
      "The large canonical-path catch records a branded reservation or copy "
      + "trap, then its finally revokes the lease and skips cancellation "
      + "because Rust settlement is unknown before throwing one fatal wrapper.",
  },
  {
    owner:
      "CentralizedKernelWorker.#replaceProcessMetadataWithinKernelEntry",
    why:
      "The metadata transaction catch records a branded stage or commit trap "
      + "before finally decides whether cancellation is still safe. A trapped "
      + "Rust instance must be poisoned without entering its cancel export.",
  },
] satisfies KernelExportFailureCatchAllowance[];

describe("kernel export-failure catch audit", () => {
  it("rejects an errno fallback before the gate's deferred fatal observer", () => {
    const source = `
      class CentralizedKernelWorker {
        #invokeEntryScratchExport(): void {}
        #dispatch(): void {
          this.#invokeEntryScratchExport();
        }
        handle(): number {
          try {
            this.#dispatch();
            return 0;
          } catch (error) {
            return 5;
          }
        }
      }
    `;
    expect(
      auditKernelExportFailureCatches(source).violations,
    ).toEqual([
      expect.objectContaining({
        owner: "CentralizedKernelWorker.handle",
      }),
    ]);
  });

  it("follows an export callable extracted before the guarded try", () => {
    const source = `
      interface KernelWorkerEntryContext {
        instance: WebAssembly.Instance;
      }
      class CentralizedKernelWorker {
        handle(entry: KernelWorkerEntryContext): number {
          const fn = entry.instance.exports.some_export as () => number;
          try {
            return fn();
          } catch {
            return 5;
          }
        }
      }
    `;
    expect(
      auditKernelExportFailureCatches(source).violations,
    ).toEqual([
      expect.objectContaining({
        owner: "CentralizedKernelWorker.handle",
      }),
    ]);
  });

  it("follows callable properties selected through an export namespace alias", () => {
    const source = `
      interface KernelWorkerEntryContext {
        instance: WebAssembly.Instance;
      }
      class CentralizedKernelWorker {
        handle(entry: KernelWorkerEntryContext): number {
          const kernelExports = entry.instance.exports;
          const begin = kernelExports.kernel_transfer_scratch_begin as
            () => number;
          try {
            return begin();
          } catch {
            return 5;
          }
        }
      }
    `;
    expect(
      auditKernelExportFailureCatches(source).violations,
    ).toEqual([
      expect.objectContaining({
        owner: "CentralizedKernelWorker.handle",
      }),
    ]);
  });

  it("follows a callable destructured from an export namespace", () => {
    const source = `
      interface KernelWorkerEntryContext {
        instance: WebAssembly.Instance;
      }
      class CentralizedKernelWorker {
        handle(entry: KernelWorkerEntryContext): number {
          const kernelExports = entry.instance.exports;
          const { kernel_transfer_scratch_begin: begin } = kernelExports;
          try {
            return begin();
          } catch {
            return 5;
          }
        }
      }
    `;
    expect(
      auditKernelExportFailureCatches(source).violations,
    ).toHaveLength(1);
  });

  it("accepts the exact branded value as the first catch action", () => {
    const source = `
      class CentralizedKernelWorker {
        #invokeEntryScratchExport(): void {}
        #rethrowKernelEntryFatal(_error: unknown): void {}
        #capacityOwnedOrdinary(): void {
          this.#invokeEntryScratchExport();
        }
        #capacityOwnedReserved(): void {
          this.#capacityOwnedOrdinary();
        }
        handle(useReserved: boolean): number {
          try {
            if (useReserved) this.#capacityOwnedReserved();
            else this.#capacityOwnedOrdinary();
            return 0;
          } catch (error) {
            this.#rethrowKernelEntryFatal(error);
            return 5;
          }
        }
      }
    `;
    expect(formatKernelExportFailureAudit(
      auditKernelExportFailureCatches(source),
    )).toEqual([]);
  });

  it("requires an explicit owner allowance for deferred settlement", () => {
    const source = `
      function isKernelExportFailure(_error: unknown): boolean {
        return false;
      }
      class CentralizedKernelWorker {
        #invokeEntryScratchExport(): void {}
        #reserved(): void {
          try {
            this.#invokeEntryScratchExport();
          } catch (error) {
            if (isKernelExportFailure(error)) {
              const fatal = error;
              void fatal;
            }
          }
        }
      }
    `;
    expect(
      auditKernelExportFailureCatches(source).violations,
    ).toHaveLength(1);
    expect(formatKernelExportFailureAudit(
      auditKernelExportFailureCatches(source, [{
        owner: "CentralizedKernelWorker.#reserved",
        why: "The fixture models settlement in finally.",
      }]),
    )).toEqual([]);
  });

  it("rejects duplicate and empty-WHY settlement allowances", () => {
    const source = `
      class CentralizedKernelWorker {
        #invokeEntryScratchExport(): void {}
        #reserved(): void {
          try {
            this.#invokeEntryScratchExport();
          } catch (error) {
            if (isKernelExportFailure(error)) void error;
          }
        }
      }
    `;
    const result = auditKernelExportFailureCatches(source, [
      {
        owner: "CentralizedKernelWorker.#reserved",
        why: "",
      },
      {
        owner: "CentralizedKernelWorker.#reserved",
        why: "duplicate",
      },
    ]);
    expect(result.contractErrors).toEqual([
      "kernel-export catch allowance "
        + "CentralizedKernelWorker.#reserved has an empty WHY",
      "duplicate kernel-export catch allowance: "
        + "CentralizedKernelWorker.#reserved",
    ]);
  });

  it("requires one owner allowance to match exactly one catch", () => {
    const source = `
      class CentralizedKernelWorker {
        #invokeEntryScratchExport(): void {}
        #reserved(): void {
          try {
            this.#invokeEntryScratchExport();
          } catch (first) {
            if (isKernelExportFailure(first)) void first;
          }
          try {
            this.#invokeEntryScratchExport();
          } catch (second) {
            if (isKernelExportFailure(second)) void second;
          }
        }
      }
    `;
    const result = auditKernelExportFailureCatches(source, [{
      owner: "CentralizedKernelWorker.#reserved",
      why: "Each fixture catch models a distinct deferred settlement.",
    }]);
    expect(result.contractErrors).toEqual([
      "kernel-export catch allowance CentralizedKernelWorker.#reserved "
        + "matched 2 catches; each allowance must identify exactly one "
        + "settlement catch",
    ]);
  });

  it("guards every live worker catch that can receive an export trap", () => {
    const source = readFileSync(
      new URL("../src/kernel-worker.ts", import.meta.url),
      "utf8",
    );
    const result = auditKernelExportFailureCatches(
      source,
      reservationSettlementAllowances,
    );
    expect(formatKernelExportFailureAudit(result)).toEqual([]);
    expect(result.exportBearingOwners).toEqual(expect.arrayContaining([
      "CentralizedKernelWorker.#beginLargeSpawnScratch",
      "CentralizedKernelWorker.#beginLargeTransferScratch",
    ]));
  });
});
