"""Guest-side game import and dispatch. Never executes an archive to identify it."""
import configparser
import os
from pathlib import Path
import shlex
import shutil
import stat
import struct
import subprocess
import sys
import tempfile
import zipfile
import zlib

MAX_ENTRIES = 1024
MAX_DEPTH = 16
MAX_BYTES = 512 * 1024 * 1024
MAX_DIRECTORY_BYTES = 1024 * 1024
CHUNK = 64 * 1024


class ImportRejected(ValueError):
    pass


class NonFileInput(ImportRejected):
    pass


def relative_name(name):
    parts = name.rstrip('/').split('/')
    if (not parts or len(parts) > MAX_DEPTH or
            any(p in ('', '.', '..') or ':' in p or '\\' in p or
                any(ord(c) < 32 or ord(c) == 127 for c in p) for p in parts)):
        raise ImportRejected('unsafe archive or file path')
    return Path(*parts)


def preflight_zip(path):
    """Bound ZipFile's central-directory allocation before constructing it.

    Single-disk classic ZIPs, stored/deflated entries only. ZIP64 is rejected
    explicitly: this importer has smaller entry/byte limits anyway.
    """
    size = path.stat().st_size
    if size > MAX_BYTES:
        raise ImportRejected('ZIP exceeds the 512 MiB input limit')
    with path.open('rb') as source:
        source.seek(max(0, size - 65557))
        tail = source.read(65557)
        offset = tail.rfind(b'PK\x05\x06')
        if offset < 0 or len(tail) - offset < 22:
            raise ImportRejected('missing ZIP directory')
        end = struct.unpack_from('<4s4H2IH', tail, offset)
        _, disk, directory_disk, disk_count, count, length, start, comment = end
        if offset + 22 + comment != len(tail):
            raise ImportRejected('invalid ZIP trailer')
        if disk or directory_disk or disk_count != count or count == 65535:
            raise ImportRejected('multi-disk and ZIP64 archives are unsupported')
        if count > MAX_ENTRIES or length > MAX_DIRECTORY_BYTES:
            raise ImportRejected('ZIP directory exceeds the import limits')
        end_at = size - len(tail) + offset
        if start + length != end_at:
            raise ImportRejected('invalid ZIP directory bounds')
        source.seek(start)
        directory = source.read(length)
    cursor = 0
    actual = 0
    while cursor < len(directory):
        if directory[cursor:cursor+4] != b'PK\x01\x02' or cursor + 46 > len(directory):
            raise ImportRejected('invalid ZIP directory entry')
        name, extra, comment = struct.unpack_from('<3H', directory, cursor + 28)
        cursor += 46 + name + extra + comment
        actual += 1
        if actual > MAX_ENTRIES or cursor > len(directory):
            raise ImportRejected('invalid ZIP directory size')
    if actual != count:
        raise ImportRejected('inconsistent ZIP entry count')


class Budget:
    def __init__(self):
        self.entries = 0
        self.bytes = 0

    def add(self, size=0):
        self.entries += 1
        self.bytes += size
        if self.entries > MAX_ENTRIES or self.bytes > MAX_BYTES:
            raise ImportRejected('import exceeds 1,024 entries or 512 MiB unpacked')


def unpack_zip(source, destination, budget, prefix_depth=0):
    preflight_zip(source)
    with zipfile.ZipFile(source) as archive:
        paths = {}
        spellings = {}
        members = []
        for info in archive.infolist():
            # orig_filename preserves NULs that ZipInfo.filename truncates.
            path = relative_name(info.orig_filename)
            if len(path.parts) + prefix_depth > MAX_DEPTH:
                raise ImportRejected('unpacked path exceeds the 16-level depth limit')
            mode = info.external_attr >> 16
            kind = stat.S_IFMT(mode)
            if kind not in (0, stat.S_IFREG, stat.S_IFDIR):
                raise ImportRejected('links and special files are unsupported')
            if info.flag_bits & 1 or info.compress_type not in (0, 8):
                raise ImportRejected('encrypted or unsupported ZIP compression')
            if info.extract_version >= 45 or info.file_size == 0xffffffff or info.compress_size == 0xffffffff:
                raise ImportRejected('ZIP64 members are unsupported')
            key = str(path).casefold()
            if key in paths:
                raise ImportRejected('duplicate archive path')
            paths[key] = info.is_dir()
            spellings[key] = str(path)
            budget.add(info.file_size)
            members.append((info, path))
        for _, path in members:
            for parent in path.parents:
                key = str(parent).casefold()
                if key in spellings and spellings[key] != str(parent):
                    raise ImportRejected('archive directory names differ only in case')
                spellings[key] = str(parent)
                if str(parent).casefold() in paths and not paths[str(parent).casefold()]:
                    raise ImportRejected('archive file conflicts with a directory')
                key = str(parent).casefold()
                if parent != Path('.') and key not in paths:
                    paths[key] = True
                    budget.add()
        for info, path in members:
            target = destination / path
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True, mode=0o700)
                continue
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            written = 0
            with archive.open(info) as contents, target.open('xb') as output:
                while True:
                    chunk = contents.read(CHUNK)
                    if not chunk:
                        break
                    written += len(chunk)
                    if written > info.file_size:
                        raise ImportRejected('ZIP output exceeds its declared size')
                    output.write(chunk)
            if written != info.file_size:
                raise ImportRejected('truncated ZIP member')
            target.chmod(0o600)


