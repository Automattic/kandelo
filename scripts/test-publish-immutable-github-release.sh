#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() {
  echo "test-publish-immutable-github-release.sh: $*" >&2
  exit 1
}

expect_failure_containing() {
  local label="$1" expected="$2"
  shift 2
  if "$@" >"$TMP_ROOT/failure.out" 2>"$TMP_ROOT/failure.err"; then
    fail "$label"
  fi
  grep -F -- "$expected" "$TMP_ROOT/failure.err" >/dev/null ||
    fail "$label failed for the wrong reason: $(cat "$TMP_ROOT/failure.err")"
}

asset_root="$TMP_ROOT/assets"
manifest="$TMP_ROOT/manifest.json"
mkdir "$asset_root"
PYTHONDONTWRITEBYTECODE=1 python3 - "$asset_root" "$manifest" <<'PY'
import hashlib
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
manifest_path = pathlib.Path(sys.argv[2])
names = ["kandelo-homebrew-bottle-mirror-plan.json"] + [
    f"package-{index:02d}.bottle.tar.gz" for index in range(1, 36)
]
assets = []
for index, name in enumerate(names):
    value = f"exact fixture asset {index}: {name}\n".encode()
    (root / name).write_bytes(value)
    assets.append({
        "name": name,
        "sha256": hashlib.sha256(value).hexdigest(),
        "bytes": len(value),
    })
manifest_path.write_text(json.dumps({
    "schema": 1,
    "repository": "kandelo-dev/homebrew-tap-core",
    "tag": "homebrew-shell-bottles-sha256-" + "1" * 64,
    "target_commitish": "a" * 40,
    "title": "Bottle mirror for the Kandelo shell",
    "body": "Thirty-five exact bottles and their canonical mirror manifest.",
    "assets": assets,
    "preferred_asset_names": names,
    "accepted_existing_asset_sets": [],
}, sort_keys=True, indent=2) + "\n")
PY

validator="$REPO_ROOT/scripts/validate-immutable-github-release-manifest.py"
bad_manifest="$TMP_ROOT/bad-basename.json"
jq '.assets[0].name = "../escape"' "$manifest" >"$bad_manifest"
expect_failure_containing \
  "validator accepted an unsafe asset basename" \
  "safe ASCII basename" \
  env -u GH_TOKEN -u GITHUB_TOKEN python3 "$validator" \
    --manifest "$bad_manifest" --asset-root "$asset_root" \
    --stage-dir "$TMP_ROOT/bad-basename-stage" \
    --out-manifest "$TMP_ROOT/bad-basename-normalized.json"

duplicate_manifest="$TMP_ROOT/duplicate-declaration.json"
jq '.assets += [.assets[0]]' "$manifest" >"$duplicate_manifest"
expect_failure_containing \
  "validator accepted duplicate asset declarations" \
  "duplicate name" \
  env -u GH_TOKEN -u GITHUB_TOKEN python3 "$validator" \
    --manifest "$duplicate_manifest" --asset-root "$asset_root" \
    --stage-dir "$TMP_ROOT/duplicate-stage" \
    --out-manifest "$TMP_ROOT/duplicate-normalized.json"

duplicate_key_manifest="$TMP_ROOT/duplicate-key.json"
PYTHONDONTWRITEBYTECODE=1 python3 - "$manifest" "$duplicate_key_manifest" <<'PY'
import pathlib
import sys

source, destination = map(pathlib.Path, sys.argv[1:])
value = source.read_text()
destination.write_text(value.replace('  "schema": 1,', '  "schema": 1,\n  "schema": 1,', 1))
PY
expect_failure_containing \
  "validator accepted a duplicate JSON object key" \
  "duplicate JSON object key 'schema'" \
  env -u GH_TOKEN -u GITHUB_TOKEN python3 "$validator" \
    --manifest "$duplicate_key_manifest" --asset-root "$asset_root" \
    --stage-dir "$TMP_ROOT/duplicate-key-stage" \
    --out-manifest "$TMP_ROOT/duplicate-key-normalized.json"

oversized_manifest="$TMP_ROOT/oversized-manifest.json"
PYTHONDONTWRITEBYTECODE=1 python3 - "$oversized_manifest" <<'PY'
import pathlib
import sys

