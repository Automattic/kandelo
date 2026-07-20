#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() {
  echo "test-homebrew-vfs-release.sh: $*" >&2
  exit 1
}

expect_failure() {
  local label="$1"
  shift
  if "$@" >"$TMP_ROOT/failure.out" 2>"$TMP_ROOT/failure.err"; then
    fail "$label"
  fi
}

tap="$TMP_ROOT/tap"
mkdir -p "$tap/Formula" "$tap/Kandelo"
cat >"$tap/Formula/file-formula.rb" <<'EOF'
class FileFormula < Formula
end
EOF
cat >"$tap/Kandelo/vfs-acceptance.json" <<'EOF'
{
  "schema": 2,
  "formula": "file-formula",
  "brewfile": "Kandelo/Brewfile.acceptance",
  "executable": "/home/linuxbrew/.linuxbrew/bin/file",
  "argv": ["file", "--version"],
  "expected_stdout": "file-5.46",
  "shell_config": "Kandelo/shell.json"
}
EOF
printf 'tap "kandelo-dev/tap-core"\nbrew "file-formula"\nbrew "dash"\n' \
  >"$tap/Kandelo/Brewfile.acceptance"
printf '{"version":1,"path":"/home/linuxbrew/.linuxbrew/bin/dash","argv":["dash","-l","-i"]}\n' \
  >"$tap/Kandelo/shell.json"
git -C "$tap" init -q
git -C "$tap" config user.name "Kandelo Test"
git -C "$tap" config user.email "kandelo-test@example.invalid"
git -C "$tap" add .
git -C "$tap" commit -q -m "acceptance tap"
tap_commit="$(git -C "$tap" rev-parse HEAD)"
kandelo_commit="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

source_root="$TMP_ROOT/source"
mkdir "$source_root"
printf 'browser-proven-vfs-bytes\n' >"$source_root/image.vfs.zst"
image_sha="$(sha256sum "$source_root/image.vfs.zst" | awk '{print $1}')"
image_bytes="$(wc -c <"$source_root/image.vfs.zst" | tr -d '[:space:]')"
brewfile_sha="$(sha256sum "$tap/Kandelo/Brewfile.acceptance" | awk '{print $1}')"
brewfile_bytes="$(wc -c <"$tap/Kandelo/Brewfile.acceptance" | tr -d '[:space:]')"
kernel_sha="cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
base_sha="dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
file_sha="eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
dash_sha="ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
config_sha="$(sha256sum "$tap/Kandelo/shell.json" | awk '{print $1}')"
config_bytes="$(wc -c <"$tap/Kandelo/shell.json" | tr -d '[:space:]')"
stdout='file-5.46\n'
stdout_sha="$(printf '%s' "$stdout" | sha256sum | awk '{print $1}')"
empty_sha="$(printf '' | sha256sum | awk '{print $1}')"

