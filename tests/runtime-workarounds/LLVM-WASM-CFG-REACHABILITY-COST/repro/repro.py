"""Time a reducible Wasm state machine through and up to the irreducible-CFG pass.

The control runs the identical compile and stops before the
wasm-fix-irreducible-control-flow pass (-stop-before), so it measures the
frontend, middle end and code generation that precede the analysis. It
replaced the -wasm-disable-fix-irreducible-control-flow-pass switch, which
LLVM 23 removed (llvm-project#185072), and works on releases with and
without that switch. An unknown -stop-before pass name is a hard compiler
error, so a renamed pass cannot silently turn the control into a full build.

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
        compile = [
            CLANG, "--target=wasm32-unknown-unknown", "-O0", "-nostdlib",
            str(root / "input.c"),
        ]
        start = time.monotonic()
        subprocess.run(compile + [
            "-c", "-mllvm", "-stop-before=wasm-fix-irreducible-control-flow",
            "-o", str(root / "control.mir"),
        ], check=True, timeout=15, capture_output=True)
        control = time.monotonic() - start
        start = time.monotonic()
        try:
            default_wasm = root / "default.wasm"
            subprocess.run(compile + [
                "-Wl,--no-entry", "-Wl,--export=lex", "-o", str(default_wasm),
            ], check=True, timeout=30, capture_output=True)
        except subprocess.TimeoutExpired:
            default = ">30"
            verdict = "reproduced" if control < 2 else "inconclusive"
            # The timed-out compile produced nothing to check.
            checked = ""
        else:
            default = time.monotonic() - start
            subprocess.run(["node", str(CHECK), str(default_wasm), str(STATE_COUNT)],
                           check=True, timeout=15)
            # A ratio captures the analysis cost across faster and slower hosts.
            # The absolute floor avoids timing noise on tiny compilation times.
            reproduced = default > 3 and default / control > 30
            verdict = "reproduced" if reproduced else "not-reproduced"
            checked = f"; {STATE_COUNT * 6} state/input combinations checked"
        details = (f"{STATE_COUNT} states; control={control:.3f}s, "
                   f"default={default}s{checked}")
        print("REPRO-VERDICT " + json.dumps({"verdict": verdict, "details": details}))


if __name__ == "__main__":
    run()
