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
bottle_tap_commit="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
bottle_kandelo_commit="9999999999999999999999999999999999999999"

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
  --arg bottle_tap_commit "$bottle_tap_commit" \
  --arg bottle_kandelo_commit "$bottle_kandelo_commit" \
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
        name: "dash", full_name: "kandelo-dev/tap-core/dash",
        tap_repository: "kandelo-dev/homebrew-tap-core", tap_name: "kandelo-dev/tap-core",
        tap_commit: $bottle_tap_commit, version: "0.5.12", arch: "wasm32",
        source_status: "success", metadata_status: "success",
        url: ("https://ghcr.io/v2/kandelo-dev/homebrew-tap-core/dash/blobs/sha256:" + $dash_sha),
        sha256: $dash_sha, bytes: 150, cache_key_sha: $dash_sha,
        link_manifest: "Kandelo/links/dash.json",
        prefix: "/home/linuxbrew/.linuxbrew",
        keg: "/home/linuxbrew/.linuxbrew/Cellar/dash/0.5.12",
        opt_link: {path: "opt/dash", target: "../Cellar/dash/0.5.12"},
        built_from: {
          tap_repository: "kandelo-dev/homebrew-tap-core",
          tap_commit: $bottle_tap_commit,
          kandelo_repository: "Automattic/kandelo",
          kandelo_commit: $bottle_kandelo_commit,
          formula_sha256: $dash_sha
        }
      },
      {
        name: "file-formula", full_name: "kandelo-dev/tap-core/file-formula",
        tap_repository: "kandelo-dev/homebrew-tap-core", tap_name: "kandelo-dev/tap-core",
        tap_commit: $tap_commit, version: "5.46", arch: "wasm32",
        source_status: "success", metadata_status: "success",
        url: ("https://ghcr.io/v2/kandelo-dev/homebrew-tap-core/file-formula/blobs/sha256:" + $file_sha),
        sha256: $file_sha, bytes: 200, cache_key_sha: $file_sha,
        link_manifest: "Kandelo/links/file-formula.json",
        prefix: "/home/linuxbrew/.linuxbrew",
        keg: "/home/linuxbrew/.linuxbrew/Cellar/file-formula/5.46",
        opt_link: {path: "opt/file-formula", target: "../Cellar/file-formula/5.46"},
        built_from: {
          tap_repository: "kandelo-dev/homebrew-tap-core",
          tap_commit: $tap_commit,
          kandelo_repository: "Automattic/kandelo",
          kandelo_commit: $kandelo_commit,
          formula_sha256: $file_sha
        }
      }
    ],
    image: "/untrusted/runner/path.vfs.zst"
  }
  ' >"$source_root/report.json"

