#!/usr/bin/env python3
"""Fail closed when the native platform adapter's reviewed layout changes.

The resolver/package.toml alone owns archive identity. These reviewed C bytes
are a separate platform layout contract: 53 public entry definitions (49
object guards + 3 connection owners + setter), the unique first-event unlink
in dispatch_event, tail arg-count before original unrefs, exact ffi/direct
callback sites, the <=20 argument ABI, and canonical utility logging. This
never rewrites upstream or guesses at a changed source shape.
"""
import hashlib
import pathlib
import sys

REVIEWED = {'wayland-client.c': 'c3536111c4fae59f9379a5927d79b80ef9bc4d0fe42054d54ce49027747d4c60', 'connection.c': '2db8435dfd051ee3f8b7fae5c37eb35d22c21cc158fc21f77bcf3d4b920a4f1f', 'wayland-private.h': 'cb49b334d1d48d08a6cb92c5bacdc9e18dfac943c745936f1a38a5bc6745f398', 'wayland-util.c': 'bbe24437bc939eeba3a89224239102f1e1c3757dbf9ea363fc22e3903c90206d', 'wayland-util.h': 'f336a00a03fcf442a59dc9e5fcce3fc94b2cbfcbcf0befba018be3657b7ea381', 'wayland-client-core.h': '936e6d191144358aec15edf1271781ea333a15da96e81bb9c99d137292a8403b'}

def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: check-wayland-client-layout.py <verified upstream src directory>")
    source = pathlib.Path(sys.argv[1])
    for name, expected in REVIEWED.items():
        try:
            actual = hashlib.sha256((source / name).read_bytes()).hexdigest()
        except OSError as error:
            raise SystemExit(f"Wayland platform adapter layout unavailable: {name}: {error}")
        if actual != expected:
            raise SystemExit(
                f"Wayland platform adapter needs review after native source/layout change: {name}\n"
                f"reviewed={expected} actual={actual}; no compile may proceed")
    print("PASS reviewed native Wayland adapter layout contract", file=sys.stderr)

if __name__ == "__main__":
    main()
