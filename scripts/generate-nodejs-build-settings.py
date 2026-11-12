#!/usr/bin/env python3
"""Serialize actual recipe inputs; never infer guest layouts from the host."""
import argparse
import json
import os
from pathlib import Path
import shlex


def generate(mozconfig, path_maps, environment):
    mappings = []
    for value in path_maps:
        prefix, separator, display = value.partition('=')
        if not separator or not prefix or not display.startswith('/'):
            raise ValueError('path maps require nonempty prefix=/logical/absolute/path')
        mappings.append((prefix, display))
    mappings.sort(key=lambda item: len(item[0]), reverse=True)

    def normalize(value):
        for prefix, display in mappings:
            value = value.replace(prefix, display)
        return value

    # These are producer declarations, not executed shell or host tool probes.
    configuration = [normalize(line.strip()) for line in mozconfig.read_text().splitlines()
                     if line.strip() and not line.lstrip().startswith('#')]
    if not any(line == 'ac_add_options --enable-project=js' for line in configuration):
        raise ValueError('expected actual SpiderMonkey mozconfig')
    fields = {'Mozconfig': configuration}
    for name in ['CFLAGS', 'CXXFLAGS', 'LDFLAGS']:
        if not environment.get(name):
            raise ValueError('missing actual recipe flags: ' + name)
        fields[name] = [normalize(flag) for flag in shlex.split(environment[name])]
    output = ['// Generated from actual Kandelo recipe inputs; no V8 data or host layout probes.',
              '#ifndef KANDELO_NODE_BUILD_SETTINGS_GENERATED_H',
              '#define KANDELO_NODE_BUILD_SETTINGS_GENERATED_H', '#include <array>',
              'namespace kandelo::node::build_settings {']
    for name, values in fields.items():
        output.append(f'inline constexpr std::array<const char*, {len(values)}> k{name} = {{{{')
        output.extend('  ' + json.dumps(value, ensure_ascii=True) + ',' for value in values)
        output.append('}};')
    output.extend(['}  // namespace kandelo::node::build_settings', '#endif', ''])
    return '\n'.join(output)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mozconfig', type=Path, required=True)
    parser.add_argument('--path-map', action='append', default=[])
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    result = generate(args.mozconfig, args.path_map, os.environ)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(result)