jq -nS \
  --arg tap_commit "$tap_commit" \
  --arg bottle_tap_commit "$bottle_tap_commit" \
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
      packages: ["kandelo-dev/tap-core/dash", "kandelo-dev/tap-core/file-formula"]
    },
    homebrew_bottles: [
      {
        name: "dash", full_name: "kandelo-dev/tap-core/dash",
        tap_repository: "kandelo-dev/homebrew-tap-core", tap_commit: $bottle_tap_commit,
        version: "0.5.12", sha256: $dash_sha, bytes: 150, cache_key_sha: $dash_sha,
        url: ("https://ghcr.io/v2/kandelo-dev/homebrew-tap-core/dash/blobs/sha256:" + $dash_sha),
        declared_runtime_support: ["node"], declared_browser_compatible: false
      },
      {
        name: "file-formula", full_name: "kandelo-dev/tap-core/file-formula",
        tap_repository: "kandelo-dev/homebrew-tap-core", tap_commit: $tap_commit,
        version: "5.46", sha256: $file_sha, bytes: 200, cache_key_sha: $file_sha,
        url: ("https://ghcr.io/v2/kandelo-dev/homebrew-tap-core/file-formula/blobs/sha256:" + $file_sha),
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

python3 - "$source_root" "$tap_commit" "$kandelo_commit" "$image_sha" \
  "$image_bytes" "$file_sha" "$dash_sha" "$bottle_tap_commit" \
  "$bottle_kandelo_commit" <<'PY'
import hashlib, json, pathlib, stat, sys, zipfile

root = pathlib.Path(sys.argv[1])
tap_commit, kandelo_commit, image_sha = sys.argv[2:5]
image_bytes = int(sys.argv[5])
file_sha, dash_sha, bottle_tap_commit, bottle_kandelo_commit = sys.argv[6:10]
archive_path = root / "layer.bin"
entries = [
    {
        "path": "home/linuxbrew/.linuxbrew", "type": "directory",
        "ownership": "shared-base-directory", "mode": 0o755, "size": 0,
    },
    {
        "path": "home/linuxbrew/.linuxbrew/Cellar", "type": "directory",
        "ownership": "shared-base-directory", "mode": 0o755, "size": 0,
    },
    {
        "path": "home/linuxbrew/.linuxbrew/Cellar/file-formula",
        "type": "directory", "ownership": "layer", "mode": 0o755, "size": 0,
    },
    {
        "path": "home/linuxbrew/.linuxbrew/Cellar/file-formula/5.46",
        "type": "directory", "ownership": "layer", "mode": 0o755, "size": 0,
    },
    {
        "path": "home/linuxbrew/.linuxbrew/Cellar/file-formula/5.46/bin",
        "type": "directory", "ownership": "layer", "mode": 0o755, "size": 0,
    },
    {
        "path": "home/linuxbrew/.linuxbrew/Cellar/file-formula/5.46/bin/file",
        "type": "file", "ownership": "layer", "mode": 0o755,
        "size": len(b"file-5.46\n"),
    },
    {
        "path": "home/linuxbrew/.linuxbrew/bin", "type": "directory",
        "ownership": "shared-base-directory", "mode": 0o755, "size": 0,
    },
    {
        "path": "home/linuxbrew/.linuxbrew/bin/file", "type": "symlink",
        "ownership": "layer", "mode": 0o777,
        "target": "/home/linuxbrew/.linuxbrew/Cellar/file-formula/5.46/bin/file",
        "size": len(b"/home/linuxbrew/.linuxbrew/Cellar/file-formula/5.46/bin/file"),
    },
    {
        "path": "home/linuxbrew/.linuxbrew/opt", "type": "directory",
        "ownership": "shared-base-directory", "mode": 0o755, "size": 0,
    },
    {
        "path": "home/linuxbrew/.linuxbrew/opt/file-formula", "type": "symlink",
        "ownership": "layer", "mode": 0o777,
        "target": "../Cellar/file-formula/5.46",
        "size": len(b"../Cellar/file-formula/5.46"),
    },
]
for entry in entries:
    entry["source_path"] = entry["path"]
    if entry["type"] == "file":
        entry["inode_group"] = entry["path"]
payloads = {
    entries[5]["path"]: b"file-5.46\n",
    entries[7]["path"]: entries[7]["target"].encode(),
    entries[9]["path"]: entries[9]["target"].encode(),
}
with zipfile.ZipFile(archive_path, "w") as archive:
    for entry in entries:
        name = entry["path"] + ("/" if entry["type"] == "directory" else "")
        info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
        info.create_system = 3
        kind = {"directory": stat.S_IFDIR, "file": stat.S_IFREG,
                "symlink": stat.S_IFLNK}[entry["type"]]
        info.external_attr = (kind | entry["mode"]) << 16
        info.compress_type = (zipfile.ZIP_STORED if entry["type"] != "file"
                              else zipfile.ZIP_DEFLATED)
        archive.writestr(info, payloads.get(entry["path"], b""))
archive_bytes = archive_path.read_bytes()
tag = "homebrew-vfs-sha256-" + image_sha
release_root = (
    "https://github.com/kandelo-dev/homebrew-tap-core/releases/download/" + tag
)


def package_record(name, version, bottle_sha, bottle_bytes):
    keg = f"/home/linuxbrew/.linuxbrew/Cellar/{name}/{version}"
    package_tap_commit = bottle_tap_commit if name == "dash" else tap_commit
    package_kandelo_commit = (
        bottle_kandelo_commit if name == "dash" else kandelo_commit
    )
    return {
        "name": name, "full_name": f"kandelo-dev/tap-core/{name}",
        "tap_repository": "kandelo-dev/homebrew-tap-core",
        "tap_name": "kandelo-dev/tap-core", "tap_commit": package_tap_commit,
        "version": version, "formula_revision": 0, "bottle_rebuild": 0,
        "arch": "wasm32", "source_status": "success",
        "metadata_status": "success",
        "url": (
            f"https://ghcr.io/v2/kandelo-dev/homebrew-tap-core/{name}"
            f"/blobs/sha256:{bottle_sha}"
        ),
        "sha256": bottle_sha, "bytes": bottle_bytes,
        "cache_key_sha": bottle_sha,
        "link_manifest": f"Kandelo/links/{name}.json",
        "prefix": "/home/linuxbrew/.linuxbrew", "keg": keg,
        "opt_link": {"path": f"opt/{name}", "target": f"../Cellar/{name}/{version}"},
        "built_from": {
            "tap_repository": "kandelo-dev/homebrew-tap-core",
            "tap_commit": package_tap_commit,
            "kandelo_repository": "Automattic/kandelo",
            "kandelo_commit": package_kandelo_commit,
            "formula_sha256": bottle_sha,
        },
    }


dash_package = package_record("dash", "0.5.12", dash_sha, 150)
file_package = package_record("file-formula", "5.46", file_sha, 200)
base_package_order = [dash_package["full_name"]]
layer_package_order = [file_package["full_name"]]
package_order = base_package_order + layer_package_order
base_source = {
    "schema": 1, "kind": "kandelo-package-output",
    "index": {
        "url": (
            "https://github.com/Automattic/kandelo/releases/download/"
            "binaries-abi-v42/index.toml"
        ),
        "sha256": "1" * 64, "bytes": 4096, "abi": 42,
    },
    "package": {
        "name": "shell", "version": "0.1.0", "revision": 14,
        "arch": "wasm32", "cache_key_sha": "2" * 64,
    },
    "archive": {
        "format": "kandelo-package-tar-zstd-v2",
        "url": (
            "https://github.com/Automattic/kandelo/releases/download/"
            "binaries-abi-v42/shell-0.1.0-rev14-abi42-wasm32-22222222.tar.zst"
        ),
        "sha256": "3" * 64, "bytes": 2048,
    },
    "output": {
        "name": "shell", "path": "shell.vfs.zst",
        "sha256": "d" * 64, "bytes": 1024,
    },
}
descriptor = {
    "schema": 3, "kind": "kandelo-homebrew-deferred-layer", "arch": "wasm32",
    "mount_prefix": "/",
    "tap": {
        "repository": "kandelo-dev/homebrew-tap-core",
        "name": "kandelo-dev/tap-core", "commit": tap_commit,
    },
    "tap_lock": [{
        "repository": "kandelo-dev/homebrew-tap-core",
        "name": "kandelo-dev/tap-core", "commit": tap_commit,
        "kandelo_repository": "Automattic/kandelo",
        "kandelo_commit": kandelo_commit, "kandelo_abi": 42,
        "bottle_release_tag": "bottles-abi-v42",
    }],
    "kandelo": {
        "repository": "Automattic/kandelo", "commit": kandelo_commit, "abi": 42,
    },
    "bottle_release_tag": "bottles-abi-v42",
    "selection": {
        "requested_packages": ["file-formula"],
        "package_order": package_order,
        "base_package_order": base_package_order,
        "layer_package_order": layer_package_order,
    },
    "packages": {"base": [dash_package], "layer": [file_package]},
    "base_vfs": {
        "sha256": "d" * 64, "bytes": 1024, "kernel_abi": 42,
        "package_source": base_source,
        "composition": {
            "path": "/etc/kandelo/homebrew-vfs.json",
            "sha256": "4" * 64, "bytes": 16384,
            "requested_packages_sha256": "5" * 64,
            "package_set_sha256": "6" * 64,
            "package_count": 1, "package_order": base_package_order,
        },
    },
    "release": {
        "repository": "kandelo-dev/homebrew-tap-core", "tag": tag,
    },
    "acceptance_vfs": {
        "asset": "kandelo-homebrew.vfs.zst",
        "url": release_root + "/kandelo-homebrew.vfs.zst",
        "sha256": image_sha, "bytes": image_bytes,
    },
    "deferred_trees": [{
        "id": "file-formula",
        "activation": {
            "mode": "first-use",
            "capabilities": ["homebrew-runtime:file-formula"],
            "roots": [
                "/home/linuxbrew/.linuxbrew/Cellar/file-formula/5.46"
            ],
        },
        "content": {
            "media_type": "application/zip", "decoder": "zip-v1",
            "sha256": hashlib.sha256(archive_bytes).hexdigest(),
            "bytes": len(archive_bytes),
        },
        "transports": [{
            "url": release_root + "/kandelo-homebrew-file-formula-layer.bin"
        }],
        "inventory": {
            "entry_count": len(entries),
            "source_entry_count": len({entry["source_path"] for entry in entries}),
            "regular_inode_count": 1,
            "layer_entry_count": sum(
                entry["ownership"] == "layer" for entry in entries
            ),
            "shared_base_directory_count": sum(
                entry["ownership"] == "shared-base-directory" for entry in entries
            ),
            "expanded_bytes": sum(entry["size"] for entry in entries),
            "payload_bytes": sum(
                entry["size"] for entry in entries if entry["type"] == "file"
            ),
            "entries": entries,
        },
    }],
}
(root / "layer.json").write_text(json.dumps(descriptor, sort_keys=True, indent=2) + "\n")
PY

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
  --lazy-layer "$source_root/layer.bin" \
  --lazy-layer-descriptor "$source_root/layer.json" \
  --out "$handoff" "${common_args[@]}" >/dev/null
python3 "$REPO_ROOT/scripts/homebrew-vfs-release.py" validate \
  --handoff "$handoff" "${common_args[@]}" >/dev/null
PYTHONDONTWRITEBYTECODE=1 python3 - \
  "$REPO_ROOT/scripts/homebrew-vfs-release.py" <<'PY'
import gzip
import io
import runpy
import sys
import tarfile

release = runpy.run_path(sys.argv[1])
validate = release["validate_lazy_layer_tar_gzip"]
resolve_hardlinks = release["resolve_lazy_layer_hardlinks"]
ValidationError = release["ValidationError"]

canonical = {
    "path": "runtime/tool",
    "source_path": "runtime/tool",
    "type": "file",
    "mode": 0o755,
    "size": 1,
    "inode_group": "runtime:tool",
}
chain = [canonical]
target = canonical["path"]
for index in range(20_000):
    path = f"runtime/link-{index:05d}"
    chain.append({
        "path": path,
        "source_path": path,
        "type": "hardlink",
        "mode": canonical["mode"],
        "size": canonical["size"],
        "inode_group": canonical["inode_group"],
        "target": target,
    })
    target = path
if resolve_hardlinks(chain) != {canonical["inode_group"]: canonical}:
    raise AssertionError("hardlink chain did not resolve to its canonical file")


def expect_graph_rejected(label, graph, message):
    try:
        resolve_hardlinks(graph)
    except ValidationError as error:
        if message not in str(error):
            raise AssertionError(
                f"{label} failed for the wrong reason: {error}"
            ) from error
    else:
        raise AssertionError(f"release validator accepted {label}")


def hardlink(path, target, group="runtime:tool"):
    return {
        "path": path,
        "source_path": path,
        "type": "hardlink",
        "mode": 0o755,
        "size": 1,
        "inode_group": group,
        "target": target,
    }


expect_graph_rejected(
    "a hardlink cycle reached through a tail",
    [
        canonical,
        hardlink("runtime/tail", "runtime/cycle-a"),
        hardlink("runtime/cycle-a", "runtime/cycle-b"),
        hardlink("runtime/cycle-b", "runtime/cycle-a"),
    ],
    "cycle reaches",
)
expect_graph_rejected(
    "a missing hardlink target",
    [canonical, hardlink("runtime/missing", "runtime/absent")],
    "is missing",
)
other = {**canonical, "path": "runtime/other", "inode_group": "runtime:other"}
expect_graph_rejected(
    "a cross-inode hardlink target",
    [canonical, other, hardlink("runtime/cross", "runtime/other")],
    "invalid target",
)

stream = io.BytesIO()
with tarfile.open(fileobj=stream, mode="w:", format=tarfile.USTAR_FORMAT) as archive:
    info = tarfile.TarInfo("runtime/tool")
    info.mode = 0o755
    info.size = 1
    archive.addfile(info, io.BytesIO(b"x"))
tar_value = stream.getvalue()
entries = [{
    "path": "runtime/tool",
    "source_path": "runtime/tool",
    "type": "file",
    "mode": 0o755,
    "size": 1,
}]
valid_gzip = gzip.compress(tar_value, mtime=0)
validate(valid_gzip, entries, len(tar_value))


def expect_rejected(label, payload, message):
    try:
        validate(payload, entries, len(tar_value))
    except ValidationError as error:
        if message not in str(error):
            raise AssertionError(
                f"{label} failed for the wrong reason: {error}"
            ) from error
    else:
        raise AssertionError(f"release validator accepted {label}")


expect_rejected(
    "concatenated gzip members",
    gzip.compress(b"", mtime=0) + valid_gzip,
    "additional gzip member or data",
)

terminator = next(
    offset
    for offset in range(0, len(tar_value) - 1023, 512)
    if tar_value[offset : offset + 1024] == bytes(1024)
)
post_terminator = bytearray(tar_value)
post_terminator[terminator + 1024] = 1
expect_rejected(
    "nonzero TAR data after the first end marker",
    gzip.compress(post_terminator, mtime=0),
    "nonzero data after its end marker",
)


def rewrite_checksum(value):
    value[148:156] = b"        "
    checksum = sum(value[:512])
    value[148:156] = f"{checksum:06o}\0 ".encode("ascii")


base256_mode = bytearray(tar_value)
encoded_mode = bytearray((0o755).to_bytes(8, "big"))
encoded_mode[0] |= 0x80
base256_mode[100:108] = encoded_mode
rewrite_checksum(base256_mode)
expect_rejected(
    "base-256 TAR mode",
    gzip.compress(base256_mode, mtime=0),
    "base-256",
)

invalid_octal_size = bytearray(tar_value)
invalid_octal_size[124:136] = b"00000000008\0"
rewrite_checksum(invalid_octal_size)
expect_rejected(
    "non-octal TAR size",
    gzip.compress(invalid_octal_size, mtime=0),
    "valid octal",
)
PY
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
jq -e --arg image_sha "$image_sha" '
  .schema == 3 and .kind == "kandelo-homebrew-deferred-layer" and
  .acceptance_vfs.sha256 == $image_sha and .mount_prefix == "/" and
  .base_vfs.sha256 == .base_vfs.package_source.output.sha256 and
  .selection.base_package_order == ["kandelo-dev/tap-core/dash"] and
  .selection.layer_package_order == ["kandelo-dev/tap-core/file-formula"] and
  .deferred_trees[0].content.decoder == "zip-v1" and
  .deferred_trees[0].inventory.entry_count == (.deferred_trees[0].inventory.entries | length) and
  .deferred_trees[0].inventory.layer_entry_count == ([.deferred_trees[0].inventory.entries[] | select(.ownership == "layer")] | length)
' "$handoff/kandelo-homebrew-file-formula-layer.json" >/dev/null ||
  fail "lazy layer descriptor contract changed"

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
printf 'tamper' >>"$negative/kandelo-homebrew-file-formula-layer.bin"
expect_failure "validator accepted a tampered lazy ZIP layer" \
  python3 "$REPO_ROOT/scripts/homebrew-vfs-release.py" validate \
  --handoff "$negative" "${common_args[@]}"
rm -rf "$negative"
cp -a "$handoff" "$negative"
jq '.deferred_trees[0].inventory.entries[0].size += 1' \
  "$negative/kandelo-homebrew-file-formula-layer.json" \
  >"$negative/layer.tmp"
mv "$negative/layer.tmp" "$negative/kandelo-homebrew-file-formula-layer.json"
expect_failure "validator accepted a lazy ZIP index that differs from its archive" \
  python3 "$REPO_ROOT/scripts/homebrew-vfs-release.py" validate \
  --handoff "$negative" "${common_args[@]}"
rm -rf "$negative"
cp -a "$handoff" "$negative"
jq '.base_vfs.package_source.output.sha256 = ("0" * 64)' \
  "$negative/kandelo-homebrew-file-formula-layer.json" >"$negative/layer.tmp"
mv "$negative/layer.tmp" "$negative/kandelo-homebrew-file-formula-layer.json"
expect_failure "validator accepted a base VFS outside its package-output receipt" \
  python3 "$REPO_ROOT/scripts/homebrew-vfs-release.py" validate \
  --handoff "$negative" "${common_args[@]}"
rm -rf "$negative"
cp -a "$handoff" "$negative"
jq '.tap_lock[0].commit = ("b" * 40)' \
  "$negative/kandelo-homebrew-file-formula-layer.json" >"$negative/layer.tmp"
mv "$negative/layer.tmp" "$negative/kandelo-homebrew-file-formula-layer.json"
expect_failure "validator accepted a layer package outside its exact tap lock" \
  python3 "$REPO_ROOT/scripts/homebrew-vfs-release.py" validate \
  --handoff "$negative" "${common_args[@]}"
rm -rf "$negative"
cp -a "$handoff" "$negative"
jq '.packages.layer[0].full_name = "other/runtime/file-formula"' \
  "$negative/kandelo-homebrew-file-formula-layer.json" >"$negative/layer.tmp"
mv "$negative/layer.tmp" "$negative/kandelo-homebrew-file-formula-layer.json"
expect_failure "validator accepted a package name outside its locked tap identity" \
  python3 "$REPO_ROOT/scripts/homebrew-vfs-release.py" validate \
  --handoff "$negative" "${common_args[@]}"
rm -rf "$negative"
cp -a "$handoff" "$negative"
jq '
  .selection.package_order = ["kandelo-dev/tap-core/file-formula"] |
  .selection.base_package_order = [] |
  .packages.base = []
' "$negative/kandelo-homebrew-file-formula-layer.json" >"$negative/layer.tmp"
mv "$negative/layer.tmp" "$negative/kandelo-homebrew-file-formula-layer.json"
expect_failure "validator accepted a runtime layer that omitted a selected dependency" \
  python3 "$REPO_ROOT/scripts/homebrew-vfs-release.py" validate \
  --handoff "$negative" "${common_args[@]}"
rm -rf "$negative"
cp -a "$handoff" "$negative"
jq '.deferred_trees[0].inventory.entries[-1].ownership = "shared-base-directory"' \
  "$negative/kandelo-homebrew-file-formula-layer.json" >"$negative/layer.tmp"
mv "$negative/layer.tmp" "$negative/kandelo-homebrew-file-formula-layer.json"
expect_failure "validator accepted a shared non-directory collision" \
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
        if state["draft"]:
            print("HTTP/1.1 404 Not Found\n")
            sys.exit(1)
        print("HTTP/1.1 200 OK\n")
        print(json.dumps(release_json(state)))
    elif "/releases/" in endpoint:
        print("HTTP/1.1 200 OK\n")
        print(json.dumps(release_json(state)))
    elif "/git/ref/tags/" in endpoint:
        if state["draft"]:
            print("HTTP/1.1 404 Not Found\n")
            sys.exit(1)
        print("HTTP/1.1 200 OK\n")
        print(json.dumps({"ref": "refs/tags/" + state["tag"], "object": {"type": state.get("tag_type", "commit"), "sha": state.get("tag_sha", state["target"])}}))
    else:
        print("HTTP/1.1 404 Not Found\n")
        sys.exit(1)
elif args[:3] == ["api", "--paginate", "--slurp"]:
    state = load()
    print(json.dumps([[release_json(state)]] if state is not None else [[]]))
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
  .image.sha256 == $image_sha and
  .lazy_layer.deferred_trees[0].transport.asset == "kandelo-homebrew-file-formula-layer.bin" and
  (.assets | length) == 7
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
# asset and publishes after all seven authenticated checks succeed.
jq '.draft = true | del(.assets["kandelo-homebrew-browser-evidence.json"])' \
  "$fake_state/state.json" >"$fake_state/state.tmp"
mv "$fake_state/state.tmp" "$fake_state/state.json"
: >"$fake_state/gh.log"
run_publisher >/dev/null
jq -e '.draft == false and (.assets | length) == 7' "$fake_state/state.json" >/dev/null ||
  fail "publisher did not recover an exact partial draft"
if ! jq -s -e '
  any(.[]; .[0:3] == ["api", "--paginate", "--slurp"]) and
  all(.[]; .[0:3] != ["api", "--method", "POST"])
' "$fake_state/gh.log" >/dev/null; then
  fail "publisher replaced an exact partial draft instead of discovering it by authenticated release list"
fi

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
