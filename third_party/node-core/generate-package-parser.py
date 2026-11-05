#!/usr/bin/env python3
"""Keep pinned simdjson field parsing verbatim except its embedding error sink."""
import argparse, hashlib, json
from pathlib import Path

def render(root):
    m=json.loads((root/'sources.json').read_text());g=m['packages']
    target=json.loads((root.parents[1]/'packages/registry/node-compat/target.json').read_text())
    if (m['version'],m['commit'])!=(target['version'],target['source']['commit']):
        raise ValueError('Package parser source pin differs')
    def section(name):
        item=g['sections'][name];source=g['sources'][item['source']];raw=(root/source['path']).read_bytes()
        if hashlib.sha256(raw).hexdigest()!=source['sha256']:raise ValueError('Package source identity differs')
        t=raw.decode();a=t.index(item['start']);value=t[a:a+item['length']]
        if t.count(item['start'])!=1 or hashlib.sha256(value.encode()).hexdigest()!=item['sha256']:raise ValueError('Package section identity differs')
        return value
    body=section('parse');a=body.index('  const auto throw_invalid_package_config = ');b=body.index('\n  if (error || document.get_object()',a)
    original=body[a:b]
    if 'THROW_ERR_INVALID_PACKAGE_CONFIG' not in original or body.count('USE(')!=1:raise ValueError('Review parser embedding adaptation')
    body=body[:a]+'  const auto throw_invalid_package_config = []() { return false; };\n'+body[b:]
    body=body.replace('USE(', 'static_cast<void>(')
    # The selected tail includes the original function closing brace.
    if not body.endswith('}\n'):raise ValueError('Review package parser boundary')
    return ('// Generated from pinned Node parser. License: LICENSE.\n'
      '#ifndef KANDELO_NODE_PACKAGE_PARSER_H\n#define KANDELO_NODE_PACKAGE_PARSER_H\n'
      '#include <optional>\n#include <simdjson.h>\n#include <string>\n#include <string_view>\n'
      'namespace kandelo::packages {\nstruct PackageConfig {\n'+section('fields')+'};\n'
      'struct Parser {\n  simdjson::ondemand::parser json_parser;\n'
      '  bool Parse(PackageConfig* package_config) {\n  auto* binding_data = this;\n'+body+'};\n}\n#endif\n')

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--output',type=Path,required=True);a=p.parse_args();a.output.write_text(render(Path(__file__).resolve().parent))
