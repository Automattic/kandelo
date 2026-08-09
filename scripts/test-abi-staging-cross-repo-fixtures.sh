#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"

[[ ${KANDELO_TAP_ROOT:-} == /* ]] || {
  echo "KANDELO_TAP_ROOT must be an absolute tap worktree path" >&2
  exit 2
}
[[ -d $KANDELO_TAP_ROOT && ! -L $KANDELO_TAP_ROOT ]] || {
  echo "KANDELO_TAP_ROOT must be a nonsymlink directory" >&2
  exit 2
}
tap_remote=$(git -C "$KANDELO_TAP_ROOT" remote get-url origin)
tap_remote_lower=$(printf '%s' "$tap_remote" | tr '[:upper:]' '[:lower:]')
[[ $tap_remote_lower == *kandelo-dev/homebrew-tap-core.git ]] || {
  echo "KANDELO_TAP_ROOT does not name the protected tap repository" >&2
  exit 2
}

TMP_ROOT=$(mktemp -d)
trap 'rm -r "$TMP_ROOT"' EXIT

FIRST_FEED_REPOSITORY="$TMP_ROOT/feed-repository-a"
SECOND_FEED_REPOSITORY="$TMP_ROOT/feed-repository-b"
git init -q "$FIRST_FEED_REPOSITORY"
git init -q "$SECOND_FEED_REPOSITORY"

host_target=$(rustc -vV | awk '/^host/ {print $2}')
cargo build -p xtask --target "$host_target" >/dev/null
XTASK="$REPO_ROOT/target/$host_target/debug/xtask"

"$XTASK" abi-staging request-policy check \
  --source abi/staging/request-policy.toml \
  --generated abi/staging/request-policy.generated.json

derive_request() {
  local destination=$1
  local head tree target_abi snapshot_sha check_sha policy_sha guard_sha guard_version
  mkdir -p "$destination"
  head=$(git rev-parse HEAD)
  tree=$(git rev-parse 'HEAD^{tree}')
  target_abi=$(sed -nE 's/^pub const ABI_VERSION: u32 = ([0-9]+);$/\1/p' \
    crates/shared/src/lib.rs)
  snapshot_sha=$(shasum -a 256 abi/snapshot.json | awk '{print $1}')
  check_sha=$(shasum -a 256 scripts/check-abi-version.sh | awk '{print $1}')
  policy_sha=$(shasum -a 256 abi/staging/request-policy.generated.json | awk '{print $1}')
  guard_sha=$(shasum -a 256 abi/staging/guard-codes.generated.json | awk '{print $1}')
  guard_version=$(jq -r '.version' abi/staging/guard-codes.generated.json)

  jq -cnS \
    --arg head "$head" \
    --arg tree "$tree" '
      {
        base_commit: null,
        base_tree: null,
        exact_head: $head,
        exact_head_repository: "Automattic/kandelo",
        exact_tree: $tree,
        number: 19,
        ref_hint: "refs/heads/cross-repository-fixture",
        repository: "Automattic/kandelo"
      }
    ' >"$destination/pull-request.json"
  jq -cnS \
    --arg head "$head" \
    --arg tree "$tree" \
    --arg snapshot "$snapshot_sha" \
    --arg check "$check_sha" \
    --argjson target "$target_abi" '
      {
        check_command_sha256: $check,
        kind: "kandelo-structural-abi-report",
        observed_previous_abi: $target,
        outcome: "compatible",
        schema: 1,
        snapshot_file_sha256: $snapshot,
        snapshot_sha256: $snapshot,
        source: {
          commit: $head,
          repository: "Automattic/kandelo",
          tree: $tree
        },
        target_abi: $target
      }
    ' >"$destination/structural-report.json"
  printf '["abi"]\n' >"$destination/change-classes.json"
  python3 - "$REPO_ROOT" "$head" "$tree" "$policy_sha" \
    "$guard_version" "$guard_sha" "$destination/protected-context.json" <<'PY'
import json
import pathlib
import sys
import tomllib

root, commit, tree, policy_sha, guard_version, guard_sha, output = sys.argv[1:]
policy = tomllib.loads((pathlib.Path(root) / "abi/staging/request-policy.toml").read_text())
context = {
    "guard_registry_sha256": guard_sha,
    "guard_registry_version": int(guard_version),
    "issuer_workflow_ref": (
        f"{policy['issuer_repository']}/{policy['issuer_workflow']}@{commit}"
    ),
    "policy": policy,
    "policy_sha256": policy_sha,
    "protected_commit": commit,
    "protected_repository": policy["issuer_repository"],
    "protected_tree": tree,
}
pathlib.Path(output).write_text(
    json.dumps(context, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n"
)
PY

  "$XTASK" abi-staging request derive \
    --exact-head-root "$REPO_ROOT" \
    --pull-request "$destination/pull-request.json" \
    --protected-context "$destination/protected-context.json" \
    --structural-report "$destination/structural-report.json" \
    --change-classes "$destination/change-classes.json" \
    --out "$destination/request.json"
}

derive_request "$TMP_ROOT/derive-a"
derive_request "$TMP_ROOT/derive-b"
cmp "$TMP_ROOT/derive-a/request.json" "$TMP_ROOT/derive-b/request.json"

append_asset() {
  local source=$1 destination=$2
  mkdir -p "$(dirname "$destination")"
  if [[ -e $destination ]]; then
    [[ -f $destination && ! -L $destination ]] || return 1
    cmp -s "$source" "$destination"
    return
  fi
  cp "$source" "$destination"
}

append_request() {
  local request=$1 feed=$2 head digest tag name destination
  head=$(jq -r '.build_source.commit' "$request")
  digest=$(shasum -a 256 "$request" | awk '{print $1}')
  tag=abi-staging-pr-$(jq -r '.pull_request.number' "$request")
  name="candidate-request-${head}-sha256-${digest}.json"
  destination="$feed/$tag/$name"
  append_asset "$request" "$destination"
}

FEED="$FIRST_FEED_REPOSITORY/releases"
append_request "$TMP_ROOT/derive-a/request.json" "$FEED"
append_request "$TMP_ROOT/derive-a/request.json" "$FEED"
for fixture in current-request same-head-reissued-request historical-request; do
  append_request \
    "$KANDELO_TAP_ROOT/Kandelo/staging/fixtures/request/$fixture.json" \
    "$FEED"
done

collision_request="$TMP_ROOT/collision.json"
printf 'different canonical bytes\n' >"$collision_request"
derived_name=$(find "$FEED/abi-staging-pr-19" -type f -name \
  "candidate-request-$(git rev-parse HEAD)-*.json" -print -quit)
[[ -n $derived_name && -f $derived_name ]] || {
  echo "fake append-only feed lost the derived request" >&2
  exit 1
}
if append_asset "$collision_request" "$derived_name"; then
  echo "fake append-only feed accepted different bytes at one identity" >&2
  exit 1
fi
cmp -s "$TMP_ROOT/derive-a/request.json" "$derived_name"

python3 - "$KANDELO_TAP_ROOT" "$FEED" "$TMP_ROOT/decision-a.json" <<'PY'
from __future__ import annotations

from collections import defaultdict
import copy
import hashlib
import json
import pathlib
import sys
from typing import Any

tap_root = pathlib.Path(sys.argv[1])
feed_root = pathlib.Path(sys.argv[2])
output = pathlib.Path(sys.argv[3])
sys.path.insert(0, str(tap_root))

from scripts.abi_staging.canonical import canonical_bytes
from scripts.abi_staging.github_public import GitHubPublicClient, PublicGitHubError
from scripts.abi_staging.reconcile import PullRequestLifecycleV1, reconcile_request
from scripts.abi_staging.request import (
    RequestValidationError,
    load_request_issuer_policy,
    validate_request,
)


class Response:
    def __init__(self, status: int, body: bytes = b"", headers: dict[str, str] | None = None):
        self.status = status
        self.body = body
        self.headers = {key.lower(): value for key, value in (headers or {}).items()}

    def read(self, amount: int = -1) -> bytes:
        return self.body if amount < 0 else self.body[:amount]

    def close(self) -> None:
        pass


class Opener:
    def __init__(self, routes: dict[str, list[Response]]):
        self.routes = routes

    def __call__(self, request: Any) -> Response:
        route = self.routes.get(request.full_url, [])
        if not route:
            raise AssertionError(f"unexpected fake public URL {request.full_url}")
        return route.pop(0)


policy_path = tap_root / "Kandelo/staging/request-issuers.toml"
policy = load_request_issuer_policy(
    policy_path, expected_tap="kandelo-dev/homebrew-tap-core"
)
tag = "abi-staging-pr-19"
files = sorted((feed_root / tag).glob("candidate-request-*.json"))
assert len(files) == 4


def client_for(order: list[pathlib.Path]) -> GitHubPublicClient:
    routes: dict[str, list[Response]] = defaultdict(list)
    releases = "https://api.github.com/repos/Automattic/kandelo/releases"
    release_body = json.dumps(
        [{"draft": False, "id": 19, "prerelease": True, "tag_name": tag}],
        separators=(",", ":"),
        sort_keys=True,
    ).encode()
    routes[f"{releases}?per_page=100&page=1"].append(
        Response(200, release_body, {"Content-Length": str(len(release_body))})
    )
    assets = []
    for asset_id, path in enumerate(order, start=100):
        public_url = f"https://github.com/Automattic/kandelo/releases/download/{tag}/{path.name}"
        assets.append({"browser_download_url": public_url, "id": asset_id, "name": path.name})
        body = path.read_bytes()
        final_url = f"https://release-assets.githubusercontent.com/fixture/{asset_id}"
        routes[public_url].append(Response(302, headers={"Location": final_url}))
        routes[final_url].append(
            Response(200, body, {"Content-Length": str(len(body))})
        )
    asset_body = json.dumps(assets, separators=(",", ":"), sort_keys=True).encode()
    asset_url = "https://api.github.com/repos/Automattic/kandelo/releases/19/assets?per_page=100&page=1"
    routes[asset_url].append(
        Response(200, asset_body, {"Content-Length": str(len(asset_body))})
    )
    return GitHubPublicClient(policy, opener=Opener(routes))


forward = client_for(files).scan()
reverse = client_for(list(reversed(files))).scan()
assert forward == reverse
by_head_and_policy = {
    (item.request["build_source"]["commit"], item.request["issuance"]["policy_version"]): item
    for item in forward
}
fixture_current = by_head_and_policy[("1" * 40, 1)]
fixture_reissued = by_head_and_policy[("1" * 40, 2)]
fixture_historical = by_head_and_policy[("0" * 40, 1)]


def action(item, lifecycle, previous=None):
    decision = reconcile_request(item, lifecycle, previous_lifecycle=previous)
    assert decision.permitted_work == ()
    return decision.action


cases = {
    "initial-head": action(
        fixture_current, PullRequestLifecycleV1("open", "1" * 40, None)
    ),
    "same-head-policy-reissue": action(
        fixture_reissued, PullRequestLifecycleV1("open", "1" * 40, None)
    ),
    "pr-advance": action(
        fixture_current, PullRequestLifecycleV1("open", "9" * 40, None)
    ),
    "old-head-completion": action(
        fixture_historical, PullRequestLifecycleV1("open", "1" * 40, None)
    ),
    "close": action(
        fixture_current, PullRequestLifecycleV1("closed", "1" * 40, None)
    ),
    "reopen-same": action(
        fixture_current,
        PullRequestLifecycleV1("open", "1" * 40, None),
        PullRequestLifecycleV1("closed", "1" * 40, None),
    ),
    "reopen-different": action(
        fixture_current,
        PullRequestLifecycleV1("open", "9" * 40, None),
        PullRequestLifecycleV1("closed", "1" * 40, None),
    ),
    "merge": action(
        fixture_current, PullRequestLifecycleV1("merged", "1" * 40, "8" * 40)
    ),
}
assert cases == {
    "initial-head": "observe-open",
    "same-head-policy-reissue": "observe-open",
    "pr-advance": "await-new-request",
    "old-head-completion": "await-new-request",
    "close": "stop-new-work",
    "reopen-same": "resume-same-head",
    "reopen-different": "await-new-request",
    "merge": "observe-merged",
}

# Authority-negative cases use exact public and typed validators; none may
# become a production fallback or a candidate-supplied coordinator path.
body = (tap_root / "Kandelo/staging/fixtures/request/current-request.json").read_bytes()
value = json.loads(body)
digest = hashlib.sha256(body).hexdigest()
name = f"candidate-request-{'1' * 40}-sha256-{digest}.json"

synthetic = copy.deepcopy(value)
synthetic["build_source"]["commit"] = "7" * 40
synthetic_body = canonical_bytes(synthetic)
synthetic_name = (
    f"candidate-request-{'7' * 40}-sha256-{hashlib.sha256(synthetic_body).hexdigest()}.json"
)
try:
    validate_request(synthetic_body, synthetic_name, policy)
except RequestValidationError:
    pass
else:
    raise AssertionError("synthetic source escaped exact authorization binding")

for invalid_url in [
    f"https://github.com/other/project/releases/download/{tag}/{name}",
    f"https://github.com/Automattic/kandelo/releases/download/abi-staging-pr-20/{name}",
    "https://github.com/Automattic/kandelo/releases/download/abi-staging-pr-19/latest.json",
    f"https://github.com/Automattic/kandelo/releases/download/{tag}/{name}.timestamp",
    "file:///tmp/candidate-supplied-reconciler.py",
]:
    try:
        GitHubPublicClient(
            policy,
            opener=lambda _: Response(
                200,
                body,
                {"Content-Length": str(len(body))},
            ),
        ).discover_url(invalid_url)
    except PublicGitHubError:
        pass
    else:
        raise AssertionError(f"invalid public authority URL was accepted: {invalid_url}")

try:
    validate_request(body, name.replace(digest, "f" * 64), policy)
except RequestValidationError:
    pass
else:
    raise AssertionError("filename/body mismatch was accepted")

try:
    load_request_issuer_policy(policy_path, expected_tap="other/tap")
except RequestValidationError:
    pass
else:
    raise AssertionError("unaddressed tap was accepted")

public_url = f"https://github.com/Automattic/kandelo/releases/download/{tag}/{name}"
escape = Opener({public_url: [Response(302, headers={"Location": "https://example.com/escape"})]})
try:
    GitHubPublicClient(policy, opener=escape).discover_url(public_url)
except PublicGitHubError:
    pass
else:
    raise AssertionError("redirect host escape was accepted")

output.write_bytes(canonical_bytes({
    "cases": cases,
    "discovered": [item.request_digest for item in forward],
    "mode": "observe",
}))
PY

# Re-run the same protected adapter from a fresh feed directory and compare
# canonical decision bytes. The copy changes no identity or ordering input.
SECOND_FEED="$SECOND_FEED_REPOSITORY/releases"
mkdir -p "$SECOND_FEED/abi-staging-pr-19"
cp "$FEED/abi-staging-pr-19"/*.json "$SECOND_FEED/abi-staging-pr-19/"
python3 - "$KANDELO_TAP_ROOT" "$SECOND_FEED" "$TMP_ROOT/decision-b.json" <<'PY'
from __future__ import annotations

import hashlib
import json
import pathlib
import sys

tap_root = pathlib.Path(sys.argv[1])
feed_root = pathlib.Path(sys.argv[2])
output = pathlib.Path(sys.argv[3])
sys.path.insert(0, str(tap_root))

from scripts.abi_staging.canonical import canonical_bytes
from scripts.abi_staging.github_public import DiscoveredRequestV1
from scripts.abi_staging.reconcile import PullRequestLifecycleV1, reconcile_request
from scripts.abi_staging.request import load_request_issuer_policy, validate_request

policy = load_request_issuer_policy(
    tap_root / "Kandelo/staging/request-issuers.toml",
    expected_tap="kandelo-dev/homebrew-tap-core",
)
discovered = []
for path in sorted((feed_root / "abi-staging-pr-19").glob("candidate-request-*.json")):
    body = path.read_bytes()
    request = validate_request(body, path.name, policy)
    digest = hashlib.sha256(body).hexdigest()
    discovered.append(DiscoveredRequestV1(
        digest,
        path.name,
        f"https://github.com/Automattic/kandelo/releases/download/abi-staging-pr-19/{path.name}",
        "abi-staging-pr-19",
        request,
    ))
by_head_and_policy = {
    (item.request["build_source"]["commit"], item.request["issuance"]["policy_version"]): item
    for item in discovered
}
current = by_head_and_policy[("1" * 40, 1)]
reissued = by_head_and_policy[("1" * 40, 2)]
historical = by_head_and_policy[("0" * 40, 1)]

def action(item, lifecycle, previous=None):
    return reconcile_request(item, lifecycle, previous_lifecycle=previous).action

cases = {
    "initial-head": action(current, PullRequestLifecycleV1("open", "1" * 40, None)),
    "same-head-policy-reissue": action(reissued, PullRequestLifecycleV1("open", "1" * 40, None)),
    "pr-advance": action(current, PullRequestLifecycleV1("open", "9" * 40, None)),
    "old-head-completion": action(historical, PullRequestLifecycleV1("open", "1" * 40, None)),
    "close": action(current, PullRequestLifecycleV1("closed", "1" * 40, None)),
    "reopen-same": action(
        current,
        PullRequestLifecycleV1("open", "1" * 40, None),
        PullRequestLifecycleV1("closed", "1" * 40, None),
    ),
    "reopen-different": action(
        current,
        PullRequestLifecycleV1("open", "9" * 40, None),
        PullRequestLifecycleV1("closed", "1" * 40, None),
    ),
    "merge": action(current, PullRequestLifecycleV1("merged", "1" * 40, "8" * 40)),
}
output.write_bytes(canonical_bytes({
    "cases": cases,
    "discovered": sorted(item.request_digest for item in discovered),
    "mode": "observe",
}))
PY
cmp "$TMP_ROOT/decision-a.json" "$TMP_ROOT/decision-b.json"

python3 - "$KANDELO_TAP_ROOT" "$TMP_ROOT/current-selection.json" <<'PY'
import hashlib
import json
import pathlib
import sys

tap = pathlib.Path(sys.argv[1])
output = pathlib.Path(sys.argv[2])
assets = []
for fixture in ["current-request.json", "same-head-reissued-request.json"]:
    body = (tap / "Kandelo/staging/fixtures/request" / fixture).read_bytes()
    request = json.loads(body)
    digest = hashlib.sha256(body).hexdigest()
    head = request["build_source"]["commit"]
    name = f"candidate-request-{head}-sha256-{digest}.json"
    assets.append({
        "browser_download_url": (
            f"https://github.com/Automattic/kandelo/releases/download/abi-staging-pr-19/{name}"
        ),
        "canonical_bytes": list(body),
        "name": name,
    })
reissued = json.loads(
    (tap / "Kandelo/staging/fixtures/request/same-head-reissued-request.json").read_bytes()
)
selection = {
    "assets": assets,
    "exact_head": reissued["build_source"]["commit"],
    "guard_registry_sha256": reissued["issuance"]["guard_registry_sha256"],
    "guard_registry_version": reissued["issuance"]["guard_registry_version"],
    "policy_sha256": reissued["issuance"]["policy_sha256"],
    "policy_version": reissued["issuance"]["policy_version"],
    "requirements_sha256": reissued["requirements"]["digest"],
}
output.write_text(json.dumps(selection, separators=(",", ":"), sort_keys=True) + "\n")
PY
"$XTASK" abi-staging request select-current \
  --input "$TMP_ROOT/current-selection.json" \
  --out "$TMP_ROOT/current-selection-result.json"
jq -e '
  .state == "selected" and
  .request.issuance.policy_version == 2 and
  .request.issuance.policy_sha256 == ("9" * 64)
' "$TMP_ROOT/current-selection-result.json" >/dev/null

if (
  cd "$KANDELO_TAP_ROOT"
  python3 -m scripts.abi_staging.cli reconcile \
    --request-asset-url file:///tmp/request.json \
    --reconciler /tmp/candidate.py
) >/dev/null 2>&1; then
  echo "tap CLI accepted a candidate-supplied reconciler path" >&2
  exit 1
fi

echo "test-abi-staging-cross-repo-fixtures: PASS"
