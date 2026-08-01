import { describe, expect, it } from "vitest";
import {
  VforkAddressSpaceBusyError,
  VforkLifetimeCoordinator,
  type VforkProcessGeneration,
} from "../src/vfork-lifetime";

interface Generation extends VforkProcessGeneration {
  readonly name: string;
}

function sharedMemory(): WebAssembly.Memory {
  return new WebAssembly.Memory({
    initial: 2,
    maximum: 2,
    shared: true,
  });
}

function generation(name: string, memory = sharedMemory()): Generation {
  return { name, memory };
}

async function expectPending(promise: Promise<unknown>): Promise<void> {
  let settled = false;
  void promise.then(() => {
    settled = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(settled).toBe(false);
}

describe("shared vfork lifetime coordinator", () => {
  it("requires an exact Shared Memory alias and distinct process identities", () => {
    const coordinator = new VforkLifetimeCoordinator<Generation>();
    const parent = generation("parent");

    expect(() => coordinator.begin(
      10,
      11,
      parent,
      generation("copied-child"),
    )).toThrow("does not alias");

    const privateMemory = new WebAssembly.Memory({ initial: 1, maximum: 1 });
    expect(() => coordinator.begin(
      10,
      11,
      generation("private-parent", privateMemory),
      generation("private-child", privateMemory),
    )).toThrow("requires Shared");

    expect(() => coordinator.begin(10, 10, parent, generation("child", parent.memory)))
      .toThrow("PIDs must differ");
    expect(() => coordinator.begin(10, 11, parent, parent))
      .toThrow("generations must differ");
  });

  it("parks the caller while sibling work and failed execs continue", async () => {
    const coordinator = new VforkLifetimeCoordinator<Generation>();
    const memory = sharedMemory();
    const parent = generation("parent", memory);
    const child = generation("child", memory);
    const lifetime = coordinator.begin(20, 21, parent, child);
    coordinator.markChildMayAccessMemory(child);

    let siblingRan = false;
    queueMicrotask(() => {
      siblingRan = true;
    });
    await expectPending(lifetime.completion);
    expect(siblingRan).toBe(true);

    expect(coordinator.noteFailedExec(child, 2)).toBe(1);
    expect(coordinator.noteFailedExec(child, 13)).toBe(2);
    expect(lifetime.failedExecAttempts).toBe(2);
    await expectPending(lifetime.completion);

    coordinator.completeAfterExactTeardown(child, "exit");
    await expect(lifetime.completion).resolves.toEqual({
      kind: "resume-parent",
      parentGeneration: parent,
      childPid: 21,
      reason: "exit",
    });
  });

  it.each(["exec", "exit", "signal", "trap"] as const)(
    "accepts exact %s teardown evidence once",
    async (reason) => {
      const coordinator = new VforkLifetimeCoordinator<Generation>();
      const memory = sharedMemory();
      const parent = generation("parent", memory);
      const child = generation("child", memory);
      const lifetime = coordinator.begin(30, 31, parent, child);
      coordinator.markChildMayAccessMemory(child);

      expect(coordinator.completeAfterExactTeardown(child, reason)).toBe(true);
      expect(coordinator.completeAfterExactTeardown(child, reason)).toBe(false);
      expect(coordinator.requireAddressSpaceContainment(child, new Error("late")))
        .toBe(false);
      await expect(lifetime.completion).resolves.toMatchObject({
        kind: "resume-parent",
        parentGeneration: parent,
        childPid: 31,
        reason,
      });
      expect(lifetime.phase).toBe("settled");
      expect(coordinator.activeCount).toBe(0);
    },
  );

  it("returns a launch error only before the child may touch memory", async () => {
    const coordinator = new VforkLifetimeCoordinator<Generation>();
    const memory = sharedMemory();
    const parent = generation("parent", memory);
    const child = generation("child", memory);
    const lifetime = coordinator.begin(40, 41, parent, child);

    expect(coordinator.abortBeforeChildStart(child, 12)).toBe(true);
    await expect(lifetime.completion).resolves.toEqual({
      kind: "return-error",
      parentGeneration: parent,
      childPid: 41,
      errno: 12,
    });

    const nextChild = generation("next-child", memory);
    const next = coordinator.begin(40, 42, parent, nextChild);
    coordinator.markChildMayAccessMemory(nextChild);
    expect(() => coordinator.abortBeforeChildStart(nextChild, 12)).toThrow(
      "cannot return",
    );
    coordinator.completeAfterExactTeardown(nextChild, "exec");
    await expect(next.completion).resolves.toMatchObject({
      kind: "resume-parent",
      reason: "exec",
    });
  });

  it("resumes for an exact kernel death before Worker launch", async () => {
    const coordinator = new VforkLifetimeCoordinator<Generation>();
    const memory = sharedMemory();
    const parent = generation("parent", memory);
    const child = generation("child", memory);
    const lifetime = coordinator.begin(50, 51, parent, child);

    coordinator.completeWithoutBorrow(child, "signal");
    await expect(lifetime.completion).resolves.toEqual({
      kind: "resume-parent",
      parentGeneration: parent,
      childPid: 51,
      reason: "signal",
    });
  });

  it("requires whole-address-space containment after ambiguous termination", async () => {
    const coordinator = new VforkLifetimeCoordinator<Generation>();
    const memory = sharedMemory();
    const parent = generation("parent", memory);
    const child = generation("child", memory);
    const lifetime = coordinator.begin(60, 61, parent, child);
    coordinator.markChildMayAccessMemory(child);
    const crash = new Error("Worker stopped without memory_quiescent");

    expect(coordinator.requireAddressSpaceContainment(child, crash)).toBe(true);
    expect(coordinator.completeAfterExactTeardown(child, "trap")).toBe(false);
    await expect(lifetime.completion).resolves.toEqual({
      kind: "contain-address-space",
      parentGeneration: parent,
      childPid: 61,
      cause: crash,
    });
  });

  it("rejects overlapping and nested borrowers with EAGAIN", async () => {
    const coordinator = new VforkLifetimeCoordinator<Generation>();
    const memory = sharedMemory();
    const parent = generation("parent", memory);
    const firstChild = generation("first-child", memory);
    const first = coordinator.begin(70, 71, parent, firstChild);
    expect(coordinator.phaseForChild(firstChild)).toBe("starting");
    coordinator.markChildMayAccessMemory(firstChild);
    expect(coordinator.phaseForChild(firstChild)).toBe("borrowing");

    for (const [parentPid, childPid, initiator] of [
      [70, 72, parent],
      [71, 73, firstChild],
    ] as const) {
      let error: unknown;
      try {
        coordinator.begin(
          parentPid,
          childPid,
          initiator,
          generation(`child-${childPid}`, memory),
        );
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(VforkAddressSpaceBusyError);
      expect((error as VforkAddressSpaceBusyError).errno).toBe(11);
    }

    coordinator.completeAfterExactTeardown(firstChild, "exec");
    expect(coordinator.phaseForChild(firstChild)).toBeUndefined();
    await first.completion;
  });

  it("allows concurrent borrowers only for distinct address spaces", async () => {
    const coordinator = new VforkLifetimeCoordinator<Generation>();
    const firstMemory = sharedMemory();
    const secondMemory = sharedMemory();
    const firstChild = generation("first-child", firstMemory);
    const secondChild = generation("second-child", secondMemory);
    const first = coordinator.begin(
      80,
      81,
      generation("first-parent", firstMemory),
      firstChild,
    );
    const second = coordinator.begin(
      90,
      91,
      generation("second-parent", secondMemory),
      secondChild,
    );

    expect(coordinator.activeCount).toBe(2);
    coordinator.markChildMayAccessMemory(firstChild);
    coordinator.markChildMayAccessMemory(secondChild);
    coordinator.completeAfterExactTeardown(firstChild, "exit");
    coordinator.completeAfterExactTeardown(secondChild, "exit");
    await Promise.all([first.completion, second.completion]);
    expect(coordinator.activeCount).toBe(0);
  });

  it("supports repeated lifetimes but never reuses a child generation", async () => {
    const coordinator = new VforkLifetimeCoordinator<Generation>();
    const memory = sharedMemory();
    const parent = generation("parent", memory);
    const firstChild = generation("first-child", memory);
    const first = coordinator.begin(100, 101, parent, firstChild);
    coordinator.markChildMayAccessMemory(firstChild);
    coordinator.completeAfterExactTeardown(firstChild, "exit");
    await first.completion;

    const secondChild = generation("second-child", memory);
    const second = coordinator.begin(100, 102, parent, secondChild);
    coordinator.markChildMayAccessMemory(secondChild);
    coordinator.completeAfterExactTeardown(secondChild, "exec");
    await expect(second.completion).resolves.toMatchObject({
      childPid: 102,
      reason: "exec",
    });

    expect(() => coordinator.begin(100, 103, parent, firstChild)).toThrow(
      "already used",
    );
  });

  it("retains the exact parent generation for stale completion suppression", async () => {
    const coordinator = new VforkLifetimeCoordinator<Generation>();
    const memory = sharedMemory();
    const oldParent = generation("old-parent", memory);
    const successor = generation("exec-successor");
    const child = generation("child", memory);
    const current = new Map([[110, oldParent]]);
    const lifetime = coordinator.begin(110, 111, oldParent, child);
    coordinator.markChildMayAccessMemory(child);

    current.set(110, successor);
    coordinator.completeAfterExactTeardown(child, "exit");
    const result = await lifetime.completion;

    expect(result.parentGeneration).toBe(oldParent);
    expect(current.get(110)).toBe(successor);
    expect(current.get(110)).not.toBe(result.parentGeneration);
  });
});
