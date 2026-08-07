# Bounded Swap for the Homebrew VFS Proof

## Status

Approved design for the ABI-42 Homebrew migration shipment bridge. This is a
CI host-resource accommodation, not a Kandelo runtime fix or a narrower release
claim.

## Context

The exact 41-bottle ABI-42 image builds and crosses the same-run artifact
boundary successfully. In Actions run `31181316067`, the fresh
`ubuntu-latest` proof runner reached about 15.2 GiB resident Node memory, left
about 286 MiB RAM available, consumed about 3.0 GiB of its 3 GiB swap, and was
then cancelled during stock `brew tap`. The filesystem still had about 85.8 GB
free.

The same exact image, selection, report, kernel, and tap revision completed the
unchanged stock Homebrew proof locally on a 48 GiB host in about three and a
half minutes. Five-second sampling observed a 15.48 GiB Node RSS peak followed
by repeated drops near 10 GiB. The proof therefore has a transient host-memory
requirement that a standard 16 GiB runner cannot reliably absorb.

## Decision

Keep every guest and publication contract unchanged. Add one 8 GiB swapfile to
the existing fresh `build-test` runner immediately before the exact Node and
Chromium proof. Provision it only on a GitHub-hosted Linux runner, fail closed
if it cannot be created or activated, retain the existing resource heartbeat,
and remove it on the normal or failure cleanup path.

This is the shortest migration bridge that needs no organization-level runner
configuration. A successful run proves the same stock `brew tap`, exact tap
checkout, bottle download, extraction, pour, execution, and trust behavior as
before. Swap does not change guest memory limits, process semantics, the VFS,
the selected bottles, the kernel, or the four published assets.

## Workflow Contract

The change is confined to `build-test` in
`.github/workflows/homebrew-experimental-vfs-publish.yml`.

Before starting the proof, the workflow must:

1. Require `RUNNER_ENVIRONMENT=github-hosted` and Linux.
2. Resolve one fixed path below `RUNNER_TEMP` and reject any existing path or
   symbolic link.
3. Record the baseline swap total and require at least 24 GiB filesystem space
   free before reserving exactly 8 GiB with `fallocate`. This leaves at least
   16 GiB free after the reservation.
4. Set mode `0600`, format the file with `mkswap`, and activate it with
   `swapon`; no provisioning command may be failure-tolerant.
5. Verify the exact active path and 8 GiB size with `swapon --show`, require the
   `/proc/meminfo` swap total to have increased from the recorded baseline by
   at least 8 GiB, and log memory, active swap, cgroup memory/swap limits when
   present, and filesystem capacity.

The existing proof command, 30-minute application deadline, heartbeat, exact
candidate checks, Chromium startup proof, evidence binding, final four-file
artifact, publisher, and anonymous readback remain unchanged.

An `if: always()` cleanup step must deactivate only the exact reviewed
swapfile and remove only that path. Cleanup must never use `swapoff -a`, a glob,
or a broad directory operation. If a service cancellation prevents cleanup,
the GitHub-hosted VM remains the containment boundary and is discarded by
GitHub; `build-test` has no publication credentials or secrets.

## Failure Behavior

- Inadequate disk, unavailable `sudo`, failed allocation, failed `mkswap`,
  failed `swapon`, an unexpected active-swap identity, or insufficient total
  swap fails `build-test` before the lifecycle begins.
- A lifecycle timeout, application failure, or another service cancellation
  remains a release failure. Publication and readback stay skipped.
- Swap exhaustion is reported by the existing heartbeat rather than converted
  into a successful or reduced proof.
- No automatic fallback selects a self-hosted runner, weakens the lifecycle,
  lowers guest memory, or imports local evidence.

## Structural Validation

Update the existing workflow checker and mutation suite before changing the
workflow implementation. They must reject:

- omitted or reordered provisioning;
- a size other than 8 GiB;
- a path outside `RUNNER_TEMP`, path clobbering, or symbolic-link acceptance;
- failure-tolerant allocation, formatting, activation, or verification;
- missing GitHub-hosted/Linux assertions;
- missing exact active-swap and total-swap verification;
- missing `if: always()` cleanup, broad cleanup, or `swapoff -a`;
- moving swap setup to `build-image`, `publish`, or `public-readback`; and
- any change to the full Node proof, Chromium proof, artifact identities,
  permissions, dependencies, publication, or anonymous readback.

Run the focused checker and mutation suite in `scripts/dev-shell.sh`, parse the
embedded Bash, run `actionlint`, and run `git diff --check`. The shipment claim
requires a new exact default-branch dispatch in which all four jobs succeed and
the four public assets pass anonymous byte-for-byte readback.

## Removal Condition

This swapfile is not intended as the permanent process-memory design. Remove it
after a general Node/browser solution bounds fork/exec memory without changing
guest semantics, such as a validated copy-avoiding spawn path or another
platform-level reclamation/admission correction. Until then, it applies only
to final stock Homebrew lifecycle gates, not individual bottle builds or
ordinary package PRs.
