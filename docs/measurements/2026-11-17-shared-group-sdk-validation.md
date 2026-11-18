# Shared-group SDK artifact validation

This records the artifact-producer stage. Normal grouped execution, actual
worker retirement and the desktop preview remain later stages. The supported
artifact limits are documented in [the SDK guide](../sdk-guide.md#experimental-memory-group-translation).

## Checked implementation

The validated source is `87ffeb45fc3b03a8939440a944bd21f9733f41c3`.
Program ABI 56 and its digest remain unchanged. Group translation uses the
versioned group-v3 extension and refuses stale layouts, wrong helper signatures,
side modules and already-translated inputs. The ordinary executable is retained
separately. Ordinary launch does not admit the group-memory import.

The translator/helper implementation passed nine integration tests, including
4,048,380 exhaustive and 144 sparse snapshot-oracle cases. Actual compiled C
checks cover scalar, SIMD, atomic, bulk, growth and initialization behavior in a
dedicated Worker. The 62 C and 12 initialization checks passed on Node and twice
on Chromium, Firefox and WebKit. The final commit changes only test ownership
registrations and the local binding in a negative initialization control: all
ten kernel-scratch contract checks and the twelve initialization checks were
rerun successfully, the latter on Node and twice on each browser. Its four
generated initialization Wasm files match the preceding signature-checked output.
Normal compiler/post-link wrapper, extension and ABI checks also passed on the
unchanged producer implementation.

## Own normal memory gate

The complete `./run.sh test browser-memory` succeeded on that source, through
the normal source-only package/image preparation and declared development shell.
No alternate executable bytes, reduced memory profile, forced collection,
reload or skipped required consumer was substituted.

| Phase | Result |
|---|---|
| Canonical preparation and consumer checks | 330/330 nodes, 11/11 products |
| Host ownership/teardown selection | 306 passed |
| Node teardown | 3 passed |
| Bun teardown | 7 passed |
| Chromium | All 6 browser cases passed |
| Firefox | All 6 browser cases passed |
| WebKit | All 6 browser cases passed |

Each browser completed four constrained-budget switching cycles in the same
page/audio realm, using the normal games, compositors, terminal and WordPress
paths. The gate also checked audio activation, forbidden memory messages,
reload detection and process exit. Its final report requires no skipped,
unexpected or flaky browser cases. The complete run took 31m57s; browser cases
took 25.6m. The raw gate log SHA-256 is
`3c31d9443f8a10cb3687ce170efa9c680f23089ae7b5c3ba841d4231728eabae`.

A SourceForge proxy connection-timeout warning and the owned Firefox temporary
Documents-directory cleanup EACCES warning remain in the log. All runtime and
memory-boundary assertions still passed. This is Playwright coverage, not native
iOS Safari evidence.

## Earlier failures remain evidence

- An earlier normal build failed during provisioning: nine packages lacked the
  pinned Rust libc checkout and four encountered disk exhaustion. Those failures
  and their repairs are retained; they were not runtime-test passes.
- The first current-head host gate failed eight unclassified fixture allocation
  or instantiation occurrences. The first registration repair then exposed a
  negative-control instance without a stable local owner. Exact owners/counts
  and a local binding fixed these findings without excluding source or changing
  the audit rules.
- The next complete gate passed canonical, host, Node and Bun phases but failed
  six Firefox/WebKit browser cases. Required Quake archive checks failed, and a
  WebKit Doom trace recorded an external WAD HTTP 502. Audio/context timeouts
  were also retained; not every failure was independently attributed to one
  cause. After the endpoints returned HEAD 200/range GET 206, all six selected
  audio cases passed without retries or source changes. The subsequent complete
  gate is the successful run reported above.

Workspace evidence is retained under `.context/shared-develop-integration-1/`:
`sdk-own-full-memory-pass-1`, `sdk-authority-browser-memory-failure-1`,
`sdk-audio-failure-isolation-pass-1`, `sdk-authority-repair-complete-1`,
`sdk-authority-repair-attempt-1-failure` and
`sdk-normal-provisioning-failure-1`. The failed browser traces and screenshots
are retained alongside the original reports.

## Limits of this stage

Synthetic fixture retirement is not an actual Worker-stop or reclamation fence.
Large irregular-alias fallback CPU cost remains an application-measurement
requirement. This stage does not expose supported grouped launch or establish
shared-object/graphics semantics, sustained Sway/Foot resource behavior, lower
total browser footprint or input/presentation latency. Those remain in the
subsequent integration stages; PHP-FPM remains ordinary and unchanged.
