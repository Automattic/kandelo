#!/usr/bin/env python3
"""Assemble the shell's private native embedding in dependency order.

These fragments share shell-private types and static helpers; they are not
independent translation units. Generate one unity source rather than relying
on the order of scattered .cpp includes. Only includes are lifted into a
canonical preamble. Function/class bodies are retained verbatim. Mozilla's
unchanged source/style checks inspect the generated unit and staged headers.
"""

import argparse
import hashlib
import json
from pathlib import Path
import re
import runpy
import io


# Work/async/callback policy precedes its resource consumers; filesystem work
# precedes adopted handles, promise requests and pathname jobs. Digests supply
# the private byte/error helpers consumed by random jobs.
FRAGMENTS = (
    'native-work.cpp', 'native-async.cpp', 'native-backing-store.cpp', 'native-retained-memory.cpp', 'native-callback.cpp', 'native-socket-owner.cpp',
    'codec-handle.cpp', 'native-fs.cpp', 'native-file-handle.cpp',
    'native-fs-promise.cpp', 'native-stat-watcher.cpp', 'native-copy-file.cpp', 'native-copy-directory.cpp', 'native-path-metadata.cpp', 'native-directory.cpp', 'native-readdir.cpp', 'native-dir.cpp', 'native-package.cpp', 'native-removal.cpp',
    'native-file-jobs.cpp', 'native-lazy-data.cpp', 'native-object-marks.cpp', 'native-environment-object.cpp', 'native-buffer.cpp', 'native-digests.cpp', 'native-http-parser.cpp', 'native-keys.cpp', 'native-secret-keygen.cpp', 'native-x509.cpp', 'native-tls-context.cpp', 'native-incremental-hash.cpp', 'native-cipher.cpp', 'native-signature.cpp', 'native-signature-jobs.cpp',
    'native-random.cpp', 'native-kdf.cpp', 'native-address-rules.cpp', 'native-dns-lookup.cpp', 'native-dns-records.cpp', 'native-datagram.cpp',
    'native-terminal.cpp', 'native-tracing.cpp', 'native-os.cpp', 'native-dotenv.cpp', 'native-vm-import.cpp', 'native-vm.cpp', 'native-vm-modules.cpp', 'native-module-syntax.cpp',
    'native-sqlite.cpp', 'native-sqlite-backup.cpp', 'histogram-native.cpp', 'event-loop-delay-native.cpp', 'histogram-clone.cpp', 'native-ports.cpp', 'native-worker.cpp', 'native-locks.cpp',
    'native-signals.cpp', 'native-wasi.cpp', 'native-sea.cpp', 'native-ffi-library.cpp', 'native-ffi-memory.cpp',
)

# These headers are also used directly by the surrounding shell operations.
SHELL_HEADERS = (
    'kandelo-node-child-wait.h', 'kandelo-node-dns-lookup.h',
    'kandelo-node-fs-constants.h', 'kandelo-node-monotonic-clock.h',
    'kandelo-node-performance-clock.h', 'kandelo-node-process-state.h',
    'kandelo-node-uv-error-table.h', 'kandelo-node-public-constants.h',
)

INCLUDE = re.compile(r'^#include ([<"])([^>"\n]+)[>"]\n', re.M)
SQLITE_FEATURE = ('#ifndef SQLITE_ENABLE_SESSION\n'
                  '#define SQLITE_ENABLE_SESSION 1\n#endif\n')


def canonical_header(name, staged):
    if name in ('tls-encrypted-output.h', 'socket-owner.h'):
        name = 'shell/kandelo-node-' + name
    # Portable owner headers use the same short aliases as standalone native
    # controls. At the engine packaging boundary those files live in shell/.
    if name in ('port-queue.h', 'port-transit-graph.h', 'port-transit-owner.h'):
        name = 'shell/kandelo-node-' + name
    if name == 'sqlite-limit-names.h':
        name = 'shell/kandelo-node-sqlite-limits.h'
    if name in ('http-connections.h', 'monotonic-clock.h', 'stream-write-material.h'):
        name = 'shell/kandelo-node-' + name
    if not name.startswith('shell/') and (staged / name).is_file():
        name = 'shell/' + name
    if name.startswith('kandelo-node-'):
        name = 'shell/' + name
    if name.startswith('shell/kandelo-node-'):
        path = staged / Path(name).name
        if not path.is_file():
            raise ValueError('Missing staged native header: ' + name)
    return name


