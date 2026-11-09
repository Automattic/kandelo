#!/usr/bin/env python3
"""Fail closed when the native platform adapter's reviewed layout changes.

The resolver/package.toml alone owns archive identity. These reviewed C bytes
are a separate platform layout contract: 51 public entry definitions (47
object guards + 3 connection owners + setter), the unique first-event unlink
in dispatch_event, tail arg-count before original unrefs, exact ffi/direct
callback sites, the <=20 argument ABI, and canonical utility logging. This
never rewrites upstream or guesses at a changed source shape.
"""
import hashlib
import pathlib
import sys

REVIEWED = {'wayland-client.c': '131b3cbf5b2fd19cce6a2f1adbdf5f006d43a756cd8e01b9d09d53cc024f21fa', 'connection.c': '6848ec9d4631e2e5025433590bcf5cb8c3ec939438d3aa10ab64b4d0b8300c5e', 'wayland-private.h': '1236baf7dca615e1808c48a15e0e52863f958ae4c12d08ef5302914424f10c7a', 'wayland-util.c': '0dce86b288ccc3a6cdfb996a41c39990cc31c493f2cba8d3ed7ee000d220e765', 'wayland-util.h': 'f336a00a03fcf442a59dc9e5fcce3fc94b2cbfcbcf0befba018be3657b7ea381', 'wayland-client-core.h': 'f744b2c9191bffe7580b7b3894d24f513f52e5dbc586404c4ea8b0f70952dfcd'}

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