pathlib.Path(sys.argv[1]).write_bytes(b" " * (4 * 1024 * 1024 + 1))
PY
expect_failure_containing \
  "validator accepted an oversized manifest" \
  "release manifest must be 1 to 4194304 bytes" \
  env -u GH_TOKEN -u GITHUB_TOKEN python3 "$validator" \
    --manifest "$oversized_manifest" --asset-root "$asset_root" \
    --stage-dir "$TMP_ROOT/oversized-stage" \
    --out-manifest "$TMP_ROOT/oversized-normalized.json"

trailing_body_manifest="$TMP_ROOT/trailing-body.json"
jq '.body += "\n"' "$manifest" >"$trailing_body_manifest"
expect_failure_containing \
  "validator accepted presentation text changed by command substitution" \
  "body must not end with a newline" \
  env -u GH_TOKEN -u GITHUB_TOKEN python3 "$validator" \
    --manifest "$trailing_body_manifest" --asset-root "$asset_root" \
    --stage-dir "$TMP_ROOT/trailing-body-stage" \
    --out-manifest "$TMP_ROOT/trailing-body-normalized.json"

too_many_historical_sets="$TMP_ROOT/too-many-historical-sets.json"
jq '. as $manifest |
    .accepted_existing_asset_sets = [range(0; 17) | [$manifest.preferred_asset_names[0]]]' \
  "$manifest" >"$too_many_historical_sets"
expect_failure_containing \
  "validator accepted too many historical asset sets" \
  "at most 16 entries" \
  env -u GH_TOKEN -u GITHUB_TOKEN python3 "$validator" \
    --manifest "$too_many_historical_sets" --asset-root "$asset_root" \
    --stage-dir "$TMP_ROOT/historical-set-stage" \
    --out-manifest "$TMP_ROOT/historical-set-normalized.json"

bad_digest_manifest="$TMP_ROOT/bad-digest.json"
jq '.assets[0].sha256 = ("0" * 64)' "$manifest" >"$bad_digest_manifest"
expect_failure_containing \
  "validator accepted source bytes with a different digest" \
  "bytes differ from its manifest" \
  env -u GH_TOKEN -u GITHUB_TOKEN python3 "$validator" \
    --manifest "$bad_digest_manifest" --asset-root "$asset_root" \
    --stage-dir "$TMP_ROOT/bad-digest-stage" \
    --out-manifest "$TMP_ROOT/bad-digest-normalized.json"

expect_failure_containing \
  "validator accepted a credential in its inert-input process" \
  "must run without GitHub credentials" \
  env GH_TOKEN=must-not-be-visible GITHUB_TOKEN= python3 "$validator" \
    --manifest "$manifest" --asset-root "$asset_root" \
    --stage-dir "$TMP_ROOT/token-stage" \
    --out-manifest "$TMP_ROOT/token-normalized.json"

fake_bin="$TMP_ROOT/fake-bin"
mkdir "$fake_bin"
cat >"$fake_bin/gh" <<'PY'
#!/usr/bin/env python3
import hashlib
import json
import os
import pathlib
import shutil
import sys

root = pathlib.Path(os.environ["FAKE_GITHUB_STATE"])
state_path = root / "state.json"
log_path = root / "gh.log"
with log_path.open("a") as log:
    log.write(json.dumps(sys.argv[1:]) + "\n")


def load():
    if not state_path.exists():
        return {"releases": [], "tags": {}, "next_release_id": 70, "next_asset_id": 100}
    state = json.loads(state_path.read_text())
    state.setdefault("tags", {})
    return state


def save(state):
    state_path.write_text(json.dumps(state, sort_keys=True))


def by_id(state, release_id):
    return next((item for item in state["releases"] if item["id"] == release_id), None)


def by_tag(state, tag):
    return [item for item in state["releases"] if item["tag"] == tag]


def asset_json(item):
    return {
        "id": item["id"],
        "name": item["name"],
        "state": item.get("state", "uploaded"),
        "size": item["size"],
        "digest": item["digest"],
    }


