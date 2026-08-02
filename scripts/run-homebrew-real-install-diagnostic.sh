#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONTRACT="$REPO_ROOT/homebrew/real-install-diagnostic.json"
BOOTSTRAP_SPEC="$REPO_ROOT/homebrew/real-install-diagnostic-brew-package-tree.json"
SHELL_CONFIG="$REPO_ROOT/homebrew/main-shell-default.json"
COMMAND="${1:-}"
if [ -n "$COMMAND" ]; then
  shift
fi
WORK_DIR=""
SELECTION_TAG=""

usage() {
  cat <<'EOF'
Usage:
  scripts/run-homebrew-real-install-diagnostic.sh prepare \
    --selection-tag <immutable-selection-tag> \
    --work-dir <new-directory>

  scripts/run-homebrew-real-install-diagnostic.sh prove-node \
    --work-dir <prepared-directory>

  scripts/run-homebrew-real-install-diagnostic.sh prove-browser \
    --work-dir <prepared-directory>

The diagnostic consumes 25 Formula handoffs without satisfying or changing
the complete main-shell product lock. The prepare step is resumable: Node and
Chromium consume the same resulting VFS and closed lazy-asset fixture.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --selection-tag)
      SELECTION_TAG="${2:-}"
      shift 2
      ;;
    --work-dir)
      WORK_DIR="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "run-homebrew-real-install-diagnostic: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ -z "$WORK_DIR" ] || [ "$WORK_DIR" = / ] || [ -L "$WORK_DIR" ]; then
  echo "run-homebrew-real-install-diagnostic: --work-dir is unsafe" >&2
  exit 2
fi

for tool in cmp cp jq node python3 ruby sha256sum wc; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "run-homebrew-real-install-diagnostic: missing $tool" >&2
    exit 2
  }
done

CONTRACT_SHA="$(sha256sum "$CONTRACT")"
CONTRACT_SHA="${CONTRACT_SHA%% *}"
SOURCE_TAP_SHA="$(jq -er '.authority.source_tap_commit' "$CONTRACT")"
ABI="$(jq -er '.authority.kandelo_abi' "$CONTRACT")"
CORE_REVISION="$SOURCE_TAP_SHA"
CANARY_REVISION="$(jq -er '.lifecycle.independent_revision' "$CONTRACT")"
MAX_BYTES="$(jq -er '.vfs.max_vfs_byte_length' "$CONTRACT")"

prepared_path() {
  printf '%s/%s\n' "$WORK_DIR" "$1"
}

