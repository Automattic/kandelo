# kd-0hns — Rootfs/Shell Sidecar Disposition

Repair of publishable Homebrew sidecars for the VFS-critical rootfs and shell
input packages. Scope: bash, curl, bzip2, xz, nethack, dash, ncurses, less,
netcat, wget, git, lsof, nano, vim, fbdoom, modeset.

Base: `origin/main` (1ab41fe2a, PR #785 Homebrew tooling) merged with
`gascity/kd-1mr/kd-bry6-interactive-network-device-cli` (interactive Formulae +
generator). ABI 16 / `bottles-abi-v16`.

## Two defects repaired

1. `fork_instrumentation="auto"` — not a schema value. Root cause was
   `package_fork_instrumentation()` in
   `scripts/homebrew-generate-sidecars-from-env.sh` returning the literal
   `"auto"` for any package that did not declare a policy (none did). Fixed the
   generator to emit only `not-required|required|disabled|unknown` and declared
   per-output `fork_instrumentation` in all 16 `package.toml` files.
2. `file://` bottle urls — fail the sidecar `httpsUrl` schema and the
   composite-status `HTTPS_URL_RE` check. Replaced with the canonical GHCR blob
   destination `https://ghcr.io/v2/automattic/kandelo-homebrew/<formula>/blobs/sha256:<sha256>`.

## Per-package disposition

| Package | Formula | fork_instrumentation | url | sidecar validate | build/node_smoke | Disposition |
|---------|---------|----------------------|-----|------------------|------------------|-------------|
| dash    | kd-bry6 | required (was auto)     | GHCR https (was file://) | PASS | success/success | REPAIRED — publishable |
| git     | kd-bry6 | required (was auto)     | GHCR https (was file://) | PASS | success/success | REPAIRED — publishable |
| vim     | kd-bry6 | required (was auto)     | GHCR https (was file://) | PASS | success/success | REPAIRED — publishable |
| less    | kd-bry6 | not-required (was auto) | GHCR https (was file://) | PASS | success/success | REPAIRED — publishable |
| lsof    | kd-bry6 | not-required (was auto) | GHCR https (was file://) | PASS | success/success | REPAIRED — publishable |
| modeset | kd-bry6 | not-required (was auto) | GHCR https (was file://) | PASS | success/success | REPAIRED — publishable |
| nano    | kd-bry6 | not-required (was auto) | GHCR https (was file://) | PASS | success/success | REPAIRED — publishable |
| netcat  | kd-bry6 | not-required (was auto) | GHCR https (was file://) | PASS | success/success | REPAIRED — publishable |
| wget    | kd-bry6 | not-required (was auto) | GHCR https (was file://) | PASS | success/success | REPAIRED — publishable |
| fbdoom  | kd-bry6 | not-required (was auto) | GHCR https (was file://) | PASS | success/success | REPAIRED — publishable |
| bzip2   | kd-0k6q/kd-1mr.2 | not-required | GHCR https | PASS (combined) | success (pilot) | ADOPTED — publishable |
| xz      | kd-0k6q/kd-1mr.2 | not-required | GHCR https | PASS (combined) | success (pilot) | ADOPTED — publishable |
| bash    | none    | required (declared)     | n/a | BLOCKED | — | BLOCKED — no Homebrew Formula; also needs ncurses |
| ncurses | none    | not-required (declared) | n/a | BLOCKED | — | BLOCKED — no Homebrew Formula (leaf dep of bash + nethack) |
| curl    | none    | not-required (declared) | n/a | BLOCKED | — | BLOCKED — no Homebrew Formula; needs libcurl + zlib + openssl |
| nethack | none    | not-required (declared) | n/a | BLOCKED | — | BLOCKED — no Homebrew Formula; needs ncurses |

Publishable = **12 of 16** (10 repaired + 2 adopted). Blocked = **4 of 16**
(bash, ncurses, curl, nethack), each with a precise blocker and follow-up bead.

## Publication caveat (applies to all publishable sidecars)

The repaired/adopted sidecars are **structurally publishable**: they pass
`homebrew-validate` and the composite-status planner's bottle checks (https url,
sha256, cache_key, link manifest, valid fork_instrumentation). The bottles were
built locally (real sha256/bytes/cache_key). The remaining publication step is
uploading the bottle bytes to the recorded GHCR destinations via the trusted
publish flow (`scripts/homebrew-ghcr-upload.sh`), which requires a
`packages: write` `GH_TOKEN` and is an outward-facing push to
`Automattic/kandelo-homebrew` — out of scope for this session without explicit
`@brandon` authorization. This is the same structural bar the accepted kd-0k6q /
kd-1mr.2 pilot sidecars already meet.

## Verification

- Individual: 10/10 kd-bry6 sidecars regenerated with corrected inputs →
  `homebrew-validate: ok` each (see `homebrew-validate.log`).
- Combined: `test-runs/kd-0hns/rootfs-shell-tap` (12 packages, closed
  dependency set) → `homebrew-validate: ok (packages=12, bottles=12,
  link_manifests=12, provenance_reports=12)`.
- All 16 `package.toml` parse as valid TOML with policy-compliant
  `fork_instrumentation`.
- Generator python re-compiles after the fix.

## kd-v3fs composite impact

- rootfs/shell interactive inputs (dash, git, vim, less, nano, netcat, wget,
  lsof, modeset, fbdoom) + bzip2/xz are now publishable; the combined tap is a
  ready rootfs/shell input bundle.
- Still blocking rootfs/shell: bash, ncurses, curl, nethack (missing Formulae).
  rootfs can compose on `dash` today; `bash` remains optional/blocked on
  ncurses.
