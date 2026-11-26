#!/usr/bin/env python3
"""Keep the executable link contract in the SDK compiler drivers."""

import os
from pathlib import Path
import re
import subprocess
import sys


# These consumers inspect, stage, or generate the allowance.
ALLOWANCE_READERS_AND_GENERATORS = {
    "images/vfs/scripts/build-kandelo-sdk-vfs-image.ts",  # Stages the SDK.
    "packages/registry/ffmpeg/audit-configure.sh",  # Checks finished Wasm imports.
    "scripts/test-install-local-binary-sealed.sh",  # Stages a verifier fixture.
    "scripts/test-install-local-generation.sh",  # Stages a verifier fixture.
    "scripts/test-wasm-artifact-guards.sh",  # Derives a verifier fixture.
    "scripts/wasm-artifact-guards.sh",  # Validates finished artifacts.
    "tools/xtask/src/dump_abi.rs",  # Generates the base host allowance.
    "tools/xtask/src/program_extensions.rs",  # Generates the SDK link allowance.
}

CRT_READERS = {
    "scripts/musl-build-state.sh",  # Checks installed sysroot files.
    "scripts/musl-output-state.mjs",  # Hashes installed sysroot files.
    "scripts/test-musl-build-state.sh",  # Stages a fake sysroot.
    "scripts/test-package-isolated-output-contracts.sh",  # Stages a fake sysroot.
    "tests/package-system/sdk-sysroot-content.test.ts",  # Checks SDK contents.
    "tools/xtask/src/package_imports.rs",  # Reads the startup object's imports.
}

EXCLUDED = ("sdk/", "crates/kandelo-cc/", ".cargo/", "docs/")
COMMENT = re.compile(r"^\s*(?:#|//|/\*|\*\s|<!--|;)")
FLAGS = re.compile(
    r"--(?:allow-undefined|table-base|global-base|export-table|growable-table)(?![\w-])"
    r"|--export[=,\s]+(?:__heap_base|__wasm_thread_init|__wasm_init_tls)(?!\w)"
)
ALLOWANCE = re.compile(r"kandelo-(?:host|link)-imports\.txt")
CRT = re.compile(r"lib/crt1\.o(?![\w.])")


def check(root: Path) -> bool:
    tracked = subprocess.check_output(["git", "ls-files", "-z", "--deduplicate"], cwd=root)
    ok = True
    for path in map(os.fsdecode, tracked.split(b"\0")):
        if not path or path.startswith(EXCLUDED):
            continue
        file = root / path
        if file.is_symlink() or not file.is_file():
            continue
        data = file.read_bytes()
        if b"\0" in data:
            continue
        for number, line in enumerate(data.decode("utf-8", errors="replace").splitlines(), 1):
            if COMMENT.match(line):
                continue
            if (
                FLAGS.search(line)
                or (CRT.search(line) and path not in CRT_READERS)
                or (
                    ALLOWANCE.search(line)
                    and (
                        path not in ALLOWANCE_READERS_AND_GENERATORS
                        or "--allow-undefined-file" in line
                    )
                )
            ):
                print(f"{path}:{number}: {line.strip()}", file=sys.stderr)
                ok = False
    return ok


if __name__ == "__main__":
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[1]
    if not check(root):
        sys.exit("check-sdk-link-contract: use the SDK drivers for the Kandelo link contract")
    print("check-sdk-link-contract: ok")
