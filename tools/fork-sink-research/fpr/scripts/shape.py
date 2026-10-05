#!/usr/bin/env python3
"""Shipped-shape size measurement for one program (run under the dev shell).

  shape.py <name> <link.wasm> <instr.in.wasm> <instr.out.wasm> <opt-seq|-> <set-file>... --out <dir>

opt-seq is the wasm-opt sequence that reproduces the shipped instrumenter input
from the link (e.g. "-O2 -g,-O2"; "-" = shipped input already has names; "raw"
= no wasm-opt). Builds a *named* equivalent of the shipped input (same code
section), instruments it with the experiment instrumenter (baseline, then each
allowlist), and prints code-section and stripped file sizes. Also repeats the
optimisation with duplicate-function elimination skipped, so the cost of keeping
function identity through wasm-opt is measured."""
import os, subprocess, sys

def leb(b, i):
    r = s = 0
    while True:
        x = b[i]; i += 1; r |= (x & 0x7F) << s; s += 7
        if x < 0x80: return r, i

def sections(path):
    b = open(path, "rb").read(); i = 8; out = {}
    while i < len(b):
        sid = b[i]; i += 1; n, i = leb(b, i)
        name = sid
        if sid == 0:
            l, j = leb(b, i); name = b[j:j + l].decode("latin-1")
        out.setdefault(name, []).append(b[i:i + n]); i += n
    return out

def code(path):
    return b"".join(sections(path).get(10, []))

def sh(*a):
    subprocess.run(a, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

def strip_size(path, tmp=None):
    """File size without name, DWARF and producers custom sections."""
    b = open(path, "rb").read(); i = 8; drop = 0
    while i < len(b):
        start = i
        sid = b[i]; i += 1; n, i = leb(b, i)
        if sid == 0:
            l, j = leb(b, i); nm = b[j:j + l].decode("latin-1")
            if nm == "name" or nm.startswith(".debug") or nm in ("producers", "sourceMappingURL", "external_debug_info"):
                drop += (i + n) - start
        i += n
    return len(b) - drop

args = sys.argv[1:]
out = args[args.index("--out") + 1]; args = args[: args.index("--out")]
name, link, cin, cout, seq, *sets = args
os.makedirs(out, exist_ok=True)
EXP = os.environ.get("FPR_EXP_INSTR", ".context/fpr/instr-exp/target/aarch64-apple-darwin/release/wasm-fork-instrument")

def optimize(src, dst, extra=()):
    if seq == "raw":
        sh("cp", src, dst); return
    cur = src
    for k, step in enumerate(seq.split()):
        flags = step.split(",")
        if "-g" not in flags: flags = ["-g"] + flags     # keep names
        nxt = f"{dst}.step{k}"
        sh("wasm-opt", cur, *flags, *extra, "-o", nxt)
        cur = nxt
    os.replace(cur, dst)

named = f"{out}/{name}.named.wasm"
if seq == "-":
    sh("cp", cin, named)
else:
    optimize(link, named)
same = code(named) == code(cin)
print(f"{name}: named input code section {'== shipped' if same else '!= shipped (sizes %d vs %d)' % (len(code(named)), len(code(cin)))}")
nodfe = f"{out}/{name}.nodfe.wasm"
if seq not in ("-", "raw"):
    optimize(link, nodfe, ("--skip-pass=duplicate-function-elimination",))
else:
    sh("cp", named, nodfe)
tmp = f"{out}/.tmp.wasm"
rows = []
def measure(label, src, allow):
    dst = f"{out}/{name}.{label}.instr.wasm"
    env = dict(os.environ)
    env.pop("WPK_FORK_ALLOWLIST", None)
    if allow: env["WPK_FORK_ALLOWLIST"] = os.path.abspath(allow)
    r = subprocess.run([EXP, src, "-o", dst], env=env, capture_output=True, text=True)
    if r.returncode:
        print(f"  {label}: instrument FAILED: {r.stderr[-300:]}"); return
    note = [l for l in r.stderr.splitlines() if l.startswith("allowlist:")]
    rows.append((label, len(code(src)), len(code(dst)), strip_size(src, tmp), strip_size(dst, tmp), note[0] if note else ""))
measure("baseline", named, None)
for s in sets:
    measure(os.path.basename(s), named, s)
if seq not in ("-", "raw"):
    measure("nodfe-baseline", nodfe, None)
    for s in sets:
        measure("nodfe-" + os.path.basename(s), nodfe, s)
print(f"  shipped input code {len(code(cin))}, shipped output code {len(code(cout))}; experiment baseline output code {rows[0][2] if rows else '?'}")
print(f"  {'variant':<40} {'code in':>10} {'code out':>10} {'file in':>10} {'file out':>10}  allowlist")
for r in rows:
    print(f"  {r[0]:<40} {r[1]:>10} {r[2]:>10} {r[3]:>10} {r[4]:>10}  {r[5]}")