jq -nS \
  --arg tap_commit "$tap_commit" \
  --arg kandelo_commit "$kandelo_commit" \
  --arg brewfile_sha "$brewfile_sha" \
  --argjson brewfile_bytes "$brewfile_bytes" \
  --arg base_sha "$base_sha" \
  --arg file_sha "$file_sha" \
  --arg dash_sha "$dash_sha" \
  --arg config_sha "$config_sha" \
  --argjson config_bytes "$config_bytes" '
  {
    schema: 1,
    metadata: {
      tap_repository: "kandelo-dev/homebrew-tap-core",
      tap_name: "kandelo-dev/tap-core",
      tap_commit: $tap_commit,
      kandelo_repository: "Automattic/kandelo",
      kandelo_commit: $kandelo_commit,
      kandelo_abi: 42,
      release_tag: "bottles-abi-v42"
    },
    selection: {
      kind: "brewfile",
      requested_packages: ["file-formula", "dash"],
      requested_packages_sha256: $brewfile_sha,
      brewfile: {parser: "kandelo-static-brewfile-v1", sha256: $brewfile_sha, bytes: $brewfile_bytes}
    },
    default_shell: {
      path: "/home/linuxbrew/.linuxbrew/bin/dash",
      argv: ["dash", "-l", "-i"],
      config_sha256: $config_sha,
      config_bytes: $config_bytes
    },
    base_image: {sha256: $base_sha, bytes: 1024, kernelAbi: 42},
    packages: [
      {
        name: "file-formula", full_name: "kandelo-dev/tap-core/file-formula",
        tap_repository: "kandelo-dev/homebrew-tap-core", tap_name: "kandelo-dev/tap-core",
        tap_commit: $tap_commit, version: "5.46", arch: "wasm32",
        source_status: "success", metadata_status: "success",
        url: ("https://ghcr.io/v2/kandelo-dev/homebrew-tap-core/file-formula/blobs/sha256:" + $file_sha),
        sha256: $file_sha, bytes: 200, cache_key_sha: $file_sha,
        link_manifest: "Kandelo/links/file-formula.json",
        prefix: "/home/linuxbrew/.linuxbrew/Cellar/file-formula/5.46", keg: "5.46"
      },
      {
        name: "dash", full_name: "kandelo-dev/tap-core/dash",
        tap_repository: "kandelo-dev/homebrew-tap-core", tap_name: "kandelo-dev/tap-core",
        tap_commit: $tap_commit, version: "0.5.12", arch: "wasm32",
        source_status: "success", metadata_status: "success",
        url: ("https://ghcr.io/v2/kandelo-dev/homebrew-tap-core/dash/blobs/sha256:" + $dash_sha),
        sha256: $dash_sha, bytes: 150, cache_key_sha: $dash_sha,
        link_manifest: "Kandelo/links/dash.json",
        prefix: "/home/linuxbrew/.linuxbrew/Cellar/dash/0.5.12", keg: "0.5.12"
      }
    ],
    image: "/untrusted/runner/path.vfs.zst"
  }
  ' >"$source_root/report.json"

jq -nS \
  --arg tap_commit "$tap_commit" \
  --arg image_sha "$image_sha" \
  --argjson image_bytes "$image_bytes" \
  --arg brewfile_sha "$brewfile_sha" \
  --argjson brewfile_bytes "$brewfile_bytes" \
  --arg kernel_sha "$kernel_sha" \
  --arg base_sha "$base_sha" \
  --arg file_sha "$file_sha" \
  --arg dash_sha "$dash_sha" \
  --arg config_sha "$config_sha" \
  --argjson config_bytes "$config_bytes" \
  --arg stdout "$stdout" \
  --arg stdout_sha "$stdout_sha" \
  --arg empty_sha "$empty_sha" '
  {
    schema: 1, status: "success",
    selection: {
      parser: "kandelo-static-brewfile-v1", sha256: $brewfile_sha,
      bytes: $brewfile_bytes, requested_packages: ["file-formula", "dash"]
    },
    dependency_edges: [
      {from: "kandelo-dev/tap-core/file-formula", to: "kandelo-dev/tap-core/dash", version: "0.5.12"}
    ],
    browser_plan: {
      compatibility_basis: "pending-exact-image-runtime-test",
      packages: ["kandelo-dev/tap-core/file-formula", "kandelo-dev/tap-core/dash"]
    },
    homebrew_bottles: [
      {
        name: "file-formula", full_name: "kandelo-dev/tap-core/file-formula",
        tap_repository: "kandelo-dev/homebrew-tap-core", tap_commit: $tap_commit,
        version: "5.46", sha256: $file_sha, bytes: 200, cache_key_sha: $file_sha,
        url: ("https://ghcr.io/v2/kandelo-dev/homebrew-tap-core/file-formula/blobs/sha256:" + $file_sha),
        declared_runtime_support: ["node"], declared_browser_compatible: false
      },
      {
        name: "dash", full_name: "kandelo-dev/tap-core/dash",
        tap_repository: "kandelo-dev/homebrew-tap-core", tap_commit: $tap_commit,
        version: "0.5.12", sha256: $dash_sha, bytes: 150, cache_key_sha: $dash_sha,
        url: ("https://ghcr.io/v2/kandelo-dev/homebrew-tap-core/dash/blobs/sha256:" + $dash_sha),
        declared_runtime_support: ["node"], declared_browser_compatible: false
      }
    ],
    platform_inputs: [
      {role: "base-vfs", origin: "kandelo-package-registry", artifact: "base.vfs.zst", sha256: $base_sha, bytes: 1024, kernel_abi: 42},
      {role: "kernel", origin: "worktree-build", artifact: "kernel.wasm", sha256: $kernel_sha, bytes: 2048, kernel_abi: 42}
    ],
    image: {artifact: "homebrew-brewfile.vfs.zst", sha256: $image_sha, bytes: $image_bytes, kernel_abi: 42},
    default_shell: {
      config_artifact: "shell.json", config_sha256: $config_sha, config_bytes: $config_bytes,
      path: "/home/linuxbrew/.linuxbrew/bin/dash", argv: ["dash", "-l", "-i"],
      bottle_package: "dash"
    },
    node: {
      executable: "/home/linuxbrew/.linuxbrew/bin/file", argv: ["file", "--version"],
      exit_code: 0, stdout: $stdout, stdout_sha256: $stdout_sha, stderr_sha256: $empty_sha
    }
  }
  ' >"$source_root/node.json"

