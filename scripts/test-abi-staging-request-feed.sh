#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"

ruby scripts/check-abi-staging-request-workflow.rb
bash .github/scripts/test-publish-abi-staging-request.sh

host_target=$(rustc -vV | awk '/^host/ {print $2}')
cargo test -p xtask --target "$host_target" abi_staging::request_
cargo run -p xtask --target "$host_target" --quiet -- \
  abi-staging request-policy check \
  --source abi/staging/request-policy.toml \
  --generated abi/staging/request-policy.generated.json

activation=$(cargo run -p xtask --target "$host_target" --quiet -- \
  abi-staging request-policy activation-mode \
  --source abi/staging/request-feed-activation.toml)
[[ $activation == observe ]] || {
  echo "request feed activation must remain observe during local rollout" >&2
  exit 1
}

if [[ -n ${KANDELO_TAP_ROOT:-} ]]; then
  bash scripts/test-abi-staging-cross-repo-fixtures.sh
fi

echo "test-abi-staging-request-feed: PASS"