def release_json(item):
    return {
        "id": item["id"],
        "tag_name": item["tag"],
        "target_commitish": item["target"],
        "name": item["title"],
        "body": item["body"],
        "draft": item["draft"],
        "prerelease": False,
        "immutable": (
            not item["draft"] and
            not os.environ.get("FAKE_IMMUTABLE_RELEASES_DISABLED")
        ),
        # Deliberately truncate the embedded inventory. The publisher must use
        # the separately paginated release-assets endpoint for all 36 assets.
        "assets": [asset_json(value) for value in item["assets"][:3]],
    }


def fields(args):
    result = {}
    for index, value in enumerate(args):
        if value in ("-f", "-F"):
            key, field_value = args[index + 1].split("=", 1)
            result[key] = field_value
    return result


args = sys.argv[1:]
if args[:2] == ["api", "--include"]:
    endpoint = args[2]
    state = load()
    if "/releases/tags/" in endpoint:
        tag = endpoint.split("/releases/tags/", 1)[1]
        matches = [item for item in by_tag(state, tag) if not item["draft"]]
        if len(matches) != 1:
            print("HTTP/1.1 404 Not Found\n")
            sys.exit(1)
        value = release_json(matches[0])
    elif "/releases/" in endpoint:
        item = by_id(state, int(endpoint.rsplit("/", 1)[1]))
        if item is None:
            print("HTTP/1.1 404 Not Found\n")
            sys.exit(1)
        value = release_json(item)
    elif "/git/ref/tags/" in endpoint:
        tag = endpoint.split("/git/ref/tags/", 1)[1]
        tag_value = state["tags"].get(tag)
        if tag_value is None:
            matches = [item for item in by_tag(state, tag) if not item["draft"]]
            if len(matches) != 1:
                print("HTTP/1.1 404 Not Found\n")
                sys.exit(1)
            item = matches[0]
            tag_value = {
                "type": item.get("tag_type", "commit"),
                "sha": item.get("tag_sha", item["target"]),
            }
        value = {
            "ref": "refs/tags/" + tag,
            "object": tag_value,
        }
    else:
        print("HTTP/1.1 404 Not Found\n")
        sys.exit(1)
    print("HTTP/1.1 200 OK\n")
    print(json.dumps(value))
elif args[:3] == ["api", "--paginate", "--slurp"]:
    endpoint = args[3]
    state = load()
    if endpoint.endswith("/releases?per_page=100"):
        releases = [release_json(item) for item in state["releases"]]
        # Put releases on a later page so discovery cannot accidentally rely
        # on the first response page.
        print(json.dumps([[], releases]))
    elif "/assets?per_page=100" in endpoint:
        release_id = int(endpoint.split("/releases/", 1)[1].split("/", 1)[0])
        release = by_id(state, release_id)
        if release is None:
            sys.exit(1)
        values = [asset_json(item) for item in release["assets"]]
        print(json.dumps([values[:20], values[20:]]))
    else:
        print("unsupported paginated endpoint", file=sys.stderr)
        sys.exit(2)
elif args[:3] == ["api", "--method", "POST"]:
    state = load()
    values = fields(args)
    if args[3].endswith("/git/refs"):
        prefix = "refs/tags/"
        if not values["ref"].startswith(prefix):
            sys.exit(2)
        tag = values["ref"][len(prefix):]
        if tag in state["tags"]:
            print("duplicate tag", file=sys.stderr)
            sys.exit(1)
        state["tags"][tag] = {"type": "commit", "sha": values["sha"]}
        save(state)
        marker = root / "lost-tag-response"
        if os.environ.get("FAKE_TAG_RESPONSE_LOST") and not marker.exists():
            marker.write_text("lost\n")
            sys.exit(1)
        print(json.dumps({"ref": values["ref"], "object": state["tags"][tag]}))
    else:
        if by_tag(state, values["tag_name"]):
            print("duplicate release", file=sys.stderr)
            sys.exit(1)
        release = {
            "id": state["next_release_id"],
            "tag": values["tag_name"],
            "target": values["target_commitish"],
            "title": values["name"],
            "body": values["body"],
            "draft": True,
            "assets": [],
        }
        state["next_release_id"] += 1
        state["releases"].append(release)
        save(state)
        marker = root / "lost-create-response"
        if os.environ.get("FAKE_CREATE_RESPONSE_LOST") and not marker.exists():
            marker.write_text("lost\n")
            sys.exit(1)
        print(json.dumps(release_json(release)))