jq -nS --arg image_sha "$image_sha" --arg kernel_sha "$kernel_sha" '
  {
    schema: 1, status: "success", runtime: "browser", engine: "chromium",
    image_sha256: $image_sha, kernel_sha256: $kernel_sha,
    executable: "/home/linuxbrew/.linuxbrew/bin/file", argv: ["file", "--version"],
    default_shell: {
      path: "/home/linuxbrew/.linuxbrew/bin/dash", argv: ["dash", "-l", "-i"],
      interactive: true, legacy_shell_downloads: 0
    }
  }
  ' >"$source_root/browser.json"

common_identity_args=(
  --tap-root "$tap"
  --tap-repository kandelo-dev/homebrew-tap-core
  --tap-name kandelo-dev/tap-core
  --tap-commit "$tap_commit"
  --formula file-formula
  --kandelo-commit "$kandelo_commit"
)
common_args=(
  "${common_identity_args[@]}"
  --abi 42
  --bottle-release-tag bottles-abi-v42
)
handoff="$TMP_ROOT/handoff"
python3 "$REPO_ROOT/scripts/homebrew-vfs-release.py" prepare \
  --image "$source_root/image.vfs.zst" \
  --report "$source_root/report.json" \
  --node-evidence "$source_root/node.json" \
  --browser-evidence "$source_root/browser.json" \
  --out "$handoff" "${common_args[@]}" >/dev/null
python3 "$REPO_ROOT/scripts/homebrew-vfs-release.py" validate \
  --handoff "$handoff" "${common_args[@]}" >/dev/null
expect_failure "validator accepted a Kandelo ABI outside the trusted plan" \
  python3 "$REPO_ROOT/scripts/homebrew-vfs-release.py" validate \
    --handoff "$handoff" "${common_identity_args[@]}" \
    --abi 43 --bottle-release-tag bottles-abi-v43
expect_failure "validator accepted a bottle release tag outside the trusted plan" \
  python3 "$REPO_ROOT/scripts/homebrew-vfs-release.py" validate \
    --handoff "$handoff" "${common_identity_args[@]}" \
    --abi 42 --bottle-release-tag bottles-abi-v41
jq -e --arg image_sha "$image_sha" '
  .schema == 1 and .kind == "kandelo-homebrew-vfs" and
  .image.sha256 == $image_sha and
  .release.tag == ("homebrew-vfs-sha256-" + $image_sha) and
  .launch.query_parameter == "vfs" and .launch.value == .image.url and
  .default_shell.path == "/home/linuxbrew/.linuxbrew/bin/dash"
' "$handoff/kandelo-homebrew-vfs.json" >/dev/null || fail "descriptor contract changed"

negative="$TMP_ROOT/negative"
cp -a "$handoff" "$negative"
printf 'tamper' >>"$negative/kandelo-homebrew.vfs.zst"
expect_failure "validator accepted a tampered VFS image" \
  python3 "$REPO_ROOT/scripts/homebrew-vfs-release.py" validate \
  --handoff "$negative" "${common_args[@]}"
rm -rf "$negative"
cp -a "$handoff" "$negative"
jq '.image_sha256 = "0000000000000000000000000000000000000000000000000000000000000000"' \
  "$negative/kandelo-homebrew-browser-evidence.json" >"$negative/browser.tmp"
