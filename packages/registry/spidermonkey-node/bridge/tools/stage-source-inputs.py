#!/usr/bin/env python3
"""Generate transient bridge inputs from the resolver's authenticated Node tree."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import tomllib


def stage(source, package, output):
    source = source.resolve(strict=True)
    output = output.resolve()
    work = Path(os.environ['WASM_POSIX_DEP_WORK_DIR']).resolve(strict=True)
    if (not output.is_relative_to(work) or output.is_relative_to(source)
            or source.is_relative_to(output)):
        raise ValueError('bridge inputs must use a separate private work directory')
    metadata = tomllib.loads(package.read_text())
    # The resolver authenticates the archive. Per-file receipts are generated
    # here for the existing generators, rather than checked into the repository.
    paths = set((source / 'deps/v8/include').rglob('*.h'))
    paths.update(source / name for name in [
        'deps/v8/src/objects/value-serializer.cc', 'deps/v8/src/objects/js-proxy.h',
        'deps/v8/src/execution/isolate.cc', 'src/env.cc',
        'deps/v8/src/builtins/builtins-trace.cc', 'deps/v8/src/common/message-template.h',
        'deps/v8/src/strings/unicode.h', 'deps/v8/src/strings/unicode-inl.h',
        'deps/v8/third_party/utf8-decoder/utf8-decoder.h',
    ])
    output.mkdir(parents=True, exist_ok=False)
    records = []
    for path in sorted(paths):
        relative = path.relative_to(source)
        if path.is_symlink() or not path.is_file():
            raise ValueError('bridge source must be an ordinary file: ' + str(relative))
        data = path.read_bytes()
        target = output / 'upstream' / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)
        records.append({'path': relative.as_posix(), 'bytes': len(data),
                        'sha256': hashlib.sha256(data).hexdigest()})
    (output / 'sources.json').write_text(json.dumps({
        'version': metadata['version'], 'source': metadata['source'], 'files': records}, indent=2) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['source', 'package', 'output']:
        parser.add_argument('--' + name, type=Path, required=True)
    args = parser.parse_args()
    stage(args.source, args.package, args.output)
