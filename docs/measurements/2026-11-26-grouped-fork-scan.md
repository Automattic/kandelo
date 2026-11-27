# Scanning the parent page table during grouped fork

At develop `dffcfca5325666d5e02cacdef03d4f14893a4584`, grouped fork made
one atomic-load import per slot up to the image maximum. The desktop uses a
16,384-slot table. While the parent is paused and its growth lock is held,
the existing read-only scanner can cover the entire table and return only
occupied slots. A new frame allocated by another process cannot enter the
parent's locked table. Fork reads the physical bound once and keeps scratch
entries for the live extent. It still rejects an occupied tail, checks frame
ownership and preserves virtual addresses, aliasing and private copies.

In a Firefox Sway session at 2634 × 1806, one Alt+Return forks Sway before
exec of the command shell, then forks Foot before exec of the login shell.
The table counts host imports inside the two Rust fork operations. Control and
candidate use the same partial shell image and module-reuse host. Only the
packaged kernel differs. Both runs use the same counters.

| Import / elapsed time | Sway control | Sway candidate | Foot control | Foot candidate |
| --- | ---: | ---: | ---: | ---: |
| Scalar atomic load | 18,749 | 2,365 | 18,518 | 2,134 |
| Next nonzero | 0 | 617 | 0 | 182 |
| Physical memory size | 640 | 26 | 201 | 22 |
| Fill | 338 | 338 | 185 | 185 |
| Copy | 334 | 334 | 181 | 181 |
| Atomic store | 645 | 645 | 199 | 199 |
| Fork operation, ms | 4.44 | 2.28 | 2.26 | 1.20 |

The two forks together made 32,762 fewer calls across these six imports and
took 3.22 ms less in this pair. This measures the fork operation itself.
Time from shortcut to fitted prompts was 1.44 s and 1.30 s in the same
sessions. The experiment cannot attribute that desktop difference to the
scanner. Four successive launches in installed Firefox on the candidate
took 2.37, 2.25, 3.18 and 3.23 seconds, respectively.

The 112 native runtime-core memory-group tests passed, including a new
malformed-last-slot case that checks the error, lock release, absent child
descriptor and unchanged pool allocation. Chromium, Firefox and experimental
WebKit displayed both fitted prompt-bearing tiles in the normal partial shell.
The change uses the existing ABI with no new host operation or retained state.

Node ran the compiled SDK fork probe on ordinary and grouped backends and
the 24-root retirement check. The first churn run saw the physical backing
rise from 164 to 170 pages during the final 128 iterations. The stock
control and a repeat with the fork patch each passed the unchanged plateau
assertion and all 256 retirement checks. The initial raw harness also
failed to resolve the standalone kernel directory as a source projection
and to link its fork fixture against the current SDK. The repeat used the
canonical package projection, explicitly loaded the candidate kernel, and
linked the fixture to the real mprotect syscall. No shipped source or
assertion was changed for that rerun.
