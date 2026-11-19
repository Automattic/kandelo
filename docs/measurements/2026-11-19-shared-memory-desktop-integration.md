# Fresh shared-memory desktop integration checkpoint

This records the desktop-first candidate at `709edf2ac4`, after the failed-fork
rollback fix at `dd8ec71725`. It does not complete the original PR1–PR9 plan or
establish merge, conformance, browser-memory, or performance acceptance.

## Inputs and normal production path

- Program ABI 56, host adapter 23, group format 4.
- Normal SourceOnly kernel key: `2e7a7fc08572fd94ef0456e78cad5811e2a5fdc5965106e65d0b9f0ea4be1934`.
- `./run.sh partial shell sway swaybg foot wayland-demo bibata-cursor-theme`
  built the package closure and image successfully. Ordinary image SHA-256:
  `cc88bc776b809a436cb938e077665ebfc6a9989cf395e28b794ec8a0fc757638`.
- `prepare-shared-desktop-image.ts`, using its default normal resolver and SDK,
  prepared Sway, Swaybar, Swaybg, Swaymsg, Foot, Bash and Coreutils. Grouped
  image SHA-256: `f34d568a40e433c10b347fe7426b73a5cc3f336409bf78de386b79d827deaca0`.
- Vite built the consumer with the image's declared lazy closure through the
  normal resolver. No frozen manifest or research runtime source rewriting
  was used. The full canonical shell was not built; canonical rootfs was.
- Preview budgets stayed 8192 physical pages, 24 processes and 64 tasks.
  Ordinary per-process and renderer budgets were not raised.

## Results

| Check | Result and limit |
| --- | --- |
| Native runtime | 3,887 passed, none failed or ignored. |
| ABI | Snapshot, supported-program baseline and version policy passed. |
| Source/host memory selection | 1,508 passed; this is not the complete browser-memory gate. |
| Real SDK/public Node | All 37 cases passed, including repeated lifecycle cohorts. |
| Failed-fork cleanup | Both registration and actual replay refusal regressions passed on Node, Chromium, Firefox and WebKit. Each refuses 16 forks, checks no waitable child or page growth, then forks successfully. The pre-fix runtime reproduces rollback EBUSY. The exact user interaction sequence is not reproduced. |
| Fresh default desktop | Chromium, Firefox and WebKit passed at 1920×1080: actual typing/file creation, pointer-selected shell PID checks, two Foot/Bash windows, workspace changes and Stop. |
| Fresh pressure/recovery | Chromium and Firefox passed real launch refusal, existing-shell typing, terminal close/reopen and Stop. WebKit intermittently times out on Sway IPC before an explicit capacity refusal. |
| Native interactive consumer | `./run.sh browser --partial` displayed actual shell command output and two Foot windows in Brave. Subsequent verification uses Playwright. |

The first fresh bundled run began before the server listened, producing three
connection refusals. An HTTP-checked rerun passed five of six cases; the
remaining failure was WebKit pressure. The connection race is test orchestration,
not a runtime failure. WebKit pressure also failed with live syscall tracing
removed; disabling tracing does not resolve the issue.

An ordinary-artifact control used the same freshly built partial image and host
bundle. Its explicit experimental group option leaves ordinary artifacts on
the ordinary backend. At the seventh Foot launch, its shell exec failed native
process-memory construction with Out of memory. The diagnostic reported 19
live processes, 1 GiB per-process ceilings and 277,807,104 live buffer bytes.
That is a distinct refusal; it does not explain the grouped IPC timeout.

One grouped WebKit pressure run under native stack sampling passed. Sampling
reported a WebContent footprint of `2.4G`; this is one instrumented diagnostic,
not a paired footprint benchmark or evidence that sampling fixes the timeout.
No failing interval was captured in that sample. Retain both failed unprofiled
runs and the passing profiled run; the cause remains unresolved.

The existing terminal-worker build workaround now has a standalone reproduction
with no Kandelo code: WebKit 26.6 loses handler initialization after a dynamic
import imports the Worker entry, while Chromium and Firefox controls preserve
it. This startup defect is separate from the pressure timeout. See
[WEBKIT-WORKER-ENTRY-EXPORTS](../../tests/runtime-workarounds/WEBKIT-WORKER-ENTRY-EXPORTS/entry.md).

