# Replay the compile commands of existing build trees, emitting LLVM IR with
# CFI type metadata (-fsanitize=cfi-icall,cfi-vcall) instead of objects.
# Writes <out>/<build>/<n>.ll plus index.tsv (n -> source file). Never
# touches the build trees' own outputs.
import json, os, shlex, subprocess, sys, hashlib
from concurrent.futures import ThreadPoolExecutor
out_root, limit = os.path.abspath(sys.argv[1]), int(sys.argv[2]) if len(sys.argv) > 2 else 0
builds = ["qtbase-build", "qtdeclarative-build", "qtshadertools-build", "quickshell-build"]
PLUGIN = os.environ["KANDELO_CALLTYPES_PLUGIN"]
EXTRA = ["-Xclang", "-fsanitize=cfi-icall", "-Xclang", "-fsanitize-trap=cfi-icall", "-Xclang", "-fwhole-program-vtables",
         "-Xclang", "-flto-unit",
         "-Xclang", "-load", "-Xclang", PLUGIN, "-fpass-plugin=" + PLUGIN]
# Only compile units whose object the quickshell link actually used.
linked = set(open(os.path.join(os.path.dirname(__file__), "linked-members.txt")).read().split())
linked |= {os.path.basename(p) for p in open(os.path.join(os.path.dirname(__file__), "linked-objs.txt")).read().split()}
jobs = []
for b in builds:
    db = json.load(open(f"/tmp/compdb-{b}.json"))
    os.makedirs(f"{out_root}/{b}", exist_ok=True)
    n = 0
    for e in db:
        argv = shlex.split(e["command"])
        if not argv or not argv[0].endswith(("wasm32posix-c++", "wasm32posix-cc")) or "-c" not in argv:
            continue
        if "cmake_pch" in e["file"] or "-emit-pch" in argv or "pchstub" in e["file"]:
            continue
        new, skip = [], False
        it = iter(range(len(argv)))
        i = 0
        while i < len(argv):
            a = argv[i]
            if a in ("-MD", "-MMD"): i += 1; continue
            if a in ("-MT", "-MF", "-MQ", "-o"): i += 2; continue
            if a == "-c": i += 1; continue
            # Precompiled headers were built with other flags: drop the PCH
            # and keep the textual -include of the same header.
            if a == "-Xclang" and i + 3 < len(argv) and argv[i + 1] == "-include-pch":
                i += 4; continue
            new.append(a); i += 1
        out = f"{out_root}/{b}/{n}.o"
        o_arg = argv[argv.index("-o") + 1] if "-o" in argv else ""
        if os.path.basename(o_arg) not in linked:
            n += 1
            continue
        orig = os.path.join(e["directory"], o_arg)
        jobs.append((b, n, e["directory"], new + EXTRA + ["-mllvm", f"-kandelo-calltypes-out={out}.calltypes", "-c", "-o", out], e["file"], orig, new + ["-c", "-o", out + ".control.o"]))
        n += 1
        if limit and n >= limit: break
def same(a, b):
    try:
        return open(a, "rb").read() == open(b, "rb").read()
    except OSError:
        return None
def run(j):
    # Result: True = identical to the build's object; "control" = differs
    # from the build's object but identical to a plugin-free compile of the
    # same replayed command (e.g. PCH replaced by a textual include);
    # False = the plugin changed the code.
    b, n, d, argv, f, orig, control = j
    if not (os.path.exists(argv[-1]) and os.path.getsize(argv[-1]) > 0):
        p = subprocess.run(argv, cwd=d, capture_output=True, text=True)
        if p.returncode: return (b, n, p.returncode, f, p.stderr[-400:], None)
    sm = same(argv[-1], orig)
    if sm is False:
        p = subprocess.run(control, cwd=d, capture_output=True, text=True)
        if p.returncode == 0 and same(argv[-1], control[-1]): sm = "control"
        try: os.remove(control[-1])
        except OSError: pass
    return (b, n, 0, f, "", sm)
fails = 0
ident = {True: 0, False: 0, None: 0, "control": 0}
with ThreadPoolExecutor(int(os.environ.get("JOBS", "16"))) as ex, open(f"{out_root}/index.tsv", "w") as idx:
    for b, n, rc, f, err, sm in ex.map(run, jobs):
        idx.write(f"{b}\t{n}\t{rc}\t{sm}\t{f}\n")
        if rc: fails += 1; print(f"FAIL {b} {n} {f}\n{err}", flush=True)
        else: ident[sm] += 1
print(f"done jobs={len(jobs)} fails={fails} identical={ident[True]} identical-to-control={ident['control']} plugin-changed-code={ident[False]} no-original={ident[None]}")
