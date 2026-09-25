import { describe, expect, it } from "vitest";
import { observeForkLaunchWorker } from "../src/fork-launch-observer";
import { MockWorkerAdapter } from "../src/worker-adapter";

describe("fork launch Worker observer", () => {
  function observed() {
    const adapter = new MockWorkerAdapter();
    adapter.createWorker({ pid: 41 });
    const worker = adapter.lastWorker!;
    let decide!: (result: number) => void;
    const launchDecided = new Promise<number>((resolve) => { decide = resolve; });
    let failures = 0;
    const failure = observeForkLaunchWorker(worker, 41, launchDecided, () => {
      failures += 1;
    });
    return { worker, decide, failure, failures: () => failures };
  }

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
  ])("fails the launch on $label before the kernel decided", async ({ fire, diagnostic }) => {
    const launch = observed();
    fire(launch.worker);
    await expect(launch.failure).rejects.toThrow(diagnostic);
    expect(launch.failures()).toBe(1);
  });

  it("reports the first premature end once", async () => {
    const launch = observed();
    launch.worker.simulateMessage({ type: "error", pid: 41, message: "first" });
    launch.worker.simulateExit(1);
    await expect(launch.failure).rejects.toThrow(/first/);
    expect(launch.failures()).toBe(1);
  });

  it("ignores messages about another pid", async () => {
    const launch = observed();
    launch.worker.simulateMessage({ type: "exit", pid: 99, status: 0 });
    launch.decide(41);
    await Promise.resolve();
    launch.worker.simulateExit(0);
    expect(launch.failures()).toBe(0);
  });

  it("treats a Worker ending after the kernel decided as ordinary", async () => {
    const launch = observed();
    launch.decide(41);
    await Promise.resolve();

    launch.worker.simulateMessage({ type: "exit", pid: 41, status: 0 });
    launch.worker.simulateExit(0);

    expect(launch.failures()).toBe(0);
    const settled = await Promise.race([
      launch.failure.then(() => "rejected", () => "rejected"),
      Promise.resolve("pending"),
    ]);
    expect(settled).toBe("pending");
  });
});
