#!/usr/bin/env python3
"""Ownership and cleanup of validation payloads; registry uses only stdlib.

Bulk files belong to the worktree. The shared registry retains UUID ownership
and summaries, never infers ownership from a reused workspace path alone.
"""
import argparse
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import time
import uuid

ROOT = Path(os.environ.get('KANDELO_AGENT_JOBS_DIR', '~/.cache/kandelo/agent-jobs')).expanduser().absolute()
OWNER = Path('.context/validation-owner.json')
MARKER = '.kandelo-artifact.json'


class CleanupError(RuntimeError):
    pass


def read_json(path):
    try:
        return json.loads(Path(path).read_text())
    except FileNotFoundError:
        return None


def write_json(path, value):
    path = Path(path)
    temporary = path.with_name(f'{path.name}.{os.getpid()}.tmp')
    with temporary.open('w') as stream:
        json.dump(value, stream)
    temporary.replace(path)


def identifier(value):
    if str(uuid.UUID(value)) != value:
        raise CleanupError('invalid artifact/worktree UUID')
    return value


@contextmanager
def locked():
    ROOT.mkdir(parents=True, exist_ok=True)
    for directory in ['workspaces', 'artifacts', 'leases']:
        (ROOT / directory).mkdir(exist_ok=True)
    with (ROOT / 'lifecycle.lock').open('a') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        yield


def safe_directory(root, relative, create=False):
    """Walk direct directory components. Never follow a cleanup symlink."""
    relative = Path(relative)
    if relative.is_absolute() or '..' in relative.parts or not relative.parts:
        raise CleanupError(f'not a worktree-relative artifact path: {relative}')
    current = Path(root)
    if current.is_symlink() or not current.is_dir():
        raise CleanupError(f'worktree is missing or redirected: {current}')
    for part in relative.parts:
        current = current / part
        if create:
            try:
                current.mkdir(mode=0o700)
            except FileExistsError:
                pass
        try:
            stat = current.lstat()
        except FileNotFoundError:
            return None
        if current.is_symlink() or not current.is_dir() or stat.st_uid != os.getuid():
            raise CleanupError(f'artifact directory is not directly owned: {current}')
    return current


def workspace(path, create=True, allow_closed=False):
    path = Path(path).resolve()
    context = safe_directory(path, '.context', create=create)
    if context is None:
        return None
    owner_path = path / OWNER
    if owner_path.is_symlink():
        raise CleanupError('worktree ownership marker is redirected')
    owner = read_json(owner_path)
    if owner is None:
        if not create:
            return None
        owner = {'schema': 1, 'id': str(uuid.uuid4())}
        write_json(owner_path, owner)
    wid = identifier(owner['id'])
    index = ROOT / 'workspaces' / f'{wid}.json'
    record = read_json(index) or {'schema': 1, 'id': wid, 'path': str(path), 'closed': False}
    if record['path'] != str(path):
        raise CleanupError('worktree UUID was copied to another directory')
    if record['closed'] and not allow_closed:
        raise CleanupError('worktree is closed for cleanup; use agent-job reopen to resume')
    write_json(index, record)
    return record


def same_workspace(record):
    path = Path(record['worktree'])
    if not path.is_dir() or path.is_symlink():
        return False
    context = safe_directory(path, '.context')
    if context is None:
        return False
    marker = path / OWNER
    if marker.is_symlink():
        raise CleanupError('worktree ownership marker is redirected')
    value = read_json(marker)
    return value is not None and value.get('id') == record['workspace_id']


def linux_process(pid):
    try:
        fields = Path(f'/proc/{pid}/stat').read_text().rsplit(') ', 1)[1].split()
        return fields[0], int(fields[2]), fields[19]
    except FileNotFoundError:
        return None


def process_identity(pid):
    """Birth identity plus zombie detection; a recycled PID isn't the owner."""
    if not isinstance(pid, int) or pid <= 0:
        return None
    if sys.platform.startswith('linux'):
        value = linux_process(pid)
        if value is None or value[0] == 'Z':
            return None
        boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
        return f'linux:{boot}:{value[2]}'
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return None
    # macOS provides /bin/ps even when the dev shell's PATH omits it.
    result = subprocess.run(['/bin/ps', '-p', str(pid), '-o', 'lstart=,stat='], capture_output=True, text=True)
    fields = result.stdout.split()
    if result.returncode or len(fields) < 6:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return None
        raise CleanupError(f'cannot establish process identity for {pid}')
    return None if fields[5].startswith('Z') else ' '.join(fields[:5])


def owner(pid):
    birth = process_identity(pid)
    if birth is None:
        raise CleanupError('artifact owner exited before registration')
    return {'pid': pid, 'birth': birth}


