#!/usr/bin/env python3
"""Identify actual installed SDK build components without changing Rust's version."""

import argparse
import hashlib
import json
import re
from pathlib import Path

SCHEMA = Path(__file__).resolve().parents[3] / "sdk/guest-rust/src/sdk-components.json"


def create_manifest(components):
    schema = json.loads(SCHEMA.read_text())
    required = set(schema["required"])
    allowed = required | set(schema["optional"])
    if required - components.keys():
        raise ValueError("missing SDK components: " + ", ".join(sorted(required - components.keys())))
    if components.keys() - allowed:
        raise ValueError("unknown SDK components: " + ", ".join(sorted(components.keys() - allowed)))
    digest = hashlib.sha256((schema["domain"] + "\0").encode("ascii"))
    for name, value in sorted(components.items()):
        if not isinstance(value, str) or not re.fullmatch("[0-9a-f]{64}", value):
            raise ValueError("invalid component digest: " + name)
        digest.update(name.encode("ascii") + b"\0" + value.encode("ascii") + b"\0")
    return {"schema": schema["schema"], "components": dict(sorted(components.items())),
            "identity": digest.hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--component", nargs=2, action="append", default=[], metavar=("NAME", "FILE"))
    parser.add_argument("--digest", nargs=2, action="append", default=[], metavar=("NAME", "SHA256"))
    args = parser.parse_args()
    components = {}
    try:
        for name, path in args.component:
            if name in components:
                raise ValueError("duplicate SDK component: " + name)
            with Path(path).open("rb") as stream:
                components[name] = hashlib.file_digest(stream, "sha256").hexdigest()
        for name, value in args.digest:
            if name in components:
                raise ValueError("duplicate SDK component: " + name)
            components[name] = value
        print(json.dumps(create_manifest(components), sort_keys=True, indent=2))
    except (OSError, ValueError) as error:
        parser.exit(1, f"rust-sdk-manifest: {error}\n")


if __name__ == "__main__":
    main()
