import { describe, expect, it } from "vitest";
import {
  cancelForkReplayGate,
  commitForkReplayGate,
  createForkReplayGate,
  ForkReplayGateCoordinator,
  observeForkReplayWorker,
  retireForkReplayWorker,
  waitForForkReplayRetirement,
} from "../src/fork-replay-gate";
import { MockWorkerAdapter } from "../src/worker-adapter";

describe("fork replay two-phase gate", () => {
  it("commits a pending child exactly once", () => {
    const gate = createForkReplayGate();
    expect(Atomics.load(new Int32Array(gate), 0)).toBe(0);
    commitForkReplayGate(gate);
    expect(Atomics.load(new Int32Array(gate), 0)).toBe(1);
    expect(() => commitForkReplayGate(gate)).toThrow(/no longer pending/);
  });

  it("cancels only while reconstruction is pending", () => {
    const pending = createForkReplayGate();
    cancelForkReplayGate(pending);
    expect(Atomics.load(new Int32Array(pending), 0)).toBe(-1);

    const committed = createForkReplayGate();
    commitForkReplayGate(committed);
    cancelForkReplayGate(committed);
    expect(Atomics.load(new Int32Array(committed), 0)).toBe(1);
  });

  it("rejects malformed gate storage before publishing state", () => {
    expect(() => commitForkReplayGate(new SharedArrayBuffer(8)))
      .toThrow(/one shared i32/);
  });
});

describe("fork replay readiness coordinator", () => {
  it("keeps the child blocked after readiness until the host commits", async () => {
    const coordinator = new ForkReplayGateCoordinator("pid=41");
    const waiting = coordinator.waitUntilReady();

    coordinator.ready();
    await waiting;

    expect(coordinator.currentPhase).toBe("ready");
    expect(Atomics.load(new Int32Array(coordinator.gate), 0)).toBe(0);
    coordinator.commit();
    expect(coordinator.currentPhase).toBe("committed");
    expect(Atomics.load(new Int32Array(coordinator.gate), 0)).toBe(1);
  });

  it("does not allow commit before the Worker proves replay readiness", () => {
    const coordinator = new ForkReplayGateCoordinator("pid=41");
    expect(() => coordinator.commit()).toThrow(
      /cannot commit fork replay while pending/,
    );
    expect(Atomics.load(new Int32Array(coordinator.gate), 0)).toBe(0);
  });

  it("cancels a deferred launch and rejects its pending readiness", async () => {
    const coordinator = new ForkReplayGateCoordinator("pid=41");
    const waiting = coordinator.waitUntilReady();

    coordinator.cancel(new Error("deferred Worker launch was cancelled"));

    await expect(waiting).rejects.toThrow(/deferred Worker launch was cancelled/);
    expect(coordinator.currentPhase).toBe("cancelled");
    expect(Atomics.load(new Int32Array(coordinator.gate), 0)).toBe(-1);
  });

  it("preserves cancellation for a waiter attached after launch rollback", async () => {
    const coordinator = new ForkReplayGateCoordinator("pid=41");
    coordinator.cancel(new Error("Worker constructor failed"));

    await expect(coordinator.waitUntilReady()).rejects.toThrow(
      /Worker constructor failed/,
    );
    expect(Atomics.load(new Int32Array(coordinator.gate), 0)).toBe(-1);
  });

  it("cancellation between ready and commit wins the transaction", async () => {
    const coordinator = new ForkReplayGateCoordinator("pid=41");
    coordinator.ready();
    await coordinator.waitUntilReady();

    coordinator.cancel(new Error("generation was replaced"));

    expect(() => coordinator.commit()).toThrow(/generation was replaced/);
    expect(Atomics.load(new Int32Array(coordinator.gate), 0)).toBe(-1);
  });
});

