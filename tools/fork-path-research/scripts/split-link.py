#!/usr/bin/env python3
"""Research shim helper: turn `clang [flags] a.c b.cpp ... -o out` (compile and
link in one driver call) into one plugin compile per source followed by the
same link over the resulting objects. Side files are named by object SHA-256,
like the compile shim's."""
import os, subprocess, sys, tempfile, hashlib

real, out_dir, plugin, _sha = sys.argv[1:5]
args = sys.argv[5:]
SRC = (".c", ".cc", ".cpp", ".cxx", ".C", ".c++", ".m", ".mm")
TAKES = {"-o", "-MF", "-MT", "-MQ", "-x", "-include", "-I", "-isystem", "-iquote", "-idirafter",
         "-imacros", "-Xclang", "-mllvm", "-target", "-arch", "-isysroot", "--sysroot", "-Xlinker", "-L", "-l", "-u", "-z"}
srcs, prev = [], ""
for i, a in enumerate(args):
    if prev not in TAKES and not a.startswith("-") and a.endswith(SRC):
        srcs.append(i)
    prev = a
plug = ["-Xclang", "-fsanitize=cfi-icall,cfi-vcall", "-Xclang", "-fsanitize-trap=cfi-icall,cfi-vcall",
        "-Xclang", "-flto-unit", "-Xclang", "-load", "-Xclang", plugin, f"-fpass-plugin={plugin}"]
tmp = tempfile.mkdtemp(dir=os.path.join(out_dir, "side"), prefix=".split.")
objs = {}
for k, i in enumerate(srcs):
    o = os.path.join(tmp, f"{k}-{os.path.basename(args[i])}.o")
    side = os.path.join(tmp, f"{k}.calltypes")
    cargs, skip = [], False
    for j, a in enumerate(args):
        if skip:
            skip = False
            continue
        if a == "-o":
            skip = True
            continue
        if j in srcs and j != i:
            continue
        cargs.append(a)
    r = subprocess.run([real, *cargs, "-c", "-o", o, *plug, "-mllvm", f"-kandelo-calltypes-out={side}"])
    if r.returncode != 0:
        sys.exit(r.returncode)
    h = hashlib.sha256(open(o, "rb").read()).hexdigest()
    os.replace(side, os.path.join(out_dir, "side", f"{h}.calltypes"))
    with open(os.path.join(out_dir, "side", "index.tsv"), "a") as f:
        f.write(f"{h}\t{os.path.abspath(args[i])} (split-link)\n")
    objs[i] = o
# Link: objects replace sources; compile-only flags are harmless at link.
largs = [objs.get(j, a) for j, a in enumerate(args)]
os.execv(real, [real, *largs])
