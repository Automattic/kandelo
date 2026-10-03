#!/usr/bin/env python3
"""Parse KANDELO_FORK_STACK_LOG output into the oracle files fpa reads.
  stacks.py <stack-log> <module-name-prefix> <out-prefix>
Writes <out>.funcs (union of observed program functions, one per line) and
<out>.parsed (each fork's frames, `--` separated). Instrumenter-generated
helpers (__wpk_*) are dropped: they are not part of the analysed module."""
import re, sys
log, mod, out = sys.argv[1:4]
frame = re.compile(r"^\s+at (.+) \(wasm://wasm/([^:]+):wasm-function\[(\d+)\]:0x[0-9a-f]+\)$")
stacks, cur = [], None
for line in open(log, encoding="utf-8", errors="replace"):
    line = line.rstrip("\n")
    if line.startswith("== "):
        cur = []
        stacks.append((line[3:], cur))
        continue
    m = frame.match(line)
    if not m or cur is None:
        continue
    name, module = m.group(1), m.group(2)
    if not module.startswith(mod + "-"):
        continue
    if name.startswith(mod + "."):
        name = name[len(mod) + 1:]
    if name.startswith("__wpk_") or name.startswith("wpk_"):
        continue
    cur.append(name)
funcs = sorted({f for _, s in stacks for f in s})
open(out + ".funcs", "w").write("\n".join(funcs) + "\n")
with open(out + ".parsed", "w") as f:
    for hdr, s in stacks:
        f.write(f"-- {hdr}\n" + "\n".join(s) + "\n")
print(f"{len(stacks)} fork stacks, {len(funcs)} distinct functions, max depth {max((len(s) for _, s in stacks), default=0)}")
