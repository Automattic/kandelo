# Machine Progress Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show one centred, full-page progress overlay across a whole machine
switch — naming and measuring both the teardown of the outgoing machine and the
load of the incoming machine's VFS image.

**Architecture:** The kernel worker already computes teardown counts it never
reports. A new `destroy_progress` message carries them over the existing
structured-clone message port to both hosts, which expose
`subscribeDestroyProgress`. `live-setup` republishes those events into the
host-owned `MachineProgress` channel (a generalization of this branch's
`BootProgress`, which already carries image bytes), and one centred overlay
component at the App root renders whichever phase is active.

**Tech Stack:** TypeScript, React 19, Vitest (`host/vitest.config.ts` includes
`../web-libs/**/*.test.ts`), `node:test` via `npm run test:unit` in
`apps/browser-demos`, Playwright (chromium/webkit).

**Spec:** `docs/superpowers/specs/2026-09-24-machine-progress-overlay-design.md`

## Global Constraints

- The main thread must never take ownership of a `SharedArrayBuffer`. Progress
  records carry scalars and strings only, never image or process memory.
- No invented denominators. A total that is not known is absent, and the bar
  renders indeterminate. Never synthesize completion.
- `detachKernel()` stays before `previousKernel.destroy()` in `startBoot`. Its
  ordering is a concurrency invariant, not an accident.
- Node and browser are peers. Every worker-entry and host change in Task 1-3
  lands in both `browser-*` and `node-*` files in the same task.
- Emit `destroy_progress` only when `completed` changes, never per 15 ms tick.
- PR title/commit subjects use the `Area: Purpose` prefix form.
- Commit message bodies wrap at 72 columns. PR descriptions do not hard wrap.

## Review Focus

Five conditions the spec implies that no obvious happy-path test would cover.
Each has a test assigned to the task that owns the code.

1. **Teardown with zero live processes.** `woken.size === 0` must render
   indeterminate, never `0/0` shown as 100%. — Task 4, "treats an absent total
   as indeterminate"; Task 5, "a zero total is reported as indeterminate".
2. **Drain times out with processes still live.** The last counts must freeze;
   no synthesized `completed === total`. — Task 2, "does not synthesize
   completion when the drain times out".
3. **Total grows mid-teardown.** `completed` must never decrease and `total`
   must never decrease, even as the denominator rises. — Task 2, "never lowers
   completed or total"; Task 6, "a receded total never yields a percentage
   above 100".
4. **Destroy events arrive after the boot was superseded.** A stale kernel's
   events must not drive the current overlay. — Task 5, "drops events from a
   superseded switch".
5. **A kernel with no `subscribeDestroyProgress`.** The optional method being
   absent must degrade to an indeterminate destroy phase, not throw. — Task 5,
   "a kernel without destroy progress degrades to a no-op".

---

### Task 1: `destroy_progress` protocol message, both hosts

**Files:**
- Modify: `host/src/browser-kernel-protocol.ts` (add interface; extend the
  `KernelToMainMessage` union near line 702)
- Modify: `host/src/node-kernel-protocol.ts` (same, union near line 495)
- Test: `host/test/destroy-progress-protocol.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `DestroyPhase`, `DestroyProgressEvent`, `DestroyProgressMessage`,
  exported from **both** protocol modules with identical shape.

- [ ] **Step 1: Write the failing test**

```ts
// host/test/destroy-progress-protocol.test.ts
import { describe, expect, it } from "vitest";
import type {
  DestroyProgressEvent as BrowserEvent,
  DestroyProgressMessage as BrowserMessage,
} from "../src/browser-kernel-protocol";
import type {
  DestroyProgressEvent as NodeEvent,
} from "../src/node-kernel-protocol";