elif args[:3] == ["api", "--method", "PATCH"]:
    state = load()
    release = by_id(state, int(args[3].rsplit("/", 1)[1]))
    if release is None:
        sys.exit(1)
    if not release["draft"]:
        print("release is immutable", file=sys.stderr)
        sys.exit(1)
    if state["tags"].get(release["tag"]) != {
        "type": "commit", "sha": release["target"]
    }:
        print("release tag is not exact", file=sys.stderr)
        sys.exit(1)
    release["draft"] = False
    save(state)
    marker = root / "lost-publish-response"
    if os.environ.get("FAKE_PUBLISH_RESPONSE_LOST") and not marker.exists():
        marker.write_text("lost\n")
        sys.exit(1)
    print(json.dumps(release_json(release)))
elif args[:2] == ["api", "-H"]:
    endpoint = args[3]
    asset_id = int(endpoint.rsplit("/", 1)[1])
    state = load()
    for release in state["releases"]:
        for item in release["assets"]:
            if item["id"] == asset_id:
                sys.stdout.buffer.write((root / item["file"]).read_bytes())
                sys.exit(0)
    sys.exit(1)
elif args[:2] == ["release", "upload"]:
    state = load()
    source = pathlib.Path(args[-1])
    tag = args[2]
    matches = by_tag(state, tag)
    if len(matches) != 1 or not matches[0]["draft"]:
        sys.exit(1)
    release = matches[0]
    if any(item["name"] == source.name for item in release["assets"]):
        print("duplicate asset", file=sys.stderr)
        sys.exit(1)
    value = source.read_bytes()
    destination = f"asset-{state['next_asset_id']}"
    (root / destination).write_bytes(value)
    release["assets"].append({
        "id": state["next_asset_id"],
        "name": source.name,
        "file": destination,
        "size": len(value),
        "digest": "sha256:" + hashlib.sha256(value).hexdigest(),
        "state": "uploaded",
    })
    state["next_asset_id"] += 1
    save(state)
    marker = root / ("lost-upload-response-" + source.name)
    if os.environ.get("FAKE_UPLOAD_RESPONSE_LOST") == source.name and not marker.exists():
        marker.write_text("lost\n")
        sys.exit(1)
else:
    print("unsupported fake gh: " + repr(args), file=sys.stderr)
    sys.exit(2)
PY
chmod +x "$fake_bin/gh"

cat >"$fake_bin/curl" <<'PY'
#!/usr/bin/env python3
import json
import os
import pathlib
import sys
import urllib.parse

if os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN"):
    print("credential reached anonymous curl", file=sys.stderr)
    sys.exit(2)
args = sys.argv[1:]
output = pathlib.Path(args[args.index("--output") + 1])
tag_and_name = args[-1].split("/releases/download/", 1)[1]
tag, encoded_name = tag_and_name.split("/", 1)
name = urllib.parse.unquote(encoded_name)
if os.environ.get("FAKE_ANONYMOUS_FAIL") == name:
    print("intentional anonymous failure", file=sys.stderr)
    sys.exit(1)
root = pathlib.Path(os.environ["FAKE_GITHUB_STATE"])
state = json.loads((root / "state.json").read_text())
release = next(item for item in state["releases"] if item["tag"] == tag)
asset = next(item for item in release["assets"] if item["name"] == name)
output.write_bytes((root / asset["file"]).read_bytes())
PY
chmod +x "$fake_bin/curl"

cat >"$fake_bin/state-lock" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[ "$PWD" = "${FAKE_EXPECTED_LOCK_ROOT:?}" ] || {
  echo "state lock ran outside the exact checkout" >&2
  exit 2
}
printf '%s\n' "$*" >>"$FAKE_GITHUB_STATE/lock.log"
case "$1" in acquire|release) exit 0 ;; *) exit 2 ;; esac
EOF
chmod +x "$fake_bin/state-lock"

lock_root="$TMP_ROOT/lock-root"
mkdir "$lock_root"

