import { describe, expect, it, vi } from "vitest";
import {
  ExactProcessGenerationDetachLedger,
  type ExactProcessGenerationDetach,
} from "../src/process-generation-detach";
import { retireSupersededExecGeneration, type ProcessGenerationOwnership } from "../src/process-lifecycle";
import { ProcessMemoryAllocator } from "../src/process-memory";

interface Generation {
  readonly name: string;
  readonly memory: WebAssembly.Memory;
}

function generation(name: string): Generation {
  return {
    name,
    memory: new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }),
  };
}

// Use the actual lease contract, including its private execution-owner identity.
function ownedGeneration(): ProcessGenerationOwnership {
  const allocator = new ProcessMemoryAllocator({ maxMemories: 1, maxTotalBytes: 65536 });
  const memoryLease = allocator.acquire({ ptrWidth: 4, initialPages: 1, maximumPages: 1 });
  return { memory: memoryLease.memory, memoryLease };
}

function harness() {
  const current = new Map<number, Generation>();
  const removed: string[] = [];
  const ledger = new ExactProcessGenerationDetachLedger<Generation>(
    (pid) => current.get(pid),
    (pid, exact) => {
      removed.push(exact.name);
      if (current.get(pid) === exact) current.delete(pid);
    },
  );
  return { current, removed, ledger };
}

function transaction(
  pid: number,
  exact: Generation,
  overrides: Partial<ExactProcessGenerationDetach<Generation>> = {},
): ExactProcessGenerationDetach<Generation> {
  return {
    pid,
    generation: exact,
    memory: exact.memory,
    detach: () => true,
    settle: () => {},
    retire: (commit) => commit(),
    ...overrides,
  };
}