describe("fork replay Worker lifecycle observer", () => {
  function observed(isCurrentGeneration = () => true) {
    const adapter = new MockWorkerAdapter();
    const worker = adapter.createWorker({ pid: 41 });
    const coordinator = new ForkReplayGateCoordinator("fork child pid=41");
    observeForkReplayWorker(
      coordinator,
      worker,
      41,
      isCurrentGeneration,
    );
    return { coordinator, worker: adapter.lastWorker! };
  }

  it("accepts readiness only from the exact current child generation", async () => {
    const current = observed();
    current.worker.simulateMessage({ type: "fork_replay_ready", pid: 41 });
    await current.coordinator.waitUntilReady();
    expect(current.coordinator.currentPhase).toBe("ready");

    const stale = observed(() => false);
    const staleWaiting = stale.coordinator.waitUntilReady();
    stale.worker.simulateMessage({ type: "fork_replay_ready", pid: 41 });
    await expect(staleWaiting).rejects.toThrow(/stale Worker generation/);
    expect(Atomics.load(new Int32Array(stale.coordinator.gate), 0)).toBe(-1);

    const wrongPid = observed();
    const wrongPidWaiting = wrongPid.coordinator.waitUntilReady();
    wrongPid.worker.simulateMessage({ type: "fork_replay_ready", pid: 99 });
    await expect(wrongPidWaiting).rejects.toThrow(/expected pid=41/);
  });

  it.each([
    {
      label: "worker-main error message",
      fire: (worker: ReturnType<typeof observed>["worker"]) =>
        worker.simulateMessage({
          type: "error",
          pid: 41,
          message: "instantiation failed",
        }),
      diagnostic: /instantiation failed/,
    },
    {
      label: "worker-main exit message",
      fire: (worker: ReturnType<typeof observed>["worker"]) =>
        worker.simulateMessage({ type: "exit", pid: 41, status: 7 }),
      diagnostic: /status=7/,
    },
    {
      label: "Worker error event",
      fire: (worker: ReturnType<typeof observed>["worker"]) =>
        worker.simulateError(new Error("worker crashed")),
      diagnostic: /worker crashed/,
    },
    {
      label: "Worker exit event",
      fire: (worker: ReturnType<typeof observed>["worker"]) =>
        worker.simulateExit(9),
      diagnostic: /code=9/,
    },
  ])("cancels on $label before readiness", async ({ fire, diagnostic }) => {
    const { coordinator, worker } = observed();
    const waiting = coordinator.waitUntilReady();
    fire(worker);
    await expect(waiting).rejects.toThrow(diagnostic);
    expect(coordinator.currentPhase).toBe("cancelled");
    expect(Atomics.load(new Int32Array(coordinator.gate), 0)).toBe(-1);
  });

  it("ignores later terminal events after a committed replay", async () => {
    const { coordinator, worker } = observed();
    worker.simulateMessage({ type: "fork_replay_ready", pid: 41 });
    await coordinator.waitUntilReady();
    coordinator.commit();

    worker.simulateMessage({ type: "exit", pid: 41, status: 0 });
    worker.simulateExit(0);

    expect(coordinator.currentPhase).toBe("committed");
    expect(Atomics.load(new Int32Array(coordinator.gate), 0)).toBe(1);
  });

  it.each([false, true])("joins the exact exit owner when readiness was already resolved: %s", async (ready) => {
    const { coordinator, worker } = observed();
    if (ready) {
      worker.simulateMessage({ type: "fork_replay_ready", pid: 41 });
      await coordinator.waitUntilReady();
    }
    let finish!: () => void;
    const teardown = new Promise<void>(resolve => { finish = resolve; });
    retireForkReplayWorker(worker, teardown);
    worker.simulateExit(0);
    let reason: unknown;
    try {
      await coordinator.waitUntilReady();
      coordinator.throwIfCancelled();
    } catch (error) { reason = error; }
    expect(reason).toBeInstanceOf(Error);
    expect(() => coordinator.commit()).toThrow(reason as Error);
    let joined = false;
    const joining = waitForForkReplayRetirement(coordinator, reason).then(result => { joined = result; });
    await Promise.resolve();
    expect(joined).toBe(false);
    finish();
    await joining;
    expect(joined).toBe(true);
    expect(Atomics.load(new Int32Array(coordinator.gate), 0)).toBe(-1);
    expect(await waitForForkReplayRetirement(new ForkReplayGateCoordinator("replacement"), reason)).toBe(false);
    expect(await waitForForkReplayRetirement(coordinator, new Error((reason as Error).message))).toBe(false);
  });

  it("preserves a real Worker failure before exit takes ownership", async () => {
    const { coordinator, worker } = observed();
    worker.simulateError(new Error("real construction failure"));
    retireForkReplayWorker(worker, Promise.resolve());
    const reason = await coordinator.waitUntilReady().catch(error => error);
    expect(reason.message).toContain("real construction failure");
    expect(await waitForForkReplayRetirement(coordinator, reason)).toBe(false);
  });

  it("propagates failed retirement instead of reporting completion", async () => {
    const { coordinator, worker } = observed();
    const teardownFailure = new Error("exact detach failed");
    const teardown = Promise.reject(teardownFailure);
    retireForkReplayWorker(worker, teardown);
    const reason = await coordinator.waitUntilReady().catch(error => error);
    await expect(waitForForkReplayRetirement(coordinator, reason)).rejects.toBe(teardownFailure);
  });

  it("does not retire a replacement Worker or a committed replay", async () => {
    const old = observed();
    const replacement = observed();
    retireForkReplayWorker(old.worker, Promise.resolve());
    replacement.worker.simulateMessage({ type: "fork_replay_ready", pid: 41 });
    await replacement.coordinator.waitUntilReady();
    replacement.coordinator.commit();
    retireForkReplayWorker(replacement.worker, Promise.resolve());
    expect(replacement.coordinator.currentPhase).toBe("committed");
    expect(old.coordinator.currentPhase).toBe("cancelled");
  });
});
