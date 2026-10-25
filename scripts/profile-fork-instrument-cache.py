#!/usr/bin/env python3
"""Compare bounded native specialization-cache budgets on exact package inputs.

Complete raw transforms exclude Binaryen and guest execution. Cache statistics
come from separate diagnostic runs; every artifact is independently checked.
"""

import argparse
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import statistics
import time


def load_script(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--cache-mib", type=int, nargs="+", default=[0, 4, 16, 64])
    parser.add_argument("--rounds", type=int, default=3)
    parser.add_argument("--guard-gib", type=float, default=16)
    parser.add_argument("--timeout", type=float, default=1800)
    parser.add_argument("inputs", type=Path, nargs="+")
    args = parser.parse_args()
    if (args.rounds < 1 or any(size < 0 for size in args.cache_mib)
            or len(set(args.cache_mib)) != len(args.cache_mib)
            or not 0 < args.guard_gib <= 16 or args.timeout <= 0):
        parser.error("invalid rounds, cache sizes, guard or timeout")
    scripts = Path(__file__).resolve().parent
    packages = load_script("package_comparison", scripts / "profile-fork-instrument-packages.py")
    guard = load_script("memory_guard", scripts / "profile-fork-instrument-memory.py")
    binary = args.binary.resolve(strict=True)
    sources = [p.resolve(strict=True) for p in args.inputs]
    if len({p.stem for p in sources}) != len(sources):
        parser.error("input stems must be unique")
    directory = args.output_dir.resolve()
    directory.mkdir(parents=True, exist_ok=False)
    ceiling = int(args.guard_gib * 1024**3)
    env = dict(os.environ, RAYON_NUM_THREADS="2")
    env.pop("WPK_FORK_PROGRESS", None)
    metadata = dict(platform=platform.platform(), started_utc=time.strftime(
        "%Y-%m-%d %H:%M:%S UTC", time.gmtime()), rounds=args.rounds,
        cache_mib=args.cache_mib, guard_bytes=ceiling, timeout_s=args.timeout,
        binary=str(binary), binary_sha256=packages.sha256(binary),
        input_sha256={str(p): packages.sha256(p) for p in sources},
        scope="Fresh serial complete native transforms; separate cache diagnostics; "
              "independent Node compile/artifact checks; no Binaryen or guest execution.")
    report = dict(metadata=metadata, runs=[], diagnostics=[])
    report_path = directory / "results.json"
    stats = re.compile(r"(\d+) hits, (\d+) misses, (\d+) evictions, "
                       r"(\d+) peak bytes, (\d+) allowed bytes")
    expected = {}

    def run(source, size, repeat, diagnostic):
        suffix = "diagnostic" if diagnostic else str(repeat)
        prefix = directory / f"{source.stem}-cache-{size}-{suffix}"
        artifact = prefix.with_suffix(".wasm")
        command = [str(binary), "measure", "stream", "instrument", str(source),
                   str(artifact), str(size * 1024**2)]
        child_env = dict(env, WPK_FORK_PROGRESS="1") if diagnostic else env
        status = packages.run_guarded(guard, command, prefix, ceiling, args.timeout, child_env)
        row = json.loads(prefix.with_suffix(".stdout").read_text())
        digest = packages.sha256(artifact)
        if (digest != row["output_sha256"]
                or expected.setdefault(source.stem, digest) != digest):
            raise RuntimeError(f"cache budget changed output: {prefix.name}")
        if packages.sha256(source) != metadata["input_sha256"][str(source)]:
            raise RuntimeError(f"input changed: {source}")
        if row["physical_lifetime_peak_bytes"] >= ceiling:
            raise RuntimeError(f"physical guard exceeded between samples: {prefix.name}")
        validation = packages.validate(guard, scripts, artifact,
            directory / f"{prefix.name}-validation", ceiling, args.timeout, env)
        row.update(case=source.stem, cache_mib=size, repeat=repeat,
                   guard_status=status, validation_status=validation)
        if diagnostic:
            matches = stats.findall(prefix.with_suffix(".stderr").read_text())
            if not matches:
                raise RuntimeError(f"no cache diagnostics: {prefix.name}")
            names = ("hits", "misses", "evictions", "peak_bytes", "allowed_bytes")
            row["cache_sessions"] = [dict(zip(names, map(int, values))) for values in matches]
        report["diagnostics" if diagnostic else "runs"].append(row)
        report_path.write_text(json.dumps(report, indent=2) + "\n")
        print(f"{prefix.name}: {status['elapsed_s']:.3f}s, "
              f"{row['physical_lifetime_peak_bytes'] / 1024**2:.2f} MiB", flush=True)

    for source in sources:
        for size in args.cache_mib:
            run(source, size, None, True)
        for repeat in range(args.rounds):
            order = args.cache_mib if repeat % 2 == 0 else list(reversed(args.cache_mib))
            for size in order:
                run(source, size, repeat, False)
        for size in args.cache_mib:
            rows = [r for r in report["runs"] if r["case"] == source.stem and r["cache_mib"] == size]
            median = statistics.median(r["guard_status"]["elapsed_s"] for r in rows)
            print(f"{source.stem}, {size} MiB cache median: {median:.3f}s", flush=True)
    print(f"Evidence: {report_path}")


if __name__ == "__main__":
    main()
