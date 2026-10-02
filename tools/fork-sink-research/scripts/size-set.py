#!/usr/bin/env python3
"""Instrument a named shipped-shape module with an allowlist taken from a set
computed on a different module (e.g. the pre-wasm-opt link with typed facts).

  size-set.py <named.wasm> <set-file> <label>

Names are matched exactly; the report says how many set names exist in the
target. A function the set omits but which wasm-opt merged into a listed
caller stays uninstrumented, so this is an ESTIMATE, not a buildable artifact."""
import os, subprocess, sys

def leb(b, i):
    r = s = 0
    while True:
        x = b[i]; i += 1; r |= (x & 0x7F) << s; s += 7
        if x < 0x80: return r, i

def measure(path):
    b = open(path, "rb").read(); i = 8; code = 0; drop = 0
    while i < len(b):
        start = i; sid = b[i]; i += 1; n, i = leb(b, i)
        if sid == 10: code = n
        if sid == 0:
            l, j = leb(b, i); nm = b[j:j + l].decode("latin-1")
            if nm == "name" or nm.startswith(".debug") or nm in ("producers", "sourceMappingURL", "external_debug_info"):
                drop += (i + n) - start
        i += n
    return code, len(b) - drop

src, setf, label = sys.argv[1:4]
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../.."))
HOST = subprocess.run(["rustc", "-vV"], capture_output=True, text=True).stdout.split("host: ")[1].split()[0]
EXP = f"{ROOT}/.context/sink/instr-exp/target/{HOST}/release/wasm-fork-instrument"
names = set(l.rstrip("\n") for l in open(setf) if l.strip())
r = subprocess.run(["wasm-tools", "print", src], capture_output=True, text=True)
present = set()
for line in r.stdout.splitlines():
    if line.startswith("  (func $"):
        nm = line[len("  (func $"):].split(" (;")[0]
        if nm.startswith('"'):
            nm = nm[1:nm.index('" (;') if '" (;' in nm else -1]
        present.add(nm)
hit = names & present
allow = f"/tmp/size-set-{os.getpid()}.txt"
open(allow, "w").write("\n".join(sorted(hit)) + "\n")
dst = f"/tmp/size-set-{os.getpid()}.wasm"
env = dict(os.environ, WPK_FORK_ALLOWLIST=allow)
p = subprocess.run([EXP, src, "-o", dst], env=env, capture_output=True, text=True)
if p.returncode:
    print(f"{label}: instrument FAILED {p.stderr[-300:]}"); sys.exit(1)
c, f = measure(dst)
note = [l for l in p.stderr.splitlines() if l.startswith("allowlist:")]
print(f"{label}: set {len(names)} names, {len(hit)} present in target; code {c} file {f}; {note[0] if note else ''}")
os.remove(dst); os.remove(allow)
