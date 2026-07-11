#!/usr/bin/env python3
"""Inspect one Homebrew bottle without evaluating Formula Ruby or extracting it."""

from __future__ import annotations

import argparse
import dataclasses
import hashlib
import json
import os
import pathlib
import posixpath
import re
import resource
import signal
import subprocess
import sys
import tarfile
import tempfile
from typing import BinaryIO, NoReturn


MAX_COMPRESSED_BYTES = 2 * 1024 * 1024 * 1024
MAX_ARCHIVE_ENTRIES = 200_000
MAX_ARCHIVE_BYTES = 16 * 1024 * 1024 * 1024
MAX_ARCHIVE_PATH_BYTES = 4096
MAX_FORMULA_BYTES = 1024 * 1024
MAX_RECEIPT_BYTES = 16 * 1024 * 1024
MAX_RUNTIME_DEPENDENCIES = 512
MAX_WASM_BYTES = 2 * 1024 * 1024 * 1024
MAX_WASM_VALIDATOR_OUTPUT_BYTES = 16 * 1024 * 1024
MAX_OUTPUT_BYTES = 64 * 1024 * 1024
DEFAULT_WASM_TIMEOUT_SECONDS = 120
MAX_LINK_DEPTH = 256
MAX_FORBIDDEN_ROOTS = 32
MAX_FORBIDDEN_ROOT_BYTES = 4096
ARCHIVE_SCAN_CHUNK_BYTES = 1024 * 1024

FORMULA_NAME = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
PKG_VERSION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+,-]{0,255}$")
DEPENDENCY_NAME = re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9@+._-]*(?:/[A-Za-z0-9][A-Za-z0-9@+._-]*){0,2}$"
)
class InspectionError(Exception):
    pass


def fail(message: str) -> NoReturn:
    raise InspectionError(message)


@dataclasses.dataclass(frozen=True)
class ArchiveEntry:
    path: str
    kind: str
    mode: int
    size: int
    member: tarfile.TarInfo
    target: str | None = None
    is_wasm: bool = False


def require_utf8(value: str, label: str) -> None:
    try:
        encoded = value.encode("utf-8")
    except UnicodeEncodeError:
        fail(f"{label} is not UTF-8")
    if len(encoded) > MAX_ARCHIVE_PATH_BYTES:
        fail(f"{label} exceeds {MAX_ARCHIVE_PATH_BYTES} bytes")
    if "\x00" in value:
        fail(f"{label} contains NUL")


def normalize_member_path(value: str, label: str) -> str:
    require_utf8(value, label)
    while value.startswith("./"):
        value = value[2:]
    value = value.rstrip("/")
    if not value or value.startswith("/") or "\\" in value:
        fail(f"{label} is not a safe relative POSIX path: {value!r}")
    parts = value.split("/")
    if any(part in {"", ".", ".."} for part in parts):
        fail(f"{label} contains an unsafe path segment: {value!r}")
    return "/".join(parts)


def require_under_payload(path: str, payload_root: str, label: str) -> str:
    if path == payload_root:
        return path
    if not path.startswith(f"{payload_root}/"):
        fail(f"{label} escapes payload root {payload_root!r}: {path!r}")
    return path


def normalize_link_target(
    value: str, source: str, payload_root: str, *, hardlink: bool
) -> str:
    label = f"archive link {source!r}"
    require_utf8(value, label)
    if not value or value.startswith("/") or "\\" in value:
        fail(f"{label} has an unsafe target: {value!r}")
    if hardlink:
        while value.startswith("./"):
            value = value[2:]
        resolved = posixpath.normpath(value)
    else:
        resolved = posixpath.normpath(posixpath.join(posixpath.dirname(source), value))
    if resolved in {"", ".", ".."} or resolved.startswith("../") or resolved.startswith("/"):
        fail(f"{label} escapes the archive root: {value!r}")
    require_utf8(resolved, label)
    return require_under_payload(resolved, payload_root, label)


