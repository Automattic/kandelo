# Shared desktop cleanup — 2026-11-22

This follows the [normal-shell integration](https://github.com/Automattic/kandelo/blob/fb798e1ea88a065b343fcb06a28b0def9c96bc66/docs/measurements/2026-11-22-shared-memory-shell-integration.md). The complete 416-file pre-cleanup PR inventory was reviewed for obsolete development paths using source scans, module references and manual inspection of suspected remnants. This cleanup audit does not replace a semantic review of the feature.

## Changes

Removed 25 obsolete files: the standalone desktop page/server and diagnostic helper, their page-only tests and external-preview configs, global preview flags/plugin/preparer, and the separate desktop package/product/config/preparer. The normal app now has only its computer-library flow and authored shell profile policy.

Composition keeps canonical and partial shell selections, installs SDK alternatives alongside ordinary executables, and validates their identities. The executable-replacement mode, filesystem alias scan, unused profile generator, old ScummVM aliases, duplicate per-program image metadata and unused worker test export are gone. The authoritative lazy SDK catalog remains. Shell recipe revision is 107; SDK-program package revision is 4. Maintained app tests always select normal profiles. SDK fixtures use normal artifact resolution, per-run storage/cleanup and an inherited OS-allocated port.

The runtime, formal SDK translator, copied inspection API, ownership/error guards, active contract regressions, runtime-workaround reproductions and dated failures remain. The original plan, original demo, existing previews and unrelated root worktree changes were preserved. Removed source and chronology remain in the [pinned pre-cleanup revision](https://github.com/Automattic/kandelo/tree/84f6213ee030300ce27e5a1de7aedaca078b924b). The workspace retains the source archive, original patch, inventory and raw validation in `.context/cruft-audit-1316/`.

## Validation

All commands ran through the declared dev shell. Production artifacts and composition used `f0b3697d52a7`; `ebdeacf97c27` subsequently changes only fixture-port inheritance. No Rust implementation or libc changed; the earlier native-workspace receipt is historical, not a fresh cleanup run.

| Check | Current result |
| --- | --- |
| ABI | Pass; program 56 and host adapter 26 unchanged |
| Source and build contracts | 386 cases/eight files, Pages registry plus 20 mutation tests, 860-file evidence inventory and strict host/app types pass |
| Images and production build | Thirteen-package partial shell, canonical shell, eleven-product static app, both filesystem-layout audits and canonical Node consumer pass |
| SDK composition and Node | Genuine twenty-member composition: 25 pass; actual Node SDK selection: 70 pass |
| SDK browser | 105 pass across Chromium, Firefox and WebKit; zero skipped/flaky/unexpected |
| Public browser VFS | 17 pass; WebKit live-child/pthread stress case times out; isolated rerun also times out |
| Canonical app | 15 pass; Freeciv game-world assertion times out |
| Compiled production app | All ten cases pass, including six three-engine shell/persistence checks and Chromium SFWBar/Cage/Freeciv/ScummVM; zero skipped/flaky/unexpected |
| Memory/lifecycle gate | Seven source checks, 1,592 host cases/59 files, three Node and seven Bun teardown cases pass. All eighteen browser cases pass with zero skipped/flaky/unexpected; each engine completes four same-page machine-switching cycles. The complete gate takes 28m34s (browser phase 23.8m). |

The five-case host count reduction is exactly the removed diagnostic helper's tests; kernel and ownership coverage stays enabled. Canonical passing cases include twelve-terminal retirement/replacement, high-resolution workspace changes, Sway restore, SFWBar and real ScummVM gameplay/Quit. The temporary test-only static preview was stopped after validation. Three completed Firefox profiles left by macOS delete ACLs were removed; no user storage was removed.

## Exact artifacts

| Image | Compressed bytes | SHA-256 |
| --- | ---: | --- |
| Canonical shell revision 107 | 1,195,204 | `e56c1051907bba6b9edd96cef70789f154b8d9491e882d22e0c0c3df9236ca34` |
| Partial shell, thirteen desktop packages | 775,349 | `beb0c01991f0aacc52550af12ee31900779893d859860f85440ba9315563fad8` |

Canonical eager content remains 2,383,879 bytes/145 files, within unchanged budgets of 2,436,000 eager bytes, 147 files and 1,208,000 compressed bytes. The partial command and packages are the same as in the earlier integration receipt.

The actual authenticated SDK assets match group manifest `96e0fd809bea80805d989154e3fef53f34b1bc0f782982c1a02589c0883f4d1f`: twenty ZIPs plus one catalog, totaling 42,788,660 bytes. All twenty ZIPs are byte-identical to the [earlier inventory](https://github.com/Automattic/kandelo/blob/fb798e1ea88a065b343fcb06a28b0def9c96bc66/docs/measurements/2026-11-22-shared-memory-shell-assets.json). Only the catalog changed: 42,186 bytes, SHA-256 `580a34c48c2bdad1ef3c12527bd7542bc8625478aea587af101d7e285ebd050f`, thirty unused bytes smaller. Distribution sizes do not measure browser memory.

## Failures and limits

The WebKit admission test exceeds its unchanged 120-second deadline with 26 live children/66 live pthreads, including one isolated rerun. The canonical Freeciv test reaches its second client and local server, then exceeds the unchanged ninety-second game-world visual assertion. Its screenshot shows the lobby saying “All players are ready; starting game”; no page errors or retirement failures were recorded. The compiled-app Freeciv pass is a mixed result and does not erase that failure. Causes and whether these are regressions remain unestablished. Reports, the Freeciv trace and screenshots are retained.

Cleanup also retained three corrected failures: the tracked-config inventory changed from thirteen to twelve; the first image build found an obsolete ScummVM branch referencing the deleted mode; the first expanded VFS run reselected its server port in workers. Exact inventory correction, branch removal and inherited port selection resolve those issues without changing runtime deadlines or assertions.

This cleanup is not fully merge-validated. Broader grouped conformance, matched memory/CPU/input/presentation measurements and original-plan release gates remain open. No native Safari, sustained gameplay, net memory saving or resolution of earlier WebKit endurance/input failures is established. Shared-object resizing/truncation and persistent writable sharing remain follow-ups. PHP-FPM source/configuration is unchanged. Nothing merges or deploys automatically.