def files_under(root):
    """Inspect lstat metadata before reads; never follow input links/FIFOs."""
    files = []
    budget = Budget()
    def fail(error):
        raise error
    for directory, dirs, names in os.walk(root, followlinks=False, onerror=fail):
        for name in sorted(dirs + names):
            path = Path(directory) / name
            relative_name(path.relative_to(root).as_posix())
            mode = path.lstat().st_mode
            if stat.S_ISFIFO(mode):
                raise NonFileInput('streams belong to the ordinary save handler')
            if not stat.S_ISDIR(mode) and not stat.S_ISREG(mode):
                raise ImportRejected('input contains a link or special file')
            budget.add(path.stat().st_size if stat.S_ISREG(mode) else 0)
            if stat.S_ISREG(mode):
                files.append(path)
    return sorted(files)


def dos_kind(path, head, size):
    if path.name.upper() in ('DOS4GW.EXE', 'DOS32A.EXE', 'CWSDPMI.EXE', 'CWSDPR0.EXE'):
        return None  # Required companions remain in place; they are not games.
    if head[:2] == b'MZ':
        if len(head) < 28:
            return None
        last, pages, relocations, paragraphs = struct.unpack_from('<4H', head, 2)
        image_size = pages * 512 - (512 - last if last else 0)
        header_size = paragraphs * 16
        relocation_offset = struct.unpack_from('<H', head, 24)[0]
        if (last >= 512 or pages == 0 or header_size < 28 or
                not header_size <= image_size <= size or
                (relocations and relocation_offset + relocations * 4 > header_size)):
            return None
        secondary = struct.unpack_from('<I', head, 60)[0] if len(head) >= 64 else 0
        if 64 <= secondary <= size - 4:
            with path.open('rb') as source:
                source.seek(secondary)
                signature = source.read(4)
            if signature in (b'PE\0\0',) or signature[:2] == b'NE':
                return None
            if signature[:2] in (b'LE', b'LX'):
                # LE/LX also serve non-DOS systems. Known DOS extender stubs
                # are useful evidence; an unknown one needs an explicit choice.
                extenders = (b'DOS/4G', b'DOS/32', b'DOS32A', b'PMODE/W', b'CauseWay')
                return 'DOS' if any(s in head for s in extenders) else 'DOS?'
        return 'DOS'
    if path.suffix.lower() == '.com' and 0 < size <= 65280:
        return 'DOS?'
    if path.suffix.lower() == '.bat' and head and b'\0' not in head:
        return 'DOS?'
    return None


def might_be_rom(head):
    if head[:4] == b'NES\x1a' or head[256:260] == b'SEGA':
        return True
    if any(head[n:n+8] == b'TMR SEGA' for n in (32752, 16368, 8176)):
        return True
    return any(len(head) >= n + 4 and
               (int.from_bytes(head[n:n+2], 'little') ^ int.from_bytes(head[n+2:n+4], 'little')) == 65535
               for n in (32732, 65500, 33244, 66012))


def installed_command(path):
    return os.access(path, os.X_OK)


