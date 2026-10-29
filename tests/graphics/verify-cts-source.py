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
def definition(source, declaration, terminator):
    start = source.index(declaration)
    cursor = source.index("{", start) + 1
    depth = 1
    while depth:
        depth += (source[cursor] == "{") - (source[cursor] == "}")
        cursor += 1
    assert source[cursor:cursor + len(terminator)] == terminator
    return source[start:cursor + len(terminator)] + "\n"

for entry in metadata.get("additional_sources", []):
    snippet = (root / entry["snippet"]).read_text()
    assert hashlib.sha256(snippet.encode()).hexdigest() == entry["snippet_sha256"]
    source = None
    if len(sys.argv) == 2:
        upstream = Path(sys.argv[1]) / entry["file"]
        assert hashlib.sha256(upstream.read_bytes()).hexdigest() == entry["file_sha256"]
        source = upstream.read_text()
    for unit in entry["definitions"]:
        body = definition(snippet, unit["declaration"], unit["terminator"])
        assert hashlib.sha256(body.encode()).hexdigest() == unit["sha256"]
        if source is not None:
            assert definition(source, unit["declaration"], unit["terminator"]) == body
print("CTS assertion method and additional definitions match " + metadata["revision"])