ACTIVE_STATE=""
ACTIVE_RECEIPT=""
ACTIVE_MANIFEST=""
new_state() {
  ACTIVE_STATE="$TMP_ROOT/state-$1"
  ACTIVE_RECEIPT="$TMP_ROOT/receipt-$1.json"
  ACTIVE_MANIFEST="$manifest"
  mkdir "$ACTIVE_STATE"
  : >"$ACTIVE_STATE/gh.log"
  : >"$ACTIVE_STATE/lock.log"
}

run_publisher() {
  PATH="$fake_bin:$PATH" \
  FAKE_GITHUB_STATE="$ACTIVE_STATE" \
  FAKE_EXPECTED_LOCK_ROOT="$lock_root" \
  STATE_LOCK_SCRIPT="$fake_bin/state-lock" \
  IMMUTABLE_RELEASE_RETRY_DELAY_SECONDS=0 \
  GITHUB_API_RETRY_DELAY_SECONDS=0 \
  GITHUB_REPOSITORY=Kandelo-dev/homebrew-tap-core \
  GH_TOKEN=fake-token \
    bash "$REPO_ROOT/scripts/publish-immutable-github-release.sh" \
      --manifest "$ACTIVE_MANIFEST" \
      --asset-root "$asset_root" \
      --lock-root "$lock_root" \
      --receipt "$ACTIVE_RECEIPT"
}

first_asset="$(jq -r '.preferred_asset_names | sort | .[0]' "$manifest")"
tag="$(jq -r '.tag' "$manifest")"
target="$(jq -r '.target_commitish' "$manifest")"

# One run loses the create, one upload, and publish responses after GitHub has
# committed each operation. Reconciliation must observe state instead of
# replaying a conflicting mutation.
new_state ambiguous
FAKE_CREATE_RESPONSE_LOST=1 \
FAKE_UPLOAD_RESPONSE_LOST="$first_asset" \
FAKE_TAG_RESPONSE_LOST=1 \
FAKE_PUBLISH_RESPONSE_LOST=1 \
  run_publisher >/dev/null
jq -e --arg tag "$tag" --arg target "$target" '
  .schema == 1 and .status == "success" and
  .visibility == "public-anonymous-readback" and .immutable == true and
  .tag == $tag and .target_commitish == $target and
  (.assets | length) == 36 and
  all(.assets[];
    (.asset_id | type == "number") and
    (.sha256 | test("^[0-9a-f]{64}$")) and .bytes > 0 and
    (.url | contains("/releases/download/" + $tag + "/")))
' "$ACTIVE_RECEIPT" >/dev/null || fail "36-asset receipt is incomplete"
jq -e '
  (.releases | length) == 1 and .releases[0].draft == false and
  (.releases[0].assets | length) == 36
' "$ACTIVE_STATE/state.json" >/dev/null || fail "ambiguous run did not publish one exact release"
[ "$(grep -c '^acquire ' "$ACTIVE_STATE/lock.log")" -eq 1 ] ||
  fail "publisher did not acquire exactly one state lock"
[ "$(grep -c '^release$' "$ACTIVE_STATE/lock.log")" -eq 1 ] ||
  fail "publisher did not release exactly one state lock"

: >"$ACTIVE_STATE/gh.log"
run_publisher >/dev/null
if jq -s -e 'any(.[];
    .[0:3] == ["api", "--method", "POST"] or
    .[0:3] == ["api", "--method", "PATCH"] or
    .[0:2] == ["release", "upload"])
  ' "$ACTIVE_STATE/gh.log" >/dev/null
then
  fail "idempotent retry mutated an immutable public release"
fi

