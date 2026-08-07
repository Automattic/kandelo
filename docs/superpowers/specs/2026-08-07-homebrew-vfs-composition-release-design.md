# Composition-Gated Homebrew VFS Release

## Status

Approved and implemented on branch `fix/homebrew-vfs-proof-swap-qk044` for
completing the experimental ABI-42 Homebrew migration. Shipment still requires
the exact post-merge default-branch dispatch, publication, and anonymous
readback. This replaces the proposed proof-runner swap accommodation. The
release gate proves exact VFS composition and bounded selected-runtime startup;
the complete stock Homebrew lifecycle remains a separate diagnostic until
Kandelo can run it without exhausting the proof host.

## Context

The exact ABI-42 candidate crossed the clean-runner boundary successfully in
Actions run `31181316067`. The builder and fresh test runner agreed on the
same-run artifact identity and on the exact VFS, canonical 41-bottle selection,
composition report, kernel, and tap revision. The fresh runner then exhausted
its 16 GiB memory class while stock `brew tap` was still running: Node resident
memory reached about 15.2 GiB, available RAM fell to about 286 MiB, and almost
3 GiB of swap was in use before the service cancelled the step.

The unchanged full lifecycle completed locally on a 48 GiB host. That result
shows that the image is viable, but it does not make the expensive lifecycle a
necessary proof of how the image was composed. The original fast-lane design
also listed full install, upgrade, remove, and reboot coverage as a non-goal for
the first experimental release.

The failed hosted step was therefore testing a broader claim than this release
needs to make. Composition correctness was already established before the
memory-intensive `brew tap`, fetch, extract, and pour sequence began.

## Decision

Publish the experimental ABI-42 VFS when all of these conditions succeed:

1. The tap revision and canonical selection bytes match the exact dispatch
   inputs.
2. Every selected bottle is validated and materialized through the existing
   flat-VFS builder, with public fallback disabled.
3. The builder emits one exact VFS, selection, report, and claimed kernel, and
   a fresh read-only runner downloads that same-run candidate by artifact ID
   and verifies every SHA-256 and byte count.
4. Node boots the exact VFS with the exact kernel, validates the embedded
   composition/runtime contract, and runs the selected `/usr/bin/brew
   --version` path without lazy downloads or unexpected host diagnostics.
5. Chromium boots those same image and kernel identities and starts the
   selected Ruby both directly and through the selected shell.
6. The trusted publication job publishes exactly the VFS, canonical selection,
   and composition report, then a credential-free job downloads and rehashes
   those exact public bytes.

The publication workflow must not run the complete stock Homebrew tap/install
lifecycle. That lifecycle stays available as an explicit manual diagnostic and
may be restored as a publication gate after the ABI-43 vfork work is rebuilt
and measured with real Homebrew artifacts.

## Release Claim

The experimental release proves that:

- the public selection is canonical, dependency-consistent, wasm32, and bound
  to Kandelo ABI 42;
- the VFS was assembled from the exact bottle URLs, digests, sizes, dependency
  identities, and winning links in that selection;
- the serialized image contains the expected Homebrew runtime support,
  selected shell, stable extraction commands, ABI metadata, and composition
  report;
- the fresh proof runner received exactly the candidate that the builder
  produced;
- the exact image and kernel boot in Node and Chromium; and
- selected Homebrew and Ruby entry points start through the normal Kandelo
  runtime path.

It does **not** prove that stock in-guest Homebrew can tap a repository,
download a bottle, extract it, pour it, execute it, uninstall it, upgrade it,
or survive a reboot on a standard hosted runner. Release notes and
documentation must state that boundary directly.

## Composition Proof

The existing builder remains authoritative for composition. It must continue
to reject a noncanonical selection, wrong ABI or architecture, duplicate or
missing Formula, dependency-order or dependency-identity mismatch, changed
bottle bytes, unsafe archive member, link ownership conflict, missing runtime
support, unexpected lazy materialization, or a report that does not bind the
exact selection and image.

The build job continues to create an intermediate candidate containing exactly
four regular, nonsymlink files:

1. `kandelo-homebrew-experimental-abi42-wasm32.vfs.zst`;
2. `homebrew-selection.json`;
3. `homebrew-vfs-build-report.json`; and
4. `kernel.wasm`.

The kernel remains an intermediate proof input rather than a release asset.
The fresh runner must download this candidate by the exact same-run artifact
ID, verify its fixed inventory and all four identities, compare the selection
bytes to the exact tap checkout, and copy the kernel only to the reviewed local
proof path. No package, VFS, or kernel input may be rebuilt on the proof runner.

## Bounded Runtime Startup

Add a focused Node startup entry point rather than changing the semantics of
the existing full-lifecycle proof or its evidence format. The startup path
must reuse the same embedded-runtime validation and normal Node kernel host,
then:

1. start the machine under one bounded deadline;
2. require zero lazy VFS downloads;
3. run `/usr/bin/brew --version` through the image-selected shell;
4. require a nonempty version and the existing success marker;
5. require zero unexpected host diagnostics; and
6. destroy the machine before returning success.

The focused CLI must load and bind the exact image, selection, report, kernel,
tap checkout, and tap revision before starting the machine. It must not accept
a native host Git, Ruby, Homebrew, Formula, bottle cache, or network fallback.
It emits no lifecycle evidence file because it does not run the lifecycle that
the existing evidence schema describes.

Chromium retains the two existing bounded selected-runtime cases. Each case
must assert the exact returned image and kernel SHA-256, a zero exit status, no
standard error, and Ruby `4.0.5`: once by starting the selected Ruby bytes
directly and once through the selected shell. The complete Chromium Homebrew
lifecycle test remains outside the publication workflow.

