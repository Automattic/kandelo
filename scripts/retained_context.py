#!/usr/bin/env python3
"""Read-only budget check for retained notes, including archived contexts."""
import argparse
import heapq
import json
import math
import os
from pathlib import Path
import stat
import sys

MIB = 1024 * 1024
MAX_BYTES = 50 * MIB
MAX_FILE_BYTES = 25 * MIB
MAX_FILES = 5000


def inspect(path):
    path = Path(path)
    if path.is_symlink():
        raise ValueError(f'retained context root must not be a symlink: {path}')
    if not path.exists():
        return {'path': str(path), 'bytes': 0, 'files': 0, 'symlinks': 0, 'largest': []}
    if not path.is_dir():
        raise ValueError(f'retained context is not a directory: {path}')
    total = count = links = 0
    largest = []

    def unreadable(error):
        raise error

    for root, dirs, files in os.walk(path, followlinks=False, onerror=unreadable):
        # Count link entries, never their targets. Walking a link into a
        # sysroot or another workspace would misattribute its storage.
        for name in list(dirs):
            if (Path(root) / name).is_symlink():
                dirs.remove(name)
                files.append(name)
        for name in files:
            entry = Path(root) / name
            info = entry.lstat()
            if stat.S_ISLNK(info.st_mode):
                links += 1
            elif not stat.S_ISREG(info.st_mode):
                raise ValueError(f'unsupported retained file type: {entry}')
            total += info.st_size
            count += 1
            row = (info.st_size, str(entry.relative_to(path)))
            if len(largest) < 10:
                heapq.heappush(largest, row)
            elif row > largest[0]:
                heapq.heapreplace(largest, row)
    return {'path': str(path), 'bytes': total, 'files': count, 'symlinks': links,
            'largest': [{'bytes': n, 'path': p} for n, p in sorted(largest, reverse=True)]}


def violations(report, max_bytes=MAX_BYTES, max_file_bytes=MAX_FILE_BYTES, max_files=MAX_FILES):
    issues = []
    if report['bytes'] > max_bytes:
        issues.append(f"total {report['bytes'] / MIB:.2f} MiB exceeds {max_bytes / MIB:g} MiB")
    if report['largest'] and report['largest'][0]['bytes'] > max_file_bytes:
        issues.append(f"a file exceeds {max_file_bytes / MIB:g} MiB")
    if report['files'] > max_files:
        issues.append(f"{report['files']} files exceeds {max_files}")
    return issues


def describe(report, issues):
    lines = [f"retained context: {report['bytes'] / MIB:.2f} MiB, {report['files']} files, "
             f"{report['symlinks']} symlinks (targets not followed): {report['path']}"]
    if issues:
        lines += [*issues, 'Largest retained entries:']
        lines += [f"  {r['bytes'] / MIB:8.2f} MiB  {r['path']!r}" for r in report['largest']]
        lines += ['Retain notes, source patches, receipts and selected logs. Put disposable build data in .scratch.',
                  'Preserve unique source/evidence before removal; use agent-job release for registered payloads.',
                  'This check never deletes or moves files. Review intentional large attachments separately.']
    return '\n'.join(lines)


def check(path, **budgets):
    report = inspect(path)
    issues = violations(report, **budgets)
    print(describe(report, issues))
    if issues:
        raise ValueError('retained context budget exceeded; review before archival')


def add_budget_arguments(parser):
    parser.add_argument('--max-mib', type=float, default=MAX_BYTES / MIB)
    parser.add_argument('--max-file-mib', type=float, default=MAX_FILE_BYTES / MIB)
    parser.add_argument('--max-files', type=int, default=MAX_FILES)


def budgets(args):
    if not all(math.isfinite(n) and n > 0 for n in (args.max_mib, args.max_file_mib, args.max_files)):
        raise ValueError('budgets must be finite and positive')
    return dict(max_bytes=args.max_mib * MIB, max_file_bytes=args.max_file_mib * MIB, max_files=args.max_files)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('path', nargs='?', default='.context')
    parser.add_argument('--json', action='store_true', help='bounded summary, not a full file inventory')
    add_budget_arguments(parser)
    args = parser.parse_args()
    limits = budgets(args)
    report = inspect(args.path)
    report['violations'] = violations(report, **limits)
    print(json.dumps(report, indent=2) if args.json else describe(report, report['violations']))
    return bool(report['violations'])


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError) as error:
        sys.exit(f'retained context: {error}')