assert_prepared() {
  if [ ! -f "$(prepared_path prepared.json)" ] ||
     [ -L "$(prepared_path prepared.json)" ]; then
    echo "run-homebrew-real-install-diagnostic: work directory is not prepared" >&2
    exit 2
  fi
  jq -e --arg digest "$CONTRACT_SHA" \
    '.schema == 1 and
     .kind == "kandelo-homebrew-real-install-diagnostic-prepared" and
     .contract_sha256 == $digest and .product_lock_used == false and
     (.selection.tag |
       test("^homebrew-prefix-selection-sha256-[0-9a-f]{64}$")) and
     (.bottles.core_bzip2_sha256 | test("^[0-9a-f]{64}$")) and
     (.bottles.core_dash_sha256 | test("^[0-9a-f]{64}$"))' \
    "$(prepared_path prepared.json)" >/dev/null

  assert_prepared_file selection_receipt selection-receipt.json
  assert_prepared_file selection_authorization selection-authorization.json
  assert_prepared_file selection_check selection-check.json
  assert_prepared_file image real-install-diagnostic.vfs.zst
  assert_prepared_file composition_report composition-report.json
  assert_prepared_file browser_fixture browser-fixture.json
  assert_prepared_file bootstrap_archive homebrew-bootstrap.zip \
    "$(prepared_path bootstrap/homebrew-bootstrap.zip)"
  assert_prepared_file bootstrap_environment homebrew-brew.env \
    "$(prepared_path bootstrap/homebrew-brew.env)"
  assert_prepared_file bottle_mirror_plan \
    kandelo-homebrew-bottle-mirror-plan.json \
    "$(prepared_path bottle-mirror/kandelo-homebrew-bottle-mirror-plan.json)"

  local prepared selection_check temporary
  prepared="$(prepared_path prepared.json)"
  selection_check="$(prepared_path selection-check.json)"
  [ "$(jq -er '.selection.tag' "$prepared")" = \
    "$(jq -er '.tag' "$(prepared_path selection-receipt.json)")" ]
  [ "$(jq -er '.bottles.core_bzip2_sha256' "$prepared")" = \
    "$(jq -er '.formulae[] | select(.formula == "bzip2") | .archive.sha256' \
      "$selection_check")" ]
  [ "$(jq -er '.bottles.core_dash_sha256' "$prepared")" = \
    "$(jq -er '.formulae[] | select(.formula == "dash") | .archive.sha256' \
      "$selection_check")" ]

  # WHY: hashes catch changed regular files, while rerunning the generic
  # verifier catches a replaced selection directory or changed tap tree.
  temporary="$(mktemp -d "$WORK_DIR/.prepared-check.XXXXXX")"
  PYTHONDONTWRITEBYTECODE=1 python3 \
    "$REPO_ROOT/scripts/homebrew-real-install-diagnostic.py" \
    --contract "$CONTRACT" verify-selection \
    --selection "$(prepared_path selection)" \
    --receipt "$(prepared_path selection-receipt.json)" \
    --authorization "$(prepared_path selection-authorization.json)" \
    --report-out "$temporary/selection-check.json"
  cmp "$temporary/selection-check.json" "$selection_check"
  rm -rf -- "$temporary"
}

assert_prepared_file() {
  local key="$1"
  local expected_name="$2"
  local path="${3:-$(prepared_path "$expected_name")}"
  local prepared
  prepared="$(prepared_path prepared.json)"
  local expected_sha expected_bytes actual_sha actual_bytes
  jq -e --arg key "$key" --arg name "$expected_name" \
    '.artifacts[$key].file == $name and
     (.artifacts[$key].sha256 | test("^[0-9a-f]{64}$")) and
     (.artifacts[$key].bytes | type == "number" and . > 0)' \
    "$prepared" >/dev/null
  [ -f "$path" ] && [ ! -L "$path" ]
  expected_sha="$(jq -er --arg key "$key" '.artifacts[$key].sha256' "$prepared")"
  expected_bytes="$(jq -er --arg key "$key" '.artifacts[$key].bytes' "$prepared")"
  actual_sha="$(sha256sum "$path")"
  actual_sha="${actual_sha%% *}"
  actual_bytes="$(wc -c <"$path" | tr -d '[:space:]')"
  [ "$actual_sha" = "$expected_sha" ] && [ "$actual_bytes" = "$expected_bytes" ]
}

