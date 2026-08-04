import { describe, expect, it } from "vitest";
import { MockWorkerHandle } from "../src/worker-adapter";
import {
  PrestartedWorkerPool,
  prestartedWorkerPoolSize,
} from "../src/prestarted-worker-pool";

class TestPhysicalWorker extends MockWorkerHandle {
  terminationCount = 0;

  override async terminate(): Promise<number> {
    this.terminationCount++;
    this.simulateExit(0);
    return 0;
  }
}

function testPool(targetSize = 4): {
  pool: PrestartedWorkerPool;
  physicalWorkers: TestPhysicalWorker[];
} {
  const physicalWorkers: TestPhysicalWorker[] = [];
  return {
    pool: new PrestartedWorkerPool(() => {
      const worker = new TestPhysicalWorker();
      physicalWorkers.push(worker);
      return worker;
    }, targetSize),
    physicalWorkers,
  };
}

describe("PrestartedWorkerPool", () => {
  it("caps pristine runners below larger process-admission limits", () => {
    expect(prestartedWorkerPoolSize(2)).toBe(2);
    expect(prestartedWorkerPoolSize(24)).toBe(4);
  });

  it("starts its bounded reserve before the first lease", async () => {
    const { pool, physicalWorkers } = testPool(2);

    expect(physicalWorkers).toHaveLength(2);
    expect(physicalWorkers.map((worker) => worker.sentMessages)).toEqual([
      [],
      [],
    ]);
    await pool.destroy();
  });

  it("leases every realm once and physically terminates it", async () => {
    const { pool, physicalWorkers } = testPool(1);
    const firstPhysical = physicalWorkers[0];
    const first = pool.createWorker({ type: "centralized_init", pid: 11 });
    await Promise.resolve();
    const secondPhysical = physicalWorkers[1];

    // Even a valid terminal fence cannot put a used realm back in the reserve.
    firstPhysical.simulateMessage({ type: "memory_quiescent", pid: 11 });
    await first.terminate();
    const second = pool.createWorker({ type: "centralized_init", pid: 12 });

    expect(secondPhysical).not.toBe(firstPhysical);
    expect(firstPhysical.sentMessages).toEqual([
      { type: "centralized_init", pid: 11 },
    ]);
    expect(secondPhysical.sentMessages).toEqual([
      { type: "centralized_init", pid: 12 },
    ]);
    expect(firstPhysical.terminationCount).toBe(1);

    await second.terminate();
    await pool.destroy();
  });

  it("retires a failed pristine worker instead of leasing it", async () => {
    const { pool, physicalWorkers } = testPool(1);
    physicalWorkers[0].simulateError(new Error("module failed"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const lease = pool.createWorker({ type: "centralized_init", pid: 21 });

    expect(physicalWorkers).toHaveLength(2);
    expect(physicalWorkers[0].terminationCount).toBe(1);
    expect(physicalWorkers[1].sentMessages).toEqual([
      { type: "centralized_init", pid: 21 },
    ]);
    await lease.terminate();
    await pool.destroy();
  });

  it("terminates pristine and leased workers at machine teardown", async () => {
    const { pool, physicalWorkers } = testPool(2);
    pool.createWorker({ type: "centralized_init", pid: 31 });
    await Promise.resolve();

    expect(physicalWorkers).toHaveLength(3);
    await pool.destroy();
    expect(physicalWorkers.map((worker) => worker.terminationCount)).toEqual([
      1,
      1,
      1,
    ]);
    expect(() => pool.createWorker({ pid: 32 })).toThrow(/destroyed/);
  });

  it("rejects invalid reserve sizes without starting a worker", () => {
    let creations = 0;
    expect(() => new PrestartedWorkerPool(() => {
      creations++;
      return new TestPhysicalWorker();
    }, -1)).toThrow(/invalid prestarted worker pool size/);
    expect(creations).toBe(0);
  });
});
