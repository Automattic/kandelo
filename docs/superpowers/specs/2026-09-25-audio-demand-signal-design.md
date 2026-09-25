# Audio demand signal: warn about audio only when a guest asked for it

Status: approved design, not yet implemented
Date: 2026-09-25

## Why

Boot any machine in the browser app — the bare shell, nginx+PHP, anything that
never produces a sample — and a toast appears saying "Audio suspended — Browser
policy pauses audio until you interact…", or "Audio unavailable — This browser
does not provide the required Web Audio output."

Those machines have no audio. The warning is noise on most of them and simply
false on a shell image: it reports a problem with a device no program in the
machine has ever opened.

The cause is that the browser UI has no way to ask "does this machine use
audio?", so it treats *audio exists and is idle* as *audio is broken*:

1. `host/src/browser-kernel-worker-entry.ts:1389` claims a PCM transport
   unconditionally at kernel ready and posts it with the `ready` message, so
   every machine has one.
2. `host/src/browser-kernel-host.ts:1263` — `getAudioState()` returns
   `"unprepared"` rather than `"unavailable"` because step 1 always supplied a
   transport.
3. `host/src/browser-kernel-host.ts:1269` — `onAudioStateChange()` *constructs*
   a `BrowserPcmDriver` as a side effect of subscribing. The UI subscribes on
   mount, so every machine gets an `AudioContext`, which then reports
   `"suspended"` under the browser's autoplay policy.
4. `apps/browser-demos/pages/kandelo/app/App.tsx:398` renders the toast whenever
   `surface.status === "running" && audioState !== "running"`. Nothing in that
   condition knows whether a guest ever wanted audio.

The fix must not lose the genuine warning. `"error"`, `"interrupted"` and
`"unavailable"` on a machine that really is playing audio are failures a user
needs to see; silently dropping them would be a worse bug than the noise.

## What the kernel already tells us

No new kernel→host signal is needed. The kernel already publishes guest audio
demand into the same shared control header the browser main thread already
holds, and the host has simply never read it.

In `crates/runtime-core/src/audio.rs`:

- `open_stream()` (audio.rs:352) → `reset_transport_for_open()` →
  `publish_configuration()` (audio.rs:282) increments `generation` and stores
  `state = PCM_STATE_STOPPED`.
- `finish_closed()` (audio.rs:383) stores `state = PCM_STATE_CLOSED` when the
  last OFD reference goes away.
- `claim_transport()` (audio.rs:781) — the call the host makes eagerly at kernel
  ready — touches only `transport_mode`. It never moves `generation` or `state`.
- Every other caller that bumps `generation` (audio.rs:444, 457, 476, 498 via
  `publish_configuration`; audio.rs:680, 775 via `enter_stopped_generation`)
  sits behind a guest stream handle, so it is reachable only after an open.

Therefore, on a machine where no guest opens `/dev/dsp`, `generation` stays `0`
and `state` stays `PCM_STATE_CLOSED` for the machine's whole life. Both words
are already exposed to the host: `PCM_CONTROL.generation` and `PCM_CONTROL.state`
in `host/src/audio/pcm-transport.ts:52-53`, read off the `PcmTransportDescriptor`
that `BrowserKernel` holds at `host/src/browser-kernel-host.ts:308`.

`generation` is monotonic, which matters: a sampler cannot miss a program that
opens `/dev/dsp`, writes a short sound and exits between two samples. `state`
alone would flap; `generation` records that it happened.

## Design

### 1. The signal

A pure helper in `host/src/audio/pcm-transport.ts`:

```ts
export function pcmGuestAudioActivity(words: Int32Array): boolean;
// true once generation !== 0 || state !== PcmStreamState.Closed
```

It reads the authoritative kernel words and nothing else. It is unit-testable
against a synthetic control header with the existing
`host/test/pcm-test-helpers.ts` `createPcmTransport()`.

### 2. Host observation, latched

`BrowserKernel` gains a latched `audioActive` flag, sampled from the control
header by a lazily started `setInterval` that mirrors the existing syscall-trace
poll at `host/src/browser-kernel-host.ts:931-943`. The sampler:

- starts when the first subscriber arrives and a transport exists;
- stops permanently the moment it latches — the latch never clears for the life
  of the machine;
- stops on `destroy()`.

A machine that never uses audio costs one `Atomics.load` per tick; a machine
that does stops sampling for good on the first observation.

New `BrowserKernel` API:

```ts
getAudioActivity(): boolean;
onAudioActivityChange(cb: (active: boolean) => void): () => void;
```

The latch is deliberate and was chosen explicitly: a program that speaks one
sentence into a sink the user never enabled should keep warning after it exits,
because that is exactly the case where losing the warning costs the user the
most. The alternative — tracking the live stream so the toast disappears when
the program closes the device — was rejected for that reason.

### 3. Subscribing stops constructing a driver

`onAudioStateChange()` (host/src/browser-kernel-host.ts:1269) no longer builds a
`BrowserPcmDriver`. `BrowserKernel` keeps its own listener set, reports the
existing truthful `"unprepared"` (transport present, sink not prepared) or
`"unavailable"` (no transport) until a driver exists, and forwards driver states
once one does.

A driver is built only by `prepareAudio()` / `resumeAudio()` — that is, from a
real user gesture. Nothing is created at boot.

This is a fix in its own right, not a gate: it is what manufactures an
`AudioContext` and an AudioWorklet rendering thread for every machine on mount.

