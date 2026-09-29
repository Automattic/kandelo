#!/usr/bin/env python3
"""Summarize a failed Kandelo package build log, or list a wasm's unresolved imports.

Usage:
  python3 diagnose-build-log.py <build.log> [--max N]
  python3 diagnose-build-log.py --imports <program.wasm>

Build logs run to thousands of lines; reading them whole costs more than the
fix. This prints the first distinct failures with a little context and, where
the failure matches a known Kandelo platform boundary, the doc or check that
explains it. It reads only the log: the resolver deletes the build's work
directory (config.log included) when a build fails.
"""
import re
import shutil
import subprocess
import sys

# (pattern, label, hint). First match wins per line; order specific -> generic.
RULES = [
    (r"Please port gnulib", "gnulib fallback",
     "configure probes for musl stdio_ext funcs said 'no'. Usually an incomplete sysroot "
     "(missing sysroot/include/bits/kandelo_*.h) -> scripts/dev-shell.sh ./run.sh setup. Not a reason to define __linux__."),
    (r"bits/kandelo_[a-z_]+\.h' file not found", "incomplete sysroot",
     "generated ABI headers missing from sysroot -> scripts/dev-shell.sh ./run.sh setup (or scripts/build-musl.sh after libc edits)."),
    (r"sysroot not found|sysroot64 not found|private sysroot SDK seed must be a real directory", "missing sysroot",
     "build the sysroot: scripts/dev-shell.sh ./run.sh setup (wasm64: scripts/build-musl.sh --arch wasm64posix)."),
    (r"retained package receipt does not match", "stale cache receipt",
     "a package.toml-only edit did not change the cache key; see docs/package-management.md 'Cache-key hashing'."),
    (r"Package artifact closure is incomplete", "mixed provenance tiers",
     "artifacts were built against different keys; rerun the full front door (./run.sh setup), not a targeted rebuild."),
    (r"kernel_abi", "kernel_abi",
     "package.toml needs kernel_abi matching ABI_VERSION in crates/shared/src/lib.rs."),
    (r"asyncify_", "legacy Asyncify artifact",
     "rebuild through scripts/run-wasm-fork-instrument.sh; see docs/fork-instrumentation.md."),
    (r"\?.*declare [a-z0-9_-]+ in depends_on|WASM_POSIX_DEP_[A-Z0-9_]+_DIR.*(unbound|required)", "undeclared dependency",
     "add the package to depends_on in package.toml; the resolver only exports declared deps."),
    (r"sha256 mismatch|checksum mismatch|hash mismatch|computed checksums? did NOT match", "source hash",
     "[source].sha256 does not match the download; re-verify the upstream archive."),
    (r"command not found", "host tool not in dev shell",
     "the dev shell is pure (flake.nix packages only). Declare the tool; do not rely on host PATH."),
    (r"C compiler cannot create executables", "toolchain unusable",
     "the SDK cc cannot link a trivial program: check the script sources sdk/activate.sh, sysroot/lib/libc.a exists, "
     "and CC/CFLAGS are not host values. Reproduce configure by hand to read config.log."),
    (r"unable to find library -l", "library not on link path",
     "the dep's lib dir is missing from LDFLAGS (-L$WASM_POSIX_DEP_<NAME>_DIR/lib), the dep is undeclared, "
     "or the dep's declared outputs do not include that archive."),
    (r"'[^']+\.h' file not found", "missing header",
     "a dependency's -I<prefix>/include is missing from CPPFLAGS, or the dep is undeclared. "
     "See docs/package-management.md 'The CPPFLAGS/LDFLAGS contract'."),
    (r"configure: error:", "configure error",
     "remember: link probes always succeed (-Wl,--allow-undefined). A probe answering wrong usually needs an "
     "ac_cv_* seed checked against wasm32posix-nm sysroot/lib/libc.a; see sdk/config.site."),
    (r"wasm-ld: error:", "link error", None),
    (r"undefined (symbol|reference)", "undefined symbol",
     "the providing library is not on LIBS/LDFLAGS or its dep is undeclared."),
    (r"(^|\] )xtask [a-z-]+: (?!.*build script .* exited with)", "resolver/manifest error",
     "the resolver rejected the package before or after its build script ran; the message names the field or contract."),
    (r"\berror: |\bError [0-9]+\b|: fatal error:", "compile/build error", None),
    (r"build script .* exited with|immutable git input verification failed|declared output", "resolver", None),
]
COMPILED = [(re.compile(p), label, hint) for p, label, hint in RULES]
# autoconf prints "configure: error: in '<dir>':" before the real message.
NOISE = re.compile(r"warning:|^\s*\d+ (warning|error)s? generated|configure: error: in '")


def diagnose(path, max_items):
    lines = open(path, errors="replace").read().splitlines()
    seen, items = set(), []
    for i, line in enumerate(lines):
        if NOISE.search(line):
            continue
        for rx, label, hint in COMPILED:
            if rx.search(line):
                key = re.sub(r"\d+", "#", line.strip())[:160]
                if key not in seen:
                    seen.add(key)
                    items.append((i, label, hint))
                break
    print(f"log: {path} ({len(lines)} lines)")
    if not items:
        print("no known failure pattern; last 25 lines:")
        print("\n".join(lines[-25:]))
        return
    # The first failure is usually the cause; later ones are fallout.
    for n, (i, label, hint) in enumerate(items[:max_items]):
        tag = "FIRST" if n == 0 else f"#{n + 1}"
        print(f"\n[{tag}] {label} (line {i + 1})")
        for j in range(max(0, i - 2), min(len(lines), i + 3)):
            print(("> " if j == i else "  ") + lines[j][:300])
        if hint:
            print(f"  hint: {hint}")
    if len(items) > max_items:
        print(f"\n... {len(items) - max_items} more distinct failures (rerun with --max N)")
    print("\nlast line:", lines[-1][:300] if lines else "")


def imports(wasm):
    tool = shutil.which("wasm-objdump")
    if not tool:
        sys.exit("wasm-objdump not found; run under scripts/dev-shell.sh (provides wabt)")
    out = subprocess.run([tool, "-x", "-j", "Import", wasm], capture_output=True, text=True, check=True).stdout
    funcs = re.findall(r"func\[\d+\] sig=\d+ <[^>]*> <- (\S+)", out)
    by_module = {}
    for name in funcs:
        mod, _, field = name.partition(".")
        by_module.setdefault(mod, []).append(field)
    for mod, fields in sorted(by_module.items()):
        print(f"{mod}: {len(fields)} function imports")
    env = sorted(by_module.get("env", []))
    if env:
        print("\nenv.* imports (with -Wl,--allow-undefined, a symbol no static library provided lands here and "
              "traps when called; compare against the host's provided imports before assuming it is legitimate):")
        for f in env:
            print("  " + f)


if __name__ == "__main__":
    args = sys.argv[1:]
    if not args or args[0] in ("-h", "--help"):
        sys.exit(__doc__)
    if args[0] == "--imports":
        imports(args[1])
    else:
        max_items = int(args[args.index("--max") + 1]) if "--max" in args else 6
        diagnose(args[0], max_items)