def process_group_alive(pgid):
    if not pgid:
        return False
    if not isinstance(pgid, int) or pgid <= 0:
        raise CleanupError('invalid owned process group')
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    if sys.platform.startswith('linux'):
        for path in Path('/proc').iterdir():
            if not path.name.isdigit():
                continue
            try:
                value = linux_process(path.name)
            except PermissionError:
                return True
            if value is not None and value[1] == pgid and value[0] != 'Z':
                return True
        return False
    result = subprocess.run(['/bin/ps', '-axo', 'pgid=,stat='], capture_output=True, text=True)
    if result.returncode:
        return True
    return any(len(fields) == 2 and fields[0] == str(pgid) and not fields[1].startswith('Z')
               for fields in (line.split() for line in result.stdout.splitlines()))


def browsers_alive():
    # A crashed Playwright CLI can leave a browser behind. No process is
    # stopped here: uncertainty or another active browser defers collection.
    if sys.platform.startswith('linux'):
        commands = []
        for path in Path('/proc').iterdir():
            if not path.name.isdigit():
                continue
            try:
                if path.stat().st_uid == os.getuid():
                    commands.append((path / 'cmdline').read_bytes().replace(b'\0', b' ').decode(errors='replace'))
            except FileNotFoundError:
                continue
    else:
        result = subprocess.run(['/bin/ps', '-U', str(os.getuid()), '-o', 'command='], capture_output=True, text=True)
        if result.returncode:
            raise CleanupError('cannot inspect remaining browser owners')
        commands = result.stdout.splitlines()
    return any(any(marker in line for marker in ['ms-playwright/', '--remote-debugging-pipe',
               '-juggler-pipe', 'Playwright.app/Contents/MacOS/Playwright']) for line in commands)


def lease_path(rid):
    return ROOT / 'leases' / f'{identifier(rid)}.lock'


