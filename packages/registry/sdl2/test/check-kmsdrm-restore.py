#!/usr/bin/env python3
"""Judge real pinned SDL/libdrm restore code at a doubled ioctl boundary."""

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tarfile
import tomllib


def digest(data):
    return hashlib.sha256(data).hexdigest()


def section(text, start, end):
    begin = text.index(start)
    return text[begin:text.index(end, begin)]


def archive_files(archive, package, names):
    metadata = tomllib.loads((package / "package.toml").read_text())
    if digest(archive.read_bytes()) != metadata["source"]["sha256"]:
        raise ValueError(f"source archive hash mismatch: {archive}")
    result = {}
    with tarfile.open(archive) as source:
        for name in names:
            matches = [m for m in source.getmembers()
                       if m.name.partition("/")[2] == name and m.isfile()]
            if len(matches) != 1:
                raise ValueError(f"expected exactly one archive member: {name}")
            result[name] = source.extractfile(matches[0]).read()
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sdl-archive", type=Path, required=True)
    parser.add_argument("--libdrm-archive", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--cc", default="clang")
    args = parser.parse_args()
    package = Path(__file__).resolve().parent.parent
    patches = sorted((package / "patches").glob("*.patch"))
    inputs = [Path(__file__), package / "test/kmsdrm-restore.c", *patches]
    frozen = {str(p): digest(p.read_bytes()) for p in inputs}
    args.output = args.output.resolve()
    paths = set()
    for patch in patches:
        for line in patch.read_text().splitlines():
            if line.startswith("+++ b/"):
                paths.add(line[6:].split("\t")[0])
    # Read only explicitly selected regular members. Never unpack archive paths
    # into the checkout or trust an archive's symlinks as extraction authority.
    upstream = archive_files(args.sdl_archive, package, paths)
    drm = archive_files(args.libdrm_archive, package.parent / "libdrm", [
        "xf86drmMode.c", "xf86drmMode.h", "include/drm/drm_mode.h",
    ])
    args.output.mkdir(parents=True, exist_ok=False)
    source = args.output / "patched-source"
    for name, data in upstream.items():
        target = source / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    patch_log = []
    for patch in patches:
        applied = subprocess.run([
            "patch", "--batch", "--forward", "--fuzz=0", "-p1", "-d", str(source),
        ], input=patch.read_bytes(), capture_output=True, check=True)
        patch_log.append(applied.stdout.decode())
    (args.output / "patch-series.log").write_text("".join(patch_log))
    video = "src/video/kmsdrm/SDL_kmsdrmvideo.c"
    originals = {"original": upstream[video].decode(),
                 "patched": (source / video).read_text()}
    header = drm["xf86drmMode.h"].decode()
    body = drm["xf86drmMode.c"].decode()
    uapi = drm["include/drm/drm_mode.h"].decode()
    shared = {
        "mode-type.inc": section(header, "typedef struct _drmModeModeInfo {",
                                 "typedef struct _drmModeFB {").strip(),
        "crtc-type.inc": section(header, "typedef struct _drmModeCrtc {",
                                 "typedef struct _drmModeEncoder {").strip(),
        "libdrm-get.inc": section(body, "drm_public drmModeCrtcPtr drmModeGetCrtc",
                                  "drm_public int drmModeSetCrtc"),
        "libdrm-set.inc": section(body, "drm_public int drmModeSetCrtc",
                                  "/*\n * Cursor manipulation"),
    }
    types = []
    for tag in ["drm_mode_modeinfo", "drm_mode_crtc"]:
        start = uapi.index("struct " + tag + " {")
        types.append(uapi[start:uapi.index("\n};", start) + 3])
    shared["uapi-types.inc"] = "\n".join(types)
    observations = {}
    for variant, text in originals.items():
        directory = args.output / variant
        directory.mkdir()
        parts = dict(shared)
        parts["sdl-selection.inc"] = section(
            text, "    /* Find the index of the mode attached to this CRTC */",
            "    if (dispdata->mode.hdisplay == 0")
        # Extract from the original function, not a second implementation of
        # restoration. The unchanged assertions must reject the unpatched code.
        restore = text[text.index("static void KMSDRM_DestroySurfaces("):]
        marker = ("    ret = KMSDRM_drmModeSetCrtc" if variant == "original"
                  else "    /* original_mode may be")
        parts["sdl-restore.inc"] = section(restore, marker,
                                          "    /***************************/")
        for name, value in parts.items():
            (directory / name).write_text(value + "\n")
        executable = directory / "control"
        subprocess.run([
            args.cc, "-std=c11", "-Wall", "-Wextra", "-Werror",
            "-fsanitize=undefined", "-fno-sanitize-recover=all",
            "-I" + str(directory), str(package / "test/kmsdrm-restore.c"),
            "-o", str(executable),
        ], check=True)
        for case in ["dark", "lit", "dark-failure", "lit-failure"]:
            result = subprocess.run([str(executable), case], capture_output=True)
            (directory / (case + ".jsonl")).write_bytes(result.stdout)
            (directory / (case + ".stderr")).write_bytes(result.stderr)
            expected = 41 if variant == "original" and case.startswith("dark") else 0
            if result.returncode != expected:
                raise AssertionError((variant, case, result.returncode, result.stderr))
            observations[variant, case] = json.loads(result.stdout)
            if variant == "patched":
                expected_log = (b"SDL_LogError: Could not restore CRTC\n"
                                if case.endswith("failure") else b"")
                if result.stderr != expected_log:
                    raise AssertionError((case, result.stderr))
    for case in ["lit", "lit-failure"]:
        if observations["original", case] != observations["patched", case]:
            raise AssertionError(f"enabled-display behavior changed: {case}")
    if frozen != {str(p): digest(p.read_bytes()) for p in inputs}:
        raise AssertionError("test or recipe patch inputs changed during the run")
    (args.output / "judgment.json").write_text(json.dumps({
        "status": "PASS", "scope": "source with ioctl boundary double; not target execution",
        "original_disabled_contract_failures": 2, "patched_cases_passed": 4,
        "enabled_observations_unchanged": True, "genuine_failure_logging_preserved": True,
        "inputs": frozen,
        "sdl_archive": digest(args.sdl_archive.read_bytes()),
        "libdrm_archive": digest(args.libdrm_archive.read_bytes()),
    }, indent=2) + "\n")
    print("PASS: original disabled restore fails; patched 4/4; enabled behavior and error logs preserved")


if __name__ == "__main__":
    main()
