#!/usr/bin/env python3
"""Read the primary archive identity once, for standalone and resolver recipes.

Output is three NUL-delimited data fields, never executable shell code.
"""
import pathlib
import re
import sys
import tomllib


def archive_identity(path):
    with pathlib.Path(path).open("rb") as stream:
        manifest = tomllib.load(stream)
    source = manifest["source"]
    values = (manifest["version"], source["url"], source["sha256"])
    if source.get("provider", "archive") != "archive":
        raise ValueError("primary source must be an archive")
    if any(not isinstance(value, str) or not value or "\0" in value for value in values):
        raise ValueError("invalid archive identity")
    if not re.fullmatch(r"[0-9a-fA-F]{64}", values[2]):
        raise ValueError("invalid source.sha256")
    return values


if __name__ == "__main__":
    try:
        for value in archive_identity(sys.argv[1]):
            sys.stdout.buffer.write(value.encode() + b"\0")
    except (IndexError, KeyError, ValueError, OSError) as error:
        sys.exit(f"package-source-metadata: {error}")