mv "$negative/browser.tmp" "$negative/kandelo-homebrew-browser-evidence.json"
expect_failure "validator accepted browser evidence for different bytes" \
  python3 "$REPO_ROOT/scripts/homebrew-vfs-release.py" validate \
  --handoff "$negative" "${common_args[@]}"
rm -rf "$negative"
cp -a "$handoff" "$negative"
printf 'unexpected\n' >"$negative/executable.sh"
expect_failure "validator accepted an executable or extra handoff entry" \
  python3 "$REPO_ROOT/scripts/homebrew-vfs-release.py" validate \
  --handoff "$negative" "${common_args[@]}"
rm -rf "$negative"
cp -a "$handoff" "$negative"
rm "$negative/kandelo-homebrew-vfs.json"
ln -s "$handoff/kandelo-homebrew-vfs.json" "$negative/kandelo-homebrew-vfs.json"
expect_failure "validator accepted a symlinked handoff entry" \
  python3 "$REPO_ROOT/scripts/homebrew-vfs-release.py" validate \
  --handoff "$negative" "${common_args[@]}"
printf 'dirty\n' >"$tap/untracked"
expect_failure "validator accepted a dirty exact tap checkout" \
  python3 "$REPO_ROOT/scripts/homebrew-vfs-release.py" validate \
  --handoff "$handoff" "${common_args[@]}"
rm "$tap/untracked"

fake_bin="$TMP_ROOT/fake-bin"
fake_state="$TMP_ROOT/fake-state"
mkdir "$fake_bin" "$fake_state"
cat >"$fake_bin/gh" <<'PY'
#!/usr/bin/env python3
import json, os, pathlib, shutil, sys

root = pathlib.Path(os.environ["FAKE_GITHUB_STATE"])
state_path = root / "state.json"
log_path = root / "gh.log"
with log_path.open("a") as log:
    log.write(json.dumps(sys.argv[1:]) + "\n")

def load():
    if not state_path.exists(): return None
    return json.loads(state_path.read_text())

def save(value):
    state_path.write_text(json.dumps(value, sort_keys=True))

def release_json(value):
    return {
        "id": 73, "tag_name": value["tag"], "target_commitish": value["target"],
        "draft": value["draft"], "prerelease": False,
        "immutable": not value["draft"] and not os.environ.get("FAKE_IMMUTABLE_RELEASES_DISABLED"),
        "assets": [{"id": item["id"], "name": name} for name, item in sorted(value["assets"].items())],
    }

args = sys.argv[1:]
if args[:2] == ["api", "--include"]:
    endpoint = args[2]
    state = load()
    if state is None:
        print("HTTP/1.1 404 Not Found\n")
        sys.exit(1)
    if "/releases/tags/" in endpoint:
        print("HTTP/1.1 200 OK\n")
        print(json.dumps(release_json(state)))
    elif "/git/ref/tags/" in endpoint:
        print("HTTP/1.1 200 OK\n")
        print(json.dumps({"ref": "refs/tags/" + state["tag"], "object": {"type": state.get("tag_type", "commit"), "sha": state.get("tag_sha", state["target"])}}))
    else:
        print("HTTP/1.1 404 Not Found\n")
        sys.exit(1)
elif args[:3] == ["api", "--method", "POST"]:
    fields = {arg.split("=", 1)[0][2:]: arg.split("=", 1)[1] for arg in args if arg.startswith(("-f", "-F")) and "=" in arg}
    # gh receives -f and its value as separate arguments; parse those too.
    fields = {}
    for index, arg in enumerate(args):
        if arg in ("-f", "-F"):
            key, value = args[index + 1].split("=", 1); fields[key] = value
    state = {"tag": fields["tag_name"], "target": fields["target_commitish"], "draft": True, "assets": {}, "next_id": 100}
    save(state)
    print(json.dumps(release_json(state)))
