# Shared-memory desktops in the normal shell — 2026-11-22

This record covers the normal-shell integration at `e8bb698bc2ce73db44bb5d3babffaa082441da49`, following the historical dedicated desktop preview. It does not promote the entire original shared-memory plan or claim a performance improvement.

## Resulting contract

The normal shell owns Cage/Foot, Sway/Foot and Sway/SFWBar profiles and Activities. Ordinary executables, executable identity and default execution stay ordinary. An explicit desktop root selects a formal SDK alternative; compatible descendants inherit its kernel-owned memory group. Other terminals keep their selected backend. The normal computer's file persistence applies to both kinds of process. Persistent writable shared mappings remain unsupported.

The SDK package carries twenty individually lazy alternatives, including `ps`. The kernel binds the implementation to the retained ordinary source descriptor and validates the source digest and candidate image. The host-adapter ABI is 26; the program ABI remains 56. The normal gallery and Pages build no longer select the separate historical desktop image. Its recipe remains manually buildable for reproduction. PHP-FPM source and configuration are unchanged.

## Exact images

| Image | Compressed bytes | SHA-256 |
| --- | ---: | --- |
| Canonical shell revision 106 | 1,197,574 | `4927bdfaf8ae65a4f5065239f16206ef32cc3e6471cdc49c6814e515fccd3982` |
| Partial shell, thirteen explicitly installed desktop packages | 777,621 | `a8bb2adbef3fc136dfe3f5d7ead934cd5b6df557891d8a27dc21bd1cb731065e` |

The canonical shell has 2,383,879 eager bytes and 145 eager files. Existing budgets remain 2,436,000 eager bytes, 147 eager files and 1,208,000 compressed bytes. The SourceOnly canonical cache key is `e38d6a2ebdcff5a46f514f83ef68fef3b55a5c03925d01ddabc2ec92da7c639b`. Hashes identify artifact bytes, not the cache key.

The partial command was:

```sh
./run.sh partial shell shared-desktop-programs cage foot sway swaybg sfwbar freeciv-browser-bundle scummvm-static curl unzip sysklogd desktop-data bibata-cursor-theme
```

## Validation

All commands ran through the declared dev shell. The final SourceOnly build at the source commit above built the partial and canonical shell, rebuilt the historical recipe through its normal resolver, passed both image-layout audits, and passed the strict canonical Node consumer. Node v24.22.1 ran ordinary/grouped commands including `ps`, `grep` and `cat` from the same unchanged canonical image. It checked process-family retirement and zero remaining group tasks, process owners, quarantined replicas, images, shared objects and native observers.

The twenty-member image-composition suite passed all 25 cases. The source preflight passed the ABI check, actual Pages registry validation and its 20 tests, 386 host/session tests, the 861-file evidence-class inventory and strict host/app types. The full native workspace and focused Node/browser libc selections passed on these Rust sources before the final image composition; the focused libc selection covered seven cases on each host, not full grouped conformance.

The canonical browser consumers passed 16 cases: six normal-shell persistence/Activity cases across Chromium, Firefox and WebKit; six Chromium startup, twelve-terminal/high-resolution capacity, Cage/Freeciv and real ScummVM gameplay cases; and four Chromium Sway/native-bar, computer restore, SFWBar menu and ScummVM launcher/Quit cases. These runs used the normal gallery and canonical shell with no preview flag, partial manifest or prepared machine URLs. The documented `./run.sh browser --partial` CLI also passed an actual Chromium ordinary-shell-to-Sway Activity check on the exact updated partial image.

The full `./run.sh test browser-memory` run is in progress at this checkpoint. Its seven source protocol checks, 1,597 host memory/lifecycle tests, three actual Node teardown cases and seven actual Bun teardown cases have passed. The required eighteen-case three-engine browser run, including four same-page machine-switching cycles per engine, has not completed; no full-gate pass is claimed.

The ordinary `./run.sh build-browser --base /` production build passed, including normal browser-product preparation and the authenticated eleven-product VFS asset group. It used no trusted-preview flag and ships the exact canonical shell bytes above. The packaged app passed six shell/persistence cases across Chromium, Firefox and WebKit and four Chromium SFWBar, Cage/Freeciv and real ScummVM gameplay/Quit cases. An additional Chromium check opened the plain app URL, observed the ordinary shell prompt and verified all three desktop Activities. These eleven checks had no skipped, flaky or unexpected cases.

## Retained failures and limits

- The first normal persisted-computer desktop failed a read-only xkbcommon mapping because the rootfs rejected every persisted file. Kernel immutable read leases now admit this bounded read-only mapping. Native fixed/resizable persistence tests verify content and mutation refusal until final retirement. Writable persistent shared mappings were not enabled.
- The first post-build Node consumer observed an ordinary process's exit before asynchronous host-owned reaping completed. Ordinary execution already reports exit at that boundary. The test now observes eventual ordinary reaping; the grouped immediate-cleanup assertions remain unchanged. The failed run is retained.
- Initial SFWBar and Sway/ScummVM consumers reached their native UI/Quit paths but their grouped shell cleanup command failed `ENOEXEC` for `ps`. The formal SDK closure now includes the real ordinary `ps` dependency and its prepared alternative. The final canonical Node command verifies that selection.
- An earlier Sway restore fixture sent input before the requested computer switch completed. Its trace identifies the URL switch and later prompt. The fixture now waits for the requested computer and its rendered prompt. No product deadline or runtime behavior was changed.
- One ScummVM gameplay screen used the wrong viewport; the maintained fixed viewport and unchanged scene threshold passed on the normal partial image. A partial-image result does not itself prove the canonical or static build.
- Earlier compiler-response, download, image and WebKit endurance failures remain in the prior [integration record](2026-11-20-shared-memory-desktop-current.md) and [lifecycle evidence](2026-11-21-shared-memory-desktop-lifecycle.json). Bounded current browser passes do not erase the earlier intermittent WebKit input failures.

These checks do not establish native Safari behavior, sustained ScummVM/audio operation, general shared-object resizing/truncation, persistent writable sharing, mixed graphical clients, quiet RSS/CPU/latency benefits or completion of PR1–PR9. The preserved original plan and those remaining measurements continue as follow-up work. No merge or deployment is authorized by this record.