describe("exact process-generation detach ledger", () => {
  it.each([true, false])("shares exec retirement with a termination that captured the old image (quiescent=%s)", async quiescent => {
    const old = ownedGeneration();
    const oldMemory = old.memory;
    const release = vi.spyOn(old.memoryLease, "release");
    const forced = vi.spyOn(old.memoryLease, "releaseAfterForcedTermination");
    const successor = ownedGeneration();
    vi.spyOn(successor.memoryLease, "release");
    vi.spyOn(successor.memoryLease, "releaseAfterForcedTermination");
    const current = new Map([[19, old]]);
    const ledger = new ExactProcessGenerationDetachLedger<ProcessGenerationOwnership>(
      pid => current.get(pid),
      pid => { current.delete(pid); },
    );
    let settle!: () => void;
    const settleGate = new Promise<void>(resolve => { settle = resolve; });
    const termination = ledger.detach({
      pid: 19, generation: old, memory: oldMemory,
      detach: () => false, settle: () => settleGate,
      retire: commit => { old.memoryLease.releaseAfterForcedTermination(); commit(); },
    });
    current.set(19, successor);
    const exec = retireSupersededExecGeneration(ledger, 19, old, quiescent);
    settle();
    await Promise.all([termination, exec]);
    // A second late termination must also observe the completion tombstone.
    await retireSupersededExecGeneration(ledger, 19, old, quiescent);
    expect(release.mock.calls.length + forced.mock.calls.length).toBe(1);
    expect(current.get(19)).toBe(successor);
    expect(successor.memoryLease.release).not.toHaveBeenCalled();
    expect(successor.memoryLease.releaseAfterForcedTermination).not.toHaveBeenCalled();
    successor.memoryLease.release();
    expect(ledger.pendingCount).toBe(0);
  });

  it.each([true, false])("an exec retirement cannot authorize termination of its successor (quiescent=%s)", async quiescent => {
    const old = ownedGeneration();
    const memory = old.memory;
    const release = vi.spyOn(old.memoryLease, "release");
    const forced = vi.spyOn(old.memoryLease, "releaseAfterForcedTermination");
    const successor = ownedGeneration();
    vi.spyOn(successor.memoryLease, "release");
    vi.spyOn(successor.memoryLease, "releaseAfterForcedTermination");
    const current = new Map([[20, successor]]);
    const ledger = new ExactProcessGenerationDetachLedger<ProcessGenerationOwnership>(
      pid => current.get(pid), pid => { current.delete(pid); },
    );
    await retireSupersededExecGeneration(ledger, 20, old, quiescent);
    const laterRetire = vi.fn();
    const result = await ledger.detach({
      pid: 20, generation: old, memory,
      detach: () => true, settle: () => {}, retire: laterRetire,
    });
    expect(result).toMatchObject({ status: "released", mayReapPid: false, removedCurrent: false, detachDisposition: "superseded" });
    expect(laterRetire).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(quiescent ? 1 : 0);
    expect(forced).toHaveBeenCalledTimes(quiescent ? 0 : 1);
    expect(current.get(20)).toBe(successor);
    expect(successor.memoryLease.release).not.toHaveBeenCalled();
    expect(successor.memoryLease.releaseAfterForcedTermination).not.toHaveBeenCalled();
    successor.memoryLease.release();
  });

  it("retires a superseded generation without waiting for its live successor", async () => {
    const { current, removed, ledger } = harness();
    const old = generation("old");
    const successor = generation("successor");
    current.set(7, successor);
    const detach = vi.fn().mockReturnValue(false);
    const settle = vi.fn();
    const retire = vi.fn((commit: () => void) => commit());
    const exact = transaction(7, old, { detach, settle, retire });

    await expect(ledger.detach(exact)).resolves.toEqual({
      status: "released",
      removedCurrent: false,
      mayReapPid: false,
      detachDisposition: "superseded",
    });
    expect(settle).toHaveBeenCalledWith(7, old.memory);
    expect(retire).toHaveBeenCalledOnce();
    expect(removed).toEqual([]);
    expect(current.get(7)).toBe(successor);
    expect(ledger.pendingCount).toBe(0);
    expect(detach).toHaveBeenCalledOnce();
  });

  it("retries a thrown detach without skipping or duplicating phases", async () => {
    const { current, removed, ledger } = harness();
    const exact = generation("exact");
    current.set(8, exact);
    const detachError = new Error("temporary detach failure");
    const detach = vi
      .fn()
      .mockImplementationOnce(() => {
        throw detachError;
      })
      .mockReturnValueOnce(true);
    const settle = vi.fn();
    const retire = vi.fn((commit: () => void) => commit());

    await expect(
      ledger.detach(transaction(8, exact, { detach, settle, retire })),
    ).resolves.toEqual({
      status: "retained-error",
      removedCurrent: false,
      mayReapPid: false,
      error: detachError,
    });

    await expect(ledger.retryPending()).resolves.toEqual([
      {
        status: "released",
        removedCurrent: true,
        mayReapPid: true,
        detachDisposition: "removed-or-absent",
      },
    ]);
    expect(detach).toHaveBeenCalledTimes(2);
    expect(settle).toHaveBeenCalledOnce();
    expect(retire).toHaveBeenCalledOnce();
    expect(removed).toEqual(["exact"]);
    expect(current.has(8)).toBe(false);
  });

  it("rechecks identity after an awaited settle installs an exec successor", async () => {
    const { current, removed, ledger } = harness();
    const old = generation("old");
    const successor = generation("successor");
    current.set(9, old);
    let continueSettle!: () => void;
    const settleGate = new Promise<void>((resolve) => {
      continueSettle = resolve;
    });
    const result = ledger.detach(
      transaction(9, old, {
        settle: () => settleGate,
      }),
    );

    await vi.waitFor(() => expect(ledger.hasPending(old)).toBe(true));
    current.set(9, successor);
    continueSettle();

    await expect(result).resolves.toEqual({
      status: "released",
      removedCurrent: false,
      mayReapPid: false,
      detachDisposition: "removed-or-absent",
    });
    expect(removed).toEqual([]);
    expect(current.get(9)).toBe(successor);
  });

  it.each(["Node", "browser"])(
    "%s destroy-style retry completes a retained exact generation",
    async () => {
      const { current, removed, ledger } = harness();
      const exact = generation("exact");
      current.set(10, exact);
      const detach = vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error("injected detach failure");
        })
        .mockReturnValueOnce(true);

      await ledger.detach(transaction(10, exact, { detach }));
      expect(ledger.pendingCount).toBe(1);

      const results = await ledger.retryPending();
      expect(results).toEqual([
        {
          status: "released",
          removedCurrent: true,
          mayReapPid: true,
          detachDisposition: "removed-or-absent",
        },
      ]);
      expect(removed).toEqual(["exact"]);
      expect(ledger.pendingCount).toBe(0);
    },
  );

  it("serializes competing cleanup paths for one generation", async () => {
    const { current, removed, ledger } = harness();
    const exact = generation("exact");
    current.set(11, exact);
    let continueDetach!: () => void;
    const detachGate = new Promise<void>((resolve) => {
      continueDetach = resolve;
    });
    const detach = vi.fn(async () => {
      await detachGate;
      return true;
    });
    const retire = vi.fn((commit: () => void) => commit());
    const exactTransaction = transaction(11, exact, { detach, retire });

    const first = ledger.detach(exactTransaction);
    const second = ledger.detach(exactTransaction);
    continueDetach();

    await expect(Promise.all([first, second])).resolves.toEqual([
      {
        status: "released",
        removedCurrent: true,
        mayReapPid: true,
        detachDisposition: "removed-or-absent",
      },
      {
        status: "released",
        removedCurrent: false,
        mayReapPid: false,
        detachDisposition: "removed-or-absent",
      },
    ]);
    expect(detach).toHaveBeenCalledOnce();
    expect(retire).toHaveBeenCalledOnce();
    expect(removed).toEqual(["exact"]);
  });

  it("does not consume a completed generation again from a late cleanup path", async () => {
    const { current, ledger } = harness();
    const exact = generation("exact");
    current.set(12, exact);
    const detach = vi.fn(() => true);
    const retire = vi.fn((commit: () => void) => commit());
    const exactTransaction = transaction(12, exact, { detach, retire });

    const first = await ledger.detach(exactTransaction);
    const late = await ledger.detach(exactTransaction);

    expect(first).toMatchObject({ status: "released", removedCurrent: true });
    expect(late).toMatchObject({ status: "released", removedCurrent: false });
    expect(detach).toHaveBeenCalledOnce();
    expect(retire).toHaveBeenCalledOnce();
  });

  it("does not retry a lease consumed before a later callback error", async () => {
    const { current, ledger } = harness();
    const exact = generation("exact");
    current.set(13, exact);
    const afterCommit = new Error("diagnostic after ownership commit");
    let leaseConsumptions = 0;
    const exactTransaction = transaction(13, exact, {
      retire: (commit) => {
        leaseConsumptions += 1;
        commit();
        throw afterCommit;
      },
    });

    await expect(ledger.detach(exactTransaction)).resolves.toMatchObject({
      status: "released",
      removedCurrent: true,
      postCommitError: afterCommit,
    });
    await expect(ledger.detach(exactTransaction)).resolves.toMatchObject({
      status: "released",
      removedCurrent: false,
      postCommitError: afterCommit,
    });
    expect(leaseConsumptions).toBe(1);
    expect(ledger.pendingCount).toBe(0);
  });

  it("records an undefined post-commit throw without retrying ownership", async () => {
    const { current, ledger } = harness();
    const exact = generation("exact");
    current.set(15, exact);
    let leaseConsumptions = 0;

    const result = await ledger.detach(
      transaction(15, exact, {
        retire: (commit) => {
          leaseConsumptions += 1;
          commit();
          throw undefined;
        },
      }),
    );

    expect(result).toMatchObject({
      status: "released",
      removedCurrent: true,
    });
    expect(result).toHaveProperty("postCommitError", undefined);
    expect(leaseConsumptions).toBe(1);
    expect(ledger.pendingCount).toBe(0);
  });

  it("retries a retirement failure that happened before ownership commit", async () => {
    const { current, ledger } = harness();
    const exact = generation("exact");
    current.set(14, exact);
    const beforeCommit = new Error("retirement preparation failed");
    const retire = vi
      .fn()
      .mockImplementationOnce(() => {
        throw beforeCommit;
      })
      .mockImplementationOnce((commit: () => void) => commit());
    const exactTransaction = transaction(14, exact, { retire });

    await expect(ledger.detach(exactTransaction)).resolves.toEqual({
      status: "retained-error",
      removedCurrent: false,
      mayReapPid: false,
      error: beforeCommit,
    });
    await expect(ledger.retryPending()).resolves.toEqual([
      {
        status: "released",
        removedCurrent: true,
        mayReapPid: true,
        detachDisposition: "removed-or-absent",
      },
    ]);
    expect(retire).toHaveBeenCalledTimes(2);
  });

  it("never authorizes reaping when kernel detach says the current host object was superseded", async () => {
    const { current, removed, ledger } = harness();
    const exact = generation("stale-host-current");
    current.set(16, exact);

    const result = await ledger.detach(
      transaction(16, exact, { detach: () => false }),
    );

    expect(result).toEqual({
      status: "released",
      removedCurrent: true,
      mayReapPid: false,
      detachDisposition: "superseded",
    });
    expect(removed).toEqual(["stale-host-current"]);
    expect(current.has(16)).toBe(false);
  });
});