elif args[:3] == ["api", "--method", "PATCH"]:
    state = load()
    if not state["draft"]:
        print("published release is immutable", file=sys.stderr); sys.exit(1)
    state["draft"] = False; save(state)
    marker = root / "lost-publish-response"
    if os.environ.get("FAKE_PATCH_RESPONSE_LOST") and not marker.exists():
        marker.write_text("lost\n"); sys.exit(1)
    print(json.dumps(release_json(state)))
elif args[:2] == ["api", "-H"]:
    endpoint = args[3]
    asset_id = int(endpoint.rsplit("/", 1)[1])
    state = load()
    for item in state["assets"].values():
        if item["id"] == asset_id:
            sys.stdout.buffer.write((root / item["file"]).read_bytes()); sys.exit(0)
    sys.exit(1)
elif args[:2] == ["release", "upload"]:
    state = load(); source = pathlib.Path(args[-1]); name = source.name
    destination = "asset-" + str(state["next_id"])
    shutil.copyfile(source, root / destination)
    state["assets"][name] = {"id": state["next_id"], "file": destination}
    state["next_id"] += 1; save(state)
else:
    print("unsupported fake gh: " + repr(args), file=sys.stderr); sys.exit(2)
PY
chmod +x "$fake_bin/gh"
cat >"$fake_bin/curl" <<'PY'
#!/usr/bin/env python3
import os, pathlib, sys
if os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN"):
    print("credential reached anonymous curl", file=sys.stderr); sys.exit(2)
args = sys.argv[1:]
output = pathlib.Path(args[args.index("--output") + 1])
name = args[-1].rsplit("/", 1)[1]
root = pathlib.Path(os.environ["FAKE_GITHUB_STATE"])
state = __import__("json").loads((root / "state.json").read_text())
item = state["assets"][name]
value = (root / item["file"]).read_bytes()
fail_once = os.environ.get("FAKE_CURL_FAIL_ONCE")
marker = root / ("curl-failed-once-" + name)
if fail_once == name and not marker.exists():
    marker.write_text("failed\n"); sys.exit(1)
if os.environ.get("FAKE_CURL_TAMPER") == name: value += b"tamper"
output.write_bytes(value)
PY
chmod +x "$fake_bin/curl"
cat >"$fake_bin/state-lock" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[ "$PWD" = "${FAKE_EXPECTED_LOCK_ROOT:?}" ] || {
  echo "state lock did not run from the exact tap checkout" >&2
  exit 2
}
case "$1" in acquire|release) exit 0 ;; *) exit 2 ;; esac
EOF
chmod +x "$fake_bin/state-lock"

publisher_args=(
  --handoff "$handoff"
  --tap-root "$tap"
  --tap-repository kandelo-dev/homebrew-tap-core
  --tap-name kandelo-dev/tap-core
  --tap-commit "$tap_commit"
  --formula file-formula
  --kandelo-commit "$kandelo_commit"
  --abi 42
  --bottle-release-tag bottles-abi-v42
)
run_publisher() {
  PATH="$fake_bin:$PATH" \
  FAKE_GITHUB_STATE="$fake_state" \
  FAKE_EXPECTED_LOCK_ROOT="$tap" \
  STATE_LOCK_SCRIPT="$fake_bin/state-lock" \
  GITHUB_REPOSITORY=kandelo-dev/homebrew-tap-core \
  GH_TOKEN=fake-token \
    bash "$REPO_ROOT/scripts/homebrew-publish-vfs-release.sh" \
      "${publisher_args[@]}" --receipt "$TMP_ROOT/receipt.json"
}

run_publisher >/dev/null
jq -e --arg image_sha "$image_sha" '
  .schema == 1 and .status == "success" and
  .visibility == "public-anonymous-readback" and
  .image.sha256 == $image_sha and (.assets | length) == 5
' "$TMP_ROOT/receipt.json" >/dev/null || fail "publisher receipt contract changed"

FAKE_CURL_FAIL_ONCE=kandelo-homebrew.vfs.zst run_publisher >/dev/null ||
  fail "publisher did not retry transient anonymous release propagation"

: >"$fake_state/gh.log"
run_publisher >/dev/null
if jq -s -e 'any(.[]; .[0:2] == ["api", "--method"] or .[0:2] == ["release", "upload"])' \
  "$fake_state/gh.log" >/dev/null; then
  fail "idempotent public retry mutated the release"
