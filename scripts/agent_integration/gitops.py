"""Git checks and file application, restricted to explicitly owned regular files."""
from contextlib import contextmanager
import os
from pathlib import Path
import subprocess
import stat
import tempfile

from .manifest import digest, identity, path, require


def run(argv, cwd, *, env=None, data=None, ok=(0,)):
    p = subprocess.run(argv, cwd=cwd, env=env, input=data, capture_output=True)
    require(p.returncode in ok, f"command failed ({p.returncode}): {argv!r}\n" +
            (p.stdout + p.stderr).decode(errors="replace")[-4000:])
    return p


def git(root, *args, env=None, data=None, ok=(0,)):
    # Literal pathspecs prevent manifest paths from expanding Git magic/globs.
    inherited = {k: v for k, v in os.environ.items() if k not in (
        "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR")}
    return run(["git", "--literal-pathspecs", "-C", str(root), *args], root,
               env={**inherited, "GIT_OPTIONAL_LOCKS": "0", **(env or {})}, data=data, ok=ok).stdout


def rev(root, ref):
    require(ref == "HEAD" or ref.startswith("refs/"), f"fully qualified Git ref required: {ref}")
    git(root, "check-ref-format", ref) if ref != "HEAD" else None
    return git(root, "rev-parse", "--verify", ref + "^{commit}").decode().strip()


def overlap(a, b):
    return a == b or a.startswith(b + "/") or b.startswith(a + "/")


def names(data):
    return {os.fsdecode(x) for x in data.split(b"\0") if x}


def whitespace(root, owned):
    tracked = names(git(root, "ls-tree", "-rz", "--name-only", "HEAD"))
    for name in owned:
        p = path(root, name)
        if name not in tracked and p.is_file():
            result = run(["git", "diff", "--no-index", "--no-ext-diff", "--no-textconv",
                          "--check", "--", "/dev/null", str(p)], root, ok=(0, 1, 2, 3))
            require(not result.stdout and not result.stderr and result.returncode in (0, 1),
                    f"Git whitespace in new file: {name}")
    git(root, "diff", "--no-ext-diff", "--no-textconv", "--check", "HEAD", "--", *owned)
    git(root, "diff", "--cached", "--no-ext-diff", "--no-textconv", "--check", "--", *owned)


@contextmanager
def index(root, base):
    with tempfile.TemporaryDirectory(prefix="agent-integration-index-") as tmp:
        env = {"GIT_INDEX_FILE": str(Path(tmp) / "index")}
        git(root, "read-tree", base, env=env)
        yield env


def prepared_patch(root, manifest, patch_bytes):
    """Use Git's patch parser, checking names and hashes before touching the worktree."""
    base = manifest["base_commit"]
    with index(root, base) as env:
        for name, expected in manifest["patch"]["before"].items():
            entry = git(root, "ls-files", "--stage", "--", name, env=env)
            if entry:
                require(entry.startswith(b"100644 "), f"only regular non-executable files supported: {name}")
                actual = digest(git(root, "show", ":" + name, env=env))
            else:
                actual = None
            require(actual == expected, f"stale patch preimage in base: {name}")
        git(root, "apply", "--cached", "--check", "--whitespace=error-all", "-",
            env=env, data=patch_bytes)
        git(root, "apply", "--cached", "--whitespace=error-all", "-", env=env, data=patch_bytes)
        changed = names(git(root, "diff", "--cached", "--no-renames", "--name-only", "-z", base, env=env))
        require(changed == set(manifest["owned_paths"]), "patch paths must equal explicitly owned paths")
        content = {}
        for name, expected in manifest["patch"]["after"].items():
            entry = git(root, "ls-files", "--stage", "--", name, env=env)
            if entry:
                require(entry.startswith(b"100644 "), f"unsupported postimage file mode: {name}")
                data = git(root, "show", ":" + name, env=env)
            else:
                data = None
            require((digest(data) if data is not None else None) == expected,
                    f"patch postimage identity mismatch: {name}")
            content[name] = data
        return content


