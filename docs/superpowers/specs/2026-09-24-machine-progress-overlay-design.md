# Machine progress overlay: destroy and load

Status: design approved 2026-09-24. Sections 3-5 were folded in without
section-by-section review at the maintainer's direction ("good enough for
now"). The centred-overlay requirement in section 3 is a direct maintainer
instruction, not an inference: the bar this design replaces was judged to read
as a stray element in a left-hand pane.

This work lands on PR #1412 rather than as a follow-up, by maintainer
direction — the load bar shipping there is the UI being corrected, so the two
belong in one change.

## Why

Switching machines in the browser has two visible stalls and the page reports
neither.

`startBoot` (`apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts`)
tears down the outgoing kernel before it builds the new one: `detachKernel()`,
then `await previousKernel.destroy()`, then
`settleAfterBootResourcesReleased()`, then `bootProfile(...)`.
`setStatus("booting")` does not run until inside `bootProfile`. So for the
whole teardown the UI still shows the *old* machine as "Running", with its
surfaces on screen, while that machine no longer exists.

Teardown is not instant. `BrowserKernel.destroy()` waits up to
`DESTROY_REQUEST_TIMEOUT_MS` (2000 ms) for a graceful realm destroy, and the
worker's drain loop runs up to `DESTROY_KILL_DRAIN_TIMEOUT_MS` (1500 ms). Then
the PCM pipeline settles and closes, the worker realm terminates, and
`settleWebKitReclaim()` runs. That is several seconds during which the page
looks frozen on a machine that is already gone.

The load half has a progress bar as of this branch, but it is drawn inside the
primary surface. The goal here is one overlay covering the page for the whole
switch, naming what is happening and what is being destroyed or loaded.

## What the user sees

One full-page overlay, active from the start of teardown to the moment the new
machine reaches `running`. Two phases, each with its own real measurement:

- `Unloading Bare shell` — `3 of 7+ processes`, becoming `9 of 9 processes`
  once teardown knows the full count
- `Loading browser-main-shell image` — `1.1 MiB / 2.3 MiB`

The bar re-bases between phases rather than pretending to be one continuous
0-100%. Weighting teardown against image bytes would require inventing a
conversion between processes and bytes; there is no principled one, and a
number that looks precise while being made up is the failure mode this design
exists to avoid.

## The measurement is real

`performDestroy` in `host/src/browser-kernel-worker-entry.ts` already computes
the numbers; nothing new has to be counted.

- Phase 1 — `killAllBlockedForTeardown()` returns `Set<number>`, the pids it
  woke. An exact count.
- Phase 2 — the drain loop's `stillDraining()` tests `processes.has(pid)` for
  each woken pid, so at any instant it knows how many of N have exited.
- Phase 3 — iterates `[...processes.entries()]`, terminating stragglers and
  thread workers. Also countable.

`host/src/node-kernel-worker-entry.ts` carries the same three phases, the same
1500 ms / 15 ms constants, and a comment stating the phases mirror the browser
entry. This is the same change twice, not a browser feature with a Node stub.

## Rebase note (2026-09-24)

Rebased onto #1416, which moved VFS image composition into a disposable
worker. That change did not touch `performDestroy` in either worker entry, nor
`BrowserKernel.destroy()`, so every teardown count this design relies on is
unaffected. It did move `startBoot`, which now begins at `live-setup.ts:702`.

## Design

### 1. The signal (worker protocol, both hosts)

A `destroy_progress` message joins `KernelToMainMessage` in **both**
`host/src/browser-kernel-protocol.ts` and `host/src/node-kernel-protocol.ts`,
alongside the existing `lazy_download` message it is modelled on:

```ts
export type DestroyPhase = "draining" | "terminating";

export interface DestroyProgressEvent {
  phase: DestroyPhase;
  completed: number;
  total: number;
  /** True while `total` may still grow. See "Provisional total" below. */
  totalProvisional: boolean;
}

export interface DestroyProgressMessage {
  type: "destroy_progress";
  event: DestroyProgressEvent;
}
```

Emitted from `performDestroy` in both worker entries, at the points where the
code already holds the numbers:

- After phase 1: `{ draining, completed: 0, total: woken.size,
  totalProvisional: true }`.
- During phase 2: emit **only when `completed` increases**, not on every 15 ms
  poll tick. Same information, at most N messages for N processes instead of up
  to 100 per teardown.
- Phase 3: `{ terminating, completed: woken.size + k, total: woken.size + M,
  totalProvisional: false }`, where M is the straggler count captured at phase
  entry.

The worker emits **cumulative** counts, not per-phase ones. Phase 3's numbers
carry phase 2's total forward so `completed` never resets between phases, which
means consumers forward events unchanged instead of each reimplementing the
accumulation. See "Cumulative denominator" below for why the total may grow.

