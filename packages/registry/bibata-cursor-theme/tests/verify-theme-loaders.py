from pathlib import Path, PurePosixPath
import hashlib
import os
import stat
import subprocess
import sys
import zipfile

archive, work = map(Path, sys.argv[1:])
root = work / "mounted-share"
root.mkdir()
aliases = {}
with zipfile.ZipFile(archive) as z:
    for item in z.infolist():
        relative = PurePosixPath(item.filename)
        assert not relative.is_absolute() and ".." not in relative.parts
        target = root.joinpath(*relative.parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        data = z.read(item)
        mode = item.external_attr >> 16
        if stat.S_ISLNK(mode):
            link = data.decode()
            assert PurePosixPath(link).name == link and link not in (".", "..")
            target.symlink_to(link)
            aliases[target.name] = link
        else:
            target.write_bytes(data)
    assert len(aliases) == 89
    assert z.read("icons/default/index.theme") == b"[Icon Theme]\nName=Default\nInherits=Bibata-Modern-Ice\n"

# Exercise native parser inheritance and OS symlink resolution against the
# actual ZIP's filesystem. The absent-theme control must fail in both loaders.
empty = work / "empty-icons"
empty.mkdir()
base_env = dict(os.environ, XCURSOR_PATH=str(empty.resolve()))
for library in ("wlroots", "wayland"):
    executable = str((work / (library + "-loader")).resolve())
    before = subprocess.run([executable, "48", "48"], env=base_env, capture_output=True, text=True)
    assert before.returncode == 1 and "loaded 0" in before.stderr
    (work / (library + "-before.log")).write_text(before.stdout + before.stderr)
    for requested, expected in ((24,24), (48,48), (64,64), (72,72), (96,96), (25,24)):
        run = subprocess.run([executable, str(requested), str(expected)],
            env=dict(os.environ, XCURSOR_PATH=str((root / "icons").resolve())),
            capture_output=True, text=True, check=True)
        (work / f"{library}-{requested}.log").write_text(run.stdout + run.stderr)
        records = dict(line.split(" ", 1) for line in run.stdout.splitlines())
        assert len(records) == 145
        for name, alias in aliases.items(): assert records[name] == records[alias], name
        pointer = list(map(int, records["default"].split()))
        assert pointer[0] == 1 and pointer[1:4] == [expected, expected, expected]
        # A 24-logical-pixel cursor at 3x/4x exceeds the truthful64 KMS
        # hardware limit; these are data/loader controls for software fallback,
        # not evidence that a compositor rendered that path successfully.
        assert (pointer[2] > 64) == (expected > 64)
        print(library, "request", requested, "selected", expected,
              "default geometry", pointer[2:6], "all145 names/89aliases PASS")
    print(library, "absent-theme failure control PASS")
print("theme ZIP SHA256", hashlib.sha256(archive.read_bytes()).hexdigest())
