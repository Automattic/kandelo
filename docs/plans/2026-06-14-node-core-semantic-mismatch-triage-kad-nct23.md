# Node Core Semantic Mismatch Triage (`kad-nct.23`)

**Date:** 2026-06-14
**Source run:** `kad-nct.17`
**Node source:** `nodejs/node` `v22.0.0`
**Peeled commit:** `12fb157f79da8c094a54bc99370994941c28c235`
**Artifact source:** commit `871bdb8b`,
`test-runs/node-core-official-node-full-kad-nct17/`

`kad-nct.17` left broad primary failure buckets for 447 TypeError semantic
mismatches, 391 AssertionError semantic mismatches, 42 other `Error`
mismatches, 24 empty/other stderr rows, and two stream buffer-encoding rows.
This triage breaks the TypeError/AssertionError/RangeError part of that
semantic bucket into module-specific follow-up beads.

## Method

The triage reads `results.ndjson` and each per-test stderr log from the
`kad-nct.17` Node-host full-suite artifact. For each test, it uses the first
non-empty stderr line as the primary failure, matching the grouping method used
by the full-suite correction report. The resulting constructor-level sample had
1,772 primary `TypeError`, `AssertionError`, or `RangeError` rows.

Rows already covered by previous full-suite beads were filtered before creating
new semantic follow-ups:

| Filtered group | Primary rows | Tracking |
| --- | ---: | --- |
| Node `test/common` unexpected global assertion | 851 | `kad-nct.11` |
| `cluster.fork is not a function` | 48 | `kad-nct.22` |
| `child_process.fork` / `cp.fork` / bare `fork` missing | 33 | `kad-nct.22` |
| Buffer `kMaxLength` allocation representative | 1 | `kad-nct.12` |
| `querystring.stringify(undefined)` | 1 | `kad-nct.13` |
| StringDecoder invalid UTF-8 replacement | 1 | `kad-nct.14` |
| URLSearchParams unpaired surrogate encoding | 1 | `kad-nct.15` |

The existing narrow runtime beads, `kad-nct.12` through `kad-nct.15`, are
related to `kad-nct.23` and now carry notes pointing back to the full-suite
artifact.

## New Follow-Up Beads

| Cluster | Primary rows | Tracking | Representative first errors |
| --- | ---: | --- | --- |
| `assert` helpers and error matching | 176 | `kad-nct.25` | `assert.rejects is not a function`; `assert.match is not a function`; `assert.CallTracker is not a constructor`; `'no error' throws 'error'` |
| Streams | 157 | `kad-nct.26` | missing `setEncoding`, `Readable.from`, `unshift`, `unpipe`, `wrap`, default high-water-mark APIs; readable/writable state assertions |
| `net`, `dns`, socket, and HTTP classes | 69 | `kad-nct.29` | `http.Server is not a function`; `OutgoingMessage is not a constructor`; missing `dns.Resolver`; missing socket helpers |
| `process` permissions, identity, warnings, resources | 55 | `kad-nct.27` | missing `process.getuid`, `process.permission`, `getActiveResourcesInfo`, `process.binding`, `emitWarning`, `memoryUsage.rss` |
| `child_process` spawn/exec stdio | 41 | `kad-nct.28` | undefined exec/execFile child objects; missing stdio stream behavior; spawnSync env/maxBuffer/timeout assertions |
| `vm` contexts and modules | 41 | `kad-nct.30` | missing `vm.runInContext`, `script.runInContext`, `SourceTextModule`, `measureMemory`, `createCachedData` |
| `zlib` / brotli / gzip | 36 | `kad-nct.31` | missing brotli/gzip APIs and constants; constructor gaps; concatenated gzip output mismatch |
| Remaining Buffer behavior | 25 | `kad-nct.32` | unsupported `base64url`; missing `isAscii`, `isUtf8`, BigInt methods, `swap16`, `SlowBuffer`; inspect/range/encoding mismatches |
| `async_hooks`, AsyncLocalStorage, promise/GC hooks | 20 | `kad-nct.33` | hook controls not returned, missing trigger data, missing `AsyncLocalStorage.snapshot`, undefined promise/GC hooks |
| `fs` semantics and watch/stream integration | 18 | `kad-nct.34` | flag side effects, watch return object gaps, missing `fs.link`/`promises.lchown`, constants/export mismatches |
| `worker_threads`, MessagePort, BroadcastChannel | 18 | `kad-nct.41` | `BroadcastChannel` not constructible, missing port helpers, transfer count/resource limit assertions |
| `diagnostics_channel` | 16 | `kad-nct.35` | missing `channel.subscribe`, bad `hasSubscribers`, tracing name mismatch, lost AsyncLocalStorage store |
| `cluster` setup/settings/Worker APIs | 16 | `kad-nct.42` | missing `cluster.settings`, `setupPrimary`, `on`/`once`/`disconnect`, `cluster.Worker`; setup assertions |
| Events | 15 | `kad-nct.36` | listener bookkeeping, alias/name, invalid listener validation, EventTarget constants, captureRejections |
| Module loader/cache | 15 | `kad-nct.37` | missing `_initPaths`, `_resolveLookupPaths`, `module.isBuiltin`; cache identity and symlink/main assertions |
| URL/WHATWG URL object model | 12 | `kad-nct.38` | missing `URL.canParse`, `url.resolveObject`, `urlToHttpOptions`; `URLSearchParams` sort/inspect/model gaps |
| Path | 10 | `kad-nct.43` | POSIX and win32 basename/dirname/extname/join/normalize/resolve mismatches; missing `toNamespacedPath` |
| Timers | 10 | `kad-nct.39` | missing `enroll`, `unenroll`, `active`, `hasRef`, `Symbol.dispose`; lifecycle/toPrimitive mismatches |
| V8/inspector/snapshot boundary | 9 primary plus adjacent rows | `kad-nct.44` | missing `v8.setFlagsFromString`, `getHeapSnapshot`, `queryObjects`, `cachedDataVersionTag`, `startupSnapshot`; support-boundary decision needed |
| Readline | 8 | `kad-nct.40` | `Interface` not constructible, missing `rl.write`, `emitKeypressEvents`, raw-mode/key handling gaps |
| `util` and `console` | 11 | `kad-nct.45` | `util.format`, `util.inherits`, `util.inspect`, `util.styleText`, `Console`, `console.clear`, broken-stdio behavior |
| `performance` / `perf_hooks` | 10 | `kad-nct.46` | missing `eventLoopUtilization`, `timerify`, constants, `nodeTiming`, histograms, resource/user timing |
| Web-platform globals and constructors | 16 | `kad-nct.47` | TextDecoder BOM/UTF-16 mismatches, EventTarget options, `MIMEType`, `BlockList`, `WebSocket`, `DOMException`, AbortSignal helpers |
| Remaining one-off tail | small residual | `kad-nct.48` | CLI/startup/runner/security/source-map/dotenv/os/punycode/querystring/StringDecoder one-offs after larger clusters land |

## Verification Notes

This bead does not change runtime behavior. A full rerun before the fix beads
land would reproduce the same stderr lines, so the concrete verification for
`kad-nct.23` is that every broad semantic class now has a specific tracking
bead or an existing linked bead. Follow-up fix beads should rerun their affected
official tests on both Node and browser hosts, then close once those tests pass
or are converted to documented support-boundary skips.
