# Audio Demand Signal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the browser app warning about audio on machines where no guest has ever opened `/dev/dsp`, without losing a genuine audio failure on a machine that has.

**Architecture:** The kernel already publishes guest audio demand into the shared PCM control header the browser main thread holds — `generation` is monotonic and non-zero only after `open_stream()`, and `state` is non-`CLOSED` only while a stream is open. `BrowserKernel` samples those two words with a self-stopping poll, latches the answer for the machine's lifetime, and exposes it through `KernelHost`/`LiveKernelHost`; `App.tsx` adds it to the toast condition. Nothing about the audio stack's behaviour changes — only what the UI warns about.

**Tech Stack:** TypeScript, React 19, Vitest (host), `node --test` (browser-demos unit), Playwright (browser e2e).

**Spec:** `docs/superpowers/specs/2026-09-25-audio-demand-signal-design.md`

## Global Constraints

- Truthful failure over convenient illusion: never report a `MachineAudioState` the system is not in. This plan adds a second, orthogonal boolean; it does not rewrite any existing state value.
- `"error"`, `"interrupted"` and `"unavailable"` must still reach the user on a machine whose guest opened `/dev/dsp`. Losing the genuine warning is a worse bug than the noise being removed.
- No special-casing by demo id, profile id or image name anywhere in this change.
- Driver construction and the eager `prepareAudio()` at `ready` (`host/src/browser-kernel-host.ts:1595-1608`) are **not** touched — that eager prepare is what makes the first gesture's `resume()` immediate.
- Kernel, ABI, `claimPcmTransport` timing and the worker protocol are unchanged. No `ABI_VERSION` bump, no `abi/snapshot.json` regeneration.
- Commit subjects use `Area: Purpose`; commit bodies wrap at 72 columns.
- Playwright against a real boot needs the source-only env and a unique port. Use `5623` with `--strictPort`; never 5401, 5487 or 5911 (other agents hold those).

## Review Focus

Input classes the spec implies but no single task's happy path exercises. Each has its test pinned to the task that owns the code.

1. **A guest that opens `/dev/dsp`, plays, and exits between two samples** — the latch must still read true afterwards, because `generation` stays bumped. Test pinned to Task 2.
2. **Subscribe / unsubscribe / re-subscribe across a machine's life** — the sampler stops with the last listener and must catch up on the next subscribe rather than miss an open that happened while nobody watched. Test pinned to Task 3.
3. **A `LiveKernelHost` wrapping a kernel that predates this API** (`getAudioActivity` undefined) — must answer `false` and return a working unsubscribe, not crash the app shell. Test pinned to Task 5.
4. **A machine with no PCM transport at all** (`msg.pcmTransport` absent) — `getAudioActivity()` must answer `false` and start no timer, rather than throwing on a null descriptor. Enforced by construction in Task 4 (the latch is created inside the existing `if (msg.pcmTransport)` guard). This repo has no unit harness for `BrowserKernel` — it needs a real Worker — so there is no test to pin; verify by inspection and in the Task 8 manual pass.
5. **Machine teardown while the sampler is running** — `destroy()` must clear the interval, or a destroyed machine keeps an `Atomics.load` timer alive per machine switch. The timer-clearing behaviour itself is tested at the latch level in Task 3 ("clears its timer on stop"); that `destroy()` actually calls it is enforced by construction in Task 4, for the same missing-harness reason.

---

### Task 1: Capture the red — the e2e test that proves the bug

**Files:**
- Create: `apps/browser-demos/test/kandelo-audio-toast.spec.ts`

