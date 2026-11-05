#!/usr/bin/env python3
"""Select unchanged Node constant definitions against actual SQLite headers."""
from pathlib import Path
import argparse
import hashlib
import json
import re


def limits(root):
    spec = json.loads((root / 'sources.json').read_text())['sqlitePlatform']
    item = spec['sources']['nativeHeader']
    raw = (root / item['path']).read_bytes()
    if hashlib.sha256(raw).hexdigest() != item['sha256']:
        raise ValueError('SQLite native header reference mismatch')
    selector = spec['limitMapping']
    text = raw.decode('utf8')
    if text.count(selector['start']) != 1:
        raise ValueError('Ambiguous SQLite limit mapping')
    start = text.index(selector['start'])
    body = text[start:start + selector['length']]
    if hashlib.sha256(body.encode()).hexdigest() != selector['sha256']:
        raise ValueError('SQLite limit mapping selection mismatch')
    names = re.findall(r'\{"([^"]+)", (SQLITE_LIMIT_[A-Z_]+)\}', body)
    if len(names) != 11:
        raise ValueError('Review SQLite limit set')
    header = ('// Generated from the unchanged pinned node_sqlite.h limit table.\n'
              '#ifndef KANDELO_SQLITE_LIMIT_NAMES_H\n#define KANDELO_SQLITE_LIMIT_NAMES_H\n'
              '#include <array>\n#include <sqlite3.h>\n#include <string_view>\n'
              'namespace kandelo::sqlite {\n' + body + '\n')
    for i, (_, macro) in enumerate(names):
        header += 'static_assert(' + macro + ' == ' + str(i) + ');\n'
    return header + '}\n#endif\n', [name for name, _ in names]


def generate(root):
    manifest = json.loads((root / 'sources.json').read_text())
    target = json.loads((root.parents[1] / 'packages/registry/node-compat/target.json').read_text())
    if (manifest['version'], manifest['commit']) != (target['version'], target['source']['commit']):
        raise ValueError('SQLite constants and Node target pins differ')
    item = manifest['sqlitePlatform']['sources']['native']
    raw = (root / item['path']).read_bytes()
    if hashlib.sha256(raw).hexdigest() != item['sha256']:
        raise ValueError('SQLite native reference hash mismatch')
    text = raw.decode('utf8')
    selector = manifest['sqlitePlatform']['constants']
    if text.count(selector['start']) != 1:
        raise ValueError('Ambiguous SQLite constant definitions')
    start = text.index(selector['start'])
    selected = text[start:start + selector['length']]
    if hashlib.sha256(selected.encode()).hexdigest() != selector['sha256']:
        raise ValueError('SQLite constant selection hash mismatch')
    body = selected[selected.index('{') + 1:selected.rindex('}')]
    return '''// Generated from unchanged pinned Node definitions; real SQLite macros.
#include <sqlite3.h>

static bool KandeloSqliteConstants(JSContext* cx, JS::HandleObject target) {
#define NODE_DEFINE_CONSTANT(target, name) do { \\
  if (!JS_DefineProperty(cx, target, #name, name, JSPROP_ENUMERATE | JSPROP_READONLY | JSPROP_PERMANENT)) return false; \\
} while (false)
''' + body + '''
#undef NODE_DEFINE_CONSTANT
  return true;
}
'''


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    result = generate(Path(__file__).resolve().parent)
    if args.check:
        if args.output.read_text() != result:
            raise ValueError('SQLite constants header is stale')
    else:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(result)
