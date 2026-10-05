#!/usr/bin/env python3
"""Print `<keep 0|1>\t<output>` for a wasm-ld argv, expanding @response files
(GNU quoting) relative to the current directory."""
import shlex, sys

def expand(args, depth=0):
    out = []
    for a in args:
        if a.startswith("@") and depth < 8:
            try:
                out += expand(shlex.split(open(a[1:], encoding="utf-8", errors="replace").read()), depth + 1)
                continue
            except OSError:
                pass
        out.append(a)
    return out

args = expand(sys.argv[1:])
keep, out, prev = 1, "", ""
for a in args:
    if a in ("-r", "--relocatable", "--shared", "-shared", "--version", "-v", "--help"):
        keep = 0
    if prev == "-o":
        out = a
    elif a.startswith("-o") and len(a) > 2 and not a.startswith("-o="):
        out = a[2:]
    prev = a
if any(s in out for s in ("conftest", "CMakeScratch", "CMakeTmp", "TryCompile")) or out in ("", "/dev/null"):
    keep = 0
print(f"{keep}\t{out}")
