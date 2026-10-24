#!/usr/bin/env python3
"""Compare complete transforms of identical, pre-instrumentation package inputs.

Uses the memory_comparison example and the existing macOS physical-memory
guard. Each measurement is a fresh process. Independent Node compilation and
host-contract checks are outside transform timings; no guest is executed.
"""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import resource
import statistics
import sys
import time


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def run_guarded(guard, command, prefix, ceiling, timeout, env):
    # This coordinator launches one child at a time. Reaped-child CPU deltas
    # include the CLI's waited-for optimizer, but exclude later validators.
    before = resource.getrusage(resource.RUSAGE_CHILDREN)
    status = guard.guarded(command, prefix, ceiling, timeout, env)
    after = resource.getrusage(resource.RUSAGE_CHILDREN)
    status.update(cpu_user_s=after.ru_utime - before.ru_utime,
                  cpu_system_s=after.ru_stime - before.ru_stime)
    prefix.with_suffix(".status.json").write_text(json.dumps(status, indent=2) + "\n")
    return status


def validate(guard, scripts, artifact, prefix, ceiling, timeout, env):
    return run_guarded(guard,
        ["node", "--experimental-wasm-exnref", "--import", "tsx",
         str(scripts / "check-fork-memory-artifact.ts"), str(artifact), "--contract-only"],
        prefix, ceiling, timeout, env)