The resource heartbeat added for the memory-intensive lifecycle is removed
from this workflow. The bounded startup checks do not need a large-runner or
swap accommodation.

## Public Assets And Readback

The release contains exactly three regular assets:

1. `kandelo-homebrew-experimental-abi42-wasm32.vfs.zst`;
2. `homebrew-selection.json`; and
3. `homebrew-vfs-build-report.json`.

`homebrew-node-evidence.json` is removed from this release. Keeping that name
after replacing the full lifecycle would falsely imply that the old shipping
proof ran. The successful GitHub jobs are the record of the bounded Node and
Chromium startup gates.

After startup succeeds, the workflow identifies the three asset identities,
immediately revalidates the VFS, selection, report, and proof kernel against the
builder outputs, and uploads only the three public assets. The publisher must
depend only on that final tested artifact, retain the existing unique run and
attempt release tag, and keep publication credentials out of the build and
test jobs.

The final anonymous readback is intentionally small in purpose. It proves only
that an unauthenticated consumer can retrieve the three named release assets
and that GitHub serves the same byte counts and SHA-256 values the workflow
published. It catches private, missing, truncated, substituted, or incorrectly
named assets. It is not provenance bookkeeping and does not replace the
composition proof.

## Full Lifecycle Diagnostic

Retain the existing stock Homebrew lifecycle implementation and evidence
schema unchanged. It remains runnable manually against exact image, selection,
report, kernel, and tap inputs on a host with sufficient resources. Do not add
it to the release workflow with `continue-on-error`: that would still consume
the constrained runner and would make a publication run look partially
failed.

A diagnostic result may support debugging or future platform work, but neither
a local result nor a failed/cancelled hosted result changes the ABI-42 release
gate. A future workflow may publish diagnostic evidence under a clearly
separate name only after that workflow and its authority boundary are designed
and reviewed.

## ABI-43 Restoration Path

The integration branch `integration/abi43-batch-linear-20260801` contains the
genuine vfork implementation intended to remove full address-space copying for
eligible fork-then-exec paths. It launches a separate child Worker over the
parent's existing shared memory, suspends the calling parent until exec or
exit, and configures upstream Ruby to use a working `vfork` path.

That implementation is a strong candidate to remove the Homebrew lifecycle's
current memory peak, but it has not yet proved the real in-guest Homebrew
lifecycle or application RSS. Do not describe the issue as fixed based on
component measurements alone.

Restore the full lifecycle to a publication gate only in a later reviewed
change after all of the following are true:

1. ABI 43 and its snapshot are landed through the normal ABI process.
2. Ruby and every selected bottle are rebuilt for ABI 43 through the normal
   Homebrew lane, and a new exact selection and VFS are composed.
3. The unchanged stock Homebrew lifecycle completes against those exact bytes
   in Node and in every host for which the release claims lifecycle support.
4. Peak RSS and process behavior are measured, reported, and leave credible
   headroom on the selected CI runner without swap, reduced guest memory,
   native-tool substitution, pre-tapping, or kernel restarts.
5. The complete lifecycle evidence is again named and published only if it
   truthfully describes the gate that ran.

The ABI-43 integration worktree is outside this packaging change. This work
must not edit, clean, reset, or include it.

## Failure Behavior

- Any authority, selection, bottle, composition, artifact-identity, Node
  startup, Chromium startup, publication, or anonymous-readback failure blocks
  the release.
- A failure in a separately invoked full-lifecycle diagnostic does not revoke
  a release that makes only the narrower composition/startup claim.
- No fallback may lower guest memory, use host-native package tools, skip exact
  byte checks, import local evidence, or publish before the fresh runner has
  completed both startup gates.
- Publication remains the only write-capable job. Build, proof, and anonymous
  readback remain read-only.

## Structural Validation

Update tests before implementation. The workflow checker and mutation suite
must require:

- the unchanged four-file, artifact-ID-addressed intermediate candidate;
- fresh-runner verification of all four candidate identities and the exact tap
  selection bytes;
- the focused Node startup CLI and both exact Chromium Ruby startup cases;
- absence of the full Node lifecycle CLI, lifecycle evidence file, and resource
  heartbeat from the publication workflow;
- an exact three-file final inventory with no kernel or evidence file;
- identification followed by immediate candidate/kernel rebinding and final
  artifact upload;
- publisher dependence only on the final tested artifact;
- exact three-asset publication and anonymous SHA-256/size readback; and
- unchanged job permissions, default-branch dispatch guard, action pins, and
  unique release-tag derivation.

Add focused unit coverage for the Node startup path. It must prove bounded
machine start, `brew --version`, no lazy downloads, diagnostic rejection,
teardown on success and failure, and that it never invokes the stock tap/install
script. Add CLI argument and exact-input binding tests. Keep the existing full
lifecycle tests unchanged.

Validation for the implementation includes the focused TypeScript tests, the
workflow checker and mutation suite through `scripts/dev-shell.sh`, Bash syntax
for embedded scripts, `actionlint`, and `git diff --check`. The shipment claim
then requires a new exact default-branch dispatch in which build, startup,
publication, and public readback all succeed.

## Non-Goals

- Changing the ABI-43 vfork implementation or its dirty worktree.
- Claiming that the full stock Homebrew lifecycle passed in hosted CI.
- Adding swap, a larger runner, or a self-hosted runner to ship ABI 42.
- Weakening bottle, selection, VFS, kernel, or public-byte validation.
- Designing the future ABI candidate-bottle staging and promotion lane in this
  shipment correction.
