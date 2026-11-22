#!/usr/bin/env python3
"""Generate real Kandelo provider configuration inside Node's private source tree.

Keep Node's original source/provider partitions and generators. This prepares
inputs for the complete upstream build; it neither builds a replacement runtime
nor accepts any library or module behavior.
"""
import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import time


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def make_value(makefile, name):
    # These upstream variables contain literal words and continuation lines.
    # Fail if future releases introduce Make expressions needing evaluation.
    text = re.sub(r'\\\n\s*', ' ', makefile.read_text())
    match = re.search(r'^' + re.escape(name) + r'\s*=\s*(.+)$', text, re.M)
    if not match or '$' in match[1]:
        raise ValueError('Cannot read original provider generation variable: ' + name)
    return shlex.split(match[1])


def main(args):
    source, work, repository = args.source.resolve(), args.work.resolve(), args.repository.resolve()
    if source == repository or source.is_relative_to(repository / 'packages') or source.is_relative_to(repository / 'third_party'):
        raise ValueError('Provider generation requires a private staged source tree')
    if source == work or source.is_relative_to(work) or work.is_relative_to(source):
        raise ValueError('Provider source and configuration work roots must be disjoint')
    work.mkdir(parents=True, exist_ok=False)

    def run(command, cwd, log, env=None):
        start = time.monotonic()
        with log.open('w') as stream:
            result = subprocess.run(command, cwd=cwd, env=env, stdout=stream, stderr=subprocess.STDOUT)
        row = {'command': command, 'cwd': str(cwd), 'exit': result.returncode,
               'seconds': time.monotonic() - start, 'log': str(log), 'logSha256': digest(log)}
        if result.returncode:
            raise RuntimeError(json.dumps(row))
        return row

    def openssl():
        package = source / 'deps/openssl'
        upstream = package / 'openssl'
        config = package / 'config'
        generated = config / 'archs/kandelo-wasm32/no-asm'
        if generated.exists():
            raise ValueError('Refusing to reuse an earlier OpenSSL target configuration')
        makefile = config / 'Makefile'
        groups = [make_value(makefile, key) for key in
                  ('GEN_HEADERS', 'CRYPTO_GEN_HEADERS', 'INTERNAL_GEN_HEADERS')]
        env = os.environ.copy()
        env.update(CC='wasm32posix-cc', CXX='wasm32posix-c++',
                   AR='wasm32posix-ar', RANLIB='wasm32posix-ranlib')
        commands = []
        commands.append(run(['perl', 'Configure', *make_value(makefile, 'COPTS'),
                             'no-asm', 'no-docs', 'kandelo-wasm32'], upstream,
                            work / 'openssl-configure.log', env))
        commands.append(run(['perl', '-w', '-I' + str(upstream), './generate_gypi.pl',
                             'no-asm', 'kandelo-wasm32', *[' '.join(group) for group in groups]],
                            config, work / 'openssl-generate.log', env))
        templates = list((upstream / 'external/perl').glob('Text-Template-*/lib'))
        if len(templates) != 1:
            raise ValueError('Expected the pinned original Text::Template dependency')
        commands.append(run(['perl', '-I' + str(templates[0]), './generate_headers.pl',
                             *[' '.join(group) for group in groups]], config,
                            work / 'openssl-headers.log', env))
        for name in ('openssl.gypi', 'openssl-cl.gypi', 'openssl-fips.gypi'):
            text = (generated / name).read_text()
            for forbidden in ('-m64', '-m32', '-D__linux__'):
                if forbidden in text:
                    raise ValueError('Unexpected target configuration: ' + forbidden)
        text = (generated / 'openssl.gypi').read_text()
        for forbidden in ('OPENSSL_NO_THREADS', 'OPENSSL_NO_DSO', 'OPENSSL_NO_ENGINE',
                          'OPENSSL_NO_POSIX_IO', 'OPENSSL_NO_ASYNC'):
            if forbidden in text:
                raise ValueError('Unexpected main-library feature exclusion: ' + forbidden)
        return {'provider': 'OpenSSL', 'target': 'kandelo-wasm32',
                'commands': commands, 'originalMakefileSha256': digest(makefile),
                'headers': [{'path': str(path.relative_to(source)), 'sha256': digest(path)}
                            for path in sorted(generated.rglob('*')) if path.is_file()],
                'runtimeQualified': False}

    def cares():
        package = source / 'deps/cares'
        build = work / 'cares'
        destination = package / 'config/kandelo/ares_config.h'
        if destination.exists():
            raise ValueError('Refusing to reuse an earlier c-ares target configuration')
        toolchain = work / 'cares-toolchain.cmake'
        toolchain.write_text('include("' + str(repository / 'sdk/cmake/kandelo-toolchain.cmake') + '")\n'
                             '# Function/library probes must link, not merely archive unresolved calls.\n'
                             'set(CMAKE_TRY_COMPILE_TARGET_TYPE EXECUTABLE)\n')
        command = ['cmake', '-S', str(package), '-B', str(build),
                   '-DCMAKE_TOOLCHAIN_FILE=' + str(toolchain),
                   '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_C_FLAGS=-D__kandelo__=1',
                   '-DCARES_SHARED=OFF', '-DCARES_STATIC=ON',
                   '-DCARES_BUILD_TOOLS=OFF', '-DCARES_BUILD_TESTS=OFF',
                   '-DCARES_THREADS=ON']
        commands = [run(command, work, work / 'cares-configure.log')]
        header = build / 'ares_config.h'
        if not header.is_file():
            raise ValueError('Original c-ares configure did not produce ares_config.h')
        if not re.search(r'^#define CARES_THREADS 1$', header.read_text(), re.M):
            raise ValueError('Original c-ares configure unexpectedly removed thread safety')
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(header, destination)
        return {'provider': 'c-ares', 'target': 'wasm32-unknown-kandelo',
                'commands': commands, 'header': str(destination.relative_to(source)),
                'headerSha256': digest(destination), 'linkedCapabilityChecks': True,
                'runtimeQualified': False}

    results = []
    # Independent configuration failures are collected together; neither provider
    # is dropped because configuring the other failed first.
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        operations = {'openssl': ('OpenSSL', openssl), 'cares': ('c-ares', cares)}
        pending = {executor.submit(operations[key][1]): operations[key][0]
                   for key in (args.provider or list(operations))}
        for future in concurrent.futures.as_completed(pending):
            try:
                results.append({**future.result(), 'prepared': True})
            except Exception as error:
                results.append({'provider': pending[future], 'prepared': False,
                                'error': str(error)})
    receipt = {'source': str(source), 'providers': results,
               'selectedProviders': args.provider or ['openssl', 'cares'],
               'nodeSourceVersion': '26.13.0', 'nodeExecutableBuilt': False,
               'runtimeQualified': False}
    (work / 'provider-configuration.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt, indent=2), flush=True)
    return int(any(not result['prepared'] for result in results))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('source', 'work', 'repository'):
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--provider', choices=('openssl', 'cares'), action='append',
                        help='Configure selected prerequisites during development; normal builds prepare both')
    raise SystemExit(main(parser.parse_args()))
