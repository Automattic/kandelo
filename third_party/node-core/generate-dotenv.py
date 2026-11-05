#!/usr/bin/env python3
"""Retain the exact target parser with explicit C++17 spelling adaptations."""
from pathlib import Path
import hashlib
import json
import sys


def render(root):
    item = json.loads((root / 'sources.json').read_text())['dotenv']
    selector = item['parser']
    raw = (root / item['sources'][selector['source']]['path']).read_bytes()
    if hashlib.sha256(raw).hexdigest() != item['sources'][selector['source']]['sha256']:
        raise ValueError('Dotenv full source identity mismatch')
    source = raw.decode()
    if source.count(selector['start']) != 1:
        raise ValueError('Ambiguous dotenv parser selection')
    start = source.index(selector['start'])
    source = source[start:start + selector['length']]
    if hashlib.sha256(source.encode()).hexdigest() != selector['sha256']:
        raise ValueError('Dotenv parser selection identity mismatch')
    for old, new in [
        ('std::string_view trim_spaces(', 'inline std::string_view trim_spaces('),
        ('void Dotenv::ParseContent(', 'inline void Dotenv::ParseContent('),
        ('key.starts_with("export ")', 'key.substr(0, 7) == "export "'),
    ]:
        if source.count(old) != 1:
            raise ValueError('Review dotenv C++17/inline adaptation: ' + old)
        source = source.replace(old, new)
    return '''// Generated from pinned Node node_dotenv.cc by generate-dotenv.py.
// Upstream Node license: third_party/node-core/LICENSE.
#ifndef KANDELO_NODE_DOTENV_PARSER_H
#define KANDELO_NODE_DOTENV_PARSER_H
#include <algorithm>
#include <map>
#include <string>
#include <string_view>
namespace kandelo::dotenv {
class Dotenv {
  std::map<std::string, std::string> store_;
 public:
  void ParseContent(std::string_view input);
  const auto& Entries() const { return store_; }
};
''' + source + '\n}  // namespace kandelo::dotenv\n#endif\n'


if __name__ == '__main__':
    root = Path(__file__).resolve().parent
    dest = root / 'dotenv-parser.h'
    result = render(root)
    if '--check' in sys.argv:
        if dest.read_text() != result:
            raise SystemExit('Dotenv native parser needs regeneration')
    else:
        dest.write_text(result)