def open_lease(record):
    fd = os.open(lease_path(record['id']), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BaseException:
        os.close(fd)
        raise
    return fd


def busy(record):
    if record.get('released_at'):
        return False
    if record['kind'] == 'job':
        try:
            fd = open_lease(record)
        except BlockingIOError:
            return True
        os.close(fd)
        if process_group_alive(record.get('pgid')):
            return True
    identity = record['owner']
    if process_identity(identity['pid']) == identity['birth']:
        return True
    return (record['kind'] == 'playwright' and not record.get('closed_at')
            and not record.get('inspection_only') and browsers_alive())


def register(path, roots, kind, rid=None, job_id=None, pid=None):
    """Caller holds lifecycle.lock through publication of the run owner."""
    ws = workspace(path, allow_closed=True)
    rid = identifier(rid or str(uuid.uuid4()))
    record_path = ROOT / 'artifacts' / f'{rid}.json'
    old = read_json(record_path)
    if old:
        if old['workspace_id'] != ws['id'] or old['roots'] != roots or old.get('released_at'):
            raise CleanupError('artifact identity does not match this live run')
        return old
    if ws['closed']:
        raise CleanupError('worktree is closed for cleanup; use agent-job reopen to resume')
    record = {'schema': 1, 'id': rid, 'workspace_id': ws['id'], 'worktree': ws['path'],
              'roots': roots, 'kind': kind, 'owner': owner(pid or os.getpid()),
              'created_at': time.time(), 'job_id': job_id}
    for relative in roots:
        target = safe_directory(ws['path'], relative)
        if target is not None:
            raise CleanupError(f'refusing to adopt an existing artifact directory: {target}')
    for relative in roots:
        target = safe_directory(ws['path'], relative, create=True)
        write_json(target / MARKER, {'id': rid, 'workspace_id': ws['id']})
    write_json(record_path, record)
    return record


def save(record):
    write_json(ROOT / 'artifacts' / f"{record['id']}.json", record)


def load(rid):
    record = read_json(ROOT / 'artifacts' / f'{identifier(rid)}.json')
    if record is None:
        raise CleanupError(f'no registered artifact {rid}')
    return record


def records():
    return [read_json(path) for path in sorted((ROOT / 'artifacts').glob('*.json'))]


def release_target(record, relative):
    pending = record.get('cleanup_pending', {}).get(relative)
    if pending:
        target = safe_directory(record['worktree'], pending['path'])
        if target is not None:
            stat = target.stat()
            if [stat.st_dev, stat.st_ino] != pending['identity']:
                raise CleanupError('parked artifact identity changed; retained for inspection')
            return target, pending
    return safe_directory(record['worktree'], relative), None


def check_release_marker(record, target, pending):
    marker = target / MARKER
    # An interrupted rmtree may already have deleted the marker. Only the
    # journaled directory inode, under the same worktree UUID, can omit it.
    if pending and not marker.exists() and not marker.is_symlink():
        return
    if marker.is_symlink() or read_json(marker) != {'id': record['id'], 'workspace_id': record['workspace_id']}:
        raise CleanupError(f'ownership marker missing or changed: {target}')


def remove_owned_root(record, relative):
    """Anchor deletion to handles and journal the rename for crash recovery."""
    original = str(relative)
    pending = record.setdefault('cleanup_pending', {})
    target, intent = release_target(record, original)
    if target is None:
        return
    relative = target.relative_to(record['worktree'])
    parts = Path(relative).parts
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    descriptors = [os.open(record['worktree'], flags)]
    try:
        for part in parts[:-1]:
            descriptors.append(os.open(part, flags, dir_fd=descriptors[-1]))
        parent = descriptors[-1]
        directory = os.open(parts[-1], flags, dir_fd=parent)
        descriptors.append(directory)
        if intent and [os.fstat(directory).st_dev, os.fstat(directory).st_ino] != intent['identity']:
            raise CleanupError('parked artifact identity changed during cleanup')
        expected = {'id': record['id'], 'workspace_id': record['workspace_id']}
        def check_marker(fd):
            try:
                marker = os.open(MARKER, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)
            except FileNotFoundError:
                if intent and [os.fstat(fd).st_dev, os.fstat(fd).st_ino] == intent['identity']:
                    return
                raise
            with os.fdopen(marker) as stream:
                if json.load(stream) != expected:
                    raise CleanupError('artifact ownership changed during cleanup')
        check_marker(directory)
        identity = os.fstat(directory)
        parked = parts[-1]
        if intent is None:
            parked = '.released-' + str(uuid.uuid4())
            pending[original] = {'path': str(Path(relative).parent / parked),
                                 'identity': [identity.st_dev, identity.st_ino]}
            save(record)  # durable intent BEFORE renaming the payload
            os.rename(parts[-1], parked, src_dir_fd=parent, dst_dir_fd=parent)
        moved = os.open(parked, flags, dir_fd=parent)
        descriptors.append(moved)
        actual = os.fstat(moved)
        if (actual.st_dev, actual.st_ino) != (identity.st_dev, identity.st_ino):
            raise CleanupError('artifact directory changed during cleanup; parked path retained for inspection')
        check_marker(moved)
        shutil.rmtree(parked, dir_fd=parent)
        pending.pop(original, None)
        save(record)
    finally:
        for fd in reversed(descriptors):
            os.close(fd)


def release(record, dry_run=False):
    if record.get('released_at'):
        return
    if busy(record):
        raise CleanupError(f"run {record.get('job_id') or record['id']} still has active writers")
    # Reused paths belong to the NEW worktree, even if old files were copied.
    if same_workspace(record):
        targets = []
        for relative in record['roots']:
            target, pending = release_target(record, relative)
            if target is None:
                continue
            check_release_marker(record, target, pending)
            targets.append(relative)
        if not dry_run:
            for relative in targets:
                remove_owned_root(record, relative)
    if not dry_run:
        record['released_at'] = time.time()
        save(record)


def archive(path, dry_run=False):
    ws = workspace(path, allow_closed=True)
    owned = [record for record in records() if record['workspace_id'] == ws['id'] and not record.get('released_at')]
    if not dry_run:
        ws['closed'] = True
        write_json(ROOT / 'workspaces' / f"{ws['id']}.json", ws)
    active = [record.get('job_id') or record['id'] for record in owned if busy(record)]
    if active:
        raise CleanupError('cleanup refused; active writers: ' + ', '.join(active))
    for record in owned:
        release(record, dry_run)
    return len(owned)


def collect(dry_run=False):
    count = 0
    for record in records():
        if record.get('released_at') or (same_workspace(record) and not record.get('cleanup_pending')) or busy(record):
            continue
        release(record, dry_run)
        count += 1
    return count


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    register_parser = sub.add_parser('register')
    register_parser.add_argument('--worktree', required=True)
    register_parser.add_argument('--run-id', required=True)
    register_parser.add_argument('--pid', type=int, required=True)
    register_parser.add_argument('--root', action='append', required=True)
    register_parser.add_argument('--inspection-only', action='store_true')
    finish_parser = sub.add_parser('finish')
    finish_parser.add_argument('--run-id', required=True)
    finish_parser.add_argument('--pid', type=int, required=True)
    args = parser.parse_args()
    with locked():
        if args.command == 'register':
            record = register(args.worktree, args.root, 'playwright', args.run_id, pid=args.pid)
            if args.inspection_only:
                record['inspection_only'] = True
                save(record)
            print(json.dumps(record))
        else:
            record = load(args.run_id)
            if record['owner'] != owner(args.pid):
                raise CleanupError('only the owning Playwright runner may complete teardown')
            record['closed_at'] = time.time()
            save(record)


if __name__ == '__main__':
    try:
        main()
    except (CleanupError, OSError, ValueError, KeyError) as error:
        sys.exit(f'validation artifacts: {error}')
