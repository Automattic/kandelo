#!/usr/bin/env python3
"""Print changed paths that match package build.toml inputs."""

from __future__ import annotations

import sys
from pathlib import Path

try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - local fallback for older Python.
    import tomli as tomllib  # type: ignore[no-redef]


def load_declared_inputs(registry: Path) -> set[str]:
    declared_inputs: set[str] = set()
    for build_toml in sorted(registry.glob("*/build.toml")):
        try:
            with build_toml.open("rb") as handle:
                data = tomllib.load(handle)
        except tomllib.TOMLDecodeError as exc:
            raise SystemExit(f"{build_toml}: invalid TOML: {exc}") from exc

        raw_inputs = data.get("inputs", [])
        if not isinstance(raw_inputs, list):
            raise SystemExit(f"{build_toml}: inputs must be an array of strings")

        for value in raw_inputs:
            if not isinstance(value, str):
                raise SystemExit(f"{build_toml}: inputs must be an array of strings")
            if value:
                declared_inputs.add(value.rstrip("/"))

    return declared_inputs


def matches_declared_input(path: str, declared_inputs: set[str]) -> bool:
    return any(path == item or path.startswith(f"{item}/") for item in declared_inputs)


def main() -> int:
    registry = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("packages/registry")
    if not registry.is_dir():
        return 0

    declared_inputs = load_declared_inputs(registry)
    changed_paths = [line.strip() for line in sys.stdin if line.strip()]
    matches = sorted({path for path in changed_paths if matches_declared_input(path, declared_inputs)})
    for path in matches:
        print(path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