def member_kind(member: tarfile.TarInfo) -> str:
    if member.isdir():
        return "directory"
    if member.isfile():
        return "regular"
    if member.issym():
        return "symlink"
    if member.islnk():
        return "hardlink"
    fail(f"archive entry {member.name!r} has an unsupported type")


def read_bounded(stream: BinaryIO, limit: int, label: str) -> bytes:
    payload = stream.read(limit + 1)
    if len(payload) > limit:
        fail(f"{label} exceeds {limit} bytes")
    return payload


def normalize_forbidden_root(value: str) -> str:
    label = "forbidden root"
    try:
        encoded = value.encode("utf-8")
    except UnicodeEncodeError:
        fail(f"{label} is not UTF-8")
    if not encoded or len(encoded) > MAX_FORBIDDEN_ROOT_BYTES:
        fail(f"{label} must be between 1 and {MAX_FORBIDDEN_ROOT_BYTES} UTF-8 bytes")
    if any(byte < 0x20 or byte == 0x7F for byte in encoded):
        fail(f"{label} contains a control character")
    if (
        not value.startswith("/")
        or value.startswith("//")
        or value == "/"
        or "\\" in value
    ):
        fail(f"{label} must be a non-root absolute POSIX path: {value!r}")
    if value.endswith("/") or posixpath.normpath(value) != value:
        fail(f"{label} must be a normalized absolute POSIX path: {value!r}")
    return value