seed_release() {
  local mode="$1" count="$2"
  PYTHONDONTWRITEBYTECODE=1 python3 - \
    "$ACTIVE_STATE" "$asset_root" "$ACTIVE_MANIFEST" "$mode" "$count" <<'PY'
import hashlib
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
assets_root = pathlib.Path(sys.argv[2])
manifest = json.loads(pathlib.Path(sys.argv[3]).read_text())
mode = sys.argv[4]
count = int(sys.argv[5])
release_assets = []
for index, declaration in enumerate(sorted(manifest["assets"], key=lambda item: item["name"])[:count]):
    name = declaration["name"]
    value = (assets_root / name).read_bytes()
    filename = f"seed-{index}"
    (root / filename).write_bytes(value)
    release_assets.append({
        "id": 100 + index,
        "name": name,
        "file": filename,
        "size": len(value),
        "digest": "sha256:" + hashlib.sha256(value).hexdigest(),
        "state": "uploaded",
    })
if mode == "unexpected":
    value = b"unexpected\n"
    (root / "unexpected").write_bytes(value)
    release_assets.append({
        "id": 900,
        "name": "unexpected.bin",
        "file": "unexpected",
        "size": len(value),
        "digest": "sha256:" + hashlib.sha256(value).hexdigest(),
        "state": "uploaded",
    })
elif mode == "duplicate":
    duplicate = dict(release_assets[0])
    duplicate["id"] = 901
    release_assets.append(duplicate)
elif mode == "bad-digest":
    release_assets[0]["digest"] = "sha256:" + "0" * 64
state = {
    "releases": [{
        "id": 70,
        "tag": manifest["tag"],
        "target": manifest["target_commitish"],
        "title": manifest["title"],
        "body": manifest["body"],
        "draft": True,
        "assets": release_assets,
    }],
    "tags": {},
    "next_release_id": 71,
    "next_asset_id": 1000,
}
(root / "state.json").write_text(json.dumps(state, sort_keys=True))
PY
}

# Exact accepted sets are considered before partial preferred drafts. This
# matters for an immutable historical release whose complete accepted set is a
# strict subset of today's preferred set.
subset_manifest="$TMP_ROOT/subset-manifest.json"
jq '.accepted_existing_asset_sets = [(.preferred_asset_names | sort | .[:2])]' \
  "$manifest" >"$subset_manifest"
new_state accepted-subset
ACTIVE_MANIFEST="$subset_manifest"
seed_release exact 2
jq '.releases[0].draft = false' "$ACTIVE_STATE/state.json" \
  >"$ACTIVE_STATE/state.tmp"
mv "$ACTIVE_STATE/state.tmp" "$ACTIVE_STATE/state.json"
run_publisher >/dev/null
jq -e '.status == "success" and (.assets | length) == 2' \
  "$ACTIVE_RECEIPT" >/dev/null ||
  fail "complete accepted subset was not reconciled as its own immutable set"
if jq -s -e 'any(.[];
    .[0:3] == ["api", "--method", "POST"] or
    .[0:3] == ["api", "--method", "PATCH"] or
    .[0:2] == ["release", "upload"])
  ' "$ACTIVE_STATE/gh.log" >/dev/null
then
  fail "complete accepted subset was mutated as a partial preferred draft"
fi

# A partial draft found only through the paginated release list is resumed in
# place. Only its 26 missing assets are uploaded.
new_state partial
seed_release exact 10
run_publisher >/dev/null
[ "$(jq -s '[.[] | select(.[0:2] == ["release", "upload"])] | length' \
  "$ACTIVE_STATE/gh.log")" -eq 26 ] || fail "partial draft did not upload exactly 26 missing assets"
if jq -s -e 'any(.[];
    .[0:3] == ["api", "--method", "POST"] and (.[3] | endswith("/releases")))' \
  "$ACTIVE_STATE/gh.log" >/dev/null
then
  fail "partial draft recovery created a replacement release"
fi
jq -e '.releases[0].draft == false and (.releases[0].assets | length) == 36' \
  "$ACTIVE_STATE/state.json" >/dev/null || fail "partial draft was not completed"

# GitHub ignores target_commitish when a release tag already exists. A wrong
# tag must therefore stop a complete draft before its immutable transition.
tag_test_manifest="$TMP_ROOT/tag-test-manifest.json"
jq '.assets = [.assets[0]] |
    .preferred_asset_names = [.assets[0].name] |
    .accepted_existing_asset_sets = []' "$manifest" >"$tag_test_manifest"
new_state wrong-tag
ACTIVE_MANIFEST="$tag_test_manifest"
seed_release exact 1
jq --arg tag "$tag" '.tags[$tag] = {
    type: "commit", sha: "9999999999999999999999999999999999999999"
  }' "$ACTIVE_STATE/state.json" >"$ACTIVE_STATE/state.tmp"
mv "$ACTIVE_STATE/state.tmp" "$ACTIVE_STATE/state.json"
expect_failure_containing \
  "publisher accepted a pre-existing wrong tag" \
  "release tag is not a direct reference to the planned commit" \
  run_publisher