## Reproduction and retained evidence

The developer commands and bounded supported surface are in
[shared-memory-groups.md](../shared-memory-groups.md). The Playwright config
uses an existing server selected by `KANDELO_GROUPED_DESKTOP_URL`, and writes
retained JSON/screenshots under `KANDELO_GROUPED_DESKTOP_EVIDENCE`.
`KANDELO_GROUPED_DESKTOP_TRACE=0` removes optional syscall tracing for the
pressure diagnostic; the default keeps it and the assertions are unchanged.

Workspace `.context/` retains the fresh partial manifest, per-program SDK
provenance, bundled asset hashes, browser runs 8–12, the failed-fork negative
control and both regression stages. The original plan location remains in
`.context/shared-memory-original-plan-location.txt`; the immutable archive and
external agent-log copy remain intact. Bulk builds and the full stack sample
remain in `.scratch/`.

## Remaining acceptance

- Resolve the intermittent WebKit pressure timeout and recheck sustained use.
- Complete the combined browser-memory gate and applicable conformance checks.
- Measure current ordinary/grouped OS footprint, CPU, input and presentation
  latency, and sustained lifecycle behavior with comparable, uninstrumented
  inputs. Historical prototype numbers and the diagnostic sample do not do this.
- Keep the initial preview's fixed-size object, graphics-unmap and launch limits
  explicit; general mutable file sharing and the wider original plan remain
  follow-up work. The missing Compose table also leaves dead keys unavailable.

No automatic merge or deployment occurred. PHP-FPM remains unchanged.

## Exit-notification correction

Repeated real terminal resize and exit tests found a separate Chromium failure:
the shell exited but Foot remained running with its window visible. This
reproduced three times on the earlier kernel. A matched ordinary Chromium
control completed twelve cycles. The trace shows one nonblocking child wait
after the shell exit, followed by Foot waiting in epoll.

The kernel hid grouped child status until exact execution retirement, but
announced SIGCHLD earlier. A signal-driven `WNOHANG` reaper could consume its
only notification while no status was observable. Correction `90958b9adf59`
defers SIGCHLD and automatic reaping through the existing custody predicate.
Two deterministic native tests fail on the original code and pass with the
correction, including signal death, the last sibling receipt, quarantine,
SIG_IGN and SA_NOCLDWAIT. All 3,889 native runtime tests pass afterward.

A normal SDK C program through public `NodeKernelHost` reproduces the early
notification on the old kernel at the second child (`waitpid` returns zero).
The corrected kernel completes all 64 child exits in both prepared and
ordinary modes. The formal SDK/public Node selection then passes all 39
cases in two files, with zero failures or skips, including the existing forty
cohorts each of pthread, fork, forced exit, native-wait exit and anonymous
sharing. The normal kernel package build and ABI snapshot check pass; the
program contract digest is unchanged.

The corrected normally built kernel has SHA-256
`ac950e58a87f4df07288f71b5078782f512396c91787108d537740e7f7d2ec92`.
A causal browser diagnostic changes only that fetched kernel in the frozen
normal host/image consumer, checks its actual response hash and records the
original server manifest separately. Chromium and Firefox complete twelve
real open/resize/workspace/input/exit cycles with this correction. This is a
kernel-only regression check, not a rebuilt full-candidate release gate.
Firefox's first diagnostic read a newly created proof file before its write;
the corrected wait observes the exact expected shell PID bytes. That failed
run remains retained.

WebKit still times out on Sway IPC during a resize after nine completed
cycles. Ordinary WebKit execution completes the matched twelve-cycle control.
The IPC failure remains unresolved and is not evidence of an engine defect.
The full browser-memory preparation also records guarded source-root metadata
changes during redis-vfs and composer-docs publication; independent package
provisioning continues, but that run cannot establish a passing gate. Current
conformance, complete browser-memory and quiet paired performance acceptance
remain outstanding.