**Interfaces:**
- Consumes: `gotoMachineOrSkip` from `apps/browser-demos/test/support/kandelo-machine.ts`.
- Produces: the spec later tasks must turn green. It asserts on the CSS class `kpcm-audio-status` (the toast's `<aside>`, `App.tsx:409`) and on the `data-audio-active` attribute Task 5 adds to the app root.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "@playwright/test";
import { gotoMachineOrSkip } from "./support/kandelo-machine";

// A shell machine runs no program that opens /dev/dsp. The kernel's shared
// PCM control header therefore still reads generation === 0 and
// state === CLOSED, and the app must not warn the user about a device
// nothing in the machine ever asked for.
test("Kandelo shell machine never warns about audio", async ({ page }) => {
  test.setTimeout(180_000);

  await gotoMachineOrSkip(page, "shell");

  // Wait for the machine itself, not for audio: the app root carries the
  // real audio state, so its presence means the shell is mounted.
  await expect(page.locator("[data-audio-state]")).toHaveCount(1, {
    timeout: 120_000,
  });

  // A click is what used to activate audio and, when the browser refused,
  // what produced the toast. It must stay silent here.
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.waitForTimeout(3_000);

  await expect(page.locator("[data-audio-active]")).toHaveAttribute(
    "data-audio-active",
    "false",
  );
  await expect(page.locator(".kpcm-audio-status")).toHaveCount(0);
});
```

- [ ] **Step 2: Run it and record the failure**

Run:

```bash
cd apps/browser-demos && \
WASM_POSIX_RESOLUTION_POLICY=source-only-v1 \
WASM_POSIX_SOURCE_ONLY_BINARY_ROOT="$(git rev-parse --show-toplevel)/local-binaries/source-only-v1" \
KANDELO_PLAYWRIGHT_PORT=5623 \
npx playwright test test/kandelo-audio-toast.spec.ts --project=chromium --reporter=list
```

Expected: FAIL. `data-audio-active` does not exist yet, so the attribute assertion fails; the `.kpcm-audio-status` assertion is the one that proves the user-visible bug and must also be observed failing (toast count 1, expected 0). Record both in the final report. If the spec reports `0 tests`, the run discovered nothing — check the port and the source-only env before believing it.

- [ ] **Step 3: Commit the red test**

```bash
git add apps/browser-demos/test/kandelo-audio-toast.spec.ts
git commit -m "$(cat <<'EOF'
Browser: Add the failing test for the audio warning on silent machines

A shell machine opens no PCM stream, yet clicking it raises "Audio
suspended". This spec pins the behaviour a user should see and fails
against current main, where the toast appears and no demand signal
exists at all.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: The demand helper

**Files:**
- Modify: `host/src/audio/pcm-transport.ts` (add one exported function near `readPcmConfig`)
- Test: `host/test/pcm-transport.test.ts`

**Interfaces:**
- Consumes: `PCM_CONTROL`, `PcmStreamState`, `loadU32` — all already exported from `host/src/audio/pcm-transport.ts` (`loadU32` at pcm-transport.ts:300).
- Produces: `export function pcmGuestAudioActivity(words: Int32Array): boolean`.

- [ ] **Step 1: Write the failing test**

Append to `host/test/pcm-transport.test.ts`, inside the existing `describe("PCM shared transport", ...)` block. The imports at the top of that file must gain `PcmStreamState`, `pcmGuestAudioActivity` and `storeU32`.

```ts
  it("reports no guest audio for a transport the host merely claimed", () => {
    const words = new Int32Array(new SharedArrayBuffer(PCM_CONTROL_BYTES));
    storeU32(words, PCM_CONTROL.generation, 0);
    storeU32(words, PCM_CONTROL.state, PcmStreamState.Closed);
    expect(pcmGuestAudioActivity(words)).toBe(false);
  });

  it("reports guest audio once a stream is open", () => {
    const words = new Int32Array(new SharedArrayBuffer(PCM_CONTROL_BYTES));
    storeU32(words, PCM_CONTROL.generation, 1);
    storeU32(words, PCM_CONTROL.state, PcmStreamState.Stopped);
    expect(pcmGuestAudioActivity(words)).toBe(true);
  });

  // Review Focus 1: a program that plays a short sound and exits leaves the
  // state back at CLOSED. The monotonic generation is what records that it
  // happened, so a sampler cannot miss it.
  it("still reports guest audio after the stream closes again", () => {
    const words = new Int32Array(new SharedArrayBuffer(PCM_CONTROL_BYTES));
    storeU32(words, PCM_CONTROL.generation, 3);
    storeU32(words, PCM_CONTROL.state, PcmStreamState.Closed);
    expect(pcmGuestAudioActivity(words)).toBe(true);
  });
```

Add `PCM_CONTROL_BYTES` to the import list too.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd host && npx vitest run test/pcm-transport.test.ts`
Expected: FAIL — `pcmGuestAudioActivity is not a function` / no exported member.

- [ ] **Step 3: Write the implementation**

In `host/src/audio/pcm-transport.ts`, after `readPcmConfig`:

```ts
/**
 * Has a guest opened `/dev/dsp` on this machine?
 *
 * The kernel already publishes both halves of the answer into this header.
 * `open_stream()` bumps `generation` and stores a non-closed `state`
 * (crates/runtime-core/src/audio.rs:352), while the host's eager
 * `claim_transport()` touches neither (audio.rs:781). So a machine whose
 * guests never opened the device reads generation 0 and state closed for its
 * whole life.
 *
 * `generation` is what makes this safe to sample rather than subscribe to: it
 * is monotonic, so a program that opens the device, writes a short sound and
 * exits between two observations still leaves its mark.
 */
export function pcmGuestAudioActivity(words: Int32Array): boolean {
  return (
    loadU32(words, PCM_CONTROL.generation) !== 0 ||
    loadU32(words, PCM_CONTROL.state) !== PcmStreamState.Closed
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd host && npx vitest run test/pcm-transport.test.ts`
Expected: PASS, including the three new cases.

- [ ] **Step 5: Commit**

```bash
git add host/src/audio/pcm-transport.ts host/test/pcm-transport.test.ts
git commit -m "$(cat <<'EOF'
Browser: Read the guest audio demand the kernel already publishes

The shared PCM control header records whether a guest ever opened
/dev/dsp: open_stream bumps the monotonic generation and leaves state
non-closed, and the host's eager transport claim touches neither. The
host has never read those words, so the UI could not tell an idle sink
from a broken one.

pcmGuestAudioActivity answers that question from the header alone. The
generation half is what makes sampling sound: a program that plays one
short sound and exits cannot slip between two observations.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: The latch and its sampler

**Files:**
- Create: `host/src/audio/audio-activity-latch.ts`
- Create: `host/test/audio-activity-latch.test.ts`

**Interfaces:**
- Consumes: `pcmGuestAudioActivity` from Task 2.
- Produces:
  ```ts
  export const AUDIO_ACTIVITY_SAMPLE_MS = 500;
  export class AudioActivityLatch {
    constructor(words: Int32Array, onActivate: () => void, intervalMs?: number);
    get active(): boolean;
    start(): void;
    stop(): void;
  }
  ```

- [ ] **Step 1: Write the failing test**

Create `host/test/audio-activity-latch.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUDIO_ACTIVITY_SAMPLE_MS,
  AudioActivityLatch,
} from "../src/audio/audio-activity-latch";
import {
  PCM_CONTROL,
  PCM_CONTROL_BYTES,
  PcmStreamState,
  storeU32,
} from "../src/audio/pcm-transport";

function closedHeader(): Int32Array {
  const words = new Int32Array(new SharedArrayBuffer(PCM_CONTROL_BYTES));
  storeU32(words, PCM_CONTROL.generation, 0);
  storeU32(words, PCM_CONTROL.state, PcmStreamState.Closed);
  return words;
}

describe("AudioActivityLatch", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("stays inactive while no guest opens the device", () => {
    const latch = new AudioActivityLatch(closedHeader(), () => {});
    latch.start();
    vi.advanceTimersByTime(AUDIO_ACTIVITY_SAMPLE_MS * 20);
    expect(latch.active).toBe(false);
  });

  it("latches and notifies once when a guest opens the device", () => {
    const words = closedHeader();
    const onActivate = vi.fn();
    const latch = new AudioActivityLatch(words, onActivate);
    latch.start();
    vi.advanceTimersByTime(AUDIO_ACTIVITY_SAMPLE_MS);
    expect(latch.active).toBe(false);

    storeU32(words, PCM_CONTROL.generation, 1);
    storeU32(words, PCM_CONTROL.state, PcmStreamState.Stopped);
    vi.advanceTimersByTime(AUDIO_ACTIVITY_SAMPLE_MS);

    expect(latch.active).toBe(true);
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("stops sampling once latched", () => {
    const words = closedHeader();
    storeU32(words, PCM_CONTROL.generation, 1);
    const latch = new AudioActivityLatch(words, () => {});
    latch.start();
    vi.advanceTimersByTime(AUDIO_ACTIVITY_SAMPLE_MS);
    expect(latch.active).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  // Review Focus 2: a subscriber may come and go. Because the signal is
  // latched and generation is monotonic, a later start() catches up on an
  // open that happened while nobody was watching.
  it("catches up on an open that happened while stopped", () => {
    const words = closedHeader();
    const latch = new AudioActivityLatch(words, () => {});
    latch.start();
    latch.stop();
    storeU32(words, PCM_CONTROL.generation, 7);
    storeU32(words, PCM_CONTROL.state, PcmStreamState.Closed);
    latch.start();
    expect(latch.active).toBe(true);
  });

  it("clears its timer on stop", () => {
    const latch = new AudioActivityLatch(closedHeader(), () => {});
    latch.start();
    expect(vi.getTimerCount()).toBe(1);
    latch.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd host && npx vitest run test/audio-activity-latch.test.ts`
Expected: FAIL — cannot resolve `../src/audio/audio-activity-latch`.

- [ ] **Step 3: Write the implementation**

Create `host/src/audio/audio-activity-latch.ts`:

```ts
import { pcmGuestAudioActivity } from "./pcm-transport.js";

/**
 * How often to ask the shared control header whether a guest has opened the
 * audio device. This is one `Atomics.load` pair, and it stops for good on the
 * first positive answer, so the cost is bounded by the machines that never
 * use audio — the exact machines this signal exists to keep quiet.
 */
export const AUDIO_ACTIVITY_SAMPLE_MS = 500;

/**
 * Latched "a guest opened /dev/dsp on this machine" flag.
 *
 * Latched on purpose: a program that speaks one sentence into a sink the user
 * never enabled should keep the warning up after it exits, because that is the
 * case where losing the warning costs the user most. The kernel's `generation`
 * word is monotonic, so the latch is also immune to sampling — a short
 * open/write/close between two ticks still leaves evidence behind.
 */
export class AudioActivityLatch {
  private timer: ReturnType<typeof setInterval> | null = null;
  private latched = false;

  constructor(
    private readonly words: Int32Array,
    private readonly onActivate: () => void,
    private readonly intervalMs: number = AUDIO_ACTIVITY_SAMPLE_MS,
  ) {}

  get active(): boolean {
    return this.latched;
  }

  /** Begin (or resume) sampling. A no-op once latched. */
  start(): void {
    if (this.latched || this.timer !== null) return;
    if (this.sample()) return;
    this.timer = setInterval(() => this.sample(), this.intervalMs);
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private sample(): boolean {
    if (this.latched) return true;
    if (!pcmGuestAudioActivity(this.words)) return false;
    this.latched = true;
    this.stop();
    this.onActivate();
    return true;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd host && npx vitest run test/audio-activity-latch.test.ts`
Expected: PASS, all five cases.

- [ ] **Step 5: Commit**

```bash
git add host/src/audio/audio-activity-latch.ts host/test/audio-activity-latch.test.ts
git commit -m "$(cat <<'EOF'
Browser: Latch whether a machine has ever used audio

The signal a user-facing warning needs is not "is a stream open now" but
"has this machine ever asked for audio". A program that speaks one
sentence into a sink nobody enabled should keep warning after it exits.

AudioActivityLatch samples the shared control header, latches the first
positive answer for the machine's lifetime, and then stops its timer for
good. Machines that never touch audio pay one Atomics.load per tick;
machines that do stop paying entirely.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Expose demand from `BrowserKernel`

**Files:**
- Modify: `host/src/browser-kernel-host.ts` — field block near line 308, audio methods near 1263-1279, `destroy()` near 1449-1451, `ready` handler near 1595-1608.

**Interfaces:**
- Consumes: `AudioActivityLatch` (Task 3), `pcmControlWords` (already imported in this file's neighbourhood via `./audio/pcm-transport`).
- Produces on `BrowserKernel`:
  ```ts
  getAudioActivity(): boolean;
  onAudioActivityChange(listener: (active: boolean) => void): () => void;
  ```

- [ ] **Step 1: Add the imports and fields**

At the existing `import type { PcmTransportDescriptor } from "./audio/pcm-transport";` (browser-kernel-host.ts:54), add a value import:

```ts
import { pcmControlWords } from "./audio/pcm-transport.js";
import { AudioActivityLatch } from "./audio/audio-activity-latch.js";
```

(If `pcmControlWords` is already imported in this file, extend that import instead of adding a second one.)

Next to `private pcmDriver: BrowserPcmDriver | null = null;` (browser-kernel-host.ts:309):

```ts
  private audioActivity: AudioActivityLatch | null = null;
  private audioActivityListeners = new Set<(active: boolean) => void>();
```

- [ ] **Step 2: Add the public accessors**

Directly after `onAudioStateChange` (browser-kernel-host.ts:1269-1279):

```ts
  /**
   * Has a guest in this machine opened the audio device?
   *
   * Orthogonal to `getAudioState()`, which describes the host sink. This
   * describes whether anything in the machine ever asked for one, and is what
   * lets the UI tell an idle sink from a broken one instead of warning every
   * machine about a device it never used.
   */
  getAudioActivity(): boolean {
    return this.audioActivity?.active ?? false;
  }

  onAudioActivityChange(listener: (active: boolean) => void): () => void {
    this.audioActivityListeners.add(listener);
    listener(this.getAudioActivity());
    this.audioActivity?.start();
    return () => {
      this.audioActivityListeners.delete(listener);
      if (this.audioActivityListeners.size === 0) this.audioActivity?.stop();
    };
  }

  private emitAudioActivity(): void {
    const active = this.getAudioActivity();
    for (const cb of this.audioActivityListeners) {
      try { cb(active); } catch { /* listener errors don't break the loop */ }
    }
  }
```

- [ ] **Step 3: Create the latch when the transport arrives**

In `handleWorkerMessage`'s `ready` case, immediately after `this.pcmTransport = msg.pcmTransport;` (browser-kernel-host.ts:1596) and before the existing `AudioContext` check:

```ts
          this.audioActivity = new AudioActivityLatch(
            pcmControlWords(msg.pcmTransport),
            () => this.emitAudioActivity(),
          );
          if (this.audioActivityListeners.size > 0) this.audioActivity.start();
```

Review Focus 4: this sits inside the existing `if (msg.pcmTransport)` guard, so a machine with no transport keeps `audioActivity === null`, `getAudioActivity()` returns `false`, and no timer is ever created.

- [ ] **Step 4: Stop the sampler on teardown**

In `destroy()`, beside the existing PCM driver teardown (browser-kernel-host.ts:1449-1451):

```ts
    this.audioActivity?.stop();
    this.audioActivity = null;
    this.audioActivityListeners.clear();
```

Review Focus 5: without this, every machine switch leaves a live interval behind.

- [ ] **Step 5: Typecheck**

Run: `cd host && npm run typecheck`
Expected: PASS. (This is the CI gate for host code; `apps/browser-demos`'s own `tsc` has pre-existing errors and is not a gate.)

- [ ] **Step 6: Commit**

```bash
git add host/src/browser-kernel-host.ts
git commit -m "$(cat <<'EOF'
Browser: Expose guest audio demand from BrowserKernel

A machine's audio sink state and whether anything in the machine wants
audio are different facts, and the host only ever published the first.
BrowserKernel now answers the second from the transport it already
holds, starting the sampler when someone subscribes and dropping it at
destroy so a machine switch leaves no timer behind.

A machine that never receives a PCM transport keeps a null latch,
answers false, and creates no timer at all.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Carry demand through the session contract

**Files:**
- Modify: `web-libs/kandelo-session/src/kernel-host.ts` — `KernelLike` optional members near 251-255, `KernelHost` interface near 823-828, `LiveKernelHost` fields near 1123/1135, `attachKernel` near 1201-1206, `detachKernel` near 1221-1223, teardown near 1559-1560, methods near 2309-2316.
- Test: `web-libs/kandelo-session/test/kandelo-session.test.ts`

**Interfaces:**
- Consumes: `BrowserKernel.getAudioActivity` / `onAudioActivityChange` (Task 4), structurally, through `KernelLike`.
- Produces on `KernelHost`: `getAudioActivity(): boolean` and `subscribeAudioActivity(cb: (active: boolean) => void): () => void`.

- [ ] **Step 1: Write the failing test**

Append to `web-libs/kandelo-session/test/kandelo-session.test.ts`, following the shape of the existing audio tests near line 707:

```ts
  it("reports guest audio demand from the kernel and defaults to false without it", () => {
    let emit: ((active: boolean) => void) | null = null;
    let active = false;
    const host = new LiveKernelHost({
      kernel: {
        getAudioActivity: () => active,
        onAudioActivityChange: (cb: (value: boolean) => void) => {
          emit = cb;
          cb(active);
          return () => { emit = null; };
        },
      } as never,
    });

    const observed: boolean[] = [];
    const off = host.subscribeAudioActivity((value) => observed.push(value));
    expect(observed).toEqual([false]);

    active = true;
    emit?.(true);
    expect(observed).toEqual([false, true]);
    expect(host.getAudioActivity()).toBe(true);
    off();

    // Review Focus 3: a kernel that predates this API must not crash the shell.
    const legacy = new LiveKernelHost({ kernel: {} as never });
    expect(legacy.getAudioActivity()).toBe(false);
    const offLegacy = legacy.subscribeAudioActivity(() => {});
    expect(typeof offLegacy).toBe("function");
    offLegacy();
  });
```

This mirrors the construction the neighbouring audio tests already use
(`kandelo-session.test.ts:707-740`): a `LiveKernelHost` built around a literal
fake kernel cast `as never`.

- [ ] **Step 2: Run test to verify it fails**

`web-libs` has no test runner of its own — its specs run from `host`'s vitest
config, which includes `../web-libs/**/*.test.ts`.

Run: `cd host && npx vitest run ../web-libs/kandelo-session/test/kandelo-session.test.ts -t "guest audio demand"`
Expected: FAIL — `host.subscribeAudioActivity is not a function`.

Never start a second vitest run in this worktree while one is in flight; two
concurrent runs fight over the shared program index and fail each other.

- [ ] **Step 3: Add the optional kernel members**

In `KernelLike`, after `onAudioStateChange?(...)` (kernel-host.ts:255):

```ts
  /**
   * Has a guest in this machine opened the audio device? Orthogonal to
   * `getAudioState`, which describes the host sink rather than demand for it.
   */
  getAudioActivity?(): boolean;
  onAudioActivityChange?(cb: (active: boolean) => void): () => void;
```

- [ ] **Step 4: Add the host-facing members**

In `KernelHost`, after `subscribeAudioState(...)` (kernel-host.ts:828):

```ts
  /** Latched: has any guest in this machine opened the audio device? */
  getAudioActivity(): boolean;
  subscribeAudioActivity(cb: (active: boolean) => void): () => void;
```

- [ ] **Step 5: Implement on `LiveKernelHost`**

Fields, beside `audioStateListeners` (kernel-host.ts:1123) and `offAudioState` (kernel-host.ts:1135):

```ts
  private audioActivityListeners = new ListenerSet<boolean>();
  private offAudioActivity: (() => void) | null = null;
```

In `attachKernel`, after the `onAudioStateChange` block (kernel-host.ts:1201-1206):

```ts
    if (kernel.onAudioActivityChange) {
      this.offAudioActivity = kernel.onAudioActivityChange((active) => {
        this.audioActivityListeners.emit(active);
      });
    }
    this.audioActivityListeners.emit(this.getAudioActivity());
```

In `detachKernel` (kernel-host.ts:1221-1223) and in the teardown path at kernel-host.ts:1559-1560, beside each existing `this.offAudioState?.(); this.offAudioState = null;` pair:

```ts
    this.offAudioActivity?.();
    this.offAudioActivity = null;
```

In `detachKernel` only, beside `this.audioStateListeners.emit("unavailable");`:

```ts
    this.audioActivityListeners.emit(false);
```

Methods, after `subscribeAudioState` (kernel-host.ts:2313-2317):

```ts
  getAudioActivity(): boolean {
    return this.kernel?.getAudioActivity?.() ?? false;
  }

  subscribeAudioActivity(cb: (active: boolean) => void): () => void {
    const off = this.audioActivityListeners.add(cb);
    cb(this.getAudioActivity());
    return off;
  }
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd host && npx vitest run ../web-libs/kandelo-session/test/kandelo-session.test.ts -t "guest audio demand"`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add web-libs/kandelo-session/src/kernel-host.ts web-libs/kandelo-session/test/kandelo-session.test.ts
git commit -m "$(cat <<'EOF'
Browser: Carry guest audio demand through the session contract

KernelHost already publishes the audio sink's state to the app. It now
also publishes whether anything in the machine asked for audio, so a
consumer can tell an idle sink from a failing one.

Both members are optional on KernelLike and default to false, so a
kernel that predates them leaves the app shell working rather than
crashing on a missing method.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Gate the toast

**Files:**
- Modify: `apps/browser-demos/pages/kandelo/app/App.tsx` — state near 83, subscription near 113-120, root element near 346, toast condition near 398.

**Interfaces:**
- Consumes: `KernelHost.getAudioActivity` / `subscribeAudioActivity` (Task 5).
- Produces: `data-audio-active` on the app root, which Task 1's spec asserts.

- [ ] **Step 1: Track demand**

Beside the existing `audioState` state (App.tsx:83):

```tsx
  const [audioActive, setAudioActive] = React.useState<boolean>(() => host.getAudioActivity());
```

Beside the existing audio-state effect (App.tsx:113-120):

```tsx
  React.useEffect(
    () => host.subscribeAudioActivity(setAudioActive),
    [host],
  );
```

- [ ] **Step 2: Publish demand on the root element**

At App.tsx:346, extend the existing attributes:

```tsx
    <div className={appClassName} style={appStyle} data-audio-state={audioState} data-audio-active={audioActive ? "true" : "false"}>
```

- [ ] **Step 3: Gate the toast**

At App.tsx:398:

```tsx
        {surface.status === "running" && audioActive && audioState !== "running" && (
```

The `AudioStatusToast` component, `activateAudio`, the `pointerdown`/`keydown` listeners and `Framebuffer.tsx` are all deliberately unchanged: the resume attempt and the warning are independent axes, and only the warning is being gated.

- [ ] **Step 4: Run the unit gates**

Run: `cd apps/browser-demos && npm run test:unit`
Expected: PASS (no new unit tests here; this proves nothing regressed).

Run: `cd host && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/browser-demos/pages/kandelo/app/App.tsx
git commit -m "$(cat <<'EOF'
Browser: Warn about audio only when a guest asked for it

The toast rendered whenever a running machine's sink was not playing,
so a bare shell told the user audio was suspended or unavailable for a
device nothing in the machine had ever opened.

It now also requires that a guest opened the audio device. A machine
that uses audio still surfaces every real failure - suspended, error,
interrupted, unavailable - and the state itself is unchanged: the root
element still carries the real audio state and now the demand beside it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Prove the genuine warning survives, on a real boot

**Files:**
- Modify: `apps/browser-demos/test/kandelo-audio-toast.spec.ts` (add the espeak direction)

**Interfaces:**
- Consumes: everything above, end to end, through a real kernel and a real guest.

- [ ] **Step 1: Write the test for the other direction**

Append to `apps/browser-demos/test/kandelo-audio-toast.spec.ts`:

```ts
// The other direction, and the one that matters more: a machine whose guest
// really does open /dev/dsp must still surface a real audio problem. Without
// a gesture the browser's autoplay policy holds the sink below "running", so
// the warning is the correct thing to show — and it must still appear.
test("Kandelo espeak machine still warns when its audio cannot play", async ({ page }) => {
  test.setTimeout(300_000);

  await gotoMachineOrSkip(page, "espeak");

  // No click: espeak-ng runs from the boot path and opens /dev/dsp on its
  // own, which is exactly the demand signal under test.
  await expect(page.locator("[data-audio-active]")).toHaveAttribute(
    "data-audio-active",
    "true",
    { timeout: 240_000 },
  );

  await expect(page.locator("[data-audio-state]")).not.toHaveAttribute(
    "data-audio-state",
    "running",
  );
  await expect(page.locator(".kpcm-audio-status")).toBeVisible();
});
```

Decision point to resolve empirically, not by assumption: if this run shows `data-audio-state` already `running` without any gesture, the browser under test is autoplaying and the assertion is testing the wrong thing. In that case do **not** weaken the assertion — establish the non-running state honestly instead (a Chromium launch arg that restores the default autoplay policy for this spec, or driving the machine through the existing `pages/test-runner/main.ts` harness) and say in the report which was used.

- [ ] **Step 2: Run both specs**

Run:

```bash
cd apps/browser-demos && \
WASM_POSIX_RESOLUTION_POLICY=source-only-v1 \
WASM_POSIX_SOURCE_ONLY_BINARY_ROOT="$(git rev-parse --show-toplevel)/local-binaries/source-only-v1" \
KANDELO_PLAYWRIGHT_PORT=5623 \
npx playwright test test/kandelo-audio-toast.spec.ts --project=chromium --reporter=list
```

Expected: 2 passed. Check the count, not just the exit code — a spec that discovers 0 tests also exits 0.

- [ ] **Step 3: Run the existing espeak regression**

Run the same command against `test/kandelo-espeak.spec.ts`.
Expected: PASS — the click still moves the machine to `data-audio-state="running"` and espeak still reaches a prompt. This is the proof that gating the warning did not change the audio path.

- [ ] **Step 4: Commit**

```bash
git add apps/browser-demos/test/kandelo-audio-toast.spec.ts
git commit -m "$(cat <<'EOF'
Browser: Pin that a machine using audio still warns

Removing noise is only safe if the genuine warning survives. This boots
the espeak machine without a gesture, waits for espeak-ng to open
/dev/dsp, and requires the toast to appear while the sink is held below
running by the browser's autoplay policy.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Full validation and manual verification

**Files:** none — evidence only.

- [ ] **Step 1: Host audio suites**

Run: `cd host && npx vitest run test/pcm-transport.test.ts test/audio-activity-latch.test.ts test/browser-pcm-driver.test.ts test/node-pcm-driver.test.ts test/pcm-audio-worklet.test.ts test/audio-integration.test.ts test/audio-signal-interruption.test.ts test/pcm-wake-observer.test.ts`
Expected: PASS. Record counts.

- [ ] **Step 2: Gates**

Run: `cd host && npm run typecheck`
Run: `cd apps/browser-demos && npm run test:unit`
Run: `cd host && npx vitest run ../web-libs/kandelo-session/test/kandelo-session.test.ts`
Expected: PASS each. Run these one at a time — concurrent vitest runs in one
worktree collide on the shared program index. Any failure must be reproduced on pristine `main` before being attributed to this change — whole-repo Vitest currently fails on `main` in a fresh worktree with `user program lacks a kandelo.abi.contract stamp`.

- [ ] **Step 3: Manual browser verification**

Run: `./run.sh browser`

Check by hand and report what was seen:
- boot the shell machine, click around, confirm no audio toast and `data-audio-active="false"` in the inspector;
- boot the espeak machine without clicking, confirm the toast appears once espeak speaks, and that its Enable button starts audio;
- boot the espeak machine, click first, confirm audio plays with no toast — the eager-resume path is intact.

- [ ] **Step 4: Report**

State exactly what was run and what was not: which suites, which browsers, which machines by hand. Name the Task 1 failure explicitly as the red-before-green evidence. Do not claim browser coverage beyond Chromium unless WebKit was actually run.
