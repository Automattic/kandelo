#!/usr/bin/env python3
"""Shipped-shape sizes for allowlisted instrumentation.

  sizes.py <name> <named-input.wasm> <out-dir> <ruleset>...

Runs fsa on the named shipped-shape input under each rule set (same function
identities as the instrumenter's input), instruments it with the experiment
instrumenter (WPK_FORK_ALLOWLIST = the fsa set), and prints the code-section
size and the file size without name/DWARF/producers sections. "today" is the
experiment instrumenter with no allowlist (identical transform to main)."""
import os, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../.."))
HOST = subprocess.run(["rustc", "-vV"], capture_output=True, text=True).stdout.split("host: ")[1].split()[0]
FSA = f"{ROOT}/tools/fork-sink-research/fsa/target/{HOST}/release/fsa"
EXP = f"{ROOT}/.context/sink/instr-exp/target/{HOST}/release/wasm-fork-instrument"
RULES = {
    "strict": ["--signal-policy", "sig"],
    "gate": ["--signal-policy", "nothrow", "--registries", "--param", "--cancel"],
    "equiv": ["--signal-policy", "nothrow", "--registries", "--param", "--cancel", "--exc", "equiv"],
    "runtime": ["--signal-policy", "nothrow", "--registries", "--param", "--cancel", "--exc", "runtime"],
    # What-if: the crt calls main directly (main leaves the function table).
    "gate-md": ["--signal-policy", "nothrow", "--registries", "--param", "--cancel", "--main-direct"],
    "equiv-md": ["--signal-policy", "nothrow", "--registries", "--param", "--cancel", "--main-direct", "--exc", "equiv"],
    "runtime-md": ["--signal-policy", "nothrow", "--registries", "--param", "--cancel", "--main-direct", "--exc", "runtime"],
}

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

name, src, out, *rulesets = sys.argv[1:]
os.makedirs(out, exist_ok=True)
c0, f0 = measure(src)
print(f"{name}: uninstrumented code {c0} file {f0}")
print(f"  {'variant':<10} {'functions':>9} {'code':>10} {'file':>10} {'code+%':>8}")
for rs in (["today", "none"] if os.environ.get("SKIP_BASE") != "1" else []) + rulesets:
    env = dict(os.environ); env.pop("WPK_FORK_ALLOWLIST", None)
    nfun = "-"
    if rs == "none":
        # Floor: same pipeline, empty allowlist (runtime scaffolding and
        # walrus dead-code removal, no instrumented function).
        setf = f"{out}/{name}.none.set"
        open(setf, "w").close()
        nfun = 0
        env["WPK_FORK_ALLOWLIST"] = setf
    elif rs != "today":
        setf = f"{out}/{name}.{rs}.set"
        r = subprocess.run([FSA, "--wasm", src, *RULES[rs], "--out-set", setf], capture_output=True, text=True)
        open(f"{out}/{name}.{rs}.fsa.txt", "w").write(r.stdout + r.stderr)
        if r.returncode:
            print(f"  {rs:<10} fsa FAILED"); continue
        nfun = sum(1 for _ in open(setf))
        env["WPK_FORK_ALLOWLIST"] = setf
    dst = f"{out}/{name}.{rs}.instr.wasm"
    r = subprocess.run([EXP, src, "-o", dst], env=env, capture_output=True, text=True)
    if r.returncode:
        print(f"  {rs:<10} instrument FAILED: {r.stderr.strip()[-300:]}"); continue
    if rs == "today":
        nfun = next((l.split()[-1] for l in r.stderr.splitlines() if "activations" in l), "-")
    c, f = measure(dst)
    print(f"  {rs:<10} {nfun:>9} {c:>10} {f:>10} {100.0*(c-c0)/c0:>7.1f}%", flush=True)
    os.remove(dst)