def generate(root, staged):
    includes = set(('"', 'shell/' + name) for name in SHELL_HEADERS)
    sections = []
    identities = {}
    for name in FRAGMENTS:
        raw = (root / name).read_bytes()
        text = raw.decode('utf-8')
        identities[name] = hashlib.sha256(raw).hexdigest()
        if name == 'native-sqlite.cpp':
            if text.count(SQLITE_FEATURE) != 1:
                raise ValueError('Review SQLite session feature preamble')
            text = text.replace(SQLITE_FEATURE, '', 1)

        # Reject conditional/nested includes: lifting one would change which
        # declarations are active. New such dependencies need explicit review.
        depth = 0
        for line in text.splitlines():
            if re.match(r'^\s*#\s*(if|ifdef|ifndef)\b', line):
                depth += 1
            elif re.match(r'^\s*#\s*endif\b', line):
                depth -= 1
            elif re.match(r'^\s*#\s*include\b', line):
                if depth or not INCLUDE.fullmatch(line + '\n'):
                    raise ValueError('Review conditional/noncanonical include: ' + name)

        def take_include(match):
            quote, header = match.groups()
            if quote == '"':
                header = canonical_header(header, staged)
            includes.add((quote, header))
            return ''

        body = INCLUDE.sub(take_include, text)
        sections.append('// ' + name + ' sha256=' + identities[name] + '\n' + body)

    def order(item):
        quote, name = item
        # Mozilla's checker puts inline implementation headers after complete
        # ordinary declarations, independently of their lexical filename.
        if quote == '<':
            section = 2
        elif name.startswith('mozilla/'):
            section = 1
        elif name.endswith('-inl.h') and '/' in name:
            section = 6
        elif name.endswith('inlines.h') and '/' not in name:
            section = 5
        else:
            section = 4 if '/' in name else 3
        return (section, name.lower())

    preamble = ('// Generated by generate-native-embedding.py; do not edit.\n'
                '// Included once by shell/js.cpp after its namespace imports.\n'
                '// Session support matches the declared node-sqlite dependency.\n' +
                SQLITE_FEATURE)
    for quote, name in sorted(includes, key=order):
        if quote == '"':
            name = canonical_header(name, staged)
        preamble += '#include ' + quote + name + ('>' if quote == '<' else '"') + '\n'

    # The surrounding shell owns these helpers. Declaring their interfaces
    # keeps native owners independent of their later definition positions.
    preamble += '''
static JSObject* KandeloNewUint8ArrayCopy(JSContext* cx, const uint8_t* data,
                                        size_t length);
static bool KandeloValueToBytes(JSContext* cx, HandleValue value,
                                std::vector<uint8_t>* output);
static bool KandeloGetString(JSContext* cx, HandleValue value, UniqueChars* output);
static bool KandeloDefineSocketInt(JSContext* cx, HandleObject object,
                                   const char* name, int32_t number);

'''
    return preamble + '\n'.join(sections), identities


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--shell-dir', type=Path, required=True)
    args = parser.parse_args()
    staged = args.shell_dir
    root = Path(__file__).resolve().parent
    # A rename during staging must translate literal local includes as well.
    # No algorithm, assertion, upstream checker or checker expectation changes.
    # Use the pinned source tree's unchanged include sorter, never its ignore
    # list or expected-output mutation. Only our direct shell owners are staged
    # here; imported implementations live under the real third_party boundary.
    checker_path = staged.parents[2] / 'config/check_spidermonkey_style.py'
    checker = runpy.run_path(str(checker_path))
    staged_owners = {}
    for path in sorted(staged.iterdir()):
        own = (path.name.startswith(('kandelo-node-', 'histogram-', 'event-loop-delay')) or
               path.name in ('native-retained-memory.h', 'retained-backing-store.h', 'crypto-errors.h'))
        # Bootstrap is generated program data, not an owner include block;
        # native.cpp is regenerated below from its exact fragment inputs.
        if path.name in ('kandelo-node-bootstrap.h', 'kandelo-node-native.cpp'):
            continue
        if not own or path.suffix not in ('.h', '.cpp', '.cc') or not path.is_file():
            continue
        text = path.read_text()
        text = re.sub(r'(?m)^(#\s*include ")([^"\n]+)(")',
                      lambda m: m[1] + canonical_header(m[2], staged) + m[3], text)
        path.write_text(checker['read_file'](io.StringIO(text)).sorted('shell/' + path.name).to_source())
        staged_owners[path.name] = hashlib.sha256(path.read_bytes()).hexdigest()
    output, identities = generate(root, staged)
    (staged / 'kandelo-node-native.cpp').write_text(output)
    (staged / 'kandelo-node-native-sources.json').write_text(
        json.dumps({'fragmentsInDependencyOrder': identities,
                    'stagedOwnerFilesAfterCanonicalIncludes': staged_owners,
                    'includeOrderingCheckerSha256': hashlib.sha256(checker_path.read_bytes()).hexdigest()}, indent=2) + '\n')


if __name__ == '__main__':
    main()
