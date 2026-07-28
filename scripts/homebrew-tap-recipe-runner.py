#!/usr/bin/python3
"""Run one attested Homebrew tap recipe behind the publisher boundary.

The ordinary invocation is an unprivileged, one-shot Unix-socket client.  The
publisher starts ``--supervisor`` as root before entering the Formula service,
which has NoNewPrivileges enabled.  The supervisor authenticates the client's
kernel credentials, validates the complete request, runs the recipe as a
different uid in its own transient systemd service, and returns only a sealed
root-owned output tree.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import selectors
import shutil
import socket
import stat
import struct
import subprocess
import sys
import time
from pathlib import Path, PurePosixPath
from typing import Any


MAX_CONFIG_BYTES = 262_144
MAX_REQUEST_BYTES = 262_144
MAX_RESPONSE_BYTES = 4_096
MAX_MESSAGE_BYTES = 8_192
MAX_RECIPE_MANIFEST_BYTES = 65_536
MAX_RECIPE_FILES = 512
MAX_DEPENDENCY_KEGS = 512
MAX_RESOURCES = 32
MAX_RECIPE_FILE_BYTES = 16_777_216
MAX_RECIPE_BYTES = 67_108_864
MAX_RECIPE_LOG_BYTES = 33_554_432
MAX_RESOURCE_ENTRIES = 65_536
MAX_RESOURCE_FILE_BYTES = 268_435_456
MAX_RESOURCE_BYTES = 1_073_741_824
MAX_RESOURCE_PATH_BYTES = 4_096
# Linux reserves one trailing NUL in sockaddr_un.sun_path, leaving 107 bytes
# for a pathname. The protected build identity intentionally retains all 64
# digest characters, so the control socket uses the shortest meaningful name.
UNIX_SOCKET_PATHNAME_BYTES = 107
RUNNER_SOCKET_BASENAME = "s"
EXPECTED_LIMITS = {
    "max_bytes": 2_147_483_648,
    "max_entries": 262_144,
    "max_file_bytes": 1_073_741_824,
    "max_path_bytes": 4_096,
}
CONFIG_KEYS = {
    "allowed_request_root",
    "arch",
    "build_gid",
    "build_uid",
    "build_user",
    "dependencies",
    "formula",
    "group_file",
    "llvm_bin",
    "manifest_sha256",
    "native_cellar",
    "native_formulae",
    "native_requirement_formulae",
    "node_bin",
    "platform_alias_root",
    "platform_host_root",
    "passwd_file",
    "protected_root",
    "recipe_alias_root",
    "recipe_entrypoint",
    "recipe_gid",
    "recipe_host_root",
    "recipe_uid",
    "recipe_user",
    "resources",
    "script_env_keys",
    "sealed_root",
    "slice",
    "source_sha256",
    "source_url",
    "sysroot_alias_root",
    "sysroot_host_root",
    "target_cellar",
    "unit_prefix",
    "version",
}
REQUEST_KEYS = {
    "arch",
    "dependencies",
    "entrypoint",
    "environment",
    "formula",
    "limits",
    "manifest_sha256",
    "native_roots",
    "output_root",
    "platform_root",
    "recipe_root",
    "resources",
    "schema",
    "source_root",
    "sysroot",
    "version",
    "work_root",
}
CLIENT_MESSAGE_KEYS = {"request", "response", "schema"}
FORMULA_COMPONENT = r"[a-z0-9][a-z0-9._+@-]{0,254}"
FORMULA_RE = re.compile(rf"^{FORMULA_COMPONENT}$")
FULL_FORMULA_RE = re.compile(
    rf"^{FORMULA_COMPONENT}/{FORMULA_COMPONENT}/{FORMULA_COMPONENT}$"
)
NIX_STORE_ROOT_RE = re.compile(r"^/nix/store/[0-9a-z]{32}-[^/\n]+$")
ENV_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,254}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
UNIT_RE = re.compile(r"^kandelo-homebrew-build-[0-9]+$")
SLICE_RE = re.compile(r"^kandelo-homebrew-build-[0-9]+[.]slice$")
VERSION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+,-]{0,254}$")
RESOURCE_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9._+-]{0,127}$")
ResourceStagingIdentity = tuple[
    tuple[int, ...],
    dict[str, tuple[int, ...]],
]
SAFE_FIXED_ENV_KEYS = {
    "ACLOCAL_PATH",
    "AR",
    "AS",
    "CC",
    "CFLAGS",
    "CMAKE_BUILD_PARALLEL_LEVEL",
    "CMAKE_PREFIX_PATH",
    "CONFIG_SITE",
    "CPP",
    "CPPFLAGS",
    "CXX",
    "CXXFLAGS",
    "HOME",
    "LANG",
    "LC_ALL",
    "LD",
    "LDFLAGS",
    "LIBS",
    "LLVM_BIN",
    "LOGNAME",
    "MAKEFLAGS",
    "MFLAGS",
    "NINJAFLAGS",
    "NM",
    "OBJCOPY",
    "OBJDUMP",
    "PATH",
    "PKG_CONFIG",
    "PKG_CONFIG_LIBDIR",
    "PKG_CONFIG_PATH",
    "PKG_CONFIG_SYSROOT_DIR",
    "RANLIB",
    "READELF",
    "SIZE",
    "SOURCE_DATE_EPOCH",
    "STRINGS",
    "STRIP",
    "TMPDIR",
    "TZ",
    "USER",
    "WASM_POSIX_FORK_INSTRUMENT",
    "WASM_POSIX_GLUE_DIR",
    "WASM_POSIX_LLVM_DIR",
    "WASM_POSIX_LOCAL_ROOT_SPILL",
    "WASM_POSIX_SYSROOT",
}
HELPER_ENV_KEYS = {
    "WASM_POSIX_DEP_NAME",
    "WASM_POSIX_DEP_OUT_DIR",
    "WASM_POSIX_DEP_RECIPE_DIR",
    "WASM_POSIX_DEP_SOURCE_DIR",
    "WASM_POSIX_DEP_SOURCE_SHA256",
    "WASM_POSIX_DEP_SOURCE_URL",
    "WASM_POSIX_DEP_TARGET_ARCH",
    "WASM_POSIX_DEP_VERSION",
    "WASM_POSIX_DEP_WORK_DIR",
    "WASM_POSIX_INSTALL_LOCAL_MIRROR",
}
FORBIDDEN_ENV_MARKERS = (
    "GITHUB_",
    "GH_",
    "TOKEN",
    "SECRET",
    "PASSWORD",
    "CREDENTIAL",
    "NIX_",
    "WASM_POSIX_BINARY_",
    "WASM_POSIX_DEPS_REGISTRY",
    "WASM_POSIX_LOCAL_BIN",
    "WASM_POSIX_XTASK",
    "HOMEBREW_KANDELO_TAP_RECIPE_",
)


class RunnerError(RuntimeError):
    """An expected fail-closed validation or execution error."""


def fail(message: str) -> None:
    raise RunnerError(message)


def strict_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            fail(f"JSON object repeats key {key!r}")
        result[key] = value
    return result


def reject_json_constant(value: str) -> None:
    fail(f"JSON contains non-finite number {value}")


def parse_json_bytes(data: bytes, label: str) -> Any:
    try:
        text = data.decode("utf-8", "strict")
        return json.loads(
            text,
            object_pairs_hook=strict_object,
            parse_constant=reject_json_constant,
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"{label} is not strict UTF-8 JSON: {error}")


def compact_json(value: Any) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    ).encode("utf-8")


def is_exact_integer(value: Any) -> bool:
    return type(value) is int


def is_exact_string_list(value: Any, *, limit: int) -> bool:
    return (
        type(value) is list
        and len(value) <= limit
        and all(type(item) is str for item in value)
        and value == sorted(set(value))
    )


def safe_text(value: str, *, allow_colon: bool = True) -> bool:
    if "\0" in value or any(
        ord(character) < 32
        or 127 <= ord(character) <= 159
        or 0xD800 <= ord(character) <= 0xDFFF
        for character in value
    ):
        return False
    return allow_colon or ":" not in value


def open_regular_file(
    path: Path,
    *,
    owner_uid: int,
    exact_mode: int,
    max_bytes: int,
    label: str,
) -> tuple[bytes, os.stat_result]:
    try:
        before = path.lstat()
    except OSError as error:
        fail(f"{label} is unavailable: {error}")
    if (
        not stat.S_ISREG(before.st_mode)
        or before.st_nlink != 1
        or before.st_uid != owner_uid
        or stat.S_IMODE(before.st_mode) != exact_mode
        or before.st_size < 1
        or before.st_size > max_bytes
    ):
        fail(f"{label} has unsafe ownership, mode, links, type, or size")
    flags = os.O_RDONLY | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        fd = os.open(path, flags)
    except OSError as error:
        fail(f"{label} cannot be opened safely: {error}")
    try:
        opened = os.fstat(fd)
        if file_identity(opened) != file_identity(before):
            fail(f"{label} changed before it was opened")
        chunks: list[bytes] = []
        remaining = max_bytes + 1
        while remaining:
            chunk = os.read(fd, min(1_048_576, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b"".join(chunks)
        if len(data) > max_bytes:
            fail(f"{label} exceeds its byte limit")
        opened_after = os.fstat(fd)
    finally:
        os.close(fd)
    try:
        after = path.lstat()
    except OSError as error:
        fail(f"{label} disappeared after it was read: {error}")
    if (
        file_identity(opened_after) != file_identity(before)
        or file_identity(after) != file_identity(before)
    ):
        fail(f"{label} changed while it was read")
    return data, before


def file_identity(value: os.stat_result) -> tuple[int, ...]:
    return (
        value.st_dev,
        value.st_ino,
        value.st_mode,
        value.st_nlink,
        value.st_uid,
        value.st_gid,
        value.st_size,
        value.st_mtime_ns,
        value.st_ctime_ns,
    )


def canonical_real_directory(
    value: Any,
    *,
    label: str,
    owner_uid: int | None = None,
    exact_mode: int | None = None,
) -> Path:
    if isinstance(value, Path):
        path = value
        rendered = str(value)
    elif type(value) is str:
        path = Path(value)
        rendered = value
    else:
        fail(f"{label} is not an absolute path")
    if not rendered.startswith("/") or not safe_text(rendered, allow_colon=False):
        fail(f"{label} is not one systemd-safe absolute path")
    try:
        before = path.lstat()
        resolved = path.resolve(strict=True)
    except OSError as error:
        fail(f"{label} is unavailable: {error}")
    if not stat.S_ISDIR(before.st_mode) or resolved != path:
        fail(f"{label} is not one canonical real directory")
    if owner_uid is not None and before.st_uid != owner_uid:
        fail(f"{label} has the wrong owner")
    if exact_mode is not None and stat.S_IMODE(before.st_mode) != exact_mode:
        fail(f"{label} has the wrong mode")
    return path


def canonical_real_file(
    value: Any,
    *,
    label: str,
    executable: bool = False,
) -> Path:
    if isinstance(value, Path):
        path = value
        rendered = str(value)
    elif type(value) is str:
        path = Path(value)
        rendered = value
    else:
        fail(f"{label} is not an absolute path")
    if not rendered.startswith("/") or not safe_text(rendered, allow_colon=False):
        fail(f"{label} is not one systemd-safe absolute path")
    try:
        before = path.lstat()
        resolved = path.resolve(strict=True)
    except OSError as error:
        fail(f"{label} is unavailable: {error}")
    if (
        not stat.S_ISREG(before.st_mode)
        or before.st_nlink != 1
        or resolved != path
        or (executable and stat.S_IMODE(before.st_mode) & 0o111 == 0)
    ):
        fail(f"{label} is not one canonical regular file")
    return path


def canonical_host_projection_source(
    value: Path, *, label: str, directory: bool
) -> Path:
    """Resolve one root-owned host path that may enter the service root."""
    try:
        resolved = value.resolve(strict=True)
        metadata = resolved.lstat()
    except OSError as error:
        fail(f"{label} is unavailable: {error}")
    expected_type = stat.S_ISDIR if directory else stat.S_ISREG
    if (
        not resolved.is_absolute()
        or not expected_type(metadata.st_mode)
        or metadata.st_uid != 0
        or metadata.st_gid != 0
        or stat.S_IMODE(metadata.st_mode) & 0o022
    ):
        fail(f"{label} has unsafe ownership, mode, or type")
    for ancestor in resolved.parents:
        ancestor_metadata = ancestor.lstat()
        ancestor_mode = stat.S_IMODE(ancestor_metadata.st_mode)
        sticky_root = (
            ancestor_metadata.st_uid == 0
            and ancestor_mode & stat.S_ISVTX
            and stat.S_ISDIR(ancestor_metadata.st_mode)
        )
        if (
            not stat.S_ISDIR(ancestor_metadata.st_mode)
            or ancestor_metadata.st_uid != 0
            or ancestor_metadata.st_gid != 0
            or (ancestor_mode & 0o022 and not sticky_root)
        ):
            fail(f"{label} has replaceable host ancestry")
    return resolved


def nix_store_requisites(config: dict[str, Any]) -> list[Path]:
    """Resolve the exact Nix closures needed by configured host tools."""
    store = Path("/nix/store")
    runtime_paths = [config["node_bin"], config["llvm_bin"]]
    selected = [path for path in runtime_paths if is_within(path, store)]
    if not selected:
        return []
    if len(selected) != len(runtime_paths):
        fail("configured host tools mix Nix and non-Nix runtime roots")

    # WHY: binding all of /nix/store would make every unrelated store object
    # visible to an untrusted tap recipe. Query the immutable closures outside
    # the service, then bind only those content-addressed roots into its empty
    # RootDirectory.
    profile_tool = Path("/nix/var/nix/profiles/default/bin/nix-store")
    try:
        tool = profile_tool.resolve(strict=True)
        metadata = tool.lstat()
    except OSError as error:
        fail(f"Nix closure query tool is unavailable: {error}")
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_uid != 0
        or stat.S_IMODE(metadata.st_mode) & 0o022
        or stat.S_IMODE(metadata.st_mode) & 0o111 == 0
        or not is_within(tool, store)
    ):
        fail("Nix closure query tool has unsafe ownership, mode, or location")
    tool_root = next(
        (parent for parent in tool.parents if parent.parent == store), None
    )
    if tool_root is None or not NIX_STORE_ROOT_RE.fullmatch(str(tool_root)):
        fail("Nix closure query tool left one content-addressed store root")
    canonical_real_directory(
        tool_root,
        label="Nix closure query tool root",
        owner_uid=0,
        exact_mode=0o555,
    )

    try:
        result = subprocess.run(
            [
                str(profile_tool),
                "--query",
                "--requisites",
                *(str(path) for path in selected),
            ],
            check=False,
            # Determinate Nix uses one multicall executable. Preserve the
            # trusted `nix-store` argv[0] while executing its already-resolved
            # immutable store object, so a profile switch cannot race this
            # query into different code.
            executable=str(tool),
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env={"LC_ALL": "C"},
            timeout=60,
        )
    except (OSError, subprocess.SubprocessError) as error:
        fail(f"Nix closure query failed: {error}")
    if result.returncode != 0 or len(result.stdout) > MAX_CONFIG_BYTES:
        fail("Nix closure query did not return one bounded closure")
    try:
        rendered_roots = result.stdout.decode("utf-8", "strict").splitlines()
    except UnicodeDecodeError:
        fail("Nix closure query returned non-UTF-8 paths")
    if (
        not rendered_roots
        or len(rendered_roots) > MAX_DEPENDENCY_KEGS
        or len(rendered_roots) != len(set(rendered_roots))
    ):
        fail("Nix closure query returned an empty, repeated, or oversized closure")

    roots: list[Path] = []
    for rendered in sorted(rendered_roots):
        if not NIX_STORE_ROOT_RE.fullmatch(rendered):
            fail("Nix closure query returned a path outside one store root")
        root = canonical_real_directory(
            rendered,
            label="Nix runtime closure root",
            owner_uid=0,
            exact_mode=0o555,
        )
        roots.append(root)
    if any(not any(is_within(path, root) for root in roots) for path in selected):
        fail("Nix closure omitted a configured host tool")
    return roots


def host_tool_projection(config: dict[str, Any]) -> list[tuple[Path, Path]]:
    """Select the immutable host runtime visible inside a recipe service."""
    projected: dict[str, tuple[Path, Path]] = {}
    # WHY: RootDirectory starts empty. These aliases provide the ordinary
    # Linux executable and loader paths without exposing the host root. Resolve
    # usr-merge symlinks on the host, then bind the real directory at the
    # conventional path inside the service.
    for rendered in ("/usr", "/bin", "/sbin", "/lib", "/lib64"):
        destination = Path(rendered)
        if not destination.exists():
            continue
        source = canonical_host_projection_source(
            destination, label=f"host runtime {rendered}", directory=True
        )
        projected[rendered] = (source, destination)

    runtime_paths = [config["node_bin"], config["llvm_bin"]]
    for root in nix_store_requisites(config):
        projected[str(root)] = (root, root)

    for path, label in (
        (config["node_bin"].parent, "configured Node runtime"),
        (config["llvm_bin"], "configured LLVM runtime"),
    ):
        if any(is_within(path, destination) for _, destination in projected.values()):
            continue
        source = canonical_host_projection_source(path, label=label, directory=True)
        projected[str(path)] = (source, path)

    alternatives = Path("/etc/alternatives")
    if alternatives.exists():
        projected[str(alternatives)] = (
            canonical_host_projection_source(
                alternatives, label="host alternatives", directory=True
            ),
            alternatives,
        )
    loader_cache = Path("/etc/ld.so.cache")
    if loader_cache.exists():
        projected[str(loader_cache)] = (
            canonical_host_projection_source(
                loader_cache, label="host loader cache", directory=False
            ),
            loader_cache,
        )
    return [projected[key] for key in sorted(projected)]


def prepare_mount_destination(
    service_root: Path, destination: Path, *, directory: bool
) -> None:
    """Create one inert mount point without following service-root symlinks."""
    rendered = str(destination)
    if (
        not destination.is_absolute()
        or destination == Path("/")
        or not safe_text(rendered, allow_colon=False)
        or ".." in PurePosixPath(rendered).parts
        or Path(os.path.normpath(rendered)) != destination
    ):
        fail("recipe service mount destination is unsafe")
    relative = destination.relative_to(Path("/"))
    current = service_root
    for component in relative.parts[:-1]:
        current = current / component
        try:
            metadata = current.lstat()
        except FileNotFoundError:
            current.mkdir(mode=0o755)
            os.chown(current, 0, 0)
            os.chmod(current, 0o755)
            continue
        if not stat.S_ISDIR(metadata.st_mode):
            fail(f"recipe service mount ancestry is not a directory: {destination}")

    mountpoint = service_root / relative
    try:
        metadata = mountpoint.lstat()
    except FileNotFoundError:
        if directory:
            mountpoint.mkdir(mode=0o755)
            os.chown(mountpoint, 0, 0)
            os.chmod(mountpoint, 0o755)
        else:
            descriptor = os.open(
                mountpoint,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC,
                0o444,
            )
            try:
                os.fchown(descriptor, 0, 0)
                os.fchmod(descriptor, 0o444)
            finally:
                os.close(descriptor)
        return
    if directory and not stat.S_ISDIR(metadata.st_mode):
        fail(f"recipe service directory mount point changed type: {destination}")
    if not directory and not stat.S_ISREG(metadata.st_mode):
        fail(f"recipe service file mount point changed type: {destination}")


def prepare_service_root(
    service_root: Path,
    readonly_binds: list[tuple[Path, Path]],
    readwrite_binds: list[tuple[Path, Path]],
) -> None:
    """Create the closed root into which systemd binds declared build inputs."""
    if os.geteuid() != 0:
        fail("recipe service root must be prepared by the root supervisor")
    if service_root.exists() or service_root.is_symlink():
        fail("recipe service root already exists")
    service_root.mkdir(mode=0o755)
    os.chown(service_root, 0, 0)
    os.chmod(service_root, 0o755)

    destinations: dict[str, tuple[Path, bool, bool]] = {}
    classified_binds = [
        (source, destination, False) for source, destination in readonly_binds
    ]
    classified_binds.extend(
        (source, destination, True) for source, destination in readwrite_binds
    )
    for source, destination, writable in classified_binds:
        rendered_source = str(source)
        if (
            not source.is_absolute()
            or not destination.is_absolute()
            or not safe_text(rendered_source, allow_colon=False)
            or ".." in PurePosixPath(rendered_source).parts
            or Path(os.path.normpath(rendered_source)) != source
        ):
            fail("recipe service bind path is not absolute")
        try:
            metadata = source.lstat()
        except OSError as error:
            fail(f"recipe service bind source is unavailable: {error}")
        if stat.S_ISDIR(metadata.st_mode):
            directory = True
        elif stat.S_ISREG(metadata.st_mode):
            directory = False
        else:
            fail(f"recipe service bind source has an unsupported type: {source}")
        key = str(destination)
        previous = destinations.get(key)
        if previous is not None and previous != (source, directory, writable):
            fail(f"recipe service bind destination is ambiguous: {destination}")
        destinations[key] = (source, directory, writable)

    # WHY: systemd creates private /dev, /proc, and /run mounts below this
    # skeleton. Empty root-owned anchors make their presence explicit while
    # leaving every unrelated host pathname absent.
    for path in (
        Path("/dev"),
        Path("/etc"),
        Path("/proc"),
        Path("/run"),
        Path("/sys"),
        Path("/tmp"),
    ):
        destinations.setdefault(str(path), (service_root, True, False))
    for rendered in sorted(destinations, key=lambda value: (value.count("/"), value)):
        _, directory, _ = destinations[rendered]
        prepare_mount_destination(
            service_root, Path(rendered), directory=directory
        )
    # Seal parents only after every nested destination exists. This avoids
    # depending on root's DAC override during construction and leaves no
    # writable backing directory if a bind mount is skipped.
    directories = [service_root]
    directories.extend(
        path
        for path in service_root.rglob("*")
        if path.is_dir() and not path.is_symlink()
    )
    for directory in sorted(directories, key=lambda path: len(path.parts), reverse=True):
        os.chown(directory, 0, 0)
        os.chmod(directory, 0o555)


def is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def normalize_config_paths(config: dict[str, Any]) -> None:
    """Separate host inputs from paths that exist only in the child service."""
    host_directory_keys = (
        "allowed_request_root",
        "native_cellar",
        "platform_host_root",
        "protected_root",
        "recipe_host_root",
        "sealed_root",
        "sysroot_host_root",
        "target_cellar",
    )
    for key in host_directory_keys:
        config[key] = canonical_real_directory(config[key], label=key)

    # WHY: these are mount destinations in the empty recipe-service root, not
    # host inputs. The supervisor deliberately runs with ProtectHome=yes, so a
    # production tap alias below /home must remain hidden until the inner
    # service binds the root-owned projection over this exact destination.
    for key in (
        "platform_alias_root",
        "recipe_alias_root",
        "sysroot_alias_root",
    ):
        config[key] = canonical_requested_path(config[key], label=key)


def validate_config(path: Path) -> dict[str, Any]:
    data, _ = open_regular_file(
        path,
        owner_uid=0,
        exact_mode=0o400,
        max_bytes=MAX_CONFIG_BYTES,
        label="recipe runner config",
    )
    config = parse_json_bytes(data, "recipe runner config")
    if (
        type(config) is not dict
        or set(config) != CONFIG_KEYS
        or compact_json(config) != data
    ):
        fail("recipe runner config has an unexpected schema")
    integer_keys = {"build_gid", "build_uid", "recipe_gid", "recipe_uid"}
    if any(not is_exact_integer(config[key]) or config[key] <= 0 for key in integer_keys):
        fail("recipe runner config has an invalid uid or gid")
    if len({config["build_uid"], config["recipe_uid"], 0}) != 3:
        fail("recipe and Formula identities are not distinct")
    for key in ("build_user", "recipe_user"):
        if type(config[key]) is not str or not re.fullmatch(
            r"[a-z_][a-z0-9_-]{0,31}", config[key]
        ):
            fail(f"recipe runner config has invalid {key}")
    if config["recipe_user"] != "kandelo-homebrew-recipe":
        fail("recipe runner config selected the wrong recipe identity")
    if config["arch"] not in {"wasm32", "wasm64"}:
        fail("recipe runner config has an invalid architecture")
    if type(config["formula"]) is not str or not FULL_FORMULA_RE.fullmatch(
        config["formula"]
    ):
        fail("recipe runner config has an invalid Formula")
    if type(config["version"]) is not str or not VERSION_RE.fullmatch(
        config["version"]
    ):
        fail("recipe runner config has an invalid version")
    for key in ("manifest_sha256", "source_sha256"):
        if type(config[key]) is not str or not SHA256_RE.fullmatch(config[key]):
            fail(f"recipe runner config has an invalid {key}")
    if (
        type(config["source_url"]) is not str
        or not config["source_url"].startswith("https://")
        or len(config["source_url"].encode("utf-8")) > 8_192
    ):
        fail("recipe runner config has an invalid source URL")
    for key in (
        "dependencies",
        "native_formulae",
        "native_requirement_formulae",
        "script_env_keys",
    ):
        values = config[key]
        if not is_exact_string_list(values, limit=128):
            fail(f"recipe runner config has an invalid {key}")
    if not all(FULL_FORMULA_RE.fullmatch(item) for item in config["dependencies"]):
        fail("recipe runner config has an invalid target dependency")
    if not all(
        FORMULA_RE.fullmatch(item)
        for item in [
            *config["native_formulae"],
            *config["native_requirement_formulae"],
        ]
    ):
        fail("recipe runner config has an invalid native Formula")
    if set(config["native_formulae"]) & set(config["native_requirement_formulae"]):
        fail("recipe runner config repeats a native Formula role")
    if not all(ENV_KEY_RE.fullmatch(item) for item in config["script_env_keys"]):
        fail("recipe runner config has an invalid script environment key")
    resources = config["resources"]
    if type(resources) is not list or len(resources) > MAX_RESOURCES:
        fail("recipe runner config has invalid resources")
    resource_names: list[str] = []
    for resource in resources:
        if (
            type(resource) is not dict
            or set(resource) != {"name", "source_sha256", "source_url"}
            or type(resource["name"]) is not str
            or not RESOURCE_NAME_RE.fullmatch(resource["name"])
            or type(resource["source_sha256"]) is not str
            or not SHA256_RE.fullmatch(resource["source_sha256"])
            or type(resource["source_url"]) is not str
            or not resource["source_url"].startswith("https://")
            or not safe_text(resource["source_url"])
            or len(resource["source_url"].encode("utf-8")) > 1_024
        ):
            fail("recipe runner config has an invalid resource identity")
        resource_names.append(resource["name"])
    if resource_names != sorted(resource_names):
        fail("recipe runner config resources are not canonical")
    resource_keys = [resource_env_key(name) for name in resource_names]
    if (
        len(resource_names) != len(set(resource_names))
        or len(resource_keys) != len(set(resource_keys))
        or set(resource_keys) & set(config["script_env_keys"])
    ):
        fail("recipe runner config has colliding resource identities")
    reject_dependency_resource_env_collisions(
        config["dependencies"], resource_names
    )
    if type(config["slice"]) is not str or not SLICE_RE.fullmatch(config["slice"]):
        fail("recipe runner config has an invalid systemd slice")
    if not isinstance(config["unit_prefix"], str) or not UNIT_RE.fullmatch(
        config["unit_prefix"]
    ):
        fail("recipe runner config has an invalid systemd unit prefix")

    normalize_config_paths(config)
    config["node_bin"] = canonical_real_file(
        config["node_bin"], label="configured Node", executable=True
    )
    for key in ("group_file", "passwd_file"):
        config[key] = canonical_real_file(config[key], label=key)
        identity_stat = config[key].lstat()
        if (
            identity_stat.st_uid != 0
            or identity_stat.st_gid != 0
            or identity_stat.st_nlink != 1
            or stat.S_IMODE(identity_stat.st_mode) != 0o444
        ):
            fail(f"{key} has unsafe ownership, links, or mode")
        if config[key].parent != config["protected_root"]:
            fail(f"{key} left the protected runner root")
    config["llvm_bin"] = canonical_real_directory(
        config["llvm_bin"], label="configured LLVM directory"
    )
    if config["protected_root"].parent != Path("/run/kandelo-homebrew-publisher"):
        fail("protected runner root left its fixed publisher anchor")
    if not re.fullmatch(r"build-[0-9a-f]{64}", config["protected_root"].name):
        fail("protected runner root has an invalid per-build identity")
    if config["sealed_root"] != config["protected_root"] / "sealed-outputs":
        fail("sealed output root left the protected runner root")
    anchor = config["protected_root"].parent
    anchor_parent = anchor.parent
    anchor_stat = anchor.lstat()
    anchor_parent_stat = anchor_parent.lstat()
    protected_stat = config["protected_root"].lstat()
    sealed_stat = config["sealed_root"].lstat()
    if (
        anchor_parent_stat.st_uid != 0
        or anchor_parent_stat.st_gid != 0
        or stat.S_IMODE(anchor_parent_stat.st_mode) & 0o022
        or anchor_stat.st_uid != 0
        or anchor_stat.st_gid != 0
        or stat.S_IMODE(anchor_stat.st_mode) != 0o711
        or protected_stat.st_uid != 0
        or protected_stat.st_gid != 0
        or stat.S_IMODE(protected_stat.st_mode) != 0o555
        or sealed_stat.st_uid != 0
        or sealed_stat.st_gid != 0
        or stat.S_IMODE(sealed_stat.st_mode) != 0o555
    ):
        fail("protected runner ancestry is writable or has unsafe ownership")
    if not is_within(config["platform_host_root"], config["protected_root"]):
        fail("platform projection left the protected runner root")
    expected_recipe_name = config["formula"].rpartition("/")[2]
    if config["recipe_alias_root"].name != expected_recipe_name:
        fail("recipe alias root differs from the selected Formula")
    if (
        config["recipe_host_root"] != config["protected_root"] / "selected-recipe"
        or config["recipe_host_root"] == config["recipe_alias_root"]
    ):
        fail("recipe host projection left the protected runner root")
    recipe_host_stat = config["recipe_host_root"].lstat()
    if (
        recipe_host_stat.st_uid != 0
        or recipe_host_stat.st_gid != 0
        or stat.S_IMODE(recipe_host_stat.st_mode) != 0o755
    ):
        fail("recipe host projection has unsafe ownership or mode")
    manifest_data, _ = open_regular_file(
        config["recipe_host_root"] / "recipe.json",
        owner_uid=0,
        exact_mode=0o644,
        max_bytes=MAX_RECIPE_MANIFEST_BYTES,
        label="projected tap recipe manifest",
    )
    if hashlib.sha256(manifest_data).hexdigest() != config["manifest_sha256"]:
        fail("projected tap recipe differs from the publisher attestation")
    config["recipe_entrypoint"] = canonical_requested_path(
        config["recipe_entrypoint"], label="configured recipe entrypoint"
    )
    if (
        config["recipe_entrypoint"].parent != config["recipe_alias_root"]
        and not is_within(config["recipe_entrypoint"], config["recipe_alias_root"])
    ):
        fail("recipe entrypoint left the selected recipe")
    return config


def canonical_requested_path(value: Any, *, label: str) -> Path:
    if (
        type(value) is not str
        or not value.startswith("/")
        or not safe_text(value, allow_colon=False)
        or len(value.encode("utf-8")) > EXPECTED_LIMITS["max_path_bytes"]
    ):
        fail(f"{label} is not one bounded absolute path")
    normalized = Path(os.path.normpath(value))
    if str(normalized) != value:
        fail(f"{label} is not canonical")
    return normalized


def dependency_env_key(full_name: str) -> str:
    short = full_name.rpartition("/")[2]
    return "WASM_POSIX_DEP_" + re.sub(r"[^A-Z0-9]", "_", short.upper()) + "_DIR"


def resource_env_key(name: str) -> str:
    return (
        "WASM_POSIX_DEP_RESOURCE_"
        + re.sub(r"[^A-Z0-9]", "_", name.upper())
        + "_DIR"
    )


def resource_guest_root(name: str) -> Path:
    return Path("/kandelo/resources") / name


def reject_dependency_resource_env_collisions(
    dependencies: list[str],
    resource_names: list[str],
) -> None:
    dependency_keys = {dependency_env_key(name) for name in dependencies}
    resource_keys = {resource_env_key(name) for name in resource_names}
    collisions = sorted(dependency_keys & resource_keys)
    if collisions:
        fail(
            "tap recipe dependency and resource paths collide: "
            f"{collisions!r}"
        )


def validate_requested_resources(
    request: dict[str, Any],
    config: dict[str, Any],
    build_root: Path,
) -> dict[str, Path]:
    supplied = request["resources"]
    expected_names = [resource["name"] for resource in config["resources"]]
    if (
        type(supplied) is not dict
        or not all(
            type(name) is str and type(path) is str
            for name, path in supplied.items()
        )
        or sorted(supplied) != expected_names
    ):
        fail("tap recipe request has the wrong resources")

    resource_root = build_root / "kandelo-package-resources"
    if not expected_names:
        if resource_root.exists() or resource_root.is_symlink():
            fail("resource staging root exists without an attested resource")
        return {}

    canonical_real_directory(
        resource_root,
        label="Formula resource staging root",
        owner_uid=config["build_uid"],
    )
    actual_names = sorted(entry.name for entry in resource_root.iterdir())
    if actual_names != expected_names:
        fail("Formula resource staging root has missing or extra resources")

    selected: dict[str, Path] = {}
    for name in expected_names:
        expected = resource_root / name
        supplied_path = canonical_requested_path(
            supplied[name], label=f"Formula resource {name}"
        )
        if supplied_path != expected:
            fail(f"Formula resource {name} left the reserved staging layout")
        canonical_real_directory(
            expected,
            label=f"Formula resource {name}",
            owner_uid=config["build_uid"],
        )
        selected[name] = expected
    return selected


def capture_resource_staging_identity(
    build_root: Path,
    resources: dict[str, Path],
) -> ResourceStagingIdentity | None:
    if not resources:
        return None
    resource_root = build_root / "kandelo-package-resources"
    try:
        root_identity = file_identity(resource_root.lstat())
        child_identities = {
            name: file_identity(path.lstat())
            for name, path in sorted(resources.items())
        }
    except OSError as error:
        fail(f"Formula resource staging identity is unavailable: {error}")
    return root_identity, child_identities


def require_resource_staging_identity(
    build_root: Path,
    resources: dict[str, Path],
    expected: ResourceStagingIdentity | None,
) -> None:
    if capture_resource_staging_identity(build_root, resources) != expected:
        fail("Formula resource staging identity changed")


def versioned_keg_roots(cellar: Path, formulae: list[str], label: str) -> dict[str, Path]:
    result: dict[str, Path] = {}
    for formula in formulae:
        rack = canonical_real_directory(
            cellar / formula,
            label=f"{label} rack {formula}",
            owner_uid=0,
            exact_mode=0o555,
        )
        if rack.parent != cellar:
            fail(f"{label} rack escaped the Cellar")
        children = sorted(rack.iterdir(), key=lambda path: path.name)
        if len(children) != 1:
            fail(f"{label} Formula {formula} does not have exactly one selected keg")
        keg = canonical_real_directory(
            children[0],
            label=f"{label} keg {formula}",
            owner_uid=0,
            exact_mode=0o555,
        )
        if keg.parent != rack:
            fail(f"{label} keg escaped its rack")
        result[formula] = keg
    return result


def installed_keg_roots(cellar: Path, label: str) -> dict[str, Path]:
    """Return the complete sealed Formula closure installed in one Cellar."""
    cellar = canonical_real_directory(
        cellar, label=f"{label} Cellar", owner_uid=0
    )
    cellar_mode = stat.S_IMODE(cellar.lstat().st_mode)
    if cellar_mode not in {0o555, 0o1775}:
        fail(f"{label} Cellar has an unsafe mode")
    names: list[str] = []
    for child in sorted(cellar.iterdir(), key=lambda path: path.name):
        if len(names) >= MAX_DEPENDENCY_KEGS:
            fail(f"{label} Cellar exceeds the keg limit")
        if not FORMULA_RE.fullmatch(child.name):
            fail(f"{label} Cellar contains an invalid Formula name")
        names.append(child.name)
    return versioned_keg_roots(cellar, names, label)


def validate_sealed_dependency_tree(root: Path, label: str) -> None:
    """Require one dependency keg to be an immutable root-owned tree."""
    directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        directory_flags |= os.O_NOFOLLOW
    root_fd = os.open(root, directory_flags)
    root_stat = os.fstat(root_fd)
    pending: list[tuple[int, str, os.stat_result]] = [(root_fd, "", root_stat)]
    entries = 0
    total_bytes = 0
    while pending:
        current_fd, relative_dir, expected_directory = pending.pop()
        try:
            if file_identity(os.fstat(current_fd)) != file_identity(expected_directory):
                fail(f"{label} directory changed before inspection")
            names = sorted(os.listdir(current_fd))
            entries += len(names)
            if entries > EXPECTED_LIMITS["max_entries"]:
                fail(f"{label} exceeds the entry limit")
            for name in names:
                relative = f"{relative_dir}/{name}" if relative_dir else name
                safe_relative_path(relative, EXPECTED_LIMITS["max_path_bytes"])
                before = os.stat(name, dir_fd=current_fd, follow_symlinks=False)
                mode = stat.S_IMODE(before.st_mode)
                if before.st_dev != root_stat.st_dev:
                    fail(f"{label} crosses a filesystem: {relative}")
                if before.st_uid != 0 or before.st_gid != 0:
                    fail(f"{label} has unsafe ownership: {relative}")
                if not stat.S_ISLNK(before.st_mode) and (
                    mode & 0o222 or mode & 0o7000
                ):
                    fail(f"{label} has an unsafe mode: {relative}")
                if stat.S_ISDIR(before.st_mode):
                    if mode != 0o555:
                        fail(f"{label} directory has a noncanonical mode: {relative}")
                    child_fd = os.open(name, directory_flags, dir_fd=current_fd)
                    if file_identity(os.fstat(child_fd)) != file_identity(before):
                        os.close(child_fd)
                        fail(f"{label} directory changed during inspection: {relative}")
                    pending.append((child_fd, relative, before))
                elif stat.S_ISREG(before.st_mode):
                    if mode not in {0o444, 0o555}:
                        fail(f"{label} file has a noncanonical mode: {relative}")
                    total_bytes += before.st_size
                    if (
                        before.st_size > EXPECTED_LIMITS["max_file_bytes"]
                        or total_bytes > EXPECTED_LIMITS["max_bytes"]
                    ):
                        fail(f"{label} exceeds its byte limit")
                elif stat.S_ISLNK(before.st_mode):
                    target = os.readlink(name, dir_fd=current_fd)
                    if (
                        not target
                        or not safe_text(target, allow_colon=False)
                        or len(target.encode("utf-8", "strict"))
                        > EXPECTED_LIMITS["max_path_bytes"]
                    ):
                        fail(f"{label} has an unsafe symlink: {relative}")
                    after = os.stat(
                        name, dir_fd=current_fd, follow_symlinks=False
                    )
                    if (
                        file_identity(after) != file_identity(before)
                        or os.readlink(name, dir_fd=current_fd) != target
                    ):
                        fail(f"{label} symlink changed during inspection: {relative}")
                else:
                    fail(f"{label} contains an unsupported node: {relative}")
            if file_identity(os.fstat(current_fd)) != file_identity(
                expected_directory
            ):
                fail(f"{label} directory changed during inspection")
        finally:
            os.close(current_fd)
            if sys.exc_info()[0] is not None:
                while pending:
                    pending_fd, _, _ = pending.pop()
                    os.close(pending_fd)


def validate_environment(
    request: dict[str, Any],
    config: dict[str, Any],
    dependencies: dict[str, Path],
    native_roots: list[Path],
    requirement_roots: list[Path],
) -> dict[str, str]:
    environment = request["environment"]
    if type(environment) is not dict or len(environment) > 512:
        fail("recipe environment is not one bounded object")
    total = 0
    for key, value in environment.items():
        if (
            type(key) is not str
            or not ENV_KEY_RE.fullmatch(key)
            or type(value) is not str
            or not safe_text(value)
        ):
            fail("recipe environment contains an invalid key or value")
        encoded = value.encode("utf-8")
        if len(encoded) > 8_192:
            fail(f"recipe environment value is oversized: {key}")
        total += len(key.encode("utf-8")) + len(encoded)
        upper = key.upper()
        if any(marker in upper for marker in FORBIDDEN_ENV_MARKERS):
            fail(f"recipe environment retained forbidden authority: {key}")
    if total > 262_144:
        fail("recipe environment exceeds its total byte limit")

    dependency_keys = set(dependencies)
    resource_keys = {
        resource_env_key(resource["name"])
        for resource in config["resources"]
    }
    allowed = (
        SAFE_FIXED_ENV_KEYS
        | HELPER_ENV_KEYS
        | dependency_keys
        | resource_keys
        | set(config["script_env_keys"])
    )
    unexpected = sorted(set(environment) - allowed)
    if unexpected:
        fail(f"recipe environment contains unexpected keys: {unexpected!r}")
    required = {
        "HOME",
        "LOGNAME",
        "PATH",
        "TMPDIR",
        "USER",
        "WASM_POSIX_DEP_NAME",
        "WASM_POSIX_DEP_OUT_DIR",
        "WASM_POSIX_DEP_RECIPE_DIR",
        "WASM_POSIX_DEP_SOURCE_DIR",
        "WASM_POSIX_DEP_SOURCE_SHA256",
        "WASM_POSIX_DEP_SOURCE_URL",
        "WASM_POSIX_DEP_TARGET_ARCH",
        "WASM_POSIX_DEP_VERSION",
        "WASM_POSIX_DEP_WORK_DIR",
        "WASM_POSIX_GLUE_DIR",
        "WASM_POSIX_INSTALL_LOCAL_MIRROR",
        "WASM_POSIX_LLVM_DIR",
        "WASM_POSIX_SYSROOT",
    } | dependency_keys | resource_keys | set(config["script_env_keys"])
    missing = sorted(required - set(environment))
    if missing:
        fail(f"recipe environment omits required keys: {missing!r}")

    formula_short = config["formula"].rpartition("/")[2]
    expected = {
        "HOME": str(request["work_root"] / "home"),
        "LOGNAME": config["recipe_user"],
        "TMPDIR": str(request["work_root"] / "tmp"),
        "USER": config["recipe_user"],
        "WASM_POSIX_DEP_NAME": formula_short,
        "WASM_POSIX_DEP_OUT_DIR": str(request["output_root"]),
        "WASM_POSIX_DEP_RECIPE_DIR": str(request["recipe_root"]),
        "WASM_POSIX_DEP_SOURCE_DIR": str(request["source_root"]),
        "WASM_POSIX_DEP_SOURCE_SHA256": config["source_sha256"],
        "WASM_POSIX_DEP_SOURCE_URL": config["source_url"],
        "WASM_POSIX_DEP_TARGET_ARCH": config["arch"],
        "WASM_POSIX_DEP_VERSION": config["version"],
        "WASM_POSIX_DEP_WORK_DIR": str(request["work_root"]),
        "WASM_POSIX_GLUE_DIR": str(request["platform_root"] / "libc/glue"),
        "WASM_POSIX_INSTALL_LOCAL_MIRROR": "0",
        "WASM_POSIX_LLVM_DIR": str(config["llvm_bin"]),
        "WASM_POSIX_SYSROOT": str(request["sysroot"]),
    }
    for key, value in dependencies.items():
        expected[key] = str(value)
    for resource in config["resources"]:
        name = resource["name"]
        expected[resource_env_key(name)] = str(resource_guest_root(name))
    for key, value in expected.items():
        if environment.get(key) != value:
            fail(f"recipe environment has the wrong protected value: {key}")
    if "LLVM_BIN" in environment and environment["LLVM_BIN"] != str(config["llvm_bin"]):
        fail("recipe environment has the wrong LLVM_BIN")
    fork_tool = request["platform_root"] / "tools/bin/wasm-fork-instrument"
    spill_tool = request["platform_root"] / "tools/bin/wasm-local-root-spill"
    if (
        environment.get("WASM_POSIX_FORK_INSTRUMENT") not in (None, str(fork_tool))
        or environment.get("WASM_POSIX_LOCAL_ROOT_SPILL") not in (None, str(spill_tool))
    ):
        fail("recipe environment changed a sealed platform tool")

    allowed_path_entries = {
        Path("/usr/bin"),
        Path("/bin"),
        request["platform_root"] / "sdk/bin",
        request["platform_root"] / "tools/bin",
        config["node_bin"].parent,
        config["llvm_bin"],
    }
    for root in [*native_roots, *requirement_roots]:
        for suffix in ("bin", "sbin", "libexec/bin"):
            candidate = root / suffix
            if candidate.is_dir() and not candidate.is_symlink():
                allowed_path_entries.add(candidate)
    entries = environment["PATH"].split(":")
    if not entries or len(entries) > 512 or any(not item for item in entries):
        fail("recipe PATH is empty, repeated, or oversized")
    if len(entries) != len(set(entries)):
        fail("recipe PATH repeats an entry")
    for item in entries:
        path = canonical_requested_path(item, label="recipe PATH entry")
        if path not in allowed_path_entries:
            fail(f"recipe PATH contains an undeclared tool root: {path}")
    return environment


def validate_request(
    request_path: Path,
    response_path: Path,
    config: dict[str, Any],
    parent_fd: int,
) -> tuple[
    dict[str, Any],
    bytes,
    dict[str, Path],
    dict[str, Path],
    ResourceStagingIdentity | None,
    list[Path],
    list[Path],
    list[tuple[Path, Path]],
]:
    allowed_root = config["allowed_request_root"]
    if request_path.name != ".kandelo-tap-recipe-request.json":
        fail("recipe request uses the wrong reserved basename")
    if response_path.name != ".kandelo-tap-recipe-response.json":
        fail("recipe response uses the wrong reserved basename")
    if request_path.parent != response_path.parent:
        fail("recipe request and response do not share one build root")
    try:
        build_root = request_path.parent.resolve(strict=True)
    except OSError as error:
        fail(f"recipe build root is unavailable: {error}")
    if build_root != request_path.parent or not is_within(build_root, allowed_root):
        fail("recipe build root left the publisher's mutable build root")
    try:
        os.stat(response_path.name, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        pass
    else:
        fail("recipe response already exists")
    request_before = os.stat(
        request_path.name, dir_fd=parent_fd, follow_symlinks=False
    )
    if request_before.st_uid != config["build_uid"]:
        fail("tap recipe request has the wrong owner")
    data = read_regular_at(
        parent_fd,
        request_path.name,
        request_before,
        max_bytes=MAX_REQUEST_BYTES,
        expected_mode=0o400,
        label="tap recipe request",
    )
    request = parse_json_bytes(data, "tap recipe request")
    if (
        type(request) is not dict
        or set(request) != REQUEST_KEYS
        or not is_exact_integer(request["schema"])
        or request["schema"] != 1
        or type(request["limits"]) is not dict
        or set(request["limits"]) != set(EXPECTED_LIMITS)
        or any(
            not is_exact_integer(request["limits"][key])
            for key in EXPECTED_LIMITS
        )
        or request["limits"] != EXPECTED_LIMITS
        or compact_json(request) != data
    ):
        fail("tap recipe request has an unexpected schema")
    for key in (
        "entrypoint",
        "output_root",
        "platform_root",
        "recipe_root",
        "source_root",
        "sysroot",
        "work_root",
    ):
        request[key] = canonical_requested_path(request[key], label=key)
    if (
        request["formula"] != config["formula"]
        or request["arch"] != config["arch"]
        or request["version"] != config["version"]
        or request["manifest_sha256"] != config["manifest_sha256"]
        or request["entrypoint"] != config["recipe_entrypoint"]
        or request["recipe_root"] != config["recipe_alias_root"]
        or request["platform_root"] != config["platform_alias_root"]
        or request["sysroot"] != config["sysroot_alias_root"]
    ):
        fail("tap recipe request differs from its publisher attestation")
    expected_build_children = {
        "source_root": "kandelo-package-source",
        "work_root": "kandelo-package-work",
        "output_root": "kandelo-package-out",
    }
    for key, basename in expected_build_children.items():
        if request[key].parent != build_root or request[key].name != basename:
            fail(f"{key} left the reserved Formula build layout")
        canonical_real_directory(request[key], label=key)
    for key in ("work_root", "output_root"):
        if any(request[key].iterdir()):
            fail(f"{key} must be empty before recipe execution")
    resources = validate_requested_resources(request, config, build_root)
    resource_staging_identity = capture_resource_staging_identity(
        build_root, resources
    )

    expected_dependency_names = config["dependencies"]
    expected_dependency_keys = {
        dependency_env_key(name): name for name in expected_dependency_names
    }
    if len(expected_dependency_keys) != len(expected_dependency_names):
        fail("attested target dependency names collide in the recipe environment")
    supplied_dependencies = request["dependencies"]
    if (
        type(supplied_dependencies) is not dict
        or not all(
            type(key) is str and type(value) is str
            for key, value in supplied_dependencies.items()
        )
        or set(supplied_dependencies) != set(expected_dependency_keys)
    ):
        fail("tap recipe request has the wrong target dependencies")
    all_target_kegs = installed_keg_roots(
        config["target_cellar"], "target dependency"
    )
    expected_target_names = [name.rpartition("/")[2] for name in expected_dependency_names]
    missing_target_names = sorted(set(expected_target_names) - set(all_target_kegs))
    if missing_target_names:
        fail(f"target Cellar omits declared dependencies: {missing_target_names!r}")
    target_kegs = {name: all_target_kegs[name] for name in expected_target_names}
    dependencies: dict[str, Path] = {}
    for key, full_name in expected_dependency_keys.items():
        short = full_name.rpartition("/")[2]
        supplied = canonical_requested_path(
            supplied_dependencies[key], label=f"target dependency {full_name}"
        )
        if supplied != target_kegs[short]:
            fail(f"tap recipe request changed target dependency {full_name}")
        dependencies[key] = supplied

    all_native_kegs = installed_keg_roots(
        config["native_cellar"], "native dependency"
    )
    expected_native_names = sorted(
        {*config["native_formulae"], *config["native_requirement_formulae"]}
    )
    if sorted(all_native_kegs) != expected_native_names:
        fail("native Cellar differs from its complete declared tool closure")
    native_kegs = {
        name: all_native_kegs[name] for name in config["native_formulae"]
    }
    requirement_kegs = {
        name: all_native_kegs[name]
        for name in config["native_requirement_formulae"]
    }
    supplied_native = request["native_roots"]
    expected_native = sorted(str(path) for path in native_kegs.values())
    if (
        type(supplied_native) is not list
        or not all(type(item) is str for item in supplied_native)
        or supplied_native != expected_native
        or len(supplied_native) != len(set(supplied_native))
    ):
        fail("tap recipe request changed its declared native tool roots")
    native_roots = [
        canonical_real_directory(path, label="native tool root")
        for path in supplied_native
    ]
    requirement_roots = list(requirement_kegs.values())
    sealed_roots = {
        **{
            str(path): (path, f"target dependency {name}")
            for name, path in all_target_kegs.items()
        },
        **{
            str(path): (path, f"native dependency {name}")
            for name, path in all_native_kegs.items()
        },
    }
    for _, (root, label) in sorted(sealed_roots.items()):
        validate_sealed_dependency_tree(root, label)
    validate_environment(
        request, config, dependencies, native_roots, requirement_roots
    )
    # WHY: Homebrew's target Cellar and opt directory must remain writable
    # until it installs the selected Formula. Never bind those mutable parents.
    # Mount each sealed keg twice: at its canonical Cellar path and at the opt
    # alias the toolchain expects. This supplies the complete closure without
    # trusting build-user-created opt links or exposing an undeclared rack.
    dependency_binds: list[tuple[Path, Path]] = []
    for cellar, kegs in (
        (config["target_cellar"], all_target_kegs),
        (config["native_cellar"], all_native_kegs),
    ):
        for name, keg in kegs.items():
            dependency_binds.append((keg, keg))
            dependency_binds.append((keg, cellar.parent / "opt" / name))
    dependency_binds.sort(key=lambda pair: (str(pair[1]), str(pair[0])))
    return (
        request,
        data,
        dependencies,
        resources,
        resource_staging_identity,
        native_roots,
        requirement_roots,
        dependency_binds,
    )


def safe_relative_path(relative: str, limit: int) -> None:
    try:
        encoded = relative.encode("utf-8", "strict")
    except UnicodeEncodeError:
        fail(f"tree contains an unsafe path: {relative!r}")
    if (
        len(encoded) > limit
        or not safe_text(relative, allow_colon=False)
    ):
        fail(f"tree contains an unsafe or oversized path: {relative!r}")


def contained_symlink(relative: str, target: str, limit: int) -> None:
    safe_relative_path(relative, limit)
    if (
        not target
        or target.startswith("/")
        or not safe_text(target, allow_colon=False)
        or len(target.encode("utf-8", "strict")) > limit
    ):
        fail(f"tree contains an unsafe symlink target: {relative!r}")
    destination = PurePosixPath(relative).parent.joinpath(PurePosixPath(target))
    depth = 0
    for component in destination.parts:
        if component in ("", "."):
            continue
        if component == "..":
            depth -= 1
        else:
            depth += 1
        if depth < 0:
            fail(f"tree symlink escapes its root: {relative!r}")


def recipe_relative_path(value: Any, *, label: str) -> str:
    try:
        encoded = value.encode("ascii", "strict") if type(value) is str else b""
    except UnicodeEncodeError:
        encoded = b""
    if (
        type(value) is not str
        or not 1 <= len(encoded) <= 1_024
        or value.startswith("/")
        or value.endswith("/")
        or "\\" in value
    ):
        fail(f"{label} is not one canonical relative path")
    components = value.split("/")
    if any(
        component in {".", ".."}
        or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,254}", component)
        for component in components
    ):
        fail(f"{label} is not one canonical relative path")
    return value


def read_regular_at(
    parent_fd: int,
    name: str,
    before: os.stat_result,
    *,
    max_bytes: int,
    expected_mode: int,
    label: str,
) -> bytes:
    if (
        not stat.S_ISREG(before.st_mode)
        or before.st_nlink != 1
        or stat.S_IMODE(before.st_mode) != expected_mode
        or before.st_size < 0
        or before.st_size > max_bytes
    ):
        fail(f"{label} has unsafe type, links, mode, or size")
    flags = os.O_RDONLY | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    if hasattr(os, "O_NONBLOCK"):
        flags |= os.O_NONBLOCK
    try:
        fd = os.open(name, flags, dir_fd=parent_fd)
    except OSError as error:
        fail(f"{label} cannot be opened safely: {error}")
    try:
        opened = os.fstat(fd)
        if file_identity(opened) != file_identity(before):
            fail(f"{label} changed before it was opened")
        chunks: list[bytes] = []
        copied = 0
        while True:
            chunk = os.read(fd, min(1_048_576, max_bytes + 1 - copied))
            if not chunk:
                break
            copied += len(chunk)
            if copied > max_bytes or copied > before.st_size:
                fail(f"{label} grew while it was read")
            chunks.append(chunk)
        after = os.fstat(fd)
    finally:
        os.close(fd)
    if copied != before.st_size or file_identity(after) != file_identity(before):
        fail(f"{label} changed while it was read")
    return b"".join(chunks)


def write_regular_at(
    parent_fd: int,
    name: str,
    data: bytes,
    *,
    mode: int,
    label: str,
) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        fd = os.open(name, flags, mode, dir_fd=parent_fd)
    except OSError as error:
        fail(f"{label} cannot be created safely: {error}")
    try:
        view = memoryview(data)
        while view:
            written = os.write(fd, view)
            if written <= 0:
                fail(f"{label} could not be written completely")
            view = view[written:]
        os.fchown(fd, 0, 0)
        os.fchmod(fd, mode)
        os.fsync(fd)
    finally:
        os.close(fd)


def stage_recipe(
    source_value: str,
    destination_value: str,
    formula: str,
    manifest_sha256: str,
) -> int:
    """Copy exactly one manifest-closed recipe into the root-owned boundary."""
    if os.geteuid() != 0:
        fail("tap recipe staging must run as root")
    if not FORMULA_RE.fullmatch(formula) or not SHA256_RE.fullmatch(manifest_sha256):
        fail("tap recipe staging received an invalid identity")
    runner = Path(__file__).resolve(strict=True)
    destination = Path(destination_value)
    if destination != runner.parent / "selected-recipe":
        fail("tap recipe projection left the protected runner root")
    if destination.exists() or destination.is_symlink():
        fail("tap recipe projection destination is occupied")
    source = canonical_real_directory(source_value, label="selected tap recipe")
    if source.name != formula:
        fail("selected tap recipe differs from the Formula")

    source_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        source_flags |= os.O_NOFOLLOW
    source_fd = os.open(source, source_flags)
    destination_fd = -1
    try:
        source_root_stat = os.fstat(source_fd)
        if stat.S_IMODE(source_root_stat.st_mode) != 0o755:
            fail("selected tap recipe root must have mode 0755")
        manifest_before = os.stat(
            "recipe.json", dir_fd=source_fd, follow_symlinks=False
        )
        manifest_bytes = read_regular_at(
            source_fd,
            "recipe.json",
            manifest_before,
            max_bytes=MAX_RECIPE_MANIFEST_BYTES,
            expected_mode=0o644,
            label="tap recipe manifest",
        )
        if hashlib.sha256(manifest_bytes).hexdigest() != manifest_sha256:
            fail("tap recipe manifest differs from the publisher attestation")
        manifest = parse_json_bytes(manifest_bytes, "tap recipe manifest")
        if (
            type(manifest) is not dict
            or set(manifest) != {"dependencies", "entrypoint", "files", "schema"}
            or not is_exact_integer(manifest["schema"])
            or manifest["schema"] != 1
            or not is_exact_string_list(manifest["dependencies"], limit=128)
            or type(manifest["files"]) is not list
            or not 1 <= len(manifest["files"]) <= MAX_RECIPE_FILES
        ):
            fail("tap recipe manifest has an unexpected schema")
        if not all(FULL_FORMULA_RE.fullmatch(item) for item in manifest["dependencies"]):
            fail("tap recipe manifest contains an invalid dependency")
        entrypoint = recipe_relative_path(
            manifest["entrypoint"], label="tap recipe entrypoint"
        )
        if not entrypoint.endswith(".sh"):
            fail("tap recipe entrypoint is not a shell script")

        expected_files: dict[str, tuple[int, int, str]] = {}
        expected_directories = {""}
        total_bytes = 0
        for record in manifest["files"]:
            if (
                type(record) is not dict
                or set(record) != {"bytes", "mode", "path", "sha256"}
                or not is_exact_integer(record["bytes"])
                or not 0 <= record["bytes"] <= MAX_RECIPE_FILE_BYTES
                or type(record["mode"]) is not str
                or record["mode"] not in {"0644", "0755"}
                or type(record["sha256"]) is not str
                or not SHA256_RE.fullmatch(record["sha256"])
            ):
                fail("tap recipe manifest contains an invalid file record")
            relative = recipe_relative_path(
                record["path"], label="tap recipe file"
            )
            if relative in expected_files:
                fail(f"tap recipe manifest repeats {relative}")
            expected_files[relative] = (
                record["bytes"],
                int(record["mode"], 8),
                record["sha256"],
            )
            parent = PurePosixPath(relative).parent
            while str(parent) != ".":
                expected_directories.add(str(parent))
                parent = parent.parent
            total_bytes += record["bytes"]
            if total_bytes > MAX_RECIPE_BYTES:
                fail("tap recipe exceeds its total byte limit")
        if (
            list(expected_files) != sorted(expected_files)
            or entrypoint not in expected_files
        ):
            fail("tap recipe manifest has a noncanonical file closure")

        os.mkdir(destination, 0o755)
        os.chown(destination, 0, 0)
        destination_fd = os.open(destination, source_flags)
        os.fchmod(destination_fd, 0o755)
        write_regular_at(
            destination_fd,
            "recipe.json",
            manifest_bytes,
            mode=0o644,
            label="projected tap recipe manifest",
        )

        actual_files: set[str] = set()
        actual_directories = {""}
        stack: list[tuple[int, int, str]] = [
            (os.dup(source_fd), os.dup(destination_fd), "")
        ]
        visited_entries = 0
        try:
            while stack:
                current_source_fd, current_destination_fd, relative_dir = stack.pop()
                try:
                    names = os.listdir(current_source_fd)
                    visited_entries += len(names)
                    if visited_entries > MAX_RECIPE_FILES + len(expected_directories) + 1:
                        fail("tap recipe tree exceeds its manifest closure")
                    for name in sorted(names):
                        relative = f"{relative_dir}/{name}" if relative_dir else name
                        recipe_relative_path(relative, label="tap recipe tree entry")
                        before = os.stat(
                            name,
                            dir_fd=current_source_fd,
                            follow_symlinks=False,
                        )
                        if before.st_dev != source_root_stat.st_dev:
                            fail(f"tap recipe crosses a filesystem: {relative}")
                        if stat.S_ISDIR(before.st_mode):
                            if (
                                relative not in expected_directories
                                or stat.S_IMODE(before.st_mode) != 0o755
                            ):
                                fail(f"tap recipe has an unexpected directory: {relative}")
                            child_source_fd = os.open(
                                name, source_flags, dir_fd=current_source_fd
                            )
                            if file_identity(os.fstat(child_source_fd)) != file_identity(before):
                                os.close(child_source_fd)
                                fail(f"tap recipe directory changed: {relative}")
                            os.mkdir(name, 0o755, dir_fd=current_destination_fd)
                            child_destination_fd = os.open(
                                name, source_flags, dir_fd=current_destination_fd
                            )
                            os.fchown(child_destination_fd, 0, 0)
                            os.fchmod(child_destination_fd, 0o755)
                            actual_directories.add(relative)
                            stack.append(
                                (
                                    child_source_fd,
                                    child_destination_fd,
                                    relative,
                                )
                            )
                        elif stat.S_ISREG(before.st_mode):
                            if relative == "recipe.json":
                                if file_identity(before) != file_identity(manifest_before):
                                    fail("tap recipe manifest changed during staging")
                                continue
                            expected = expected_files.get(relative)
                            if expected is None:
                                fail(f"tap recipe has an unexpected file: {relative}")
                            expected_bytes, expected_mode, expected_sha256 = expected
                            data = read_regular_at(
                                current_source_fd,
                                name,
                                before,
                                max_bytes=MAX_RECIPE_FILE_BYTES,
                                expected_mode=expected_mode,
                                label=f"tap recipe file {relative}",
                            )
                            if (
                                len(data) != expected_bytes
                                or hashlib.sha256(data).hexdigest()
                                != expected_sha256
                            ):
                                fail(f"tap recipe file differs from its manifest: {relative}")
                            write_regular_at(
                                current_destination_fd,
                                name,
                                data,
                                mode=expected_mode,
                                label=f"projected tap recipe file {relative}",
                            )
                            actual_files.add(relative)
                        else:
                            fail(f"tap recipe contains an unsupported node: {relative}")
                    os.fsync(current_destination_fd)
                finally:
                    os.close(current_source_fd)
                    os.close(current_destination_fd)
        finally:
            for pending_source_fd, pending_destination_fd, _ in stack:
                os.close(pending_source_fd)
                os.close(pending_destination_fd)
        if actual_files != set(expected_files) or actual_directories != expected_directories:
            fail("tap recipe tree differs from its closed manifest")
        if file_identity(os.fstat(source_fd)) != file_identity(source_root_stat):
            fail("tap recipe root changed while it was staged")
        os.fsync(destination_fd)
        if os.fstat(destination_fd).st_ino == source_root_stat.st_ino:
            fail("tap recipe projection aliases its source")
        return 0
    except BaseException:
        if destination.exists() and destination.parent == runner.parent:
            shutil.rmtree(destination, ignore_errors=True)
        raise
    finally:
        if destination_fd >= 0:
            os.close(destination_fd)
        os.close(source_fd)


def copy_input_tree(
    source: Path,
    destination: Path,
    limits: dict[str, int],
    *,
    expected_root_identity: tuple[int, ...] | None = None,
) -> tuple[int, int]:
    destination.mkdir(mode=0o700)
    entries = 0
    total_bytes = 0
    directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC
    file_flags = os.O_RDONLY | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        directory_flags |= os.O_NOFOLLOW
        file_flags |= os.O_NOFOLLOW
    if hasattr(os, "O_NONBLOCK"):
        file_flags |= os.O_NONBLOCK
    source_fd = os.open(source, directory_flags)
    destination_fd = os.open(destination, directory_flags)
    root_stat = os.fstat(source_fd)
    if (
        expected_root_identity is not None
        and file_identity(root_stat) != expected_root_identity
    ):
        os.close(source_fd)
        os.close(destination_fd)
        fail("source root identity changed before copy")
    pending: list[tuple[int, int, str, os.stat_result]] = [
        (source_fd, destination_fd, "", root_stat)
    ]
    while pending:
        (
            current_source_fd,
            current_destination_fd,
            relative_dir,
            expected_directory,
        ) = pending.pop()
        try:
            try:
                names = os.listdir(current_source_fd)
            except OSError as error:
                fail(f"source tree cannot be enumerated: {error}")
            entries += len(names)
            if entries > limits["max_entries"]:
                fail("source tree exceeds the entry limit")
            for name in sorted(names):
                relative = f"{relative_dir}/{name}" if relative_dir else name
                safe_relative_path(relative, limits["max_path_bytes"])
                before = os.stat(
                    name, dir_fd=current_source_fd, follow_symlinks=False
                )
                if before.st_dev != root_stat.st_dev:
                    fail(f"source tree crosses a filesystem: {relative}")
                if stat.S_ISDIR(before.st_mode):
                    child_source_fd = os.open(
                        name, directory_flags, dir_fd=current_source_fd
                    )
                    if file_identity(os.fstat(child_source_fd)) != file_identity(before):
                        os.close(child_source_fd)
                        fail(f"source directory changed before copy: {relative}")
                    os.mkdir(name, 0o700, dir_fd=current_destination_fd)
                    child_destination_fd = os.open(
                        name, directory_flags, dir_fd=current_destination_fd
                    )
                    os.fchown(child_destination_fd, 0, 0)
                    pending.append(
                        (
                            child_source_fd,
                            child_destination_fd,
                            relative,
                            before,
                        )
                    )
                elif stat.S_ISREG(before.st_mode):
                    if (
                        before.st_nlink != 1
                        or before.st_size > limits["max_file_bytes"]
                    ):
                        fail(f"source file has unsafe links or size: {relative}")
                    total_bytes += before.st_size
                    if total_bytes > limits["max_bytes"]:
                        fail("source tree exceeds its total byte limit")
                    input_fd = os.open(
                        name, file_flags, dir_fd=current_source_fd
                    )
                    output_fd = os.open(
                        name,
                        os.O_WRONLY
                        | os.O_CREAT
                        | os.O_EXCL
                        | os.O_CLOEXEC
                        | getattr(os, "O_NOFOLLOW", 0),
                        0o600,
                        dir_fd=current_destination_fd,
                    )
                    copied = 0
                    try:
                        if file_identity(os.fstat(input_fd)) != file_identity(before):
                            fail(f"source file changed before copy: {relative}")
                        while True:
                            chunk = os.read(input_fd, 1_048_576)
                            if not chunk:
                                break
                            copied += len(chunk)
                            if copied > before.st_size:
                                fail(f"source file grew while copied: {relative}")
                            view = memoryview(chunk)
                            while view:
                                written = os.write(output_fd, view)
                                if written <= 0:
                                    fail(f"source file copy stopped early: {relative}")
                                view = view[written:]
                        opened_after = os.fstat(input_fd)
                        os.fchown(output_fd, 0, 0)
                        os.fchmod(
                            output_fd,
                            0o555
                            if stat.S_IMODE(before.st_mode) & 0o111
                            else 0o444,
                        )
                        os.fsync(output_fd)
                    finally:
                        os.close(input_fd)
                        os.close(output_fd)
                    after = os.stat(
                        name, dir_fd=current_source_fd, follow_symlinks=False
                    )
                    if (
                        copied != before.st_size
                        or file_identity(opened_after) != file_identity(before)
                        or file_identity(after) != file_identity(before)
                    ):
                        fail(f"source file changed while copied: {relative}")
                elif stat.S_ISLNK(before.st_mode):
                    target = os.readlink(name, dir_fd=current_source_fd)
                    contained_symlink(relative, target, limits["max_path_bytes"])
                    os.symlink(target, name, dir_fd=current_destination_fd)
                    os.chown(
                        name,
                        0,
                        0,
                        dir_fd=current_destination_fd,
                        follow_symlinks=False,
                    )
                    after = os.stat(
                        name, dir_fd=current_source_fd, follow_symlinks=False
                    )
                    if (
                        file_identity(after) != file_identity(before)
                        or os.readlink(name, dir_fd=current_source_fd) != target
                    ):
                        fail(f"source symlink changed while copied: {relative}")
                else:
                    fail(f"source tree contains an unsupported node: {relative}")
            os.fchown(current_destination_fd, 0, 0)
            os.fchmod(current_destination_fd, 0o555)
            os.fsync(current_destination_fd)
            if file_identity(os.fstat(current_source_fd)) != file_identity(
                expected_directory
            ):
                fail(f"source directory changed while copied: {relative_dir or '.'}")
        finally:
            os.close(current_source_fd)
            os.close(current_destination_fd)
            # WHY: traversal keeps unopened sibling directories as live file
            # descriptors.  A fail-closed rejection must not leak those
            # descriptors into the long-lived root supervisor.
            if sys.exc_info()[0] is not None:
                while pending:
                    (
                        pending_source_fd,
                        pending_destination_fd,
                        _,
                        _,
                    ) = pending.pop()
                    os.close(pending_source_fd)
                    os.close(pending_destination_fd)
    try:
        final_source = source.lstat()
    except OSError as error:
        fail(f"source root disappeared after copy: {error}")
    if file_identity(final_source) != file_identity(root_stat):
        fail("source root changed while copied")
    return entries, total_bytes


def seal_output_tree(
    raw_root: Path,
    sealed_root: Path,
    limits: dict[str, int],
    *,
    recipe_uid: int,
    recipe_gid: int,
) -> tuple[str, int, int]:
    records: list[list[Any]] = [["d", "", 0o555, 0]]
    entries = 0
    total_bytes = 0
    sealed_root.mkdir(mode=0o700)
    directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC
    file_flags = os.O_RDONLY | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        directory_flags |= os.O_NOFOLLOW
        file_flags |= os.O_NOFOLLOW
    if hasattr(os, "O_NONBLOCK"):
        file_flags |= os.O_NONBLOCK
    raw_fd = os.open(raw_root, directory_flags)
    sealed_fd = os.open(sealed_root, directory_flags)
    raw_root_stat = os.fstat(raw_fd)
    if (
        raw_root_stat.st_uid != recipe_uid
        or raw_root_stat.st_gid != recipe_gid
        or stat.S_IMODE(raw_root_stat.st_mode) not in {0o555, 0o755}
    ):
        os.close(raw_fd)
        os.close(sealed_fd)
        fail("recipe output root has unsafe ownership or mode")
    pending: list[tuple[int, int, str]] = [(raw_fd, sealed_fd, "")]
    while pending:
        current_raw_fd, current_sealed_fd, relative_dir = pending.pop()
        try:
            names = os.listdir(current_raw_fd)
            entries += len(names)
            if entries > limits["max_entries"]:
                fail("recipe output exceeds the entry limit")
            for name in sorted(names):
                relative = f"{relative_dir}/{name}" if relative_dir else name
                safe_relative_path(relative, limits["max_path_bytes"])
                before = os.stat(
                    name, dir_fd=current_raw_fd, follow_symlinks=False
                )
                if before.st_dev != raw_root_stat.st_dev:
                    fail(f"recipe output crosses a filesystem: {relative}")
                if before.st_uid != recipe_uid or before.st_gid != recipe_gid:
                    fail(f"recipe output has unsafe ownership: {relative}")
                if stat.S_ISDIR(before.st_mode):
                    if stat.S_IMODE(before.st_mode) not in {0o555, 0o755}:
                        fail(f"recipe output directory has an unsafe mode: {relative}")
                    child_raw_fd = os.open(
                        name, directory_flags, dir_fd=current_raw_fd
                    )
                    if file_identity(os.fstat(child_raw_fd)) != file_identity(before):
                        os.close(child_raw_fd)
                        fail(f"recipe output directory changed: {relative}")
                    os.mkdir(name, 0o700, dir_fd=current_sealed_fd)
                    child_sealed_fd = os.open(
                        name, directory_flags, dir_fd=current_sealed_fd
                    )
                    os.fchown(child_sealed_fd, 0, 0)
                    records.append(["d", relative, 0o555, 0])
                    pending.append((child_raw_fd, child_sealed_fd, relative))
                elif stat.S_ISREG(before.st_mode):
                    raw_mode = stat.S_IMODE(before.st_mode)
                    if (
                        before.st_nlink != 1
                        or raw_mode not in {0o444, 0o555, 0o644, 0o755}
                        or before.st_size > limits["max_file_bytes"]
                    ):
                        fail(f"recipe output file has unsafe links, mode, or size: {relative}")
                    total_bytes += before.st_size
                    if total_bytes > limits["max_bytes"]:
                        fail("recipe output exceeds its total byte limit")
                    digest = hashlib.sha256()
                    input_fd = os.open(name, file_flags, dir_fd=current_raw_fd)
                    output_fd = os.open(
                        name,
                        os.O_WRONLY
                        | os.O_CREAT
                        | os.O_EXCL
                        | os.O_CLOEXEC
                        | getattr(os, "O_NOFOLLOW", 0),
                        0o600,
                        dir_fd=current_sealed_fd,
                    )
                    copied = 0
                    try:
                        if file_identity(os.fstat(input_fd)) != file_identity(before):
                            fail(f"recipe output changed before copy: {relative}")
                        while True:
                            chunk = os.read(input_fd, 1_048_576)
                            if not chunk:
                                break
                            copied += len(chunk)
                            if copied > before.st_size:
                                fail(f"recipe output grew while copied: {relative}")
                            digest.update(chunk)
                            view = memoryview(chunk)
                            while view:
                                written = os.write(output_fd, view)
                                if written <= 0:
                                    fail(f"recipe output copy stopped early: {relative}")
                                view = view[written:]
                        opened_after = os.fstat(input_fd)
                        sealed_mode = 0o555 if raw_mode & 0o111 else 0o444
                        os.fchown(output_fd, 0, 0)
                        os.fchmod(output_fd, sealed_mode)
                        os.fsync(output_fd)
                    finally:
                        os.close(input_fd)
                        os.close(output_fd)
                    after = os.stat(
                        name, dir_fd=current_raw_fd, follow_symlinks=False
                    )
                    if (
                        copied != before.st_size
                        or file_identity(opened_after) != file_identity(before)
                        or file_identity(after) != file_identity(before)
                    ):
                        fail(f"recipe output changed while copied: {relative}")
                    records.append(
                        [
                            "f",
                            relative,
                            sealed_mode,
                            0,
                            before.st_size,
                            digest.hexdigest(),
                        ]
                    )
                elif stat.S_ISLNK(before.st_mode):
                    target = os.readlink(name, dir_fd=current_raw_fd)
                    contained_symlink(relative, target, limits["max_path_bytes"])
                    os.symlink(target, name, dir_fd=current_sealed_fd)
                    os.chown(
                        name,
                        0,
                        0,
                        dir_fd=current_sealed_fd,
                        follow_symlinks=False,
                    )
                    after = os.stat(
                        name, dir_fd=current_raw_fd, follow_symlinks=False
                    )
                    if (
                        file_identity(after) != file_identity(before)
                        or os.readlink(name, dir_fd=current_raw_fd) != target
                    ):
                        fail(f"recipe output symlink changed while copied: {relative}")
                    records.append(["l", relative, 0, target])
                else:
                    fail(f"recipe output contains an unsupported node: {relative}")
            os.fchown(current_sealed_fd, 0, 0)
            os.fchmod(current_sealed_fd, 0o555)
            os.fsync(current_sealed_fd)
        finally:
            os.close(current_raw_fd)
            os.close(current_sealed_fd)
            # WHY: rejected output may leave sibling directories queued for
            # traversal; close their descriptors before returning the error to
            # the one-shot supervisor.
            if sys.exc_info()[0] is not None:
                while pending:
                    pending_raw_fd, pending_sealed_fd, _ = pending.pop()
                    os.close(pending_raw_fd)
                    os.close(pending_sealed_fd)
    records.sort(key=lambda record: record[1])
    digest = hashlib.sha256(compact_json(records)).hexdigest()
    return digest, entries, total_bytes


def ensure_no_uid_processes(config: dict[str, Any], *, kill: bool = False) -> None:
    command = ["/usr/bin/pgrep", "-u", str(config["recipe_uid"])]
    result = subprocess.run(command, check=False, stdout=subprocess.DEVNULL)
    if result.returncode == 1:
        return
    if result.returncode not in (0, 1):
        fail("could not inspect recipe identity processes")
    if not kill:
        fail("recipe identity still owns a process after service completion")
    subprocess.run(
        ["/usr/bin/pkill", "-KILL", "-u", str(config["recipe_uid"])],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    result = subprocess.run(command, check=False, stdout=subprocess.DEVNULL)
    if result.returncode != 1:
        fail("recipe identity survived forced teardown")


def systemctl_value(unit: str, property_name: str) -> str:
    result = subprocess.run(
        [
            "/usr/bin/systemctl",
            "show",
            f"--property={property_name}",
            "--value",
            unit,
        ],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        timeout=30,
    )
    if result.returncode != 0:
        return ""
    return result.stdout.strip()


def teardown_recipe_unit(unit: str, config: dict[str, Any]) -> None:
    """Kill and verify the exact transient service before output is trusted."""
    service = f"{unit}.service"
    control_group = systemctl_value(service, "ControlGroup")
    subprocess.run(
        [
            "/usr/bin/systemctl",
            "kill",
            "--kill-whom=all",
            "--signal=KILL",
            service,
        ],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=30,
    )
    subprocess.run(
        ["/usr/bin/systemctl", "stop", service],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=30,
    )
    ensure_no_uid_processes(config, kill=True)
    if control_group:
        if (
            not control_group.startswith("/")
            or not safe_text(control_group, allow_colon=False)
            or ".." in PurePosixPath(control_group).parts
        ):
            fail("recipe service reported an unsafe cgroup")
        cgroup = Path("/sys/fs/cgroup") / control_group.lstrip("/")
        if cgroup.exists():
            procs = cgroup / "cgroup.procs"
            if procs.exists() and procs.read_text(encoding="ascii").strip():
                fail("recipe service cgroup still contains a process")
    subprocess.run(
        ["/usr/bin/systemctl", "reset-failed", service],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=30,
    )
    load_state = systemctl_value(service, "LoadState")
    if load_state not in {"", "not-found"}:
        fail(f"recipe service survived teardown with state {load_state}")


def run_bounded_command(command: list[str], *, timeout_seconds: int) -> int:
    """Stream recipe diagnostics without granting unbounded runner memory/disk."""
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        close_fds=True,
    )
    if process.stdout is None:
        process.kill()
        process.wait()
        fail("tap recipe diagnostics pipe was not created")
    # WHY: a recipe may exit after spawning a descendant that inherited its
    # diagnostics pipe.  A blocking "final read" would then bypass the command
    # deadline while waiting for that unrelated writer to close the pipe.
    os.set_blocking(process.stdout.fileno(), False)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    deadline = time.monotonic() + timeout_seconds
    total = 0
    try:
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                fail("tap recipe exceeded its execution deadline")
            events = selector.select(min(remaining, 1.0))
            if not events:
                continue
            for key, _ in events:
                while True:
                    try:
                        chunk = os.read(key.fd, 65_536)
                    except BlockingIOError:
                        break
                    if not chunk:
                        selector.unregister(key.fileobj)
                        break
                    total += len(chunk)
                    if total > MAX_RECIPE_LOG_BYTES:
                        fail("tap recipe exceeded its diagnostic output limit")
                    try:
                        sys.stdout.buffer.write(chunk)
                        sys.stdout.buffer.flush()
                    except BrokenPipeError:
                        # Continue draining so the child cannot block merely
                        # because the outer CI log consumer disconnected.
                        pass
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            fail("tap recipe exceeded its execution deadline")
        try:
            return process.wait(timeout=remaining)
        except subprocess.TimeoutExpired:
            fail("tap recipe exceeded its execution deadline")
    finally:
        selector.close()
        process.stdout.close()
        if process.poll() is None:
            process.kill()
        try:
            process.wait(timeout=30)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def run_recipe(
    request: dict[str, Any],
    config: dict[str, Any],
    dependencies: dict[str, Path],
    resources: dict[str, Path],
    resource_staging_identity: ResourceStagingIdentity | None,
    native_roots: list[Path],
    requirement_roots: list[Path],
    dependency_binds: list[tuple[Path, Path]],
    request_sha256: str,
) -> tuple[Path, str, int, int]:
    execution_root = config["protected_root"] / f"execution-{request_sha256}"
    if execution_root.exists() or execution_root.is_symlink():
        fail("recipe execution root already exists")
    execution_root.mkdir(mode=0o700)
    source_root = execution_root / "source"
    resource_root = execution_root / "resources"
    work_root = execution_root / "work"
    output_root = execution_root / "output"
    service_root = execution_root / "root"
    try:
        copy_input_tree(request["source_root"], source_root, request["limits"])
        resource_binds: list[tuple[Path, Path]] = []
        if resources:
            build_root = request["source_root"].parent
            require_resource_staging_identity(
                build_root, resources, resource_staging_identity
            )
            resource_root.mkdir(mode=0o700)
            copied_entries = 0
            copied_bytes = 0
            for name, source in sorted(resources.items()):
                remaining_limits = {
                    "max_entries": MAX_RESOURCE_ENTRIES - copied_entries,
                    "max_file_bytes": MAX_RESOURCE_FILE_BYTES,
                    "max_bytes": MAX_RESOURCE_BYTES - copied_bytes,
                    "max_path_bytes": MAX_RESOURCE_PATH_BYTES,
                }
                if (
                    remaining_limits["max_entries"] < 0
                    or remaining_limits["max_bytes"] < 0
                ):
                    fail("Formula resources exceed their aggregate limits")
                entries, total = copy_input_tree(
                    source,
                    resource_root / name,
                    remaining_limits,
                    expected_root_identity=resource_staging_identity[1][name],
                )
                copied_entries += entries
                copied_bytes += total
                resource_binds.append(
                    (resource_root / name, resource_guest_root(name))
                )
            os.chown(resource_root, 0, 0)
            os.chmod(resource_root, 0o555)
            # Recheck the Formula-owned staging root after every resource has
            # been copied so late additions, removals, or root replacement do
            # not silently escape the attested resource set.
            validate_requested_resources(
                request, config, request["source_root"].parent
            )
            require_resource_staging_identity(
                build_root, resources, resource_staging_identity
            )
        work_root.mkdir(mode=0o700)
        output_root.mkdir(mode=0o755)
        os.chmod(output_root, 0o755)
        (work_root / "home").mkdir(mode=0o700)
        (work_root / "tmp").mkdir(mode=0o700)
        for path in (work_root, output_root, work_root / "home", work_root / "tmp"):
            os.chown(path, config["recipe_uid"], config["recipe_gid"])
        os.chown(execution_root, 0, 0)
        os.chmod(execution_root, 0o555)

        readonly_binds = [
            *host_tool_projection(config),
            (source_root, request["source_root"]),
            (config["recipe_host_root"], request["recipe_root"]),
            (config["platform_host_root"], request["platform_root"]),
            (config["sysroot_host_root"], request["sysroot"]),
            (config["passwd_file"], Path("/etc/passwd")),
            (config["group_file"], Path("/etc/group")),
            *dependency_binds,
            *resource_binds,
        ]
        readwrite_binds = [
            (work_root, request["work_root"]),
            (output_root, request["output_root"]),
        ]
        prepare_service_root(service_root, readonly_binds, readwrite_binds)

        unit = f"{config['unit_prefix']}-recipe-{request_sha256[:16]}"
        service = f"{unit}.service"
        if systemctl_value(service, "LoadState") not in {"", "not-found"}:
            fail("recipe service unit already exists")
        ensure_no_uid_processes(config)
        command = [
            "/usr/bin/systemd-run",
            "--quiet",
            "--wait",
            "--pipe",
            f"--unit={unit}",
            f"--slice={config['slice']}",
            f"--uid={config['recipe_uid']}",
            f"--gid={config['recipe_gid']}",
            "--property=KillMode=control-group",
            "--property=SendSIGKILL=yes",
            "--property=TimeoutStopSec=10s",
            "--property=RuntimeMaxSec=7200s",
            "--property=NoNewPrivileges=yes",
            "--property=PrivateNetwork=yes",
            "--property=RestrictAddressFamilies=AF_UNIX",
            "--property=PrivateDevices=yes",
            "--property=PrivateIPC=yes",
            f"--property=RootDirectory={service_root}",
            "--property=MountAPIVFS=yes",
            "--property=TemporaryFileSystem=/etc:ro",
            "--property=TemporaryFileSystem=/tmp:rw,nosuid,nodev,mode=1777,size=1073741824",
            "--property=ProtectSystem=strict",
            "--property=ProtectHome=tmpfs",
            "--property=ProtectKernelTunables=yes",
            "--property=ProtectKernelModules=yes",
            "--property=ProtectControlGroups=yes",
            "--property=ProtectKernelLogs=yes",
            "--property=ProtectClock=yes",
            "--property=ProtectHostname=yes",
            "--property=ProtectProc=invisible",
            "--property=ProcSubset=pid",
            "--property=RestrictSUIDSGID=yes",
            "--property=RestrictNamespaces=yes",
            "--property=RestrictRealtime=yes",
            "--property=LockPersonality=yes",
            "--property=KeyringMode=private",
            "--property=RemoveIPC=yes",
            "--property=SupplementaryGroups=",
            "--property=UMask=0022",
            "--property=TasksMax=4096",
            "--property=LimitNOFILE=4096",
            "--property=CapabilityBoundingSet=",
            "--property=AmbientCapabilities=",
            f"--working-directory={request['work_root']}",
            "--service-type=exec",
            "--expand-environment=no",
        ]
        command.extend(
            f"--property=BindReadOnlyPaths={source}:{destination}"
            for source, destination in readonly_binds
        )
        command.extend(
            f"--property=BindPaths={source}:{destination}"
            for source, destination in readwrite_binds
        )
        child_environment = dict(request["environment"])
        # WHY: Homebrew Requirements are publisher-only and intentionally
        # absent from Formula `deps`, so tap support cannot request their
        # versioned kegs. The root-owned config derives them from the static
        # host plan and adds only their sealed executable directories.
        requirement_path_entries: list[str] = []
        for root in requirement_roots:
            for suffix in ("bin", "sbin", "libexec/bin"):
                candidate = root / suffix
                if candidate.is_dir() and not candidate.is_symlink():
                    requirement_path_entries.append(str(candidate))
        existing_path = child_environment["PATH"].split(":")
        child_environment["PATH"] = ":".join(
            [*sorted(set(requirement_path_entries)), *existing_path]
        )
        command.extend(["--", "/usr/bin/env", "-i"])
        command.extend(
            f"{key}={value}" for key, value in sorted(child_environment.items())
        )
        command.extend(["/usr/bin/bash", str(request["entrypoint"])])
        return_code: int | None = None
        try:
            return_code = run_bounded_command(command, timeout_seconds=7_260)
        finally:
            teardown_recipe_unit(unit, config)
        if return_code is None or return_code != 0:
            status = (
                "before reporting a status"
                if return_code is None
                else str(return_code)
            )
            fail(f"tap recipe exited with status {status}")

        sealed = config["sealed_root"] / request_sha256
        if sealed.exists() or sealed.is_symlink():
            fail("sealed recipe output already exists")
        digest, entries, total = seal_output_tree(
            output_root,
            sealed,
            request["limits"],
            recipe_uid=config["recipe_uid"],
            recipe_gid=config["recipe_gid"],
        )
        return sealed, digest, entries, total
    except BaseException:
        if "sealed" in locals() and (sealed.exists() or sealed.is_symlink()):
            shutil.rmtree(sealed, ignore_errors=True)
        raise
    finally:
        shutil.rmtree(execution_root, ignore_errors=True)


def write_response(
    response_path: Path,
    parent_fd: int,
    config: dict[str, Any],
    request_sha256: str,
    sealed_root: Path,
    manifest_sha256: str,
    entry_count: int,
    total_bytes: int,
) -> None:
    response = compact_json(
        {
            "entry_count": entry_count,
            "output_manifest_sha256": manifest_sha256,
            "request_sha256": request_sha256,
            "schema": 1,
            "sealed_output_root": str(sealed_root),
            "total_bytes": total_bytes,
        }
    )
    if len(response) > MAX_RESPONSE_BYTES:
        fail("tap recipe response exceeds its byte limit")
    try:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        fd = os.open(response_path.name, flags, 0o400, dir_fd=parent_fd)
        try:
            view = memoryview(response)
            while view:
                written = os.write(fd, view)
                view = view[written:]
            os.fsync(fd)
            os.fchown(fd, 0, 0)
            os.fchmod(fd, 0o444)
        finally:
            os.close(fd)
        os.fsync(parent_fd)
    except FileExistsError:
        fail("tap recipe response appeared during execution")


def process_request(
    request_path: Path, response_path: Path, config: dict[str, Any]
) -> tuple[Path, int]:
    parent_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        parent_flags |= os.O_NOFOLLOW
    try:
        parent_before = response_path.parent.lstat()
        parent_fd = os.open(response_path.parent, parent_flags)
    except OSError as error:
        fail(f"recipe build root cannot be held safely: {error}")
    sealed: Path | None = None
    completed = False
    try:
        if file_identity(os.fstat(parent_fd)) != file_identity(parent_before):
            fail("recipe build root changed before it was held")
        (
            request,
            request_bytes,
            dependencies,
            resources,
            resource_staging_identity,
            native_roots,
            requirement_roots,
            dependency_binds,
        ) = validate_request(request_path, response_path, config, parent_fd)
        request_sha256 = hashlib.sha256(request_bytes).hexdigest()
        sealed, manifest, entries, total = run_recipe(
            request,
            config,
            dependencies,
            resources,
            resource_staging_identity,
            native_roots,
            requirement_roots,
            dependency_binds,
            request_sha256,
        )
        write_response(
            response_path,
            parent_fd,
            config,
            request_sha256,
            sealed,
            manifest,
            entries,
            total,
        )
        completed = True
        return sealed, parent_fd
    except BaseException:
        if sealed is not None and sealed.parent == config["sealed_root"]:
            shutil.rmtree(sealed, ignore_errors=True)
        try:
            os.unlink(response_path.name, dir_fd=parent_fd)
        except FileNotFoundError:
            pass
        raise
    finally:
        if not completed:
            os.close(parent_fd)


def runner_paths() -> tuple[Path, Path, Path]:
    runner = Path(__file__).resolve(strict=True)
    socket_path = runner.with_name(RUNNER_SOCKET_BASENAME)
    if len(os.fsencode(socket_path)) > UNIX_SOCKET_PATHNAME_BYTES:
        fail("tap recipe runner socket path exceeds the Linux Unix-socket limit")
    return (
        runner.with_name("runner-config.json"),
        socket_path,
        runner,
    )


def client(request: str, response: str) -> int:
    _, socket_path, _ = runner_paths()
    message = compact_json(
        {"request": request, "response": response, "schema": 1}
    )
    if len(message) > MAX_MESSAGE_BYTES:
        fail("tap recipe runner request message is oversized")
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
    try:
        connection.connect(str(socket_path))
        connection.sendall(message)
        reply = connection.recv(MAX_MESSAGE_BYTES + 1)
    finally:
        connection.close()
    if len(reply) > MAX_MESSAGE_BYTES:
        fail("tap recipe runner returned an oversized reply")
    document = parse_json_bytes(reply, "tap recipe runner reply")
    if (
        type(document) is not dict
        or set(document) != {"message", "schema", "status"}
        or not is_exact_integer(document["schema"])
        or document["schema"] != 1
        or document["status"] not in {"ok", "error"}
        or type(document["status"]) is not str
        or type(document["message"]) is not str
        or not safe_text(document["message"])
        or len(document["message"].encode("utf-8")) > 2_048
    ):
        fail("tap recipe runner returned an invalid reply")
    if document["status"] != "ok":
        fail(document["message"])
    return 0


def supervisor() -> int:
    if os.geteuid() != 0:
        fail("tap recipe supervisor must run as root")
    config_path, socket_path, runner_path = runner_paths()
    config = validate_config(config_path)
    if runner_path.parent != config["protected_root"]:
        fail("tap recipe runner left its configured protected root")
    runner_stat = runner_path.lstat()
    if (
        not stat.S_ISREG(runner_stat.st_mode)
        or runner_stat.st_uid != 0
        or runner_stat.st_gid != 0
        or runner_stat.st_nlink != 1
        or stat.S_IMODE(runner_stat.st_mode) != 0o555
        or runner_stat.st_size < 1
    ):
        fail("tap recipe runner executable is not sealed")
    if socket_path.exists() or socket_path.is_symlink():
        fail("tap recipe runner socket path is occupied")

    listener = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
    try:
        listener.bind(str(socket_path))
        os.chown(socket_path, config["build_uid"], config["build_gid"])
        os.chmod(socket_path, 0o600)
        listener.listen(1)
        connection, _ = listener.accept()
        try:
            credentials = connection.getsockopt(
                socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")
            )
            pid, uid, gid = struct.unpack("3i", credentials)
            if (
                pid <= 0
                or uid != config["build_uid"]
                or gid != config["build_gid"]
            ):
                fail("tap recipe runner rejected the client identity")
            message = connection.recv(MAX_MESSAGE_BYTES + 1)
            if len(message) > MAX_MESSAGE_BYTES:
                fail("tap recipe runner client message is oversized")
            document = parse_json_bytes(message, "tap recipe runner client message")
            if (
                type(document) is not dict
                or set(document) != CLIENT_MESSAGE_KEYS
                or not is_exact_integer(document["schema"])
                or document["schema"] != 1
                or compact_json(document) != message
            ):
                fail("tap recipe runner client message has an invalid schema")
            request_path = canonical_requested_path(
                document["request"], label="tap recipe request path"
            )
            response_path = canonical_requested_path(
                document["response"], label="tap recipe response path"
            )
            listener.close()
            socket_path.unlink(missing_ok=True)
            sealed: Path | None = None
            response_parent_fd: int | None = None
            try:
                sealed, response_parent_fd = process_request(
                    request_path, response_path, config
                )
                reply = {"message": "tap recipe output sealed", "schema": 1, "status": "ok"}
            except RunnerError as error:
                reply = {"message": str(error)[:2_048], "schema": 1, "status": "error"}
            except (OSError, subprocess.SubprocessError) as error:
                print(
                    f"homebrew-tap-recipe-runner: internal execution failure: {error}",
                    file=sys.stderr,
                )
                reply = {
                    "message": "tap recipe runner encountered an internal execution failure",
                    "schema": 1,
                    "status": "error",
                }
            try:
                connection.sendall(compact_json(reply))
            except OSError:
                if sealed is not None and sealed.parent == config["sealed_root"]:
                    shutil.rmtree(sealed, ignore_errors=True)
                if response_parent_fd is not None:
                    try:
                        os.unlink(response_path.name, dir_fd=response_parent_fd)
                        os.fsync(response_parent_fd)
                    except FileNotFoundError:
                        pass
                fail("tap recipe client disconnected before accepting the result")
            finally:
                if response_parent_fd is not None:
                    os.close(response_parent_fd)
            return 0 if reply["status"] == "ok" else 1
        finally:
            connection.close()
    finally:
        listener.close()
        socket_path.unlink(missing_ok=True)


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--destination")
    parser.add_argument("--formula")
    parser.add_argument("--manifest-sha256")
    parser.add_argument("--request")
    parser.add_argument("--response")
    parser.add_argument("--source")
    parser.add_argument("--stage-recipe", action="store_true")
    parser.add_argument("--supervisor", action="store_true")
    arguments = parser.parse_args()
    selected_modes = int(arguments.supervisor) + int(arguments.stage_recipe)
    if selected_modes > 1:
        fail("tap recipe runner modes are mutually exclusive")
    staging_values = (
        arguments.source,
        arguments.destination,
        arguments.formula,
        arguments.manifest_sha256,
    )
    if arguments.supervisor:
        if (
            arguments.request is not None
            or arguments.response is not None
            or any(value is not None for value in staging_values)
        ):
            fail("tap recipe supervisor accepts no request arguments")
    elif arguments.stage_recipe:
        if (
            arguments.request is not None
            or arguments.response is not None
            or any(value is None for value in staging_values)
        ):
            fail("tap recipe staging requires its exact projection arguments")
    elif (
        arguments.request is None
        or arguments.response is None
        or any(value is not None for value in staging_values)
    ):
        fail("tap recipe runner requires --request and --response")
    return arguments


def main() -> int:
    try:
        arguments = parse_arguments()
        if arguments.supervisor:
            return supervisor()
        if arguments.stage_recipe:
            return stage_recipe(
                arguments.source,
                arguments.destination,
                arguments.formula,
                arguments.manifest_sha256,
            )
        if os.geteuid() == 0:
            fail("tap recipe client must not run as root")
        return client(arguments.request, arguments.response)
    except RunnerError as error:
        print(f"homebrew-tap-recipe-runner: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
