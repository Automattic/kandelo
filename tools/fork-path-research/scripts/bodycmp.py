# Compare two wasm objects by the multiset of function bodies, where call
# targets, local labels and numbered internal symbols are normalized.
import subprocess, sys, re, collections
def bodies(p):
    out = subprocess.run(["wasm-objdump", "-d", p], capture_output=True, text=True).stdout
    funcs, cur = [], None
    for line in out.splitlines():
        if re.match(r'^[0-9a-f]+ func\[\d+\] <', line):
            if cur is not None: funcs.append("\n".join(cur))
            cur = []
        elif cur is not None and '|' in line:
            ins = line.split('|', 1)[1].strip()
            ins = re.sub(r'\b(call|return_call|ref\.func) \d+ <([^>]*)>', lambda m: f"{m.group(1)} <{re.sub(r'\.[0-9]+$', '.N', m.group(2))}>", ins)
            ins = re.sub(r'\.L[\w.]*', '.L', ins)
            cur.append(ins)
    if cur is not None: funcs.append("\n".join(cur))
    return collections.Counter(funcs)
a, b = bodies(sys.argv[1]), bodies(sys.argv[2])
print("SAME" if a == b else f"DIFF {sum((a - b).values())} {sum((b - a).values())}")
