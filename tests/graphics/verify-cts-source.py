#!/usr/bin/env python3
"""Check the port's executable assertion body against its recorded source pin."""
import hashlib
import json
from pathlib import Path
import sys

root = Path(__file__).resolve().parent / "cts"
metadata = json.loads((root / "upstream.json").read_text())

def method(source):
    start = source.index("void " + metadata["method"] + "(")
    cursor = source.index("{", start) + 1
    depth = 1
    while depth:
        depth += (source[cursor] == "{") - (source[cursor] == "}")
        cursor += 1
    return source[start:cursor] + "\n"

body = method((root / "surfaceless-case.inc").read_text())
assert hashlib.sha256(body.encode()).hexdigest() == metadata["method_sha256"]
if len(sys.argv) == 2:
    upstream = Path(sys.argv[1]) / metadata["file"]
    assert hashlib.sha256(upstream.read_bytes()).hexdigest() == metadata["file_sha256"]
    assert method(upstream.read_text()) == body
print("CTS assertion method matches " + metadata["revision"])
