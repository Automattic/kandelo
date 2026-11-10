#!/usr/bin/env python3
"""Seal this benchmark's authored execution closure; never provision products."""
import hashlib
import json
import shutil
import sys
from pathlib import Path

CONFIGS = ("package.json", "package-lock.json", "tsconfig.json", "apps/browser-demos/package.json", "apps/browser-demos/package-lock.json")

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def inputs(root):
    directory = root / "benchmarks/desktop-latency"
    paths = sorted(p for p in directory.rglob("*") if p.is_file() or p.is_symlink())
    paths += [root / name for name in CONFIGS if (root / name).exists()]
    if not paths or len(paths) > 256:
        raise ValueError("Source closure count")
    if any(p.is_symlink() or not p.is_file() for p in paths):
        raise ValueError("Authored source must be regular, not a mutable symlink")
    if sum(p.stat().st_size for p in paths) > 8 * 1024 * 1024:
        raise ValueError("Source closure capacity")
    return {str(p.relative_to(root)): digest(p) for p in sorted(paths)}

def freeze(root, out):
    sealed = out / "source"
    sealed.mkdir()
    before = inputs(root)
    for name in before:
        target = sealed / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(root / name, target)
    # Copies, not hardlinks: a concurrent edit cannot change the executed bytes.
    if inputs(root) != before or inputs(sealed) != before:
        raise ValueError("Source changed while sealing")
    links = {}
    for name in ("node_modules", "apps/browser-demos/node_modules"):
        source = root / name
        if source.exists():
            target = sealed / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.symlink_to(source.resolve())
            links[name] = str(source.resolve())
    (out / "frozen-source.json").write_text(json.dumps({"schema": 1, "origin": str(root), "files": before, "dependencyLinks": links}, indent=2) + "\n")
    print("Sealed benchmark authored source", len(before))

def verify(root, out, phase):
    if not phase or not all(c.isalnum() or c == "-" for c in phase):
        raise ValueError("Invalid custody phase")
    expected = json.loads((out / "frozen-source.json").read_text())["files"]
    def observe(directory):
        try:
            actual = inputs(directory)
            return {"changed": sorted(name for name in set(expected) | set(actual) if expected.get(name) != actual.get(name))}
        except Exception as error:
            return {"error": str(error), "changed": ["<closure-unavailable>"]}
    origin, sealed = observe(root), observe(out / "source")
    valid = not origin["changed"] and not sealed["changed"]
    record = {"phase": phase, "valid": valid, "origin": origin, "sealed": sealed, "scope": "authored benchmark/config closure; declared dependency links separate"}
    text = json.dumps(record, indent=2) + "\n"
    (out / ("source-integrity-" + phase + ".json")).write_text(text)
    (out / "source-integrity.json").write_text(text)
    print(text, end="")
    return 0 if valid else 1

if __name__ == "__main__":
    try:
        command, root_arg, out_arg, *rest = sys.argv[1:]
        root, out = Path(root_arg).resolve(), Path(out_arg).resolve()
        if command == "freeze" and not rest:
            freeze(root, out)
        elif command == "verify" and len(rest) == 1:
            sys.exit(verify(root, out, rest[0]))
        else:
            raise ValueError("Expected freeze ROOT OUT or verify ROOT OUT PHASE")
    except Exception as error:
        print("Benchmark source custody failure:", error, file=sys.stderr)
        sys.exit(1)