def detect(root, metadata, run=subprocess.run, available=installed_command):
    candidates = []
    has_dos = available('/usr/bin/dos-play')
    has_rom = available('/usr/bin/retro-run')
    for path in files_under(root):
        with path.open('rb') as source:
            head = source.read(66016)
        dos = dos_kind(path, head, path.stat().st_size)
        if dos and has_dos:
            candidates.append({'label': f'{dos}: {path.relative_to(root)}',
                               'argv': ['/usr/bin/dos-play', str(path)], 'choice': dos.endswith('?')})
        if has_rom and might_be_rom(head):
            result = run(['/usr/bin/retro-run', '--identify', str(path)], capture_output=True, text=True, timeout=120)
            if result.returncode == 0:
                candidates.append({'label': f'ROM ({result.stdout.strip()}): {path.relative_to(root)}',
                                   'argv': ['/usr/bin/retro-run', str(path)], 'choice': False})
            elif result.returncode != 1:
                raise ImportRejected('ROM detection failed: ' + result.stderr[-500:])
    # Smaller images can omit engines. Offer only installed runtimes rather
    # than launching a missing command or treating its absence as bad content.
    if not available('/usr/libexec/scummvm') or not available('/usr/bin/scummvm'):
        return candidates
    config = metadata / 'scummvm.ini'
    # Detection is a non-graphical engine command. The interactive wrapper
    # publishes a running-game PID file, which a probe must not replace.
    result = run(['/usr/libexec/scummvm', '--config=' + str(config), '--add', '--recursive', '--path=' + str(root)],
                 capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        raise ImportRejected('ScummVM detection failed: ' + result.stderr[-500:])
    parser = configparser.ConfigParser(interpolation=None, strict=True)
    parser.read(config, encoding='utf-8')
    for target in parser.sections():
        section = parser[target]
        if target == 'scummvm' or 'gameid' not in section or 'path' not in section:
            continue
        resolved = Path(section['path']).resolve()
        if not resolved.is_relative_to(root.resolve()):
            raise ImportRejected('ScummVM target escapes the imported game directory')
        candidates.append({'label': 'ScummVM: ' + section.get('description', target),
                           'argv': ['/usr/bin/scummvm', '--config=' + str(config), target], 'choice': False})
    return candidates


def stage_import(source, parent):
    if not stat.S_ISREG(source.lstat().st_mode) and not stat.S_ISDIR(source.lstat().st_mode):
        raise NonFileInput('game imports require ordinary files or directories')
    parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    stage = Path(tempfile.mkdtemp(prefix='import-', dir=parent))
    root = stage / 'files'
    root.mkdir(mode=0o700)
    (stage / 'metadata').mkdir(mode=0o700)
    budget = Budget()
    had_zip = False
    try:
        files = files_under(source) if source.is_dir() else [source]
        if source.is_dir():
            for directory, dirs, _ in os.walk(source):
                for name in dirs:
                    relative = (Path(directory) / name).relative_to(source)
                    (root / relative).mkdir(parents=True, exist_ok=True, mode=0o700)
                    budget.add()
        for path in files:
            relative = relative_name(path.relative_to(source).as_posix() if source.is_dir() else path.name)
            with path.open('rb') as stream:
                magic = stream.read(4)
            # Retain originals too: a ZIP inside a dropped game folder can be
            # a required data file, rather than a distribution container.
            expected = path.stat().st_size
            budget.add(expected)
            destination = root / relative
            destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            copied = 0
            with path.open('rb') as incoming, destination.open('xb') as outgoing:
                while True:
                    chunk = incoming.read(CHUNK)
                    if not chunk:
                        break
                    copied += len(chunk)
                    if copied > expected:
                        raise ImportRejected('input changed during import')
                    outgoing.write(chunk)
            if copied != expected:
                raise ImportRejected('input changed during import')
            destination.chmod(0o600)
            if magic.startswith(b'PK') or path.suffix.lower() == '.zip':
                had_zip = True
                destination = root / relative.parent / (relative.name + '.unpacked')
                if destination.exists():
                    raise ImportRejected('archive destination conflicts with another input')
                destination.mkdir(parents=True, mode=0o700)
                budget.add()
                unpack_zip(path, destination, budget, len(relative.parts))
        return stage, had_zip
    except BaseException:
        shutil.rmtree(stage)
        raise


def status(batch, value):
    data = value.replace('\n', ' ').replace('\r', ' ').encode('utf-8')[:256]
    data = data.decode('utf-8', errors='ignore').encode('utf-8')
    # Use the shell's exchange metadata utility, shared with its other handlers.
    subprocess.run(['/usr/bin/setfattr', '-n', 'user.kandelo.status', '-v',
                    data.decode('utf-8'), str(batch)], check=True)


def choose(candidates):
    if len(candidates) == 1 and not candidates[0]['choice']:
        return candidates[0]
    print('Choose a game or runtime (0 cancels):')
    for index, candidate in enumerate(candidates, 1):
        label = ''.join(c if ord(c) >= 32 and ord(c) != 127 else '?' for c in candidate['label'])
        print(f"  {index}. {label}")
    if not sys.stdin.isatty():
        raise ImportRejected('a terminal is required to choose among games')
    while True:
        try:
            response = input('Game number: ').strip()
        except EOFError:
            return None
        if response == '0':
            return None
        if response.isdecimal() and 1 <= int(response) <= len(candidates):
            return candidates[int(response) - 1]
        print('Enter a listed number, or 0 to cancel.')


def command_for(candidate):
    return shlex.join([Path(candidate['argv'][0]).name, *candidate['argv'][1:]])


def request_terminal(command, display):
    argv = ['/usr/bin/kandelo-terminal', '--title', 'Imported games']
    if display:
        argv.append('--display')
    return subprocess.run([*argv, command]).returncode == 0


def main(argv):
    if len(argv) != 2 or argv[0] not in ('exchange', 'play'):
        raise ImportRejected('usage: game-play DIRECTORY|ZIP')
    action, name = argv
    source = Path(name).absolute()
    if action == 'exchange':
        status(source, 'inspecting game content')
    else:
        print('Inspecting game content...', flush=True)
    data = Path(os.environ.get('XDG_DATA_HOME') or str(Path.home() / '.local/share'))
    if not data.is_absolute():
        raise ImportRejected('XDG_DATA_HOME must be absolute')
    if any(ord(c) < 32 or ord(c) == 127 for c in str(data)):
        raise ImportRejected('XDG_DATA_HOME contains a control character')
    data.mkdir(parents=True, exist_ok=True, mode=0o700)
    imports = data / 'kandelo/game-imports'
    stage = None
    if action == 'exchange' or not source.is_dir():
        stage, had_zip = stage_import(source, imports)
        root, metadata = stage / 'files', stage / 'metadata'
    else:
        root = source
        # Detection owns its config; never trust a config supplied in a ZIP.
        imports.mkdir(parents=True, exist_ok=True, mode=0o700)
        metadata = Path(tempfile.mkdtemp(prefix='detection-', dir=imports))
        had_zip = False
    candidates = []
    try:
        candidates = detect(root, metadata)
        if action == 'exchange':
            if not candidates:
                shutil.rmtree(stage)
                os.execv('/usr/libexec/kandelo/exchange-save', ['exchange-save', str(source)])
            # Preserve the established raw-ROM import path and replacement
            # semantics. ZIPs and mixed DOS/ROM batches use the shared picker.
            if not had_zip and all(c['argv'][0] == '/usr/bin/retro-run' for c in candidates):
                shutil.rmtree(stage)
                os.execv('/usr/libexec/kandelo/retro-load-rom', ['retro-load-rom', str(source)])
            direct = len(candidates) == 1 and not candidates[0]['choice']
            command = command_for(candidates[0]) if direct else 'game-play ' + shlex.quote(str(root))
            # A picker needs a visible terminal before it owns a display.
            # Only the selected game requests replacement of a display owner.
            if not request_terminal(command, direct):
                # The Node host has no page to open a terminal. Retain the
                # import and report the repeatable command instead of guessing
                # a runtime or starting an invisible interactive picker.
                status(source, 'imported games; run ' + command)
            else:
                status(source, 'opened a terminal: ' + command)
            return 0
        if not candidates:
            raise ImportRejected('no supported DOS, ScummVM or console game found')
        selected = choose(candidates)
        if selected:
            print('Starting ' + selected['label'], flush=True)
            if request_terminal(command_for(selected), True):
                return 0
            os.execv(selected['argv'][0], selected['argv'])
        return 0
    except BaseException:
        # Successful imports stay available for manual retry. Extraction
        # failures are removed by stage_import before anything is launched.
        if action == 'exchange' and stage is not None and not candidates:
            shutil.rmtree(stage, ignore_errors=True)
        raise


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv[1:]))
    except NonFileInput as error:
        if len(sys.argv) == 3 and sys.argv[1] == 'exchange':
            os.execv('/usr/libexec/kandelo/exchange-save', ['exchange-save', sys.argv[2]])
        print('game-play: ' + str(error), file=sys.stderr)
        sys.exit(1)
    except (OSError, ValueError, RuntimeError, EOFError, zipfile.BadZipFile, zlib.error, subprocess.SubprocessError) as error:
        if len(sys.argv) == 3 and sys.argv[1] == 'exchange':
            saved = subprocess.run(['/usr/libexec/kandelo/exchange-save', sys.argv[2]]).returncode == 0
            status(Path(sys.argv[2]), 'failed: game import: ' + str(error) + (' (saved original)' if saved else ' (could not save original)'))
        print('game-play: ' + str(error), file=sys.stderr)
        sys.exit(1)