jq -e '.releases[0].draft == true' "$ACTIVE_STATE/state.json" >/dev/null ||
  fail "wrong pre-existing tag was detected only after publication"
if jq -s -e 'any(.[]; .[0:3] == ["api", "--method", "PATCH"])' \
  "$ACTIVE_STATE/gh.log" >/dev/null
then
  fail "publisher attempted to publish a draft under a wrong pre-existing tag"
fi

new_state annotated-tag
ACTIVE_MANIFEST="$tag_test_manifest"
seed_release exact 1
jq --arg tag "$tag" --arg target "$target" '.tags[$tag] = {
    type: "tag", sha: $target
  }' "$ACTIVE_STATE/state.json" >"$ACTIVE_STATE/state.tmp"
mv "$ACTIVE_STATE/state.tmp" "$ACTIVE_STATE/state.json"
expect_failure_containing \
  "publisher accepted a pre-existing annotated tag" \
  "release tag is not a direct reference to the planned commit" \
  run_publisher
jq -e '.releases[0].draft == true' "$ACTIVE_STATE/state.json" >/dev/null ||
  fail "annotated tag was detected only after publication"
if jq -s -e 'any(.[]; .[0:3] == ["api", "--method", "PATCH"])' \
  "$ACTIVE_STATE/gh.log" >/dev/null
then
  fail "publisher attempted to publish a draft under an annotated tag"
fi

new_state unexpected
seed_release unexpected 1
printf 'older successful receipt\n' >"$ACTIVE_RECEIPT"
cp "$ACTIVE_RECEIPT" "$TMP_ROOT/older-receipt"
expect_failure_containing \
  "publisher accepted an unexpected draft asset" \
  "unexpected or partial legacy asset set" \
  run_publisher
cmp "$TMP_ROOT/older-receipt" "$ACTIVE_RECEIPT" >/dev/null ||
  fail "failed publication replaced an existing successful receipt"

new_state duplicate
seed_release duplicate 1
expect_failure_containing \
  "publisher accepted duplicate release asset names" \
  "malformed, duplicate, or too many assets" \
  run_publisher
[ ! -e "$ACTIVE_RECEIPT" ] || fail "duplicate asset failure emitted a receipt"

new_state bad-digest
seed_release bad-digest 1
expect_failure_containing \
  "publisher accepted a release asset digest mismatch" \
  "metadata differs from its exact digest or size" \
  run_publisher
if jq -s -e 'any(.[]; .[0:2] == ["release", "upload"])' \
  "$ACTIVE_STATE/gh.log" >/dev/null
then
  fail "digest mismatch was overwritten instead of failing closed"
fi

new_state identity
seed_release exact 1
jq '.releases[0].title = "Different presentation identity"' \
  "$ACTIVE_STATE/state.json" >"$ACTIVE_STATE/state.tmp"
mv "$ACTIVE_STATE/state.tmp" "$ACTIVE_STATE/state.json"
expect_failure_containing \
  "publisher accepted a different existing title" \
  "identity is malformed or mismatched" \
  run_publisher

# Anonymous failure happens only after the complete draft has become an
# immutable public release. It emits no receipt; an unchanged retry can finish
# readback without attempting any release mutation.
new_state anonymous
FAKE_ANONYMOUS_FAIL="$first_asset" expect_failure_containing \
  "publisher accepted a failed anonymous readback" \
  "anonymous readback failed" \
  run_publisher
[ ! -e "$ACTIVE_RECEIPT" ] || fail "anonymous failure emitted a receipt"
jq -e '.releases[0].draft == false and (.releases[0].assets | length) == 36' \
  "$ACTIVE_STATE/state.json" >/dev/null || fail "anonymous failure corrupted the immutable release"
: >"$ACTIVE_STATE/gh.log"
run_publisher >/dev/null
if jq -s -e 'any(.[];
    .[0:3] == ["api", "--method", "POST"] or
    .[0:3] == ["api", "--method", "PATCH"] or
    .[0:2] == ["release", "upload"])
  ' "$ACTIVE_STATE/gh.log" >/dev/null
then
  fail "anonymous recovery mutated the already immutable release"
fi

echo "test-publish-immutable-github-release.sh: ok"