def measure_cli(guard, cli, scripts, source, directory, rounds, ceiling, timeout, env,
                participates, input_hash):
    """Time the production CLI, including Binaryen, without a memory claim.

    The existing guard observes the parent process, not the optimizer child's
    physical footprint. Keep these rows separate from complete-transform peaks.
    """
    rows = []
    hashes = {}
    for repeat in range(rounds):
        order = ("walrus", "native") if repeat % 2 == 0 else ("native", "walrus")
        for backend in order:
            prefix = directory / f"{source.stem}-cli-{repeat}-{backend}"
            artifact = prefix.with_suffix(".wasm")
            command = [str(cli), str(source), "--backend", backend,
                       "--post-optimize", "Os", "-o", str(artifact)]
            load_before = os.getloadavg()
            status = run_guarded(guard, command, prefix, ceiling, timeout, env)
            load_after = os.getloadavg()
            digest = sha256(artifact)
            if not participates and digest != input_hash:
                raise RuntimeError(f"no-op CLI changed the input: {prefix.name}")
            if hashes.setdefault(backend, digest) != digest:
                raise RuntimeError(f"nondeterministic optimized output: {prefix.name}")
            validation = validate(guard, scripts, artifact, directory / f"{prefix.name}-validation",
                                  ceiling, timeout, env)
            rows.append(dict(case=source.stem, phase="cli-post-optimize-Os", backend=backend,
                             repeat=repeat, output_bytes=artifact.stat().st_size,
                             load_average_before=load_before, load_average_after=load_after,
                             output_sha256=digest, guard_status=status, validation_status=validation))
            print(f"{source.stem} CLI round {repeat + 1} {backend}: "
                  f"{status['elapsed_s']:.3f}s", flush=True)
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--cli", type=Path, help="also time the production CLI with --post-optimize Os")
    parser.add_argument("--rounds", type=int, default=3)
    parser.add_argument("--guard-gib", type=float, default=16)
    parser.add_argument("--timeout", type=float, default=1800)
    parser.add_argument("inputs", nargs="+", type=Path)
    args = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("the physical-footprint comparison currently requires macOS")
    if args.rounds < 1 or not (0 < args.guard_gib <= 16) or args.timeout <= 0:
        parser.error("invalid rounds, guard (0 < GiB <= 16), or timeout")
    sources = [p.resolve(strict=True) for p in args.inputs]
    if len({p.stem for p in sources}) != len(sources):
        parser.error("input stems must be unique")
    binary = args.binary.resolve(strict=True)
    cli = args.cli.resolve(strict=True) if args.cli else None
    directory = args.output_dir.resolve()
    directory.mkdir(parents=True, exist_ok=False)
    scripts = Path(__file__).resolve().parent
    spec = importlib.util.spec_from_file_location(
        "memory_guard", scripts / "profile-fork-instrument-memory.py")
    guard = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(guard)
    env = dict(os.environ, RAYON_NUM_THREADS="2")
    ceiling = int(args.guard_gib * 1024**3)
    metadata = {
        "platform": platform.platform(), "machine": platform.machine(),
        "started_utc": time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime()),
        "logical_cpus": os.cpu_count(),
        "python": platform.python_version(), "rounds": args.rounds,
        "guard_bytes": ceiling, "timeout_s": args.timeout,
        "binary": str(binary), "binary_sha256": sha256(binary),
        "cli": str(cli) if cli else None, "cli_sha256": sha256(cli) if cli else None,
        "input_sha256": {str(p): sha256(p) for p in sources},
        "rayon_threads": 2,
        "scope": "Complete transforms with common immutable I/O, feature metadata, "
                 "serial structural validation, atomic publication and checksums; "
                 "no Binaryen or guest execution in raw transforms. Optional CLI Os timings "
                 "include Binaryen but do not measure its child-process memory. "
                 "Separate Node compile/contract checks.",
    }
    rows = []
    report = directory / "results.json"
    report.write_text(json.dumps({"metadata": metadata, "runs": rows}, indent=2) + "\n")
    for source in sources:
        expected = None
        outputs = {}
        for repeat in range(args.rounds):
            order = ("eager", "stream") if repeat % 2 == 0 else ("stream", "eager")
            for backend in order:
                prefix = directory / f"{source.stem}-{repeat}-{backend}"
                artifact = prefix.with_suffix(".wasm")
                command = [str(binary), "measure", backend, "instrument", str(source), str(artifact)]
                load_before = os.getloadavg()
                status = run_guarded(guard, command, prefix, ceiling, args.timeout, env)
                load_after = os.getloadavg()
                row = json.loads(prefix.with_suffix(".stdout").read_text())
                if row["physical_lifetime_peak_bytes"] >= ceiling:
                    raise RuntimeError(f"{prefix.name} exceeded the physical guard between samples")
                if sha256(source) != metadata["input_sha256"][str(source)]:
                    raise RuntimeError(f"input changed: {source}")
                if sha256(artifact) != row["output_sha256"]:
                    raise RuntimeError(f"published bytes differ: {prefix.name}")
                if outputs.setdefault(backend, row["output_sha256"]) != row["output_sha256"]:
                    raise RuntimeError(f"nondeterministic output: {prefix.name}")
                if not row["participates"] and row["output_sha256"] != metadata["input_sha256"][str(source)]:
                    raise RuntimeError(f"no-op transform changed the input: {prefix.name}")
                fingerprint = tuple(row[k] for k in ("input_bytes", "participates", "contract_sha256", "data_sha256"))
                if expected is None:
                    expected = fingerprint
                if fingerprint != expected:
                    raise RuntimeError(f"ABI or data fingerprint differs: {prefix.name}")
                row["validation_status"] = validate(
                    guard, scripts, artifact, directory / f"{prefix.name}-validation",
                    ceiling, args.timeout, env)
                row.update(case=source.stem, repeat=repeat, guard_status=status,
                           load_average_before=load_before, load_average_after=load_after)
                rows.append(row)
                report.write_text(json.dumps({"metadata": metadata, "runs": rows}, indent=2) + "\n")
                print(f"{source.stem} round {repeat + 1} {backend}: "
                      f"{status['elapsed_s']:.3f}s, "
                      f"{row['physical_lifetime_peak_bytes'] / 1024**2:.2f} MiB", flush=True)
        for backend in ("eager", "stream"):
            samples = [r for r in rows if r["case"] == source.stem and r["backend"] == backend]
            print(f"{source.stem} {backend} median: "
                  f"{statistics.median(r['guard_status']['elapsed_s'] for r in samples):.3f}s", flush=True)
        if cli:
            rows.extend(measure_cli(guard, cli, scripts, source, directory, args.rounds,
                                    ceiling, args.timeout, env, row["participates"],
                                    metadata["input_sha256"][str(source)]))
            report.write_text(json.dumps({"metadata": metadata, "runs": rows}, indent=2) + "\n")
    print(f"Evidence: {report}")


if __name__ == "__main__":
    main()
