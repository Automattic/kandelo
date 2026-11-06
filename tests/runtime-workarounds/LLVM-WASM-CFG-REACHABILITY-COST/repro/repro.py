"""Compare one reducible Wasm state machine with/without CFG reachability analysis.

This reproduction uses no Kandelo source, headers, compiler plugins, or runtime.
"""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

CLANG = str(Path(os.environ["LLVM_BIN"]) / "clang")
STATE_COUNT = 3000
CHECK = Path(__file__).with_name("check.cjs")


def source():
    lines = [
        "extern int advance(int); typedef unsigned short State;",
        "__attribute__((optnone)) int lex(int lookahead, State state) {",
        "goto start; next: lookahead=advance(lookahead); start: switch(state) {",
    ]
    for state in range(STATE_COUNT):
        successors = [(state + step) % STATE_COUNT for step in (1, 2, 3)]
        lines.append(
            f"case {state}: {{ static const unsigned short map[] = {{"
            f"1,{successors[0]},2,{successors[1]},3,{successors[2]}"
            "}; for (unsigned j=0;j<6;j+=2) if(map[j]==lookahead) {"
            f"state=map[j+1]; goto next;}} }} return {state};"
        )
    lines += ["default:return -1;}}", "int advance(int x) {return x+1;}"]
    return "\n".join(lines)


def run():
    with tempfile.TemporaryDirectory(prefix="llvm-wasm-cfg-") as temp:
        root = Path(temp)
        (root / "input.c").write_text(source())
        base = [
            CLANG, "--target=wasm32-unknown-unknown", "-O0", "-nostdlib",
            "-Wl,--no-entry", "-Wl,--export=lex", str(root / "input.c"),
        ]
        control_wasm = root / "control.wasm"
        start = time.monotonic()
        subprocess.run(base + [
            "-mllvm", "-wasm-disable-fix-irreducible-control-flow-pass",
            "-o", str(control_wasm),
        ], check=True, timeout=15, capture_output=True)
        control = time.monotonic() - start
        subprocess.run(["node", str(CHECK), str(control_wasm), str(STATE_COUNT)],
                       check=True, timeout=15)
        start = time.monotonic()
        try:
            default_wasm = root / "default.wasm"
            subprocess.run(base + ["-o", str(default_wasm)],
                           check=True, timeout=30, capture_output=True)
        except subprocess.TimeoutExpired:
            default = ">30"
            verdict = "reproduced" if control < 2 else "inconclusive"
        else:
            default = time.monotonic() - start
            subprocess.run(["node", str(CHECK), str(default_wasm), str(STATE_COUNT)],
                           check=True, timeout=15)
            # A ratio captures the analysis cost across faster and slower hosts.
            # The absolute floor avoids timing noise on tiny compilation times.
            reproduced = default > 3 and default / control > 30
            verdict = "reproduced" if reproduced else "not-reproduced"
        details = (f"{STATE_COUNT} states; control={control:.3f}s, "
                   f"default={default}s; {STATE_COUNT * 6} state/input combinations checked")
        print("REPRO-VERDICT " + json.dumps({"verdict": verdict, "details": details}))


if __name__ == "__main__":
    run()