### 4. Eager resume is preserved

The gesture-driven resume path stays exactly as it is. `activateAudio` and its
`pointerdown` / `keydown` listeners (App.tsx:120-135) are unchanged, and
`apps/browser-demos/pages/kandelo/panes/Framebuffer.tsx:171` is untouched.

This matters because the resume attempt and the warning are independent axes.
A successful eager resume already produces no toast today — `audioState` becomes
`"running"` and the condition at App.tsx:398 is false. So:

- **Shell machine:** the user clicks, the shared context resumes silently,
  nothing is shown. If it had failed, still nothing is shown, because
  `generation === 0` says no guest ever opened the device. We are not claiming
  audio works; we are declining to warn about a device nobody asked for.
- **espeak / SDL2 machine:** the user's earlier click already resumed the shared
  context, so when the guest opens `/dev/dsp` it plays immediately — no toast,
  no extra click, identical to today's good path. If resume had failed, the
  latch flips and the toast appears carrying the real state.

Keeping the resume inside the gesture handler also avoids a WebKit
sticky-activation risk: a context created *after* a gesture rather than during
one may refuse to resume on Safari, which would cost audio demos an extra click.
Deferring driver creation to demand would additionally save one `AudioContext`
and one worklet thread per page for users who only ever boot audio-free
machines, and on iOS would avoid a resume that can duck audio playing elsewhere.
That is a follow-on optimisation gated on a WebKit/Chromium probe, deliberately
out of scope here.

### 5. Session contract

`web-libs/kandelo-session/src/kernel-host.ts` gains, alongside the existing
optional audio members (kernel-host.ts:251-255):

```ts
getAudioActivity?(): boolean;
onAudioActivityChange?(cb: (active: boolean) => void): () => void;
```

`LiveKernelHost` mirrors its existing audio-state plumbing
(kernel-host.ts:1201-1206, 2309-2315) with `getAudioActivity()` and
`subscribeAudioActivity()`, defaulting to `false` when the kernel does not
implement them, and tearing the subscription down on the same paths that drop
`offAudioState`.

### 6. UI

`apps/browser-demos/pages/kandelo/app/App.tsx`:

- track `audioActive` from `host.subscribeAudioActivity`, the same shape as the
  existing `audioState` subscription;
- the toast condition at App.tsx:398 becomes
  `surface.status === "running" && audioActive && audioState !== "running"`.

With §3 in place, a machine whose guest opens `/dev/dsp` before anyone has
clicked reports `"unprepared"` rather than `"suspended"`. Both mean the same
thing to a user — audio has not started; interact to enable — so
`AudioStatusToast` must speak `"unprepared"` with that copy instead of falling
through to the suspended wording by accident. `"error"`, `"interrupted"` and
`"unavailable"` keep their distinct text. This is labelling a state we are
already in, not renaming it: `data-audio-state` (App.tsx:346) still carries the
real state, and the toast title still names it.

### 7. Node

The truth-reading helper lands in shared audio code (`host/src/audio/`), so both
hosts read demand the same way.

No Node subscriber is added, and this is a real platform boundary rather than a
Node-later shortcut: `host/src/node-kernel-host.ts` exposes no audio API at all
today, Node's worker prepares `NodePcmDriver` unconditionally at init
(`host/src/node-kernel-worker-entry.ts:1224-1235`), Node has no autoplay policy
to be gated by, and there is no Node surface that warns a user about audio.
There is nothing on that host for the signal to gate.

Kernel, ABI, transport-claim timing and worker protocol are all unchanged.

## What this rejects

- **Hiding the toast whenever the state is not `"running"`.** That suppresses
  genuine `"error"` and `"interrupted"` states.
- **Reporting `"running"`, or any state the system is not in.** The platform
  values contract forbids shaping UI state to fake correctness.
- **Special-casing by demo or image name.** A fix that only works for the shell
  demo is the anti-pattern that contract names.
- **Suppressing `"unprepared"` alone.** Defensible and honest, but it patches
  over the design rather than answering "does this machine use audio?", and it
  would still warn on a shell machine whose context resumed and then failed.
- **Declaring an audio capability in demo config.** A second source of truth
  that can disagree with the kernel — and it would be wrong the moment a user
  runs `espeak` in a shell machine.

## How it gets proven

A component test cannot prove this. The evidence has to include a real boot.

1. **Failing first.** A new Playwright spec boots a shell machine, clicks, and
   asserts no `.kpcm-audio-status` toast. It must be red on current `main` —
   clicking is exactly what produces the toast today — and the report must say
   so.
2. **The genuine warning survives.** The espeak profile
   (`apps/browser-demos/test/kandelo-espeak.spec.ts` already boots it) asserts
   the toast still appears once `espeak-ng` opens `/dev/dsp` without an enabled
   sink, and that Enable works. Green before *and* after.
3. **Unit coverage.** `pcmGuestAudioActivity` over a synthetic header in
   `host/test/`; and that subscribing to audio state creates no `AudioContext`,
   driven through the existing `apps/browser-demos/pages/test-runner/main.ts`
   harness in a real browser.
4. **Gates.** `cd host && npm run typecheck`; `cd apps/browser-demos && npm run
   test:unit`; the host Vitest audio suites; `./run.sh browser` by hand for both
   directions.

Whole-repo Vitest currently fails on `main` in a fresh worktree with
`user program lacks a kandelo.abi.contract stamp`; any failure seen must be
checked against pristine `main` before being attributed to this change.
