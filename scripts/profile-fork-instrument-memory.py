#!/usr/bin/env python3
"""Guarded macOS phase and complete-transform measurements on controlled examples.

The instrument phase transforms, validates and atomically writes complete
artifacts. A separate guarded Node process checks their host contract and
controlled normal execution; it is excluded from transformation measurements.
The native example reports the OS lifetime physical-footprint peak; polling
enforces the guard rather than estimating short-lived peaks.
"""

import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import platform
import signal
import statistics
import subprocess
import sys
import time


class Usage(ctypes.Structure):
    # macOS SDK sys/resource.h, struct rusage_info_v4.
    _fields_ = [("uuid", ctypes.c_ubyte * 16), ("values", ctypes.c_uint64 * 35)]


def guarded(command, prefix, ceiling, timeout, env):
    library = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
    library.proc_pid_rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
    library.proc_pid_rusage.restype = ctypes.c_int
    started = time.monotonic()
    peak_sample = 0
    reason = None
    with prefix.with_suffix(".stdout").open("w") as stdout, \
            prefix.with_suffix(".stderr").open("w") as stderr, \
            prefix.with_suffix(".samples.tsv").open("w") as trace:
        process = subprocess.Popen(command, stdout=stdout, stderr=stderr,
                                   env=env, start_new_session=True)
        trace.write("elapsed_s\tphysical_bytes\tresident_bytes\tlifetime_physical_peak_bytes\n")
        try:
            while process.poll() is None:
                usage = Usage()
                elapsed = time.monotonic() - started
                if library.proc_pid_rusage(process.pid, 4, ctypes.byref(usage)) == 0:
                    physical, resident, lifetime = usage.values[7], usage.values[6], usage.values[28]
                    peak_sample = max(peak_sample, physical)
                    trace.write(f"{elapsed:.6f}\t{physical}\t{resident}\t{lifetime}\n")
                    if max(physical, lifetime) >= ceiling:
                        reason = "physical-footprint guard"
                if elapsed > timeout:
                    reason = "wall-time guard"
                if reason:
                    os.killpg(process.pid, signal.SIGTERM)
                    try:
                        process.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                        process.wait()
                    break
                try:
                    process.wait(timeout=0.005)
                except subprocess.TimeoutExpired:
                    pass
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
            process.wait()
    status = {"returncode": process.returncode, "stop_reason": reason,
              "elapsed_s": time.monotonic() - started,
              "sampled_physical_peak_bytes": peak_sample, "command": command}
    prefix.with_suffix(".status.json").write_text(json.dumps(status, indent=2) + "\n")
    if reason or process.returncode:
        raise RuntimeError(f"{prefix.name} failed: {status}; see .stderr")
    return status


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--rounds", type=int, default=3)
    parser.add_argument("--guard-gib", type=float, default=1.0)
    parser.add_argument("--timeout", type=float, default=120)
    parser.add_argument("--phases", nargs="+", choices=("frontend", "roundtrip", "sinks", "instrument"),
                        default=["frontend", "roundtrip"])
    parser.add_argument("--generator", choices=("generate", "generate-sinks"), default="generate")
    args = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("the physical-footprint comparison currently requires macOS")
    if args.rounds < 1 or not (0 < args.guard_gib <= 16) or args.timeout <= 0:
        parser.error("invalid rounds, guard (0 < GiB <= 16), or timeout")
    if "instrument" in args.phases and args.generator != "generate-sinks":
        parser.error("instrument comparisons require the controlled ABI-valid generate-sinks fixtures")
    binary = args.binary.resolve(strict=True)
    directory = args.output_dir.resolve()
    directory.mkdir(parents=True, exist_ok=False)
    inputs = directory / "inputs"
    env = dict(os.environ, RAYON_NUM_THREADS="2")
    ceiling = int(args.guard_gib * 1024**3)
    guarded([str(binary), args.generator, str(inputs)], directory / "generate",
            ceiling, args.timeout, env)
    hashes = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(inputs.glob("*.wasm"))}
    metadata = {"platform": platform.platform(), "machine": platform.machine(),
                "python": platform.python_version(), "rounds": args.rounds,
                "guard_bytes": ceiling, "timeout_s": args.timeout,
                "binary": str(binary), "binary_sha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
                "input_sha256": hashes, "rayon_threads": 2,
                "generator": args.generator, "phases": args.phases,
                "scope": "frontend: front-end/closure/binding; roundtrip: also serialization; sinks: facts/sink planning; instrument: complete transform, file snapshots, feature declaration, validation, atomic publish, checksums; excludes Binaryen and separate Node validation"}
    rows = []
    report = directory / "results.json"
    for source in sorted(inputs.glob("*.wasm")):
        for phase in args.phases:
            expected = None
            output_hashes = {}
            for repeat in range(args.rounds):
                order = ("eager", "stream") if repeat % 2 == 0 else ("stream", "eager")
                for backend in order:
                    prefix = directory / f"{source.stem}-{phase}-{repeat}-{backend}"
                    command = [str(binary), "measure", backend, phase, str(source)]
                    artifact = prefix.with_suffix(".wasm")
                    if phase == "instrument":
                        command.append(str(artifact))
                    status = guarded(command,
                                     prefix, ceiling, args.timeout, env)
                    row = json.loads(prefix.with_suffix(".stdout").read_text())
                    if row["physical_lifetime_peak_bytes"] >= ceiling:
                        raise RuntimeError(f"{prefix.name} exceeded the physical guard between samples")
                    if phase == "instrument":
                        check = tuple(row[k] for k in ("input_bytes", "contract_sha256", "data_sha256"))
                        if output_hashes.setdefault(backend, row["output_sha256"]) != row["output_sha256"]:
                            raise RuntimeError(f"nondeterministic full output: {prefix.name}")
                        if hashlib.sha256(artifact.read_bytes()).hexdigest() != row["output_sha256"]:
                            raise RuntimeError(f"published bytes differ from measured artifact: {prefix.name}")
                        checker = Path(__file__).resolve().with_name("check-fork-memory-artifact.ts")
                        row["validation_status"] = guarded(
                            ["node", "--experimental-wasm-exnref", "--import", "tsx", str(checker), str(artifact)],
                            directory / f"{prefix.name}-validation", ceiling, args.timeout, env)
                    else:
                        check = tuple(row[k] for k in ("functions", "activations", "control",
                                                   "activation_hash", "control_hash", "binding_hash",
                                                   "boundaries", "boundary_hash", "fork_returning", "returning_hash"))
                    if expected is None:
                        expected = check
                    if check != expected:
                        raise RuntimeError(f"comparison fingerprint differs for {prefix.name}: {check} != {expected}")
                    row.update(case=source.stem, repeat=repeat, guard_status=status)
                    rows.append(row)
                    report.write_text(json.dumps({"metadata": metadata, "runs": rows}, indent=2) + "\n")
            fields = []
            for backend in ("eager", "stream"):
                samples = [r for r in rows if r["case"] == source.stem and r["phase"] == phase and r["backend"] == backend]
                physical = [r["physical_lifetime_peak_bytes"] / 1024**2 for r in samples]
                heap = [r["rust_requested_peak_bytes"] / 1024**2 for r in samples]
                fields.append(f"{backend}: physical {statistics.median(physical):.2f} MiB ({min(physical):.2f}–{max(physical):.2f}); Rust {statistics.median(heap):.2f} MiB")
            print(f"{source.stem} / {phase}: " + "; ".join(fields), flush=True)
    print(f"Evidence: {report}")


if __name__ == "__main__":
    main()