describe("destroy_progress protocol", () => {
  it("describes cumulative teardown counts", () => {
    const event: BrowserEvent = {
      phase: "draining",
      completed: 3,
      total: 7,
      totalProvisional: true,
    };
    const message: BrowserMessage = { type: "destroy_progress", event };
    expect(message.type).toBe("destroy_progress");
    expect(message.event.totalProvisional).toBe(true);
  });

  it("uses the same shape in both hosts", () => {
    // A Node event must be assignable to the browser type and back. If the two
    // protocol files drift, this stops compiling.
    const node: NodeEvent = {
      phase: "terminating",
      completed: 9,
      total: 9,
      totalProvisional: false,
    };
    const browser: BrowserEvent = node;
    const back: NodeEvent = browser;
    expect(back.phase).toBe("terminating");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd host && npx vitest run test/destroy-progress-protocol.test.ts`
Expected: FAIL — `DestroyProgressEvent` is not exported from either module.

- [ ] **Step 3: Write minimal implementation**

Add to **both** `host/src/browser-kernel-protocol.ts` and
`host/src/node-kernel-protocol.ts`:

```ts
/** Which teardown step `performDestroy` is in. */
export type DestroyPhase = "draining" | "terminating";

/**
 * Cumulative teardown progress. Counts processes, not bytes.
 *
 * `total` is a lower bound while `totalProvisional` is true: the drain phase
 * knows only the processes it woke, and the terminate phase adds stragglers it
 * discovers afterwards. `completed` never resets between phases.
 */
export interface DestroyProgressEvent {
  phase: DestroyPhase;
  completed: number;
  total: number;
  totalProvisional: boolean;
}

export interface DestroyProgressMessage {
  type: "destroy_progress";
  event: DestroyProgressEvent;
}
```

In each file add `| DestroyProgressMessage` to the `KernelToMainMessage` union
(browser: near line 702, alongside `| LazyDownloadMessage`; node: near line 495,
same).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd host && npx vitest run test/destroy-progress-protocol.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add host/src/browser-kernel-protocol.ts host/src/node-kernel-protocol.ts \
  host/test/destroy-progress-protocol.test.ts
git commit -m "Host: Add the destroy_progress worker message to both protocols"
```

---

### Task 2: Emit teardown progress from both worker entries

**Files:**
- Modify: `host/src/browser-kernel-worker-entry.ts` (`performDestroy`, from
  line 4093; phase 3 begins at line 4127)
- Modify: `host/src/node-kernel-worker-entry.ts` (`performDestroy`, from
  line 3405)
- Create: `host/src/destroy-progress-reporter.ts`
- Test: `host/test/destroy-progress-reporter.test.ts` (create)

**Why a separate module:** the emission rule (cumulative, monotonic, only on
change) is the part with real logic and the part Review Focus items 2 and 3
target. Both worker entries are very large files; putting the rule in one small
module lets it be tested directly and keeps the two entries identical by
construction rather than by careful copying.

**Interfaces:**
- Consumes: `DestroyProgressEvent` from Task 1.
- Produces: `createDestroyProgressReporter(emit): DestroyProgressReporter` with
  methods `startDraining(total: number): void`,
  `drained(completedCount: number): void`,
  `startTerminating(stragglerCount: number): void`,
  `terminated(count: number): void`.

- [ ] **Step 1: Write the failing test**

```ts
// host/test/destroy-progress-reporter.test.ts
import { describe, expect, it } from "vitest";
import type { DestroyProgressEvent } from "../src/browser-kernel-protocol";
import { createDestroyProgressReporter } from "../src/destroy-progress-reporter";

function collect() {
  const events: DestroyProgressEvent[] = [];
  return { events, emit: (e: DestroyProgressEvent) => events.push(e) };
}

describe("destroy progress reporter", () => {
  it("reports the woken total as provisional when draining starts", () => {
    const { events, emit } = collect();
    createDestroyProgressReporter(emit).startDraining(7);
    expect(events).toEqual([
      { phase: "draining", completed: 0, total: 7, totalProvisional: true },
    ]);
  });

  it("emits only when the completed count changes", () => {
    const { events, emit } = collect();
    const r = createDestroyProgressReporter(emit);
    r.startDraining(7);
    r.drained(0);
    r.drained(0);
    r.drained(2);
    r.drained(2);
    r.drained(3);
    expect(events.map((e) => e.completed)).toEqual([0, 2, 3]);
  });

  it("carries the drain total forward and marks it final when terminating", () => {
    const { events, emit } = collect();
    const r = createDestroyProgressReporter(emit);
    r.startDraining(7);
    r.drained(7);
    r.startTerminating(2);
    r.terminated(1);
    expect(events.at(-2)).toEqual({
      phase: "terminating", completed: 7, total: 9, totalProvisional: false,
    });
    expect(events.at(-1)).toEqual({
      phase: "terminating", completed: 8, total: 9, totalProvisional: false,
    });
  });

  it("never lowers completed or total", () => {
    // Review Focus 3. The denominator may grow; neither number may shrink.
    const { events, emit } = collect();
    const r = createDestroyProgressReporter(emit);
    r.startDraining(7);
    r.drained(5);
    r.startTerminating(2);
    r.terminated(0);
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.completed).toBeGreaterThanOrEqual(events[i - 1]!.completed);
      expect(events[i]!.total).toBeGreaterThanOrEqual(events[i - 1]!.total);
    }
  });

  it("does not synthesize completion when the drain times out", () => {
    // Review Focus 2. Three of seven exited, then teardown gave up.
    const { events, emit } = collect();
    const r = createDestroyProgressReporter(emit);
    r.startDraining(7);
    r.drained(3);
    const last = events.at(-1)!;
    expect(last.completed).toBe(3);
    expect(last.completed).not.toBe(last.total);
  });

  it("reports a zero total rather than inventing one", () => {
    const { events, emit } = collect();
    createDestroyProgressReporter(emit).startDraining(0);
    expect(events).toEqual([
      { phase: "draining", completed: 0, total: 0, totalProvisional: true },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd host && npx vitest run test/destroy-progress-reporter.test.ts`
Expected: FAIL — cannot find module `../src/destroy-progress-reporter`.

- [ ] **Step 3: Write minimal implementation**

```ts
// host/src/destroy-progress-reporter.ts
import type { DestroyProgressEvent } from "./browser-kernel-protocol";

export interface DestroyProgressReporter {
  /** Phase 2 begins; `total` is the woken pid count. */
  startDraining(total: number): void;
  /** Phase 2 tick: how many of the woken set have exited so far. */
  drained(completedCount: number): void;
  /** Phase 3 begins; `stragglerCount` is added to the total. */
  startTerminating(stragglerCount: number): void;
  /** Phase 3 tick: how many stragglers have been terminated so far. */
  terminated(count: number): void;
}

/**
 * Turns `performDestroy`'s phase counters into cumulative progress events.
 *
 * Emits only when `completed` moves, so a 15 ms drain poll does not produce a
 * message per tick. Never lowers `completed` or `total`: the denominator grows
 * once, when phase 3 discovers stragglers, and the UI marks it provisional
 * until then.
 */
export function createDestroyProgressReporter(
  emit: (event: DestroyProgressEvent) => void,
): DestroyProgressReporter {
  let phase: DestroyProgressEvent["phase"] = "draining";
  let drainTotal = 0;
  let total = 0;
  let completed = 0;
  let provisional = true;
  let emitted = false;

  const publish = (): void => {
    emit({ phase, completed, total, totalProvisional: provisional });
    emitted = true;
  };

  return {
    startDraining(next) {
      phase = "draining";
      drainTotal = Math.max(0, next);
      total = drainTotal;
      completed = 0;
      provisional = true;
      publish();
    },
    drained(count) {
      const next = Math.min(Math.max(count, completed), drainTotal);
      if (emitted && next === completed) return;
      completed = next;
      publish();
    },
    startTerminating(stragglerCount) {
      phase = "terminating";
      total = drainTotal + Math.max(0, stragglerCount);
      provisional = false;
      publish();
    },
    terminated(count) {
      const next = Math.min(Math.max(drainTotal + count, completed), total);
      if (next === completed) return;
      completed = next;
      publish();
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd host && npx vitest run test/destroy-progress-reporter.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Wire the reporter into the browser worker entry**

In `host/src/browser-kernel-worker-entry.ts`, import the reporter and use it in
`performDestroy`. Replace the phase-1/2 block (from `let woken = new Set<number>();`
through the `if (stillDraining())` warning) with:

```ts
  const destroyProgress = createDestroyProgressReporter((event) =>
    post({ type: "destroy_progress", event }),
  );
  let woken = new Set<number>();
  try { woken = await kernelWorker.killAllBlockedForTeardown(); } catch (e) {
    console.error(`[kernel-worker] killAllBlockedForTeardown failed: ${e}`);
  }
  destroyProgress.startDraining(woken.size);

  const drainDeadline = Date.now() + DESTROY_KILL_DRAIN_TIMEOUT_MS;
  const liveWokenCount = () => {
    let live = 0;
    for (const pid of woken) if (processes.has(pid)) live++;
    return live;
  };
  const stillDraining = () => liveWokenCount() > 0;
  while (stillDraining() && Date.now() < drainDeadline) {
    destroyProgress.drained(woken.size - liveWokenCount());
    await delay(DESTROY_KILL_DRAIN_POLL_MS);
  }
  destroyProgress.drained(woken.size - liveWokenCount());
  if (stillDraining()) {
    console.warn(`[kernel-worker] destroy drain timed out with woken process(es) still live; force-terminating`);
  }
```

Then at the top of `retireCurrentGenerations` (line ~4132), before the loop:

```ts
  const retireCurrentGenerations = async (): Promise<void> => {
    const stragglers = [...processes.entries()];
    destroyProgress.startTerminating(stragglers.length);
    let retired = 0;
    for (const [pid, info] of stragglers) {
```

and immediately after each iteration's existing body completes (at the end of
the `for` block), add:

```ts
      destroyProgress.terminated(++retired);
```

Add the import at the top of the file:

```ts
import { createDestroyProgressReporter } from "./destroy-progress-reporter";
```

- [ ] **Step 6: Wire the reporter into the node worker entry**

Apply the identical change to `host/src/node-kernel-worker-entry.ts`
`performDestroy` (from line 3405): same import, same reporter construction
posting through that file's `post()`, same `liveWokenCount` helper replacing
the boolean-only `stillDraining`, same `startTerminating` / `terminated` calls
in its `retireCurrentGenerations`. The node loop uses
`await new Promise((r) => setTimeout(r, DESTROY_KILL_DRAIN_POLL_MS))` rather
than `delay(...)`; leave that as it is.

- [ ] **Step 7: Verify both hosts still build and pass**

Run: `cd host && npm run typecheck`
Expected: no errors.

Run: `cd host && npx vitest run test/destroy-progress-reporter.test.ts test/destroy-progress-protocol.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 8: Commit**

```bash
git add host/src/destroy-progress-reporter.ts host/test/destroy-progress-reporter.test.ts \
  host/src/browser-kernel-worker-entry.ts host/src/node-kernel-worker-entry.ts
git commit -m "Host: Report teardown progress from performDestroy in both hosts"
```

---

### Task 3: Expose `subscribeDestroyProgress` on both hosts

**Files:**
- Modify: `host/src/browser-kernel-host.ts` (listener set near line 281;
  `emitLazyDownload` near line 1552; dispatch `case "lazy_download"` near
  line 1782; `subscribeLazyDownloads` near line 891)
- Modify: `host/src/node-kernel-host.ts` (listener set near line 228;
  `subscribeLazyDownloads` near line 926; listener clear near line 1032)
- Test: `host/test/destroy-progress-subscription.test.ts` (create)

**Interfaces:**
- Consumes: `DestroyProgressEvent`, `DestroyProgressMessage` (Task 1).
- Produces: `subscribeDestroyProgress(cb: (event: DestroyProgressEvent) => void): () => void`
  on `BrowserKernel` and `NodeKernelHost`.

- [ ] **Step 1: Write the failing test**

```ts
// host/test/destroy-progress-subscription.test.ts
import { describe, expect, it } from "vitest";
import type { DestroyProgressEvent } from "../src/browser-kernel-protocol";

// The emit/fan-out rule, exercised against the same helper both hosts use.
import { createDestroyProgressFanout } from "../src/destroy-progress-reporter";

describe("destroy progress fan-out", () => {
  it("delivers each event to every subscriber", () => {
    const fanout = createDestroyProgressFanout();
    const a: DestroyProgressEvent[] = [];
    const b: DestroyProgressEvent[] = [];
    fanout.subscribe((e) => a.push(e));
    fanout.subscribe((e) => b.push(e));
    fanout.emit({ phase: "draining", completed: 1, total: 4, totalProvisional: true });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it("stops delivering after unsubscribe", () => {
    const fanout = createDestroyProgressFanout();
    const seen: DestroyProgressEvent[] = [];
    const off = fanout.subscribe((e) => seen.push(e));
    off();
    fanout.emit({ phase: "draining", completed: 1, total: 4, totalProvisional: true });
    expect(seen).toEqual([]);
  });

  it("keeps delivering to healthy subscribers when one throws", () => {
    const fanout = createDestroyProgressFanout();
    const seen: DestroyProgressEvent[] = [];
    fanout.subscribe(() => { throw new Error("subscriber blew up"); });
    fanout.subscribe((e) => seen.push(e));
    fanout.emit({ phase: "terminating", completed: 4, total: 4, totalProvisional: false });
    expect(seen).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd host && npx vitest run test/destroy-progress-subscription.test.ts`
Expected: FAIL — `createDestroyProgressFanout` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `host/src/destroy-progress-reporter.ts`:

```ts
export interface DestroyProgressFanout {
  subscribe(cb: (event: DestroyProgressEvent) => void): () => void;
  emit(event: DestroyProgressEvent): void;
  clear(): void;
}

/** Shared listener set so both hosts fan out identically. */
export function createDestroyProgressFanout(): DestroyProgressFanout {
  const listeners = new Set<(event: DestroyProgressEvent) => void>();
  return {
    subscribe(cb) {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    emit(event) {
      for (const cb of listeners) {
        try { cb(event); } catch { /* listener errors don't break the loop */ }
      }
    },
    clear() { listeners.clear(); },
  };
}
```

In `host/src/browser-kernel-host.ts`:

```ts
// near line 281, beside lazyDownloadListeners
private destroyProgress = createDestroyProgressFanout();

// beside subscribeLazyDownloads (near line 891)
subscribeDestroyProgress(cb: (event: DestroyProgressEvent) => void): () => void {
  return this.destroyProgress.subscribe(cb);
}

// in handleWorkerMessage, beside case "lazy_download" (near line 1782)
case "destroy_progress":
  this.destroyProgress.emit(msg.event);
  break;
```

Apply the same three edits to `host/src/node-kernel-host.ts` (listener field
near line 228, method near line 926, dispatch case beside its `lazy_download`
handling), and add `this.destroyProgress.clear();` next to the existing
`this.lazyDownloadListeners.clear();` near line 1032.

Import `createDestroyProgressFanout` and the `DestroyProgressEvent` type in
both host files.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd host && npx vitest run test/destroy-progress-subscription.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Verify the protocol dispatch is exhaustive**

Run: `cd host && npm run typecheck`
Expected: no errors. Both dispatches have a `never` exhaustiveness check, so a
missing `case "destroy_progress"` fails compilation here.

- [ ] **Step 6: Commit**

```bash
git add host/src/destroy-progress-reporter.ts host/src/browser-kernel-host.ts \
  host/src/node-kernel-host.ts host/test/destroy-progress-subscription.test.ts
git commit -m "Host: Expose destroy progress subscription on both kernel hosts"
```

---

### Task 4: Generalize `BootProgress` into `MachineProgress`

**Files:**
- Modify: `web-libs/kandelo-session/src/kernel-host.ts` (`BootPhase` and
  `BootProgress` at lines 122-133; `KernelHost` methods `getBootProgress` /
  `subscribeBootProgress`; `LiveKernelHost` field, `setBootProgress`,
  `getBootProgress`, `subscribeBootProgress`, and the `setStatus` clear;
  `KernelLike` optional method beside `subscribeLazyDownloads` at line 252)
- Rename: `web-libs/kandelo-session/test/boot-progress.test.ts` →
  `web-libs/kandelo-session/test/machine-progress.test.ts`
- Modify: `apps/browser-demos/pages/kandelo/kernel-host/react.tsx`
  (`useBootProgress` → `useMachineProgress`)

**Interfaces:**
- Consumes: `DestroyProgressEvent` (Task 1), for the `KernelLike` signature.
- Produces: `MachineProgress`, `KernelHost.getMachineProgress()`,
  `KernelHost.subscribeMachineProgress(cb)`,
  `LiveKernelHost.setMachineProgress(p)`, and
  `KernelLike.subscribeDestroyProgress?(cb)`.

- [ ] **Step 1: Write the failing test**

Rename the existing file first so its history follows:

```bash
git mv web-libs/kandelo-session/test/boot-progress.test.ts \
  web-libs/kandelo-session/test/machine-progress.test.ts
```

Replace its contents with:

```ts
import { describe, expect, it } from "vitest";
import { LiveKernelHost } from "../src/kernel-host";
import type { KernelLike, MachineProgress } from "../src/kernel-host";

function loadingImage(overrides: Partial<MachineProgress> = {}): MachineProgress {
  return {
    phase: "image",
    label: "wordpress-sqlite.vfs.zst",
    completed: 1024,
    total: 4096,
    unit: "bytes",
    status: "loading",
    ...overrides,
  };
}

function unloading(overrides: Partial<MachineProgress> = {}): MachineProgress {
  return {
    phase: "destroying",
    label: "Bare shell",
    completed: 3,
    total: 7,
    totalProvisional: true,
    unit: "processes",
    status: "loading",
    ...overrides,
  };
}

function stubKernel(): KernelLike {
  return {} as KernelLike;
}

describe("LiveKernelHost machine progress", () => {
  it("reports nothing before a switch starts", () => {
    expect(new LiveKernelHost().getMachineProgress()).toBeNull();
  });

  it("carries image progress in bytes", () => {
    const host = new LiveKernelHost({ status: "booting" });
    host.setMachineProgress(loadingImage());
    expect(host.getMachineProgress()).toEqual(loadingImage());
  });

  it("carries teardown progress in processes", () => {
    const host = new LiveKernelHost({ status: "running" });
    host.setMachineProgress(unloading());
    expect(host.getMachineProgress()).toEqual(unloading());
  });

  it("keeps a provisional total distinguishable from a final one", () => {
    const host = new LiveKernelHost({ status: "running" });
    host.setMachineProgress(unloading({ totalProvisional: true }));
    expect(host.getMachineProgress()?.totalProvisional).toBe(true);
    host.setMachineProgress(unloading({
      completed: 9, total: 9, totalProvisional: false,
    }));
    expect(host.getMachineProgress()?.totalProvisional).toBe(false);
  });

  it("treats an absent total as indeterminate", () => {
    // Review Focus 1: a teardown with nothing to reap must not read as 100%.
    const host = new LiveKernelHost({ status: "running" });
    host.setMachineProgress(unloading({ completed: 0, total: undefined }));
    expect(host.getMachineProgress()?.total).toBeUndefined();
  });

  it("fans out each update to subscribers", () => {
    const host = new LiveKernelHost({ status: "booting" });
    const seen: Array<MachineProgress | null> = [];
    host.subscribeMachineProgress((p) => seen.push(p));
    host.setMachineProgress(loadingImage({ completed: 1024 }));
    host.setMachineProgress(loadingImage({ completed: 2048 }));
    expect(seen.map((p) => p?.completed)).toEqual([1024, 2048]);
  });

  it("stops notifying an unsubscribed listener", () => {
    const host = new LiveKernelHost({ status: "booting" });
    const seen: Array<MachineProgress | null> = [];
    const off = host.subscribeMachineProgress((p) => seen.push(p));
    off();
    host.setMachineProgress(loadingImage());
    expect(seen).toEqual([]);
  });

  it("survives attachKernel, which clears the kernel-lifecycle ledger", () => {
    const host = new LiveKernelHost({ status: "booting" });
    host.setMachineProgress(loadingImage({ status: "complete" }));
    host.attachKernel(stubKernel());
    expect(host.getMachineProgress()).toEqual(loadingImage({ status: "complete" }));
  });

  it("survives the whole teardown, when status is still running", () => {
    // Teardown publishes while the outgoing machine is still `running`; the
    // clear must not fire until the switch finishes.
    const host = new LiveKernelHost({ status: "running" });
    host.setMachineProgress(unloading());
    host.setStatus("booting");
    expect(host.getMachineProgress()).toEqual(unloading());
  });

  it("clears once the machine finishes booting", () => {
    const host = new LiveKernelHost({ status: "booting" });
    const seen: Array<MachineProgress | null> = [];
    host.subscribeMachineProgress((p) => seen.push(p));
    host.setMachineProgress(loadingImage());
    host.setStatus("running");
    expect(host.getMachineProgress()).toBeNull();
    expect(seen.at(-1)).toBeNull();
  });

  it("stores only scalars, so no machine memory is retained", () => {
    const host = new LiveKernelHost({ status: "booting" });
    host.setMachineProgress(loadingImage());
    for (const value of Object.values(host.getMachineProgress()!)) {
      expect(["string", "number", "boolean"]).toContain(typeof value);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd host && npx vitest run ../web-libs/kandelo-session/test/machine-progress.test.ts`
Expected: FAIL — `setMachineProgress` is not a function.

- [ ] **Step 3: Write minimal implementation**

In `web-libs/kandelo-session/src/kernel-host.ts`, replace the `BootPhase` /
`BootProgress` block (lines 122-133) with:

```ts
/** Stage of a machine switch that can report progress. */
export type MachinePhase = "destroying" | "image";

/**
 * Progress of a machine switch: tearing the outgoing machine down, then
 * loading the incoming machine's VFS image.
 *
 * Deliberately separate from {@link LazyDownloadEvent}: both halves run while
 * no kernel is attached, and `attachKernel` clears the lazy-download ledger.
 *
 * Every field is a scalar. This record must never retain image bytes or
 * process memory — the main thread is not an owner of machine memory.
 *
 * `total` is absent when no total is known, which callers render as
 * indeterminate rather than inventing a denominator. `totalProvisional` marks
 * a total that is a lower bound and may still grow; see the teardown phases in
 * `host/src/destroy-progress-reporter.ts`.
 */
export interface MachineProgress {
  phase: MachinePhase;
  label: string;
  completed: number;
  total?: number;
  totalProvisional?: boolean;
  unit: "processes" | "bytes";
  status: "loading" | "complete" | "error";
  error?: string;
}
```

Rename the `KernelHost` members:

```ts
  // Machine switch progress. Null outside an in-flight switch.
  getMachineProgress(): MachineProgress | null;
  subscribeMachineProgress(
    cb: (progress: MachineProgress | null) => void,
  ): () => void;
```

Rename the `LiveKernelHost` field and methods (`bootProgress` →
`machineProgress`, `bootProgressListeners` → `machineProgressListeners`,
`setBootProgress` → `setMachineProgress`, `getBootProgress` →
`getMachineProgress`, `subscribeBootProgress` → `subscribeMachineProgress`),
and update the `setStatus` clear to call `this.setMachineProgress(null)`.

Add to `KernelLike`, beside `subscribeLazyDownloads` (line 252):

```ts
  /**
   * Subscribe to teardown progress. Emitted by the kernel worker while
   * `destroy()` reaps processes. Optional: a kernel without it reports
   * nothing, and the destroy phase stays indeterminate.
   */
  subscribeDestroyProgress?(
    cb: (event: DestroyProgressEvent) => void,
  ): () => void;
```

`DestroyProgressEvent` is redeclared structurally in this file rather than
imported, matching how `LazyDownloadEvent` and `KernelSyscallEvent` are already
mirrored here so kandelo-session does not pull host's wire types into UI
bundles:

```ts
/**
 * Teardown progress from the kernel worker. Mirrors
 * host/src/browser-kernel-protocol.ts: DestroyProgressEvent — duplicated as a
 * structural type for the same reason as LazyDownloadEvent above.
 */
export interface DestroyProgressEvent {
  phase: "draining" | "terminating";
  completed: number;
  total: number;
  totalProvisional: boolean;
}
```

In `apps/browser-demos/pages/kandelo/kernel-host/react.tsx`, rename
`useBootProgress` to `useMachineProgress`, with `BootProgress` →
`MachineProgress` in its imports and signature.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd host && npx vitest run ../web-libs/kandelo-session/test/machine-progress.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add web-libs/kandelo-session/src/kernel-host.ts \
  web-libs/kandelo-session/test/machine-progress.test.ts \
  apps/browser-demos/pages/kandelo/kernel-host/react.tsx
git commit -m "Browser: Generalize boot progress into machine-switch progress"
```

---

### Task 5: Publish teardown progress from `startBoot`

**Files:**
- Modify: `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts`
  (`startBoot` at line 795; the image-progress reporter and `loadVfsImage`
  call site further down, which currently build a `BootProgress`)
- Create: `apps/browser-demos/pages/kandelo/kernel-host/machine-progress.ts`
- Test: `apps/browser-demos/pages/kandelo/kernel-host/machine-progress.test.ts`
  (create; runs under `npm run test:unit`)

**Why a separate module:** the mapping from a `DestroyProgressEvent` to a
`MachineProgress` is pure and carries Review Focus items 4 and 5. `live-setup.ts`
is already very large; a focused module keeps this testable without React or a
live kernel.

**Interfaces:**
- Consumes: `MachineProgress` (Task 4), `DestroyProgressEvent` (Task 4's
  structural copy).
- Produces:
  `destroyProgressToMachineProgress(label: string, event: DestroyProgressEvent): MachineProgress`,
  `initialDestroyProgress(label: string): MachineProgress`, and
  `subscribeDestroyProgress(kernel, label, isCurrent, publish): () => void`.

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  destroyProgressToMachineProgress,
  initialDestroyProgress,
  subscribeDestroyProgress,
} from "./machine-progress.ts";
import type {
  DestroyProgressEvent,
  MachineProgress,
} from "../../../../../web-libs/kandelo-session/src/kernel-host";

test("teardown starts indeterminate, before any count is known", () => {
  // Phase 1 is one awaited call with no granularity, so there is nothing to
  // report until the first draining event lands.
  assert.deepEqual(initialDestroyProgress("Bare shell"), {
    phase: "destroying",
    label: "Bare shell",
    completed: 0,
    unit: "processes",
    status: "loading",
  });
});

test("a draining event becomes a provisional-total machine progress", () => {
  assert.deepEqual(
    destroyProgressToMachineProgress("Bare shell", {
      phase: "draining", completed: 3, total: 7, totalProvisional: true,
    }),
    {
      phase: "destroying",
      label: "Bare shell",
      completed: 3,
      total: 7,
      totalProvisional: true,
      unit: "processes",
      status: "loading",
    },
  );
});

test("a terminating event carries a final total", () => {
  const progress = destroyProgressToMachineProgress("Bare shell", {
    phase: "terminating", completed: 9, total: 9, totalProvisional: false,
  });
  assert.equal(progress.totalProvisional, false);
  assert.equal(progress.total, 9);
});

test("a zero total is reported as indeterminate, not as complete", () => {
  // Review Focus 1: 0 of 0 must not render as a finished bar.
  const progress = destroyProgressToMachineProgress("Bare shell", {
    phase: "draining", completed: 0, total: 0, totalProvisional: true,
  });
  assert.equal(progress.total, undefined);
  assert.equal(progress.completed, 0);
});

test("a kernel without destroy progress degrades to a no-op", () => {
  // Review Focus 5. subscribeDestroyProgress is optional on KernelLike; a
  // kernel that lacks it must leave the phase indeterminate, not throw.
  const published: MachineProgress[] = [];
  const off = subscribeDestroyProgress(
    {}, "Bare shell", () => true, (p) => published.push(p),
  );
  assert.equal(typeof off, "function");
  off();
  assert.deepEqual(published, []);
});

test("drops events from a superseded switch", () => {
  // Review Focus 4. A stale kernel finishing its teardown must not drive the
  // overlay of the switch that replaced it.
  const published: MachineProgress[] = [];
  let emit: ((e: DestroyProgressEvent) => void) | undefined;
  const kernel = {
    subscribeDestroyProgress(cb: (e: DestroyProgressEvent) => void) {
      emit = cb;
      return () => { emit = undefined; };
    },
  };
  let current = true;
  subscribeDestroyProgress(
    kernel, "Bare shell", () => current, (p) => published.push(p),
  );
  emit!({ phase: "draining", completed: 1, total: 4, totalProvisional: true });
  current = false;
  emit!({ phase: "draining", completed: 2, total: 4, totalProvisional: true });
  assert.equal(published.length, 1);
  assert.equal(published[0]!.completed, 1);
});

test("unsubscribing stops delivery", () => {
  const published: MachineProgress[] = [];
  let emit: ((e: DestroyProgressEvent) => void) | undefined;
  const kernel = {
    subscribeDestroyProgress(cb: (e: DestroyProgressEvent) => void) {
      emit = cb;
      return () => { emit = undefined; };
    },
  };
  const off = subscribeDestroyProgress(
    kernel, "Bare shell", () => true, (p) => published.push(p),
  );
  off();
  assert.equal(emit, undefined);
  assert.deepEqual(published, []);
});

test("retains no object references from the event", () => {
  const progress = destroyProgressToMachineProgress("Bare shell", {
    phase: "draining", completed: 1, total: 2, totalProvisional: true,
  });
  for (const value of Object.values(progress)) {
    assert.ok(
      ["string", "number", "boolean"].includes(typeof value),
      `progress field retained a ${typeof value}`,
    );
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test apps/browser-demos/pages/kandelo/kernel-host/machine-progress.test.ts`
Expected: FAIL — cannot find module `./machine-progress.ts`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/browser-demos/pages/kandelo/kernel-host/machine-progress.ts
import type {
  DestroyProgressEvent,
  MachineProgress,
} from "../../../../../web-libs/kandelo-session/src/kernel-host";

/**
 * What the overlay shows before teardown has any count to report.
 *
 * Phase 1 of `performDestroy` is a single awaited call, so there is a real gap
 * with no measurement. Omitting `total` renders it indeterminate rather than
 * inventing a starting denominator.
 */
export function initialDestroyProgress(label: string): MachineProgress {
  return {
    phase: "destroying",
    label,
    completed: 0,
    unit: "processes",
    status: "loading",
  };
}

/**
 * Subscribe to a kernel's teardown progress, if it reports any.
 *
 * `subscribeDestroyProgress` is optional on `KernelLike`, so a kernel without
 * it yields a no-op unsubscribe and the phase stays indeterminate rather than
 * throwing. `isCurrent` drops events from a switch that has been superseded:
 * a stale kernel can finish its teardown after a newer one has taken over.
 */
export function subscribeDestroyProgress(
  kernel: {
    subscribeDestroyProgress?(
      cb: (event: DestroyProgressEvent) => void,
    ): () => void;
  },
  label: string,
  isCurrent: () => boolean,
  publish: (progress: MachineProgress) => void,
): () => void {
  return kernel.subscribeDestroyProgress?.((event) => {
    if (!isCurrent()) return;
    publish(destroyProgressToMachineProgress(label, event));
  }) ?? (() => {});
}

/**
 * Map one teardown event onto the host's machine-progress record.
 *
 * A zero total means there was nothing to reap; it is dropped so the bar stays
 * indeterminate instead of rendering 0 of 0 as a finished bar.
 */
export function destroyProgressToMachineProgress(
  label: string,
  event: DestroyProgressEvent,
): MachineProgress {
  return {
    phase: "destroying",
    label,
    completed: event.completed,
    ...(event.total > 0
      ? { total: event.total, totalProvisional: event.totalProvisional }
      : {}),
    unit: "processes",
    status: "loading",
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test apps/browser-demos/pages/kandelo/kernel-host/machine-progress.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Wire it into `startBoot`**

In `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts`, import both
helpers, then change the teardown block in `startBoot` (line 795) to:

```ts
    const seq = ++bootSeq;
    const previousKernel = currentKernel;
    // The descriptor still names the OUTGOING machine here: setDescriptor for
    // the incoming one runs inside bootProfile, after this teardown.
    const outgoingTitle = h.getBootDescriptor().title;
    currentKernel = null;
    h.detachKernel();
    if (previousKernel) {
      h.setMachineProgress(initialDestroyProgress(outgoingTitle));
      const offDestroyProgress = subscribeDestroyProgress(
        previousKernel,
        outgoingTitle,
        () => seq === bootSeq,
        (progress) => h.setMachineProgress(progress),
      );
      try {
        await previousKernel.destroy().catch(() => {});
      } finally {
        offDestroyProgress();
      }
      await settleAfterBootResourcesReleased();
    }
```

Then update the existing image reporter (the `reportVfsImageProgress` callback)
to build a `MachineProgress` instead of a `BootProgress`:

```ts
  const reportVfsImageProgress: VfsImageProgressReport = (report) => {
    if (!isCurrent()) return;
    host.setMachineProgress({
      phase: "image",
      label: vfsImageLabel,
      completed: report.loadedBytes,
      ...(report.totalBytes === undefined ? {} : { total: report.totalBytes }),
      unit: "bytes",
      status: report.status,
      ...(report.error === undefined ? {} : { error: report.error }),
    });
  };
```

- [ ] **Step 6: Verify the app still typechecks**

Run: `cd apps/browser-demos && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "live-setup|machine-progress"`
Expected: no output. (Other pre-existing errors in this config are unrelated;
see the PR description.)

- [ ] **Step 7: Commit**

```bash
git add apps/browser-demos/pages/kandelo/kernel-host/machine-progress.ts \
  apps/browser-demos/pages/kandelo/kernel-host/machine-progress.test.ts \
  apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts
git commit -m "Browser: Publish teardown progress from the machine switch"
```

---

### Task 6: The centred overlay

**Files:**
- Create: `apps/browser-demos/pages/kandelo/panes/MachineProgressOverlay.tsx`
- Create: `apps/browser-demos/pages/kandelo/panes/machine-progress-format.ts`
- Create: `apps/browser-demos/pages/kandelo/panes/machine-progress-format.test.ts`
- Delete: `apps/browser-demos/pages/kandelo/panes/BootProgressBar.tsx`
- Modify: `apps/browser-demos/pages/kandelo/views/MachineView.tsx` (remove the
  `<BootProgressBar />` render and its import)
- Modify: `apps/browser-demos/pages/kandelo/app/App.tsx` (render the overlay at
  the App root)
- Modify: `apps/browser-demos/pages/kandelo/styles.css` (replace the
  `.kpreboot-*` rules with `.kmprogress-*`)

**Interfaces:**
- Consumes: `useMachineProgress()` (Task 4), `MachineProgress` (Task 4).
- Produces: `MachineProgressOverlay` (default-less named export), and
  `formatMachineProgress(progress): { headline: string; detail: string; percent: number | null; valueText: string }`.

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { formatMachineProgress } from "./machine-progress-format.ts";

test("a provisional teardown total is marked with a plus", () => {
  const f = formatMachineProgress({
    phase: "destroying", label: "Bare shell", completed: 3, total: 7,
    totalProvisional: true, unit: "processes", status: "loading",
  });
  assert.equal(f.headline, "Unloading Bare shell");
  assert.equal(f.detail, "3 of 7+ processes");
  assert.equal(f.valueText, "3 of at least 7 processes");
});

test("a final teardown total drops the plus", () => {
  const f = formatMachineProgress({
    phase: "destroying", label: "Bare shell", completed: 9, total: 9,
    totalProvisional: false, unit: "processes", status: "loading",
  });
  assert.equal(f.detail, "9 of 9 processes");
  assert.equal(f.valueText, "9 of 9 processes");
  assert.equal(f.percent, 100);
});

test("image progress reads in binary units", () => {
  const f = formatMachineProgress({
    phase: "image", label: "browser-main-shell image",
    completed: 1024 * 1024, total: 2 * 1024 * 1024,
    unit: "bytes", status: "loading",
  });
  assert.equal(f.headline, "Loading browser-main-shell image");
  assert.equal(f.detail, "1.0 MiB / 2.0 MiB");
  assert.equal(f.percent, 50);
});

test("no total yields no percentage", () => {
  const f = formatMachineProgress({
    phase: "destroying", label: "Bare shell", completed: 0,
    unit: "processes", status: "loading",
  });
  assert.equal(f.percent, null);
  assert.equal(f.detail, "0 processes");
});

test("an error shows its message rather than a count", () => {
  const f = formatMachineProgress({
    phase: "image", label: "custom.vfs.zst", completed: 0,
    unit: "bytes", status: "error", error: "custom.vfs.zst returned HTTP 503",
  });
  assert.equal(f.detail, "custom.vfs.zst returned HTTP 503");
});

test("a receded total never yields a percentage above 100", () => {
  // Review Focus 3's UI side: the total may grow under a finished count.
  const f = formatMachineProgress({
    phase: "destroying", label: "Bare shell", completed: 7, total: 9,
    totalProvisional: false, unit: "processes", status: "loading",
  });
  assert.ok(f.percent !== null && f.percent < 100);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test apps/browser-demos/pages/kandelo/panes/machine-progress-format.test.ts`
Expected: FAIL — cannot find module `./machine-progress-format.ts`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/browser-demos/pages/kandelo/panes/machine-progress-format.ts
import type { MachineProgress } from "../../../../../web-libs/kandelo-session/src/kernel-host";

export interface FormattedMachineProgress {
  headline: string;
  detail: string;
  /** Null when no total is known; the bar renders indeterminate. */
  percent: number | null;
  /** Spoken form; a bare "+" conveys nothing to a screen reader. */
  valueText: string;
}

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(kib < 10 ? 1 : 0)} KiB`;
  const mib = kib / 1024;
  return `${mib.toFixed(mib < 10 ? 1 : 0)} MiB`;
}

export function formatMachineProgress(
  progress: MachineProgress,
): FormattedMachineProgress {
  const headline = progress.phase === "destroying"
    ? `Unloading ${progress.label}`
    : `Loading ${progress.label}`;
  const percent = progress.total && progress.total > 0
    ? Math.min(100, Math.max(0, (progress.completed / progress.total) * 100))
    : null;

  if (progress.status === "error") {
    return {
      headline,
      detail: progress.error ?? "failed",
      percent,
      valueText: progress.error ?? "failed",
    };
  }

  if (progress.unit === "bytes") {
    const detail = progress.total === undefined
      ? humanBytes(progress.completed)
      : `${humanBytes(progress.completed)} / ${humanBytes(progress.total)}`;
    return { headline, detail, percent, valueText: detail };
  }

  if (progress.total === undefined) {
    const detail = `${progress.completed} processes`;
    return { headline, detail, percent, valueText: detail };
  }
  const marker = progress.totalProvisional ? "+" : "";
  return {
    headline,
    detail: `${progress.completed} of ${progress.total}${marker} processes`,
    percent,
    valueText: progress.totalProvisional
      ? `${progress.completed} of at least ${progress.total} processes`
      : `${progress.completed} of ${progress.total} processes`,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test apps/browser-demos/pages/kandelo/panes/machine-progress-format.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Write the overlay component**

```tsx
// apps/browser-demos/pages/kandelo/panes/MachineProgressOverlay.tsx
//
// One centred, full-page overlay for a whole machine switch: teardown of the
// outgoing machine, then the incoming machine's image load.
//
// Centred on purpose. The bar this replaces rendered inside the primary
// surface slot, so it appeared in whatever pane happened to be mounted and
// read as a stray element in a left-hand column. A machine switch is a
// whole-page event and has to look like one.

import * as React from "react";

import { useMachineProgress } from "../kernel-host/react";
import { formatMachineProgress } from "./machine-progress-format";

export const MachineProgressOverlay: React.FC = () => {
  const progress = useMachineProgress();
  if (progress === null) return null;

  const { headline, detail, percent, valueText } =
    formatMachineProgress(progress);

  return (
    <div
      className={`kmprogress-overlay kmprogress-${progress.status}`}
      role="status"
      aria-live="polite"
    >
      <div className="kmprogress-card">
        <div className="kmprogress-headline">{headline}</div>
        <div
          className={`kmprogress-bar${percent === null ? " indeterminate" : ""}`}
          role="progressbar"
          aria-label={headline}
          {...(percent === null
            ? { "aria-valuetext": valueText }
            : {
              "aria-valuenow": Math.round(percent),
              "aria-valuemin": 0,
              "aria-valuemax": 100,
              "aria-valuetext": valueText,
            })}
        >
          <span style={{ width: percent === null ? "44%" : `${percent}%` }} />
        </div>
        <div className="kmprogress-detail">{detail}</div>
      </div>
    </div>
  );
};
```

- [ ] **Step 6: Mount it and remove the old bar**

In `apps/browser-demos/pages/kandelo/app/App.tsx`, import the overlay and
render it as the last child of the app root element, immediately before the
closing tag of the element that already contains `<LazyDownloadToasts ... />`:

```tsx
      <MachineProgressOverlay />
```

In `apps/browser-demos/pages/kandelo/views/MachineView.tsx`, delete the
`<BootProgressBar />` element and its comment, and delete the
`import { BootProgressBar } from "../panes/BootProgressBar";` line.

Delete the file:

```bash
git rm apps/browser-demos/pages/kandelo/panes/BootProgressBar.tsx
```

- [ ] **Step 7: Add the stylesheet rules**

In `apps/browser-demos/pages/kandelo/styles.css`, replace the block of
`.kpreboot-progress*` and `.kpreboot-bar*` rules added earlier in this branch
with:

```css
/* Machine switch progress: one centred, full-page overlay covering teardown
   and image load. Centred rather than pinned to a pane — a switch is a
   whole-page event. */
.kmprogress-overlay {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: grid;
  place-items: center;
  background: color-mix(in oklch, var(--k-bg) 72%, transparent);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
}

.kmprogress-card {
  width: min(420px, calc(100vw - 48px));
  padding: 18px 20px;
  border-radius: 12px;
  background: var(--k-surface);
  box-shadow: 0 18px 48px rgb(0 0 0 / 28%);
  font-family: var(--k-font-mono);
  font-size: 12px;
}

.kmprogress-headline {
  color: var(--k-text);
  margin-bottom: 10px;
}

.kmprogress-bar {
  position: relative;
  overflow: hidden;
  height: 3px;
  border-radius: 999px;
  background: color-mix(in oklch, var(--k-text) 9%, transparent);
}

.kmprogress-bar > span {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--k-accent);
  transition: width 0.16s ease;
}

.kmprogress-error .kmprogress-bar > span { background: var(--k-err); }
.kmprogress-complete .kmprogress-bar > span { background: var(--k-ok); }

.kmprogress-bar.indeterminate > span {
  animation: kdownload-slide 1.1s ease-in-out infinite;
}

.kmprogress-detail {
  margin-top: 8px;
  color: color-mix(in oklch, var(--k-text) 62%, transparent);
  font-variant-numeric: tabular-nums;
}

.kmprogress-error .kmprogress-detail { color: var(--k-err); }
```

- [ ] **Step 8: Verify**

Run: `cd apps/browser-demos && npm run test:unit`
Expected: PASS. Note the count grows by the new format and mapping tests.

Run: `cd apps/browser-demos && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "MachineProgressOverlay|MachineView|App.tsx|machine-progress"`
Expected: no output.

- [ ] **Step 9: Commit**

```bash
git add apps/browser-demos/pages/kandelo/panes/MachineProgressOverlay.tsx \
  apps/browser-demos/pages/kandelo/panes/machine-progress-format.ts \
  apps/browser-demos/pages/kandelo/panes/machine-progress-format.test.ts \
  apps/browser-demos/pages/kandelo/views/MachineView.tsx \
  apps/browser-demos/pages/kandelo/app/App.tsx \
  apps/browser-demos/pages/kandelo/styles.css
git rm --cached apps/browser-demos/pages/kandelo/panes/BootProgressBar.tsx 2>/dev/null || true
git commit -m "Browser: Show machine switch progress in a centred full-page overlay"
```

---

### Task 7: Make the overlay modal without stranding keyboard users

**Files:**
- Modify: `apps/browser-demos/pages/kandelo/app/App.tsx` (apply `inert` to the
  app content while a switch is in flight)
- Test: `apps/browser-demos/test/machine-progress-modal.spec.ts` (create)

**Interfaces:**
- Consumes: `useMachineProgress()` (Task 4), `MachineProgressOverlay` (Task 6).
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "@playwright/test";

const fixturePageUrl = "/test/fixtures/boot-progress-fixture.html";
const fixtureModuleUrl = "/test/fixtures/boot-progress-fixture.ts";

test("the overlay is modal while a switch is in flight", async ({ page }) => {
  await page.goto(fixturePageUrl);
  await page.evaluate(async (moduleUrl) => {
    const { mountBootScreen } = await import(moduleUrl);
    const root = document.createElement("div");
    document.body.append(root);
    (window as unknown as { fixture: unknown }).fixture = mountBootScreen(root);
  }, fixtureModuleUrl);

  await page.evaluate(() => {
    (window as unknown as {
      fixture: { setProgress(v: unknown): void };
    }).fixture.setProgress({
      phase: "destroying",
      label: "Bare shell",
      completed: 3,
      total: 7,
      totalProvisional: true,
      unit: "processes",
      status: "loading",
    });
  });

  await expect(page.locator("[role=progressbar]")).toBeVisible();
  await expect(page.locator(".kmprogress-card")).toBeVisible();
  // The content behind the overlay must not be reachable by keyboard.
  await expect(page.locator("[data-machine-content][inert]")).toHaveCount(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/browser-demos && KANDELO_PLAYWRIGHT_PORT=5487 npx playwright test machine-progress-modal --project=chromium --reporter=list`
Expected: FAIL — no element matches `[data-machine-content][inert]`.

- [ ] **Step 3: Write minimal implementation**

In `apps/browser-demos/pages/kandelo/app/App.tsx`, read the progress at the App
root and mark the content inert while it is non-null:

```tsx
  const machineProgress = useMachineProgress();
```

Add `data-machine-content` and the conditional `inert` attribute to the element
that wraps the app's interactive content (the one currently holding `<main>`
and `<Dock ... />`):

```tsx
    <div
      data-machine-content
      {...(machineProgress === null ? {} : { inert: "" })}
    >
```

Keep `<MachineProgressOverlay />` a **sibling** of that wrapper, not a child —
an inert ancestor would make the overlay itself unreachable.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/browser-demos && KANDELO_PLAYWRIGHT_PORT=5487 npx playwright test machine-progress-modal --project=chromium --reporter=list`
Expected: PASS, 1 test.

- [ ] **Step 5: Commit**

```bash
git add apps/browser-demos/pages/kandelo/app/App.tsx \
  apps/browser-demos/test/machine-progress-modal.spec.ts
git commit -m "Browser: Make the machine progress overlay modal"
```

---

### Task 8: Migrate the existing specs and fixture to the overlay

**Files:**
- Modify: `apps/browser-demos/test/fixtures/boot-progress-fixture.ts` (mount
  the overlay instead of `BootProgressBar`; `setProgress` takes a
  `MachineProgress`)
- Modify: `apps/browser-demos/test/boot-progress-ui.spec.ts` (target the
  overlay; add a destroying-phase case)
- Modify: `apps/browser-demos/test/boot-progress-live.spec.ts` (unchanged
  assertions, but confirm the selector still resolves against the overlay)

**Interfaces:**
- Consumes: `MachineProgressOverlay` (Task 6), `MachineProgress` (Task 4).
- Produces: nothing new.

- [ ] **Step 1: Update the fixture to mount the overlay**

Replace the `BootProgressBar` import and element in
`apps/browser-demos/test/fixtures/boot-progress-fixture.ts` with
`MachineProgressOverlay`, and change `setProgress` to accept `MachineProgress`
and call `host.setMachineProgress(...)`:

```ts
import { MachineProgressOverlay } from "../../pages/kandelo/panes/MachineProgressOverlay";
import {
  LiveKernelHost,
  type MachineProgress,
} from "../../../../web-libs/kandelo-session/src/kernel-host";

export interface BootProgressFixture {
  setProgress(progress: MachineProgress | null): void;
  finishBoot(): void;
  unmount(): void;
}
```

with the render becoming:

```ts
  root.render(
    React.createElement(
      KernelHostProvider,
      { host },
      React.createElement(MachineProgressOverlay, {}),
      React.createElement(Shell, {}),
    ),
  );
```

and `setProgress` calling `host.setMachineProgress(progress)`.

- [ ] **Step 2: Update the UI spec's payloads and add a teardown case**

In `apps/browser-demos/test/boot-progress-ui.spec.ts`, every `setProgress`
payload gains `unit: "bytes"` and uses `completed`/`total` instead of
`loadedBytes`/`totalBytes`. Then add:

```ts
test("shows the machine being unloaded with a provisional count", async ({ page }) => {
  await setProgress(page, {
    phase: "destroying",
    label: "Bare shell",
    completed: 3,
    total: 7,
    totalProvisional: true,
    unit: "processes",
    status: "loading",
  });

  await expect(page.getByText("Unloading Bare shell")).toBeVisible();
  await expect(page.getByText("3 of 7+ processes")).toBeVisible();
  await expect(page.locator("[role=progressbar]"))
    .toHaveAttribute("aria-valuetext", "3 of at least 7 processes");
});
```

The test that asserted the boot banner's `image:` line is removed: that banner
belongs to `PreBoot`, which no longer carries progress. Replace it with an
assertion that the overlay names the image:

```ts
test("names the image being loaded", async ({ page }) => {
  await setProgress(page, {
    phase: "image",
    label: "browser-main-shell.vfs.zst",
    completed: 512,
    total: 2048,
    unit: "bytes",
    status: "loading",
  });

  await expect(page.getByText("Loading browser-main-shell.vfs.zst"))
    .toBeVisible();
});
```

- [ ] **Step 3: Run both specs to verify they pass**

Run:
```bash
cd apps/browser-demos && \
WASM_POSIX_RESOLUTION_POLICY=source-only-v1 \
WASM_POSIX_SOURCE_ONLY_BINARY_ROOT="$(git rev-parse --show-toplevel)/local-binaries/source-only-v1" \
KANDELO_PLAYWRIGHT_PORT=5487 \
npx playwright test boot-progress-ui boot-progress-live --project=chromium --reporter=list
```
Expected: PASS. The live spec is unchanged; it asserts `[role=progressbar]`,
which the overlay still provides.

- [ ] **Step 4: Commit**

```bash
git add apps/browser-demos/test/fixtures/boot-progress-fixture.ts \
  apps/browser-demos/test/boot-progress-ui.spec.ts
git commit -m "Browser: Move the progress specs onto the machine overlay"
```

---

### Task 9: Prove it against a real machine switch

**Files:**
- Create: `apps/browser-demos/test/machine-switch-progress.spec.ts`

**Why:** the load bar shipped in this branch passed every unit and fixture test
while being invisible in a real boot, because `MachineView` chose which pane was
mounted. Only a real switch proves placement. This task is the one that catches
that class of mistake for the teardown half.

**Interfaces:**
- Consumes: the whole stack from Tasks 1-7.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

```ts
// apps/browser-demos/test/machine-switch-progress.spec.ts
//
// A real switch between two machines that share one VFS image. Unit tests
// cannot prove this: which pane is mounted during a switch is chosen at
// runtime, so a correctly-built overlay can still be invisible.

import { expect, test } from "@playwright/test";

const appUrl = (path: string): string => {
  const baseUrl = process.env.KANDELO_TEST_BASE_URL;
  return baseUrl ? new URL(path, baseUrl).href : path;
};

test("a machine switch shows teardown then load progress @slow", async ({
  browserName,
  context,
  page,
}) => {
  test.skip(browserName !== "chromium", "needs CDP network emulation");
  test.setTimeout(400_000);

  await page.goto(appUrl("/"), { waitUntil: "domcontentloaded" });
  await expect(page.locator(".xterm-rows").first()).toBeVisible({
    timeout: 240_000,
  });

  // Throttle before the second boot so the image load is observable.
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 40,
    downloadThroughput: (4 * 1024 * 1024) / 8,
    uploadThroughput: (1 * 1024 * 1024) / 8,
  });

  const headlines: string[] = [];
  await page.exposeFunction("__recordHeadline", (text: string) => {
    if (text && headlines.at(-1) !== text) headlines.push(text);
  });
  await page.evaluate(() => {
    setInterval(() => {
      const el = document.querySelector(".kmprogress-headline");
      if (el) {
        (window as unknown as {
          __recordHeadline: (t: string) => void;
        }).__recordHeadline(el.textContent ?? "");
      }
    }, 50);
  });

  await page.getByRole("button", { name: /^(New|Launch new computer)$/ })
    .first().click();
  await page.locator("tr.kgal-row").first().waitFor();
  await page.locator('tr.kgal-row:not([data-current="true"])')
    .filter({ hasText: /Node\.js/i }).first().click();

  await expect(page.locator(".kmprogress-card")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".xterm-rows").first()).toBeVisible({
    timeout: 240_000,
  });
  await expect(page.locator(".kmprogress-card")).toHaveCount(0);

  expect(headlines.some((h) => h.startsWith("Unloading"))).toBe(true);
  expect(headlines.some((h) => h.startsWith("Loading"))).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails, then passes**

Before Tasks 1-7 are complete this fails on the missing `.kmprogress-card`.
After them, run:

```bash
cd apps/browser-demos && \
WASM_POSIX_RESOLUTION_POLICY=source-only-v1 \
WASM_POSIX_SOURCE_ONLY_BINARY_ROOT="$(git rev-parse --show-toplevel)/local-binaries/source-only-v1" \
KANDELO_PLAYWRIGHT_PORT=5487 \
npx playwright test machine-switch-progress --project=chromium --reporter=list
```
Expected: PASS, 1 test.

- [ ] **Step 3: Manually verify through the real app**

```bash
bash scripts/dev-shell.sh ./run.sh browser --port 5911 --strictPort
```

Open `http://127.0.0.1:5911/pages/kandelo/`, switch machines from the New
gallery, and confirm: the overlay is centred, it reads `Unloading <machine>`
with a process count, then `Loading <image>` with bytes, and it clears when the
new machine reaches running. Repeat on a warm reload.

- [ ] **Step 4: Commit**

```bash
git add apps/browser-demos/test/machine-switch-progress.spec.ts
git commit -m "Browser: Cover machine switch progress against a real switch"
```

---

### Task 10: Full verification and PR update

**Files:**
- Modify: PR #1412 description.

- [ ] **Step 1: Run every wired suite**

```bash
cd host && npm run typecheck
cd host && npx vitest run ../web-libs/kandelo-session/ test/destroy-progress-reporter.test.ts \
  test/destroy-progress-protocol.test.ts test/destroy-progress-subscription.test.ts
cd apps/browser-demos && npm run test:unit
```
Expected: all pass. Record the counts; they go in the PR description.

- [ ] **Step 2: Run the browser specs**

```bash
cd apps/browser-demos && \
WASM_POSIX_RESOLUTION_POLICY=source-only-v1 \
WASM_POSIX_SOURCE_ONLY_BINARY_ROOT="$(git rev-parse --show-toplevel)/local-binaries/source-only-v1" \
KANDELO_PLAYWRIGHT_PORT=5487 \
npx playwright test boot-progress-ui boot-progress-live machine-progress-modal \
  machine-switch-progress gallery-current-machine terminal-links \
  --project=chromium --reporter=list
```
Expected: all pass.

- [ ] **Step 3: Update the PR description**

Add a section to PR #1412 covering the overlay: why teardown reported nothing,
that the counts come from `performDestroy`'s existing bookkeeping rather than a
new measurement, the provisional total and its `+`, the receding fill, the
correction that `post()` is the message port and not the syscall channel, and
the Node/browser parity of the worker change. Link the spec. Do not hard wrap.

- [ ] **Step 4: Commit and push**

```bash
git push
```

