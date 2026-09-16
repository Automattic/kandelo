# Lane E1 — census of Node/browser peer divergence

**Date: 2026-09-11. Status: complete.**

Lane E claimed three pairs of files, 7,513 lines, "about 70% divergent",
and estimated 10–20 agent-days. **All three of those numbers were
misleading, and the lane is much smaller than it looked.**

## The 70% figure was measuring the wrong thing

It came from diffing each pair after normalising host names. That
conflates two completely different situations: *the same job written
twice and drifted*, and *two different jobs that were never the same*.
Symbol-level comparison separates them.

## Pair 1 — `*-kernel-host.ts` (3,156 lines): not drift

`node-kernel-host.ts` exports `NodeKernelHost`, `loadKernelWasm`,
`resolveRootfsImage`, `spawnKernelWorkerThread`.
`browser-kernel-host.ts` exports `BrowserKernel`,
`fetchDefaultBrowserKernelArtifact`, `fetchDefaultBrowserForkModule32`.

**They share exactly one name: `DESTROY_REQUEST_TIMEOUT_MS`.**

One loads artifacts from disk and spawns a worker thread; the other
fetches them over HTTP and starts a Web Worker. These are different jobs,
not copies. **This pair is essentially all floor**, and a lane target
that assumed it would shrink was wrong.

## Pair 2 — `*-kernel-worker-entry.ts` (3,208 lines): already consolidated

**The survey and lane text both said "10 symbols each" from
`process-lifecycle.ts". That was wrong** — it counted the `import`
statement only. The real mechanism is a generic factory:

```ts
const lifecycle = createProcessLifecycle<ProcessInfo["worker"]>({ ... });
const { handleFork, handleExec, handleVfork, ... } = lifecycle;
```

**The browser destructures 73 members and Node 72, of which 72 are
shared.** The entire fork / vfork / clone / exec / spawn / exit / thread
lifecycle is already one implementation. The consolidation lane E was
going to perform has, for this pair, largely happened.

What remains in each file:

| | Lines | From lifecycle | Own declarations |
|---|---|---|---|
| browser | 1,806 | 73 | 77 |
| node | 1,402 | 72 | 50 |

- **57 browser-only declarations** — framebuffer release/rebind, the
  service-worker bridge, mouse injection, audio drain, lazy registration.
  Genuine browser capability.
- **30 node-only** — session directories, crash safety net, local exec
  resolution, `port`.
- **21 declared in both** — and this is the entire residual drift surface
  for this pair: `handleDestroy`, `handleInit`, `handleHttpRequest`,
  `installProcessWorkerListeners`, `performDestroy`, `post`,
  `reportProcessExit`, `sideModuleInitFields`, plus shared constants.

## Pair 3 — `*-kernel-protocol.ts` (1,153 lines): the clearest duplication

**43 identically-named message types are declared in both files** —
`InitMessage`, `SpawnMessage`, `PipeReadMessage`, `PtyWriteMessage`,
`ReadVfsFileMessage`, `ResponseMessage`, `KernelToMainMessage`, and 36
more. These are structural type declarations with no platform content.

18 are browser-only and genuinely so (framebuffer, audio, mouse,
`ListenTcpMessage`, lazy archives); 2 are Node-only
(`ResolveExecRequestMessage`, `ResolveExecResponseMessage`).

**This is the most mechanical win in the lane and it is type-level only**,
so it cannot change runtime behaviour.

## One suspicion investigated and dismissed

`NODE_PROCESS_WORKER_TERMINATION_SETTLE_MS` is declared only in the
*browser* entry, which looked like a misplaced Node constant. It is not:
it names the `node` **guest program**, and bounds a Chrome-specific delay
when terminating a worker running SpiderMonkey Node. Correctly placed,
and not a defect. Recorded because the census's job includes saying which
suspicions did not pan out.

## No category-three findings

E1's third category — "a bug one host fixed and the other did not" — is
the one that would have justified the lane most strongly. **The census
found none.** The divergences resolve into genuine platform capability
(87 declarations) and duplicated type declarations (43), with 21
same-named worker-entry declarations still to audit individually.

That is a real result and it lowers the lane's urgency.

## The gate was measuring the wrong thing

`hostEntryPairTypeScript` counted lines, 7,513 → 2,000. **Unreachable and
wrong**: pair 1 is floor and will not shrink, and pair 2's remaining bulk
is genuine per-host capability.

**Replaced by `hostPeerDuplicateDeclarations`** — declaration names
appearing in both halves of a pair, summed across the three pairs:
**43 + 21 + 1 = 65**, target **12**. Target is not 0 because a handful
(`kernelWorker`, `port`, `maxPages`, `lifecycle`) are legitimately
per-host instances of a shared concept.

## Revised increments

- **E1 — this census.** Done.
- **E2 — unify the 43 protocol message types** into one shared module.
  Type-level, mechanical, cannot change runtime behaviour. Start here.
- **E3 — audit the 21 same-named worker-entry declarations** one at a
  time: shared concept, or genuinely per-host?
- **E4 — leave `*-kernel-host.ts` alone** and record why, so a later pass
  does not "discover" the divergence and try to merge it.

## Estimate

From **10–20 agent-days, "unknown until E1"** to **4–8 agent-days,
medium**. The consolidation the lane was scoped to perform already
happened for the pair that mattered; what is left is one mechanical
type-unification and a 21-item audit.

## What this census did not establish

- **Whether the 21 shared worker-entry declarations have drifted**, only
  that they share names. Each needs reading; that is E3, not E1.
- **Whether `createProcessLifecycle` covers the lifecycle completely**, or
  whether some lifecycle logic remains duplicated inside the 57/30
  host-specific declarations.
- **Anything about browser runtime behaviour.** This was a symbol-level
  reading.