prepare() {
  if ! [[ "$SELECTION_TAG" =~ ^homebrew-prefix-selection-sha256-[0-9a-f]{64}$ ]]; then
    echo "run-homebrew-real-install-diagnostic: prepare needs an immutable selection tag" >&2
    exit 2
  fi
  if [ -e "$WORK_DIR" ]; then
    echo "run-homebrew-real-install-diagnostic: work directory already exists" >&2
    exit 2
  fi
  mkdir "$WORK_DIR"

  local selection_root selection_receipt selection_authorization
  local selection_check bootstrap_dir policy platform image report mirror
  local bzip2_sha dash_sha
  selection_root="$(prepared_path selection)"
  selection_receipt="$(prepared_path selection-receipt.json)"
  selection_authorization="$(prepared_path selection-authorization.json)"
  selection_check="$(prepared_path selection-check.json)"
  bootstrap_dir="$(prepared_path bootstrap)"
  policy="$(prepared_path materialization-policy.json)"
  platform="$(prepared_path platform-only.vfs)"
  image="$(prepared_path real-install-diagnostic.vfs.zst)"
  report="$(prepared_path composition-report.json)"
  mirror="$(prepared_path bottle-mirror)"

  # WHY: fetch the immutable release anonymously into this new private work
  # directory. Every later consumer uses only this verified snapshot, so a
  # caller cannot swap or mutate an external selection between checks.
  env -u GH_TOKEN -u GITHUB_TOKEN \
    -u HOMEBREW_GITHUB_API_TOKEN \
    -u HOMEBREW_GITHUB_PACKAGES_TOKEN \
    -u HOMEBREW_DOCKER_REGISTRY_TOKEN \
    PYTHONDONTWRITEBYTECODE=1 python3 \
    "$REPO_ROOT/scripts/homebrew-prefix-campaign-executor.py" \
    fetch-selection-release \
    --repository kandelo-dev/homebrew-tap-core \
    --tag "$SELECTION_TAG" \
    --out "$selection_root" \
    --receipt-out "$selection_receipt"
  PYTHONDONTWRITEBYTECODE=1 python3 \
    "$REPO_ROOT/scripts/homebrew-prefix-campaign-executor.py" \
    verify-selection-readback \
    --selection "$selection_root" \
    --receipt "$selection_receipt" \
    --report-out "$selection_authorization"
  PYTHONDONTWRITEBYTECODE=1 python3 \
    "$REPO_ROOT/scripts/homebrew-real-install-diagnostic.py" \
    --contract "$CONTRACT" verify-selection \
    --selection "$selection_root" \
    --receipt "$selection_receipt" \
    --authorization "$selection_authorization" \
    --report-out "$selection_check"
  bzip2_sha="$(jq -er '.formulae[] | select(.formula == "bzip2") | .archive.sha256' \
    "$selection_check")"
  dash_sha="$(jq -er '.formulae[] | select(.formula == "dash") | .archive.sha256' \
    "$selection_check")"

  jq -e '.vfs.materialization_policy' "$CONTRACT" \
    >"$policy"

  # WHY: the support-data extractor authenticates the detached bootstrap
  # outputs against the same anonymous selection authorization as the VFS.
  env -u GH_TOKEN -u GITHUB_TOKEN \
    -u HOMEBREW_GITHUB_API_TOKEN \
    -u HOMEBREW_GITHUB_PACKAGES_TOKEN \
    -u HOMEBREW_DOCKER_REGISTRY_TOKEN \
    "$REPO_ROOT/node_modules/.bin/tsx" \
    "$REPO_ROOT/scripts/extract-homebrew-support-data-bottle.ts" \
    --tap-root "$selection_root/tap" \
    --expected-tap-sha "$SOURCE_TAP_SHA" \
    --tap-repository kandelo-dev/homebrew-tap-core \
    --tap-name kandelo-dev/tap-core \
    --package homebrew-bootstrap \
    --arch wasm32 \
    --expected-abi "$ABI" \
    --selection-verification-report "$selection_authorization" \
    --output-directory "$bootstrap_dir"

  # Deliberately omit the package-registry manifest fragment. The diagnostic
  # must prove that every executable it uses came from these bottle trees.
  node "$REPO_ROOT/tools/mkrootfs/bin/mkrootfs.mjs" build \
    "$REPO_ROOT/MANIFEST" "$REPO_ROOT/images/rootfs" \
    --repo-root "$REPO_ROOT" \
    --sab-size "$MAX_BYTES" \
    --max-size "$MAX_BYTES" \
    --kernel-abi "$ABI" \
    -o "$platform"

  env -u GH_TOKEN -u GITHUB_TOKEN \
    -u HOMEBREW_GITHUB_API_TOKEN \
    -u HOMEBREW_GITHUB_PACKAGES_TOKEN \
    -u HOMEBREW_DOCKER_REGISTRY_TOKEN \
    "$REPO_ROOT/node_modules/.bin/tsx" \
    "$REPO_ROOT/images/vfs/scripts/build-homebrew-materialized-vfs-image.ts" \
    --metadata "$selection_root/tap/Kandelo/metadata.json" \
    --tap-root "$selection_root/tap" \
    --brewfile "$REPO_ROOT/homebrew/real-install-diagnostic.Brewfile" \
    --arch wasm32 \
    --runtime node \
    --base-image "$platform" \
    --max-bytes "$MAX_BYTES" \
    --bottle-cache "$(prepared_path bottle-cache)" \
    --no-fallback \
    --catalog-commit "$SOURCE_TAP_SHA" \
    --migration-lock "$CONTRACT" \
    --materialization-policy "$policy" \
    --bottle-mirror-repository kandelo-dev/homebrew-tap-core \
    --bottle-mirror-out "$mirror" \
    --package-tree-spec "$BOOTSTRAP_SPEC" \
    --package-tree-archive "$bootstrap_dir/homebrew-bootstrap.zip" \
    --homebrew-bootstrap-env "$bootstrap_dir/homebrew-brew.env" \
    --write-profile \
    --shell-config "$SHELL_CONFIG" \
    --out "$image" \
    --report "$report"

  # WHY: the generic builder calls every compatibility binding a migration
  # lock. Bind that field to this diagnostic contract and reject the shipping
  # runtime-support shape so the result cannot masquerade as the main shell.
  jq -e \
    --arg digest "$CONTRACT_SHA" \
    --argjson bytes "$(wc -c <"$CONTRACT" | tr -d '[:space:]')" \
    --argjson formula_order "$(jq -c '.vfs.formula_order' "$CONTRACT")" \
    --argjson embedded "$(jq -c '.vfs.materialization_policy.embedded_package_order' "$CONTRACT")" \
    --arg bzip2_sha "$bzip2_sha" \
    --arg dash_sha "$dash_sha" '
    .migration_lock == {sha256: $digest, bytes: $bytes} and
    ([.packages[].name] == $formula_order) and
    (.packages | length == 24) and
    (.materialization.embedded_package_order == $embedded) and
    (.materialization.embedded_tree_count == 3) and
    (.materialization.deferred_tree_count == 21) and
    (.materialization | has("runtime_support") | not) and
    (.materialization.bottle_mirror.asset_count == 21) and
    ([.packages[] | select(.name == "bzip2") | .sha256] == [$bzip2_sha]) and
    ([.packages[] | select(.name == "dash") | .sha256] == [$dash_sha]) and
    (.package_deferred_trees | length == 1) and
    (.package_deferred_trees[0].activation | has("atomicGroup") | not) and
    (.default_shell.path == "/opt/kandelo/homebrew/bin/bash")
  ' "$report" >/dev/null

  "$REPO_ROOT/node_modules/.bin/tsx" \
    "$REPO_ROOT/scripts/create-homebrew-guest-lifecycle-fixture.ts" \
    --transport-mode closed \
    --image "$image" \
    --homebrew-bootstrap-spec "$BOOTSTRAP_SPEC" \
    --homebrew-bootstrap-archive "$bootstrap_dir/homebrew-bootstrap.zip" \
    --homebrew-bootstrap-env "$bootstrap_dir/homebrew-brew.env" \
    --bottle-mirror "$mirror" \
    --fixed-asset-url-root \
      https://closed.kandelo.invalid/homebrew-real-install-diagnostic/ \
    --core-revision "$CORE_REVISION" \
    --canary-revision "$CANARY_REVISION" \
    --timeout-ms 900000 \
    --out "$(prepared_path browser-fixture.json)"

  jq -n \
    --arg contract_sha256 "$CONTRACT_SHA" \
    --arg selection_tag "$SELECTION_TAG" \
    --arg bzip2_sha "$bzip2_sha" \
    --arg dash_sha "$dash_sha" \
    --argjson artifacts "$(
      jq -n \
        --arg selection_receipt_sha "$(sha256sum "$selection_receipt" | cut -d' ' -f1)" \
        --argjson selection_receipt_bytes "$(wc -c <"$selection_receipt")" \
        --arg selection_authorization_sha "$(sha256sum "$selection_authorization" | cut -d' ' -f1)" \
        --argjson selection_authorization_bytes "$(wc -c <"$selection_authorization")" \
        --arg selection_check_sha "$(sha256sum "$selection_check" | cut -d' ' -f1)" \
        --argjson selection_check_bytes "$(wc -c <"$selection_check")" \
        --arg image_sha "$(sha256sum "$image" | cut -d' ' -f1)" \
        --argjson image_bytes "$(wc -c <"$image")" \
        --arg report_sha "$(sha256sum "$report" | cut -d' ' -f1)" \
        --argjson report_bytes "$(wc -c <"$report")" \
        --arg fixture_sha "$(sha256sum "$(prepared_path browser-fixture.json)" | cut -d' ' -f1)" \
        --argjson fixture_bytes "$(wc -c <"$(prepared_path browser-fixture.json)")" \
        --arg bootstrap_archive_sha "$(sha256sum "$bootstrap_dir/homebrew-bootstrap.zip" | cut -d' ' -f1)" \
        --argjson bootstrap_archive_bytes "$(wc -c <"$bootstrap_dir/homebrew-bootstrap.zip")" \
        --arg bootstrap_environment_sha "$(sha256sum "$bootstrap_dir/homebrew-brew.env" | cut -d' ' -f1)" \
        --argjson bootstrap_environment_bytes "$(wc -c <"$bootstrap_dir/homebrew-brew.env")" \
        --arg mirror_plan_sha "$(sha256sum "$mirror/kandelo-homebrew-bottle-mirror-plan.json" | cut -d' ' -f1)" \
        --argjson mirror_plan_bytes "$(wc -c <"$mirror/kandelo-homebrew-bottle-mirror-plan.json")" '{
          selection_receipt: {
            file: "selection-receipt.json",
            sha256: $selection_receipt_sha,
            bytes: $selection_receipt_bytes
          },
          selection_authorization: {
            file: "selection-authorization.json",
            sha256: $selection_authorization_sha,
            bytes: $selection_authorization_bytes
          },
          selection_check: {
            file: "selection-check.json",
            sha256: $selection_check_sha,
            bytes: $selection_check_bytes
          },
          image: {
            file: "real-install-diagnostic.vfs.zst",
            sha256: $image_sha,
            bytes: $image_bytes
          },
          composition_report: {
            file: "composition-report.json",
            sha256: $report_sha,
            bytes: $report_bytes
          },
          browser_fixture: {
            file: "browser-fixture.json",
            sha256: $fixture_sha,
            bytes: $fixture_bytes
          },
          bootstrap_archive: {
            file: "homebrew-bootstrap.zip",
            sha256: $bootstrap_archive_sha,
            bytes: $bootstrap_archive_bytes
          },
          bootstrap_environment: {
            file: "homebrew-brew.env",
            sha256: $bootstrap_environment_sha,
            bytes: $bootstrap_environment_bytes
          },
          bottle_mirror_plan: {
            file: "kandelo-homebrew-bottle-mirror-plan.json",
            sha256: $mirror_plan_sha,
            bytes: $mirror_plan_bytes
          }
        }'
    )" '{
      schema: 1,
      kind: "kandelo-homebrew-real-install-diagnostic-prepared",
      product_lock_used: false,
      contract_sha256: $contract_sha256,
      selection: {tag: $selection_tag},
      bottles: {
        core_bzip2_sha256: $bzip2_sha,
        core_dash_sha256: $dash_sha
      },
      artifacts: $artifacts
    }' >"$(prepared_path prepared.json)"
  printf 'Prepared diagnostic: %s\n' "$(prepared_path prepared.json)"
}

