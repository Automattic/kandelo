#!/usr/bin/env python3
"""Print `path<TAB>sha256` for every loose object file that contributed code
to a wasm-ld link, read from the link's -Map file. Archive members are
resolved later from the archive itself."""
import hashlib, os, re, sys

seen = set()
in_code = False
for line in open(sys.argv[1], encoding="utf-8", errors="replace"):
    m = re.match(r"^\s+(\S+)\s+([0-9a-f]+)\s+([0-9a-f]+)( +)(.*)$", line.rstrip("\n"))
    if not m:
        continue
    gap, rest = len(m.group(4)), m.group(5)
    if gap == 1:  # output section header
        in_code = rest == "CODE"
        continue
    if not in_code or ":(" not in rest:
        continue
    path = rest[: rest.rindex(":(")]
    if path.endswith(")") or path.startswith("<") or path in seen:
        continue
    seen.add(path)
    try:
        print(f"{path}\t{hashlib.sha256(open(path, 'rb').read()).hexdigest()}")
    except OSError as e:
        print(f"{path}\t-\t{e}")