def dirty_guard(root, owned, protected):
    """Freeze unrelated dirty files and every tracked/protected file for later checks."""
    dirty = names(git(root, "diff", "--name-only", "-z", "HEAD"))
    dirty |= names(git(root, "diff", "--cached", "--name-only", "-z", "HEAD"))
    dirty |= names(git(root, "ls-files", "--others", "--exclude-standard", "-z"))
    all_paths = names(git(root, "ls-files", "-z")) | dirty
    for name in dirty:
        require(not any(overlap(name, own) for own in owned), f"unsafe dirty overlap: {name}")
    guard = sorted(n for n in all_paths if n not in owned and
                   (n in dirty or any(overlap(n, p) for p in protected)))
    return {n: guard_identity(root, n) for n in guard}


def guard_identity(root, name):
    """Git supplies these names; preserve unrelated spaces, modes and symlinks."""
    require(not Path(name).is_absolute() and ".." not in Path(name).parts, "unsafe Git path")
    target = root / name
    if not target.exists() and not target.is_symlink():
        return None
    mode = target.lstat().st_mode
    if stat.S_ISLNK(mode):
        return {"link": os.readlink(target), "mode": stat.S_IMODE(mode)}
    if stat.S_ISDIR(mode):
        # Git submodules are directories. Their tracked/untracked status is
        # retained without walking or copying another repository's artifacts.
        return {"directory_status": git(target, "status", "--porcelain=v1", "-z").hex(),
                "head": rev(target, "HEAD")}
    require(stat.S_ISREG(mode), f"unsupported dirty special file: {name}")
    return {"sha256": digest(target.read_bytes()), "mode": stat.S_IMODE(mode)}


def index_entries(root, owned):
    lines = git(root, "ls-files", "--stage", "-z").split(b"\0")
    return sorted(os.fsdecode(x) for x in lines if x and os.fsdecode(x.split(b"\t", 1)[1]) not in owned)


def index_matches(root, identities, env=None):
    for name, wanted in identities.items():
        entry = git(root, "ls-files", "--stage", "--", name, env=env)
        if wanted is None:
            if entry:
                return False
        elif not entry.startswith(b"100644 ") or digest(git(root, "show", ":" + name, env=env)) != wanted:
            return False
    return True


def safe_owned_index(root, before, after):
    for name in before:
        entry = git(root, "ls-files", "--stage", "--", name)
        if entry:
            if not entry.startswith(b"100644 ") or b" 0\t" not in entry:
                return False
            value = digest(git(root, "show", ":" + name))
        else:
            value = None
        if value not in (before[name], after[name]):
            return False
    return True


def protected_inventory(root, prefixes):
    if not prefixes:
        return []
    return sorted(names(git(root, "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", *prefixes)))


def sync_dir(directory):
    fd = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic(pathname, data):
    mkdir_durable(pathname.parent)
    fd, tmp = tempfile.mkstemp(prefix=".agent-integration-", dir=pathname.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(tmp, 0o644)
        os.replace(tmp, pathname)
        sync_dir(pathname.parent)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def mkdir_durable(directory):
    missing = []
    candidate = directory
    while not candidate.exists():
        missing.append(candidate)
        candidate = candidate.parent
    for candidate in reversed(missing):
        candidate.mkdir(exist_ok=True)
        sync_dir(candidate.parent)


def apply_files(root, before, after, content):
    # Inspect the whole change before writing any file. Recheck each file at
    # replacement too: worktree locks cannot exclude editors or other tools.
    for name in before:
        require(identity(root, name) in (before[name], after[name]), f"partial/uncertain application: {name}")
    for name in sorted(before):
        actual = identity(root, name)
        require(actual in (before[name], after[name]), f"partial/uncertain application: {name}")
        if actual == after[name]:
            continue
        target = path(root, name)
        if content[name] is None:
            target.unlink()
            sync_dir(target.parent)
        else:
            atomic(target, content[name])