prove_node() {
  assert_prepared
  local common
  common=(
    --image "$(prepared_path real-install-diagnostic.vfs.zst)"
    --homebrew-bootstrap-spec "$BOOTSTRAP_SPEC"
    --homebrew-bootstrap-archive \
      "$(prepared_path bootstrap/homebrew-bootstrap.zip)"
    --homebrew-bootstrap-env \
      "$(prepared_path bootstrap/homebrew-brew.env)"
    --transport-mode closed
    --bottle-mirror-plan \
      "$(prepared_path bottle-mirror/kandelo-homebrew-bottle-mirror-plan.json)"
    --image-contract real-install-diagnostic
    --core-bzip2-sha256 \
      "$(jq -er '.bottles.core_bzip2_sha256' "$(prepared_path prepared.json)")"
    --core-dash-sha256 \
      "$(jq -er '.bottles.core_dash_sha256' "$(prepared_path prepared.json)")"
    --core-revision "$CORE_REVISION"
    --canary-revision "$CANARY_REVISION"
    --timeout-ms 900000
  )
  "$REPO_ROOT/node_modules/.bin/tsx" \
    "$REPO_ROOT/homebrew/test/homebrew_guest_lifecycle_node.ts" \
    "${common[@]}" --proof-mode shipping-core
  "$REPO_ROOT/node_modules/.bin/tsx" \
    "$REPO_ROOT/homebrew/test/homebrew_guest_lifecycle_node.ts" \
    "${common[@]}" --proof-mode shipping-canary
}

