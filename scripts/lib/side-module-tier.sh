# Shared by the CO-RESIDENT side-module build scripts: dylink-module,
# wasi-module, wasm-artifact-module and fork-module. NOT sffs-module --
# `sffs_module32` is absent from `CORESIDENT_SIDE_MODULES` and from
# `binary-resolver.ts` entirely, so it is not served from the tier and staging
# it there would ADD a shadowing candidate rather than remove one.
#
# Two halves of one rule, because a check without the staging is a rejection
# nobody can clear: the sibling scripts do not write to the tier today, so
# comparing without staging would fail forever and rebuilding would not help.
#
# `resolveBinary` (host/src/binary-resolver.ts) searches
# `local-binaries/source-only-v1/` FIRST, ahead of `local-binaries/` and
# `host/wasm/`. A module staged only to the latter two is therefore not the
# module either host loads, and a stale copy in the tier shadows every rebuild
# silently. The engine already requires these to agree --
# `coresident_side_module_projection_is_current` accepts only
# `source == projected` -- but that runs at PROJECTION time, and a tree whose
# package build is broken never projects. These functions apply the same rule
# at build and verify-fresh time, where it still happens.

# Stage an artifact into the source-only tier when that tree exists.
# Usage: stage_side_module_tier_copy <repo_root> <artifact-basename>
stage_side_module_tier_copy() {
  local repo="$1" name="$2"
  local tier="$repo/local-binaries/source-only-v1"
  local staged="$repo/local-binaries/$name"
  # Both absences are legitimate, not errors: the tier tree does not exist in
  # every checkout, and wasm64 artifacts are built only opportunistically, so a
  # caller may stage a width this build did not produce.
  [[ -d "$tier" ]] || return 0
  [[ -f "$staged" ]] || return 0
  cp "$staged" "$tier/$name"
  echo "  also staged $name -> local-binaries/source-only-v1/$name" >&2
}

# Fail when the tier copy disagrees with the staged artifact.
# Usage: assert_side_module_tier_copy_matches <label> <repo_root> <basename>
assert_side_module_tier_copy_matches() {
  local label="$1" repo="$2" name="$3"
  local staged="$repo/local-binaries/$name"
  local shadow="$repo/local-binaries/source-only-v1/$name"
  [[ -f "$shadow" ]] || return 0
  if ! cmp -s "$shadow" "$staged"; then
    echo "$label: $shadow differs from $staged, and it is the copy" \
      "resolveBinary returns FIRST -- so the verified artifact is not the one" \
      "the hosts load. Rebuild with 'bash crates/$label/build-wasm.sh', which" \
      "stages every tier." >&2
    return 1
  fi
  return 0
}