class BottleInspector:
    def __init__(
        self,
        archive_path: pathlib.Path,
        formula: str,
        version: str,
        expected_abi: int,
        expected_arch: str,
        wasm_validator: pathlib.Path,
        wasm_timeout_seconds: int,
        forbidden_roots: tuple[str, ...],
    ) -> None:
        self.archive_path = archive_path
        self.formula = formula
        self.version = version
        self.payload_root = f"{formula}/{version}"
        self.expected_abi = expected_abi
        self.expected_arch = expected_arch
        self.wasm_validator = wasm_validator
        self.wasm_timeout_seconds = wasm_timeout_seconds
        self.forbidden_roots = tuple(
            (root, root.encode("utf-8")) for root in forbidden_roots
        )
        self.forbidden_root_overlap = max(
            len(encoded) - 1 for _root, encoded in self.forbidden_roots
        )
        self.entries: dict[str, ArchiveEntry] = {}
        self.archive: tarfile.TarFile | None = None

    def run(self) -> dict[str, object]:
        if self.archive_path.is_symlink() or not self.archive_path.is_file():
            fail(f"bottle archive must be a regular non-symlink file: {self.archive_path}")
        compressed_bytes = self.archive_path.stat().st_size
        if compressed_bytes > MAX_COMPRESSED_BYTES:
            fail(f"bottle archive exceeds {MAX_COMPRESSED_BYTES} compressed bytes")

        try:
            self.archive = tarfile.open(self.archive_path, mode="r:gz")
        except (OSError, tarfile.TarError) as error:
            fail(f"cannot open bottle archive: {error}")
        try:
            try:
                self._read_inventory()
                self._validate_ancestor_types()
                self._validate_links()
                return self._result()
            except (OSError, tarfile.TarError, UnicodeError) as error:
                fail(f"cannot inspect bottle archive: {error}")
        finally:
            self.archive.close()
            self.archive = None

    def _read_inventory(self) -> None:
        assert self.archive is not None
        total_bytes = 0
        for index, member in enumerate(self.archive):
            if index >= MAX_ARCHIVE_ENTRIES:
                fail(f"bottle archive exceeds {MAX_ARCHIVE_ENTRIES} entries")
            path = normalize_member_path(member.name, f"archive entry {index}")
            if path in self.entries:
                fail(f"bottle archive repeats path {path!r}")
            if path not in {self.formula, self.payload_root}:
                require_under_payload(path, self.payload_root, f"archive entry {index}")
            kind = member_kind(member)
            if path in {self.formula, self.payload_root} and kind != "directory":
                fail(f"bottle archive root {path!r} is not a directory")
            if member.size < 0:
                fail(f"archive entry {path!r} has a negative size")
            if member.mode < 0 or member.mode > 0o7777:
                fail(f"archive entry {path!r} has an invalid mode")
            if kind in {"directory", "symlink", "hardlink"} and member.size != 0:
                fail(f"archive {kind} {path!r} unexpectedly contains data")
            total_bytes += member.size
            if total_bytes > MAX_ARCHIVE_BYTES:
                fail(f"bottle archive declares more than {MAX_ARCHIVE_BYTES} bytes")
            target = None
            is_wasm = False
            if kind in {"symlink", "hardlink"}:
                target = normalize_link_target(
                    member.linkname,
                    path,
                    self.payload_root,
                    hardlink=kind == "hardlink",
                )
            elif kind == "regular":
                source = self.archive.extractfile(member)
                if source is None:
                    fail(f"cannot read regular archive entry {path!r}")
                with source:
                    is_wasm = self._scan_regular(source, path, member.size)
            self.entries[path] = ArchiveEntry(
                path=path,
                kind=kind,
                mode=member.mode,
                size=member.size,
                member=member,
                target=target,
                is_wasm=is_wasm,
            )

        if not self.entries:
            fail("bottle archive is empty")

    def _scan_regular(self, source: BinaryIO, path: str, expected_size: int) -> bool:
        first = bytearray()
        tail = b""
        bytes_read = 0
        while True:
            chunk = source.read(ARCHIVE_SCAN_CHUNK_BYTES)
            if not chunk:
                break
            bytes_read += len(chunk)
            if len(first) < 4:
                first.extend(chunk[: 4 - len(first)])
            window = tail + chunk
            for root, encoded_root in self.forbidden_roots:
                if encoded_root in window:
                    fail(
                        f"regular archive entry {path!r} contains forbidden build root "
                        f"{root!r}"
                    )
            if self.forbidden_root_overlap:
                tail = window[-self.forbidden_root_overlap :]
        if bytes_read != expected_size:
            fail(
                f"regular archive entry {path!r} declared {expected_size} bytes "
                f"but yielded {bytes_read}"
            )
        return bytes(first) == b"\0asm"

    def _validate_ancestor_types(self) -> None:
        for path in self.entries:
            parts = path.split("/")
            for index in range(1, len(parts)):
                ancestor_path = "/".join(parts[:index])
                ancestor = self.entries.get(ancestor_path)
                if ancestor is not None and ancestor.kind != "directory":
                    fail(
                        f"archive entry {path!r} has non-directory ancestor "
                        f"{ancestor_path!r}"
                    )

    def _resolve(self, path: str, trail: tuple[str, ...] = ()) -> ArchiveEntry:
        require_under_payload(path, self.payload_root, "resolved archive path")
        if path in trail or len(trail) >= MAX_LINK_DEPTH:
            chain = " -> ".join((*trail, path))
            fail(f"bottle archive contains a link cycle: {chain}")

        parts = path.split("/")
        for index in range(1, len(parts) + 1):
            prefix = "/".join(parts[:index])
            entry = self.entries.get(prefix)
            if entry is None:
                continue
            if entry.kind in {"symlink", "hardlink"}:
                assert entry.target is not None
                suffix = parts[index:]
                replacement = entry.target
                if suffix:
                    replacement = posixpath.normpath(posixpath.join(replacement, *suffix))
                require_under_payload(replacement, self.payload_root, "resolved archive link")
                return self._resolve(replacement, (*trail, path))
            if index < len(parts) and entry.kind != "directory":
                fail(f"resolved archive path {path!r} traverses non-directory {prefix!r}")

        resolved = self.entries.get(path)
        if resolved is None:
            fail(f"bottle archive contains a dangling link to {path!r}")
        return resolved

    def _validate_links(self) -> None:
        for entry in self.entries.values():
            if entry.kind not in {"symlink", "hardlink"}:
                continue
            resolved = self._resolve(entry.path)
            if entry.kind == "hardlink" and resolved.kind != "regular":
                fail(f"archive hardlink {entry.path!r} does not resolve to a regular file")

    def _extract_regular(self, entry: ArchiveEntry) -> BinaryIO:
        if entry.kind != "regular":
            fail(f"archive entry {entry.path!r} is not a regular file")
        assert self.archive is not None
        stream = self.archive.extractfile(entry.member)
        if stream is None:
            fail(f"cannot read archive entry {entry.path!r}")
        return stream

    def _required_regular(self, rel: str, maximum: int) -> tuple[ArchiveEntry, bytes]:
        path = f"{self.payload_root}/{rel}"
        entry = self.entries.get(path)
        if entry is None or entry.kind != "regular":
            fail(f"bottle payload requires regular file {rel!r}")
        if entry.size > maximum:
            fail(f"bottle payload file {rel!r} exceeds {maximum} bytes")
        with self._extract_regular(entry) as stream:
            return entry, read_bounded(stream, maximum, f"bottle payload file {rel!r}")

    def _runtime_dependencies(self, receipt: bytes) -> list[dict[str, object]]:
        try:
            document = json.loads(receipt.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            fail(f"bottle INSTALL_RECEIPT.json is not valid UTF-8 JSON: {error}")
        if not isinstance(document, dict):
            fail("bottle INSTALL_RECEIPT.json must be an object")
        dependencies = document.get("runtime_dependencies")
        if not isinstance(dependencies, list):
            fail("bottle INSTALL_RECEIPT.json runtime_dependencies must be an array")
        if len(dependencies) > MAX_RUNTIME_DEPENDENCIES:
            fail(
                "bottle INSTALL_RECEIPT.json has more than "
                f"{MAX_RUNTIME_DEPENDENCIES} runtime dependencies"
            )

        out: list[dict[str, object]] = []
        seen: set[str] = set()
        for index, dependency in enumerate(dependencies):
            if not isinstance(dependency, dict):
                fail(f"runtime_dependencies[{index}] must be an object")
            full_name = dependency.get("full_name")
            if not isinstance(full_name, str) or not DEPENDENCY_NAME.fullmatch(full_name):
                fail(f"runtime_dependencies[{index}].full_name is invalid")
            normalized = full_name.lower()
            if normalized in seen:
                fail(f"runtime dependency {full_name!r} is duplicated")
            seen.add(normalized)
            declared_directly = dependency.get("declared_directly")
            if not isinstance(declared_directly, bool):
                fail(f"runtime dependency {full_name!r} declared_directly must be boolean")
            version = dependency.get("pkg_version") or dependency.get("version")
            if not isinstance(version, str) or not PKG_VERSION.fullmatch(version):
                fail(f"runtime dependency {full_name!r} version is invalid")
            out.append(
                {
                    "declared_directly": declared_directly,
                    "full_name": full_name,
                    "version": version,
                }
            )
        return sorted(out, key=lambda value: (str(value["full_name"]).lower(), value["full_name"]))

    def _path_executables(self, all_paths: list[str]) -> tuple[list[str], dict[str, ArchiveEntry]]:
        path_exec_files: list[str] = []
        resolved_execs: dict[str, ArchiveEntry] = {}
        for rel in all_paths:
            if rel.split("/", 1)[0] not in {"bin", "sbin"}:
                continue
            resolved = self._resolve(f"{self.payload_root}/{rel}")
            if resolved.kind == "regular" and resolved.mode & 0o111:
                path_exec_files.append(rel)
                resolved_execs[resolved.path] = resolved
        return path_exec_files, resolved_execs

    @staticmethod
    def _set_validator_limits() -> None:
        resource.setrlimit(
            resource.RLIMIT_FSIZE,
            (MAX_WASM_VALIDATOR_OUTPUT_BYTES, MAX_WASM_VALIDATOR_OUTPUT_BYTES),
        )

    def _validate_wasm(self, wasm_path: str, label: str) -> str:
        with (
            tempfile.NamedTemporaryFile() as stdout_file,
            tempfile.NamedTemporaryFile() as stderr_file,
        ):
            try:
                process = subprocess.Popen(
                    [
                        "bash",
                        str(self.wasm_validator),
                        wasm_path,
                        str(self.expected_abi),
                        self.expected_arch,
                    ],
                    stdin=subprocess.DEVNULL,
                    stdout=stdout_file,
                    stderr=stderr_file,
                    close_fds=True,
                    start_new_session=True,
                    preexec_fn=self._set_validator_limits,
                )
            except (OSError, subprocess.SubprocessError) as error:
                fail(f"cannot start Wasm inspection for {label!r}: {error}")
            try:
                return_code = process.wait(timeout=self.wasm_timeout_seconds)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait()
                fail(
                    f"Wasm inspection timed out after {self.wasm_timeout_seconds} "
                    f"seconds for {label!r}"
                )

            stdout_file.flush()
            stderr_file.flush()
            stdout_bytes = os.fstat(stdout_file.fileno()).st_size
            stderr_bytes = os.fstat(stderr_file.fileno()).st_size
            if (
                stdout_bytes >= MAX_WASM_VALIDATOR_OUTPUT_BYTES
                or stderr_bytes >= MAX_WASM_VALIDATOR_OUTPUT_BYTES
            ):
                fail(f"Wasm inspection output exceeds its limit for {label!r}")
            stdout_file.seek(0)
            stderr_file.seek(0)
            try:
                stdout = stdout_file.read().decode("utf-8", errors="strict")
            except UnicodeDecodeError:
                fail(f"Wasm inspection output is not UTF-8 for {label!r}")
            stderr = stderr_file.read(2048).decode("utf-8", errors="replace")
            if return_code != 0:
                fail(f"cannot inspect bottle executable {label!r}: {stderr}")
        result = stdout.strip()
        if result not in {"required", "not-required"}:
            fail(f"Wasm inspection returned an invalid result for {label!r}")
        return result

    def _inspect_wasm(self, entry: ArchiveEntry) -> str:
        if entry.size > MAX_WASM_BYTES:
            fail(f"bottle Wasm module {entry.path!r} exceeds {MAX_WASM_BYTES} bytes")
        with self._extract_regular(entry) as source, tempfile.NamedTemporaryFile(
            suffix=".wasm"
        ) as wasm_file:
            first = source.read(4)
            if first != b"\0asm":
                fail(f"archive entry {entry.path!r} changed during Wasm inspection")
            wasm_file.write(first)
            while True:
                chunk = source.read(1024 * 1024)
                if not chunk:
                    break
                wasm_file.write(chunk)
            wasm_file.flush()
            return self._validate_wasm(wasm_file.name, entry.path)

    def _result(self) -> dict[str, object]:
        formula_rel = f".brew/{self.formula}.rb"
        _formula_entry, formula_bytes = self._required_regular(
            formula_rel, MAX_FORMULA_BYTES
        )
        _receipt_entry, receipt_bytes = self._required_regular(
            "INSTALL_RECEIPT.json", MAX_RECEIPT_BYTES
        )
        runtime_dependencies = self._runtime_dependencies(receipt_bytes)

        all_files = sorted(
            path.removeprefix(f"{self.payload_root}/")
            for path, entry in self.entries.items()
            if path.startswith(f"{self.payload_root}/")
            and entry.kind in {"regular", "symlink", "hardlink"}
        )
        path_exec_files, _resolved_execs = self._path_executables(all_files)
        wasm_entries = {
            entry.path: entry
            for entry in self.entries.values()
            if entry.path.startswith(f"{self.payload_root}/") and entry.is_wasm
        }
        fork_instrumentation = "not-required"
        for entry in sorted(wasm_entries.values(), key=lambda value: value.path):
            result = self._inspect_wasm(entry)
            if result == "required":
                fork_instrumentation = "required"

        return {
            "schema": 1,
            "abi_version": self.expected_abi,
            "arch": self.expected_arch,
            "payload_root": self.payload_root,
            "all_files": all_files,
            "path_exec_files": sorted(path_exec_files),
            "runtime_dependencies": runtime_dependencies,
            "formula_sha256": hashlib.sha256(formula_bytes).hexdigest(),
            "fork_instrumentation": fork_instrumentation,
        }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", required=True)
    parser.add_argument("--formula", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--expected-abi", required=True, type=int)
    parser.add_argument("--expected-arch", required=True, choices=("wasm32", "wasm64"))
    parser.add_argument(
        "--forbidden-root",
        action="append",
        required=True,
        help="normalized absolute build root forbidden in archive members; repeat as needed",
    )
    parser.add_argument(
        "--wasm-validator",
        default=str(pathlib.Path(__file__).with_name("homebrew-validate-wasm-executable.sh")),
    )
    parser.add_argument(
        "--wasm-timeout-seconds",
        type=int,
        default=DEFAULT_WASM_TIMEOUT_SECONDS,
    )
    parser.add_argument("--out", default="-")
    args = parser.parse_args()
    if not FORMULA_NAME.fullmatch(args.formula):
        parser.error("--formula is invalid")
    if not PKG_VERSION.fullmatch(args.version):
        parser.error("--version is invalid")
    if not 1 <= args.expected_abi <= 0xFFFFFFFF:
        parser.error("--expected-abi must be between 1 and 4294967295")
    if not 1 <= args.wasm_timeout_seconds <= DEFAULT_WASM_TIMEOUT_SECONDS:
        parser.error(
            f"--wasm-timeout-seconds must be between 1 and {DEFAULT_WASM_TIMEOUT_SECONDS}"
        )
    if len(args.forbidden_root) > MAX_FORBIDDEN_ROOTS:
        parser.error(f"at most {MAX_FORBIDDEN_ROOTS} --forbidden-root values are allowed")
    try:
        args.forbidden_root = tuple(
            normalize_forbidden_root(value) for value in args.forbidden_root
        )
    except InspectionError as error:
        parser.error(str(error))
    if len(set(args.forbidden_root)) != len(args.forbidden_root):
        parser.error("--forbidden-root values must be unique")
    validator = pathlib.Path(args.wasm_validator)
    if validator.is_symlink() or not validator.is_file():
        parser.error(f"--wasm-validator is not a regular non-symlink file: {validator}")
    args.wasm_validator = validator.resolve()
    return args


def write_result(result: dict[str, object], output: str) -> None:
    payload = (json.dumps(result, indent=2, sort_keys=True) + "\n").encode("utf-8")
    if len(payload) > MAX_OUTPUT_BYTES:
        fail(f"inspection JSON exceeds {MAX_OUTPUT_BYTES} bytes")
    if output == "-":
        sys.stdout.buffer.write(payload)
        return
    path = pathlib.Path(output)
    if path.is_symlink():
        fail(f"refusing to replace symlink output: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix=f".{path.name}.", delete=False) as tmp:
        temporary = pathlib.Path(tmp.name)
        tmp.write(payload)
    try:
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def main() -> int:
    args = parse_args()
    try:
        result = BottleInspector(
            pathlib.Path(args.archive),
            args.formula,
            args.version,
            args.expected_abi,
            args.expected_arch,
            args.wasm_validator,
            args.wasm_timeout_seconds,
            args.forbidden_root,
        ).run()
        write_result(result, args.out)
    except InspectionError as error:
        print(f"homebrew-inspect-bottle.py: {error}", file=sys.stderr)
        return 1
    except (OSError, subprocess.SubprocessError, tarfile.TarError, UnicodeError) as error:
        print(f"homebrew-inspect-bottle.py: inspection failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