Phase 1 is a single awaited call with no internal granularity, so it gets no
fabricated sub-progress. It is the gap before the first `draining` event, during
which the bar is indeterminate.

`BrowserKernel` and `NodeKernelHost` each gain `subscribeDestroyProgress(cb)`,
mirroring their existing `subscribeLazyDownloads`, plus a `case
"destroy_progress"` in the message dispatch. `KernelLike` in
`web-libs/kandelo-session` gains it as an optional method, so a kernel that does
not implement it reports nothing rather than failing.

**Transport, and what this does not cost.** `post()` is plain `postMessage`
in both entries — `globalThis.postMessage` in the browser worker,
`port.postMessage` in Node. That is the structured-clone message port, which is
a *different* transport from the syscall path: syscalls ride the
SharedArrayBuffer channel with `Atomics.wait`/`notify` and `CH_STATUS` /
`CH_PENDING`, which is exactly what `killAllBlockedForTeardown` walks to wake
parked workers. A `destroy_progress` message never touches that channel.

So the cost is a structured clone and a main-thread task per message, for a
handful of small objects, during teardown, while guests are being killed and
syscall traffic is ending anyway. Emitting on change rather than on tick is
tidiness, not mitigation of a real risk. (An earlier draft of this spec claimed
these messages shared the syscall channel and treated the traffic as an
accepted cost. That was wrong.)

### 2. The host channel and wiring

`BootProgress`, added earlier in this branch, generalizes into one
machine-lifecycle record. It stays host-owned, so it survives
`detachKernel()` — which matters because detach runs *before* destroy and
tears down every kernel-scoped subscription:

```ts
export interface MachineProgress {
  phase: "destroying" | "image";
  label: string;
  completed: number;
  total?: number;        // absent -> indeterminate, never invented
  totalProvisional?: boolean;  // true -> `total` may still grow
  unit: "processes" | "bytes";
  status: "loading" | "complete" | "error";
  error?: string;
}
```

`unit` lets the overlay format without branching on phase. The
`draining`/`terminating` sub-phase is deliberately not carried into this record:
"Unloading Bare shell" plus a real count answers what is happening and to what,
and the internal step name is implementation detail.

Wiring in `startBoot`:

- Capture the outgoing machine's title from `h.getBootDescriptor()` at the top.
  Verified: `setDescriptor` for the incoming machine runs inside `bootProfile`,
  after destroy, so the descriptor still names the outgoing machine here.
- Publish `{ phase: "destroying", label, completed: 0, unit: "processes",
  status: "loading" }` before `previousKernel.destroy()`.
- Subscribe to `previousKernel.subscribeDestroyProgress`, republish each event
  under the existing `seq === bootSeq` guard so a superseded boot cannot drive
  the overlay, and unsubscribe in a `finally`.

**`detachKernel()` stays before `destroy()`.** Its ordering carries an explicit
WHY: detaching while this activation still owns the previous generation is what
stops a superseded boot from detaching a *newer* kernel when it resumes.
Reordering it to simplify this feature would trade a concurrency invariant for a
progress bar.

The existing clearing rule needs no change. Verified: during destroy the status
is still `running` so no clear fires; `setStatus("booting")` does not clear; the
final `setStatus("running")` does.

**Provisional total.** Phases 2 and 3 count different sets — drained pids,
then stragglers discovered afterwards. Reporting each with its own denominator
makes the bar jump backwards (7/7 then 0/2), which reads as broken. So the
worker emits cumulative totals (see section 1): phase 2 reports
`total = woken.size`; when phase 3 finds M stragglers the total becomes
`woken.size + M`, with `completed` continuing upward and never resetting.

The total is therefore a lower bound until phase 3 fixes it, and the UI says so
rather than letting it change silently: while `totalProvisional` is true the
count renders as `3 of 7+ processes`, and once the total is final as
`9 of 9 processes`. The `+` is what makes the growth expected instead of
looking like a bug.

Note the obvious phrasing is backwards and must be avoided. The phase-2 total
*is* the blocked set — exactly the processes parked in `Atomics.wait` that
`killAllBlockedForTeardown` woke. What phase 3 adds is the opposite: the
stragglers, which the code describes as "non-blocked workers, or any that didn't
exit in time", plus thread workers. So a label like "7 + blocked" would misname
the number; 7 already is the blocked count.

**The fill may recede once.** With a provisional total, `7 of 7` shows 100% and
then becomes `7 of 9` at 78% when stragglers are found. That is accepted: the
`+` marks the number as a lower bound, so the drop is legible as the system
learning rather than a glitch. The alternatives are worse — capping the fill
below 100% while provisional is a small lie, and holding the bar indeterminate
until the total is final discards the real measurement available during the
longest phase.

### 3. The overlay

A `MachineProgressOverlay` component rendered at the App root, visible whenever
`useMachineProgress()` is non-null. It replaces the in-pane `BootProgressBar`
added earlier in this branch — that component is deleted rather than left as a
second bar for the same event. Its CSS is renamed with it.

