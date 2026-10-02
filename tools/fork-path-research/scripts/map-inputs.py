#!/usr/bin/env python3
"""Print `input<TAB>sha256` for every object that contributed code to a
wasm-ld link, read from the link's -Map file, while the build tree still
exists. Archive members print as `archive(member)` (one line per member of
that name). Run in the link's working directory."""
import hashlib, re, sys

def ar_members(path):
    b = open(path, "rb").read()
    if not b.startswith(b"!<arch>\n"):
        return []
    out, names, off = [], b"", 8
    while off + 60 <= len(b):
        h = b[off:off + 60]
        raw = h[0:16].decode("latin-1").strip()
        size = int(h[48:58].decode().strip() or 0)
        data, end = off + 60, off + 60 + size
        name = None
        if raw == "//":
            names = b[data:end]
        elif raw in ("/", "/SYM64/") or raw.startswith("__.SYMDEF"):
            pass
        elif raw.startswith("#1/"):
            n = int(raw[3:])
            name = b[data:data + n].rstrip(b"\0").decode("latin-1")
            data += n
        elif raw.startswith("/") and raw[1:].isdigit():
            o = int(raw[1:])
            e = names.find(b"\n", o)
            name = names[o:e if e >= 0 else len(names)].decode("latin-1").rstrip("/")
        else:
            name = raw.rstrip("/")
        if name and not name.startswith("__.SYMDEF"):
            out.append((name, b[data:end]))
        off = end + (end % 2)
    return out

seen, archives = set(), {}
in_code = False
for line in open(sys.argv[1], encoding="utf-8", errors="replace"):
    m = re.match(r"^\s+(\S+)\s+([0-9a-f]+)\s+([0-9a-f]+)( +)(.*)$", line.rstrip("\n"))
    if not m:
        continue
    gap, rest = len(m.group(4)), m.group(5)
    if gap == 1:  # output section header
        in_code = rest == "CODE"
        continue
    if not in_code or ":(" not in rest or gap >= 14:
        continue
    inp = rest[: rest.rindex(":(")]
    if inp.startswith("<") or inp in seen:
        continue
    seen.add(inp)
    try:
        if inp.endswith(")") and "(" in inp:
            a, mem = inp[: inp.rindex("(")], inp[inp.rindex("(") + 1 : -1]
            if a not in archives:
                archives[a] = ar_members(a)
            for n, data in archives[a]:
                if n == mem:
                    print(f"{inp}\t{hashlib.sha256(data).hexdigest()}")
        else:
            print(f"{inp}\t{hashlib.sha256(open(inp, 'rb').read()).hexdigest()}")
    except OSError as e:
        print(f"{inp}\t-\t{e}")