prove_browser() {
  assert_prepared
  local browser_root
  browser_root="$REPO_ROOT/apps/browser-demos/public/homebrew-real-install-diagnostic"
  if [ -e "$browser_root" ] || [ -L "$browser_root" ]; then
    echo "run-homebrew-real-install-diagnostic: browser fixture root exists" >&2
    exit 2
  fi
  mkdir "$browser_root"
  cleanup_browser_root() {
    if [ "$browser_root" = \
      "$REPO_ROOT/apps/browser-demos/public/homebrew-real-install-diagnostic" ]; then
      rm -rf -- "$browser_root"
    fi
  }
  trap cleanup_browser_root EXIT
  install_asset() {
    local source="$1"
    local destination
    destination="$browser_root/$(basename "$source")"
    [ ! -e "$destination" ]
    cp "$source" "$destination"
    cmp "$source" "$destination"
  }
  install_asset "$(prepared_path real-install-diagnostic.vfs.zst)"
  install_asset "$BOOTSTRAP_SPEC"
  install_asset "$(prepared_path bootstrap/homebrew-bootstrap.zip)"
  install_asset "$(prepared_path bootstrap/homebrew-brew.env)"
  for asset in "$(prepared_path bottle-mirror)"/*; do
    install_asset "$asset"
  done
  (
    cd "$REPO_ROOT/apps/browser-demos"
    KANDELO_PLAYWRIGHT_VITE_MODE=homebrew-closed-acceptance \
    KANDELO_PLAYWRIGHT_CLOSED_ACCEPTANCE_ROOT=\
/homebrew-real-install-diagnostic \
    KANDELO_HOMEBREW_REAL_INSTALL_DIAGNOSTIC_FIXTURE_PATH=\
"$(prepared_path browser-fixture.json)" \
    KANDELO_HOMEBREW_REAL_INSTALL_DIAGNOSTIC_PREPARED_PATH=\
"$(prepared_path prepared.json)" \
    npx playwright test \
      test/homebrew-real-install-diagnostic.spec.ts \
      --project=chromium
  )
}

case "$COMMAND" in
  prepare) prepare ;;
  prove-node) prove_node ;;
  prove-browser) prove_browser ;;
  -h|--help|"") usage ;;
  *)
    echo "run-homebrew-real-install-diagnostic: unknown command: $COMMAND" >&2
    usage >&2
    exit 2
    ;;
esac
