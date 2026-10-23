# WEBKIT-AUDIOWORKLET-CLOSE-LEAK

Status: suspected. A standalone page now shows the leak, but only in a
thread listing a person reads; no page judges it by itself. Not filed.

## Defect

Suspected WebKit defect. Closing an `AudioContext` that loaded an
AudioWorklet module does not end the worklet's rendering thread: `close()`
resolves, the context reports `"closed"`, and one `WebCore: AudioWorklet`
thread stays in the WebKit page process. Each closed context adds one.
The Web Audio specification's close steps say the user agent attempts to
release system resources; it does not say when a closed context's
`AudioWorkletGlobalScope` ends, which is part of what is unknown.

## Why Kandelo is affected

Each Kandelo browser machine with audio used to create its own
`AudioContext` for the PCM sink and close it at teardown. On WebKit every
machine switch therefore left one realtime audio thread behind: the
maintainer measured 1 -> 2 -> 3 -> 4 `WebCore: AudioWorklet` threads across
three switches, with an instrumented `close()` completing and the context
reaching `"closed"` each time. Chromium reaped the thread.

## Workaround and its cost

`host/src/audio/browser-pcm-driver.ts` keeps one page-wide `AudioContext`
(`sharedAudioContext`) for every machine the page boots (PR #1410). The
worklet module is registered once; each machine creates and tears down only
its `AudioWorkletNode`; teardown suspends the context instead of closing
it. The single rendering thread is a fixed cost instead of a per-switch
leak, and the user's audio activation survives machine switches, since
autoplay policy attaches to the context. Callers that pass
`options.createContext` (tests, embedders) keep a private context and the
old close-the-context behavior. `host/test/browser-kernel.test.ts` resets
modules between tests because of the shared context.

Cost: one audio rendering thread lives for the life of the page once any
machine has used audio, and machines share a context's sample rate and
latency settings.

## Evidence

2026-09-24 (maintainer, Playwright WebKit webkit-2336): thread stacks in the
page process showed the leak in Kandelo (above). A reduced page (context,
worklet module, node with a `SharedArrayBuffer` in `processorOptions`,
close) did **not** reproduce it then.

2026-10-22 (Playwright WebKit webkit-2359, `26.6`, macOS 27): the reduced
page `repro/repro.html` **does** leave the threads. Counting
`WebCore: AudioWorklet` threads with `sample <WebContent pid> 1` about 25 s
after the last `close()`:

| cycles (contexts created and closed) | worklet threads left |
|---|---|
| 0 | 0 |
| 1 | 1 |
| 3 | 3 |
| 4 | 4 (three runs, sampled at about 1 s and 30 s: 4 and 4) |
| 8 | 8 |

The 0, 1, 4 and 8 rows come from a first version of the page that kept no
reference to the node or context after `close()` (so nothing on the page
could keep the worklet alive); the 3 row is the committed page, which also
pings the closed nodes (below). 200 cycles in one page produced no failure the page could
see (every context closed; no error).

### Self-judging attempt (negative)

The processor answers every message on its port, so an answer after
`close()` shows the worklet's thread is still running. Ten seconds (and
thirty) after closing three contexts:

| engine | closed worklets that answered |
|---|---|
| WebKit 26.6 | 3 / 3 |
| Firefox 155.0 | 3 / 3 |
| Chromium 153.0.8010.12 | 0 / 3 |

This does not qualify as a verdict. The specification does not say a
closed context's worklet must stop answering while the page still holds its
node, and Firefox answers too; whether Firefox also keeps a thread per
closed context was not measured. The page keeps the probe as a clue and
always reports `inconclusive`. A page cannot count threads, so a
self-judging reproduction needs some other observable consequence of the
leaked thread.

## Why this is not a Kandelo defect (what is still unknown)

The reduced page contains no Kandelo code and leaves one thread per closed
context, so on webkit-2359 the fault does not need Kandelo. It stays
suspected because only a thread listing shows it. Unknown: why the same
reduction did not leak on webkit-2336; whether released Safari leaks;
whether a thread that answers nothing and runs no `process()` is a
resource leak WebKit would accept as a bug (its count grows without bound,
which is the argument).

## Draft upstream report

Not ready to file (suspected). Draft for bugs.webkit.org, component Web
Audio:

> **Title:** `AudioContext.close()` leaves a `WebCore: AudioWorklet` thread
> in the WebContent process for every closed context that loaded an
> AudioWorklet module
>
> **Steps:** serve the attached `repro/` cross-origin isolated
> (`Cross-Origin-Opener-Policy: same-origin`,
> `Cross-Origin-Embedder-Policy: require-corp`), open
> `repro.html?cycles=8`, wait for "done" plus 25 s, then run
> `sample <WebContent pid> 1 | grep -c 'WebCore: AudioWorklet'`.
>
> **Expected:** 0 (or 1 for a page-wide pool); every closed context's
> rendering thread is released.
> **Actual:** 8; one thread per closed context, for as long as the page
> lives (Playwright WebKit webkit-2359, 26.6, macOS 27).
>
> **Impact:** an application that creates and closes an audio context per
> session leaks a realtime thread per session.

## Removal criteria

When the latest released Safari (macOS and iOS) leaves no
`WebCore: AudioWorklet` thread per closed context with `repro.html`, and
Kandelo's machine-switch thread census (`benchmarks/measure-machine-switch-leak.mjs`)
stays flat with per-machine contexts, `browser-pcm-driver.ts` may return to
one context per machine. Keeping the shared context is also acceptable for
the autoplay benefit; then retire this entry with that reason and drop the
tags.