fi

cp "$fake_state/state.json" "$fake_state/public-state.json"
jq 'del(.assets["kandelo-homebrew-browser-evidence.json"])' \
  "$fake_state/state.json" >"$fake_state/state.tmp"
mv "$fake_state/state.tmp" "$fake_state/state.json"
expect_failure "publisher filled a missing asset in an existing public release" run_publisher
cp "$fake_state/public-state.json" "$fake_state/state.json"

# A partial exact draft is recoverable: the publisher fills only the missing
# asset and publishes after all five authenticated checks succeed.
jq '.draft = true | del(.assets["kandelo-homebrew-browser-evidence.json"])' \
  "$fake_state/state.json" >"$fake_state/state.tmp"
mv "$fake_state/state.tmp" "$fake_state/state.json"
run_publisher >/dev/null
jq -e '.draft == false and (.assets | length) == 5' "$fake_state/state.json" >/dev/null ||
  fail "publisher did not recover an exact partial draft"

# Existing public bytes are immutable and never overwritten.
asset_file="$(jq -r '.assets["kandelo-homebrew.vfs.zst"].file' "$fake_state/state.json")"
printf 'mismatch\n' >"$fake_state/$asset_file"
expect_failure "publisher overwrote a mismatched public asset" run_publisher
rm -f "$fake_state/state.json" "$fake_state"/asset-*
run_publisher >/dev/null

# A lost response after GitHub makes the release public is reconciled from the
# release API. An immutable public release rejects every redundant PATCH.
rm -f "$fake_state/state.json" "$fake_state"/asset-* "$fake_state/lost-publish-response"
FAKE_PATCH_RESPONSE_LOST=1 run_publisher >/dev/null ||
  fail "publisher did not reconcile an ambiguous successful publish"

jq '.assets["unexpected.sh"] = {id: 999, file: "unexpected"}' \
  "$fake_state/state.json" >"$fake_state/state.tmp"
mv "$fake_state/state.tmp" "$fake_state/state.json"
printf 'bad\n' >"$fake_state/unexpected"
expect_failure "publisher accepted an unexpected release asset" run_publisher
jq 'del(.assets["unexpected.sh"])' "$fake_state/state.json" >"$fake_state/state.tmp"
mv "$fake_state/state.tmp" "$fake_state/state.json"

if PATH="$fake_bin:$PATH" FAKE_GITHUB_STATE="$fake_state" \
   FAKE_CURL_TAMPER=kandelo-homebrew.vfs.zst FAKE_EXPECTED_LOCK_ROOT="$tap" \
   STATE_LOCK_SCRIPT="$fake_bin/state-lock" \
   GITHUB_REPOSITORY=kandelo-dev/homebrew-tap-core GH_TOKEN=fake-token \
   bash "$REPO_ROOT/scripts/homebrew-publish-vfs-release.sh" "${publisher_args[@]}" \
     --receipt "$TMP_ROOT/tampered-receipt.json" >/dev/null 2>&1; then
  fail "publisher accepted a failed anonymous digest readback"
fi

jq '.tag_sha = "9999999999999999999999999999999999999999"' \
  "$fake_state/state.json" >"$fake_state/state.tmp"
mv "$fake_state/state.tmp" "$fake_state/state.json"
expect_failure "publisher accepted a release tag at the wrong commit" run_publisher

# Repository-level immutable releases are an operator prerequisite. The scoped
# publisher does not receive administration permission to preflight that
# setting, but it must refuse success and emit no receipt when GitHub reports
# the resulting public release as mutable.
rm -f "$fake_state/state.json" "$fake_state"/asset-* "$TMP_ROOT/receipt.json"
FAKE_IMMUTABLE_RELEASES_DISABLED=1 expect_failure \
  "publisher accepted a public release without GitHub immutability" run_publisher
grep -F "public release is not protected by GitHub immutable releases" \
  "$TMP_ROOT/failure.err" >/dev/null ||
  fail "publisher did not explain the immutable-release prerequisite"
[ ! -e "$TMP_ROOT/receipt.json" ] ||
  fail "publisher emitted a success receipt for a mutable public release"

echo "test-homebrew-vfs-release.sh: ok"
