# Grouped executable transfer during a terminal burst

The change targets develop at `6b6904b3075437433a1cccec0273142850c8f93c`.
Before the change, the shared launcher copied the selected grouped executable
back from Rust after binding. The host already held the complete observation
used by Rust to verify that binding. The launcher can use that owned buffer
through final admission, compilation and commit. Rust still checks the binding
and independently revalidates the retained target at commit. The buffer lives
for the existing launch transaction.

The Foot image in the tested partial shell contains 4,335,086 executable bytes.
For each Foot launch the host now skips one allocation of that size, its
65,536-byte chunk reads and one size query. Five Foot launches skip 20.7 MiB of
whole-image transfers and at least 335 chunk reads for Foot alone. The shell
executables use the same path.

## Measurement

The browser comparison used host revision
`0ae2a062cd89a95ca945adeb393d0ba9fa7a07f0` with and without this host change.
Both sides used the same Sway partial shell
(`8f7a25bc1b93fdb82e2ae78ac0448798d7dfdf22cb63822e6cc1c50bdb997e92`)
and grouped kernel artifact
(`af47c623f87611b6d05d5ab42cec7dfa291648afbc64a36ff8992a9c8158bb87`).
This kernel includes the independently proposed reduction in binding hashes.
The runner sent five trusted Alt+Enter presses and checked the original prompt
and five added prompts in screenshots.

The interval starts after Rust accepts the binding and ends after the host
receives the final admission result for Foot. Medians are over the five Foot
executables in one burst per browser build. This interval includes temporary
target cancellation and final admission.

| Browser | Before | Reused buffer |
| --- | ---: | ---: |
| Chromium | 18.78 ms | 4.26 ms |
| WebKit | 22.06 ms | 3.62 ms |

The measured step did less work even during a period of substantially higher
machine load. The aggregate first-key-to-six-prompts samples increased from
3.83 to 4.58 seconds on Chromium and from 5.59 to 6.67 seconds on WebKit.
The one-minute host load changed from 14 to 119 and from 8 to 119, respectively.
Those runs give no end-to-end speedup estimate. A first Firefox trial stalled
with a black desktop before the initial prompt at a one-minute load of 146.

## Validation

The Node prepared-exec and grouped execution suites passed 78 tests with the
kernel artifact built from the exact develop revision above. They include a
control that verifies the compiler receives the bound bytes while final
admission and commit still run. The browser runs use the normal partial
shell, package references and Sway/Foot startup. The host build including its declarations passed. Other graphical workloads
and long-running desktop churn are outside this receipt.