- Full-page: `position: fixed; inset: 0`, using the backdrop-blur idiom already
  present in `styles.css` (`.kshare-backdrop` and peers).
- **Centred.** The card holding the label, bar and counts is centred in the
  viewport, not pinned to a pane or an edge. This is the explicit fix for the
  bar this design replaces: that one rendered inside the primary surface slot,
  so it appeared in whatever pane happened to be mounted and read as a stray
  element in a left-hand column rather than as the state of the whole machine.
  A machine switch is a whole-page event and has to look like one. The card has
  a bounded width so the bar does not stretch across a wide monitor.
- Modal. The outgoing machine is gone and the incoming one is not up, so there
  is nothing meaningful to interact with underneath. The app container gets
  `inert` while the overlay is up, so blocking pointer events does not leave
  keyboard users tabbing into hidden content.
- Content: verb plus label (`Unloading <label>` / `Loading <label>`), the bar,
  and the formatted counts — `3 of 7+ processes` while the total is
  provisional, `9 of 9 processes` once final, `1.1 MiB / 2.3 MiB` for bytes.
- Accessibility: `role="progressbar"` with `aria-valuenow`/`min`/`max` when a
  total exists, `aria-valuetext` when indeterminate; the container is
  `role="status"` with `aria-live="polite"` so a phase change is announced once
  rather than on every tick. A provisional total always sets `aria-valuetext`
  to spell it out — "3 of at least 7 processes" — because a bare `+` conveys
  nothing to a screen reader.

### 4. Degradation

Each case below is a state the system can really reach; none of them may be
presented as success.

- **Kernel already fatal, or never initialized.** `destroy()` returns before
  issuing a request, so no events arrive. Overlay shows `Unloading <machine>`
  indeterminate for the duration.
- **`killAllBlockedForTeardown` throws.** Already caught and logged; `woken` is
  empty, so `total` is 0. Report indeterminate, not `0/0` rendered as 100%.
- **Graceful destroy (2000 ms) or drain (1500 ms) times out.** The worker is
  terminated and events stop. The last counts freeze and the phase flips to
  `image` when loading starts. Completion is **not** synthesized: a frozen bar
  is the truthful record that the work did not finish.
- **Idle machine with no live processes.** `total` is 0; a brief indeterminate
  flash. Acceptable.
- **Superseded boot.** The `seq === bootSeq` guard drops the events.
- **Node host.** The channel exists and is covered by tests; there is no overlay
  because there is no UI. That is a platform boundary, documented here, not a
  parity gap — the platform-observable behavior (the events) is identical.

### 5. Testing

- `web-libs/kandelo-session/test/` — the channel: phase transitions, `unit`
  handling, indeterminate when `total` is absent, the provisional-to-final
  total transition, survival across `attachKernel()`, clearing when status
  leaves `booting`. Runs in the wired
  Vitest suite.
- `host/test/` — worker emission: boot a kernel with N processes, destroy it,
  and assert the event sequence is monotonic in `completed`, ends with
  `completed === total` and `totalProvisional: false`, never lowers `total`,
  and emits at most one event per count change. This is
  the test that proves the numbers are real rather than plausible.
- `apps/browser-demos` unit (now wired into CI via `npm run test:unit`) —
  overlay formatting for both units and both total states: `3 of 7+ processes`,
  `9 of 9 processes`, and `1.1 MiB / 2.3 MiB`.
- Playwright — a gallery switch shows the overlay with `Unloading <old>` then
  `Loading <new>`, and it disappears at `running`. Transfer throttled through
  CDP, as in `boot-progress-live.spec.ts`, because a locally served image lands
  too fast to observe otherwise.
- Manual `./run.sh browser` on a cold and a warm service-worker cache.

Existing tests from the load-bar work migrate rather than being dropped.
`boot-progress-ui.spec.ts` and its fixture target `BootProgressBar`, which this
design deletes; they move to the overlay and gain the `destroying` phase.
`boot-progress-live.spec.ts` keeps asserting a real boot but against the
overlay's selector. The `BootProgress` unit tests in
`web-libs/kandelo-session/test/` become `MachineProgress` tests covering both
phases.

A note carried forward from the load bar: a component test cannot prove this
works. `MachineView` chooses which pane is mounted during boot, and a bar placed
on an unmounted pane passed every unit test while being invisible to users. The
Playwright test against a real switch is the one that counts.

## Out of scope

- Progress inside phase 1 of teardown. It is one awaited call; sub-progress
  would be invented.
- `halt()` as a user action. No UI calls it today. `reboot()` routes through
  `applyBootDescriptor` -> `startBoot`, so it is covered for free.
- Document-close teardown. The page is going away; there is no one to inform.
- Any change to teardown ordering or to the JSC `Atomics.wait` workaround.
