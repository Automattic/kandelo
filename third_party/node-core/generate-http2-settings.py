#!/usr/bin/env python3
"""Render standalone HTTP/2 settings from the audited Node/nghttp2 sources.

No host constant snapshot or session substitute is used. Selections are exact
upstream bytes; constants derive from Node's macro lists and nghttp2 enums.
The small settings framing owner below has no network/session dependencies.
"""
from pathlib import Path
import ast
import hashlib
import json
import operator
import re

ROOT = Path(__file__).resolve().parent


def render():
    manifest = json.loads((ROOT / 'sources.json').read_text())
    spec = manifest['http2Settings']
    if (spec['version'], spec['commit']) != (manifest['version'], manifest['commit']):
        raise ValueError('HTTP/2 settings must retain the audited Node target')
    source = {}
    for name, item in spec['references'].items():
        raw = (ROOT / item['path']).read_bytes()
        if hashlib.sha256(raw).hexdigest() != item['sha256']:
            raise ValueError('HTTP/2 reference identity mismatch: ' + name)
        source[name] = raw.decode()
    values = {}
    binary = {ast.Add: operator.add, ast.Sub: operator.sub,
              ast.LShift: operator.lshift, ast.RShift: operator.rshift,
              ast.BitOr: operator.or_, ast.BitAnd: operator.and_}

    def number(expression):
        expression = re.sub(r'\((?:u?int(?:8|16|32|64)_t)\)', '', expression)
        expression = re.sub(r'(?<=\w)[uUlL]+\b', '', expression)
        tree = ast.parse(expression.strip(), mode='eval').body
        def visit(node):
            if isinstance(node, ast.Constant) and type(node.value) is int:
                return node.value
            if isinstance(node, ast.Name):
                return values[node.id]
            if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub):
                return -visit(node.operand)
            if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.UAdd):
                return visit(node.operand)
            if isinstance(node, ast.BinOp) and type(node.op) in binary:
                return binary[type(node.op)](visit(node.left), visit(node.right))
            raise ValueError('Review HTTP/2 numeric expression: ' + expression)
        return visit(tree)

    clean = lambda text: re.sub(r'/\*.*?\*/|//[^\n]*', '', text, flags=re.S)
    for filename in ['deps/nghttp2/lib/includes/nghttp2/nghttp2.h', 'src/node_http2.h']:
        text = clean(source[filename])
        enum_pattern = r'(?:typedef\s+)?enum(?:\s+\w+)?\s*\{([^}]+)\}' if filename.startswith('deps/') else r'enum (?:PaddingStrategy|SessionType)\s*\{([^}]+)\}'
        for block in re.findall(enum_pattern, text):
            previous = -1
            for entry in block.split(','):
                entry = entry.strip()
                if not entry:
                    continue
                match = re.fullmatch(r'(\w+)\s*(?:=\s*(.+))?', entry, re.S)
                if not match:
                    raise ValueError('Review HTTP/2 enum: ' + entry)
                name, expression = match.groups()
                previous = number(expression) if expression else previous + 1
                values[name] = previous
        for name, expression in re.findall(r'constexpr\s+\w+\s+(\w+)\s*=\s*([^;]+);', text):
            if name.startswith(('DEFAULT_SETTINGS_', 'MAX_', 'MIN_', 'STREAM_OPTION_')):
                values[name] = number(expression)
        for name, expression in re.findall(r'^#define\s+(NGHTTP2_(?:DEFAULT_WEIGHT|MAX_WINDOW_SIZE|MAX_FRAME_SIZE_MIN|MAX_FRAME_SIZE_MAX))\s+([^\n]+)', text, re.M):
            values[name] = number(expression)

    for name, expression in re.findall(r'^#define\s+(NGHTTP2_MAX_FRAME_SIZE_(?:MIN|MAX))\s+([^\n]+)', clean(source['deps/nghttp2/lib/nghttp2_frame.h']), re.M):
        values[name] = number(expression)

    def macro(filename, name):
        lines = source[filename].splitlines()
        prefix = '#define ' + name + '(V)'
        matches = [i for i, line in enumerate(lines) if line.startswith(prefix)]
        if len(matches) != 1:
            raise ValueError('Review HTTP/2 macro: ' + name)
        index = matches[0]
        if lines[index][len(prefix):].strip() != chr(92):
            raise ValueError('Review HTTP/2 macro declaration: ' + name)
        result = []
        while lines[index].rstrip().endswith(chr(92)):
            index += 1
            result.append(lines[index].rstrip().removesuffix(chr(92)).rstrip())
        return '\n'.join(result)

    def numeric_names(name):
        body = macro('src/node_http2.h', name)
        result = []
        for line in body.splitlines():
            line = line.strip()
            if not line:
                continue
            item = re.fullmatch(r'V\((\w+)\)', line)
            nested = re.fullmatch(r'(HTTP2_\w+)\(V\)', line)
            if item:
                result.append(item[1])
            elif nested:
                result += numeric_names(nested[1])
            else:
                raise ValueError('Review HTTP/2 constant macro line: ' + line)
        return result

    constants = [(name, values[name], False) for name in numeric_names('HTTP2_HIDDEN_CONSTANTS')]
    constants += [(name, values[name], True) for name in numeric_names('HTTP2_CONSTANTS')]
    constants.append(('NGHTTP2_DEFAULT_WEIGHT', values['NGHTTP2_DEFAULT_WEIGHT'], True))
    for macro_name, prefix in [('HTTP_SPECIAL_HEADERS', 'HTTP2_HEADER_'),
                               ('HTTP_REGULAR_HEADERS', 'HTTP2_HEADER_'),
                               ('HTTP_ADDITIONAL_HEADERS', 'HTTP2_HEADER_'),
                               ('HTTP_KNOWN_METHODS', 'HTTP2_METHOD_'),
                               ('HTTP_STATUS_CODES', 'HTTP_STATUS_')]:
        body = macro('src/node_http_common.h', macro_name)
        for line in body.splitlines():
            if not line.strip():
                continue
            item = re.fullmatch(r'\s*V\((\w+),\s*("[^"]*"|\d+)\)\s*', line)
            if not item:
                raise ValueError('Review HTTP/2 string/status constant: ' + line)
            constants.append((prefix + item[1], json.loads(item[2]), True))

    def section(filename, start, end):
        text = source[filename]
        if text.count(start) != 1:
            raise ValueError('Review HTTP/2 selection: ' + start)
        a = text.index(start)
        b = text.index(end, a)
        return text[a:b].rstrip()

    util = 'lib/internal/http2/util.js'
    core = 'lib/internal/http2/core.js'
    sections = {
        'bounds': section(core, 'const kMaxFrameSize =', '\nconst kMaxALTSVC ='),
        'layout': section(util, 'const IDX_SETTINGS_HEADER_TABLE_SIZE =', '\nconst IDX_SESSION_STATE_'),
        'assertObject': section(util, 'const assertIsObject = hideStackFrames(', '\nconst assertIsArray ='),
        'assertRange': section(util, 'const assertWithinRange = hideStackFrames(', '\nfunction toHeaderObject('),
        'defaults_functions': section(util, 'function addCustomSettingsToObj()', '\n// Remote is a boolean.'),
        'update': section(util, 'function updateSettingsBuffer(settings)', '\nfunction remoteCustomSettingsToBuffer('),
        'validate': section(core, 'const validateSettings = hideStackFrames(', '\n// Wrap a typed array'),
        'public': section(core, 'function getPackedSettings(settings)', '\nfunction performServerHandshake('),
    }
    # nghttp2 validates only the known settings cases below; unknown IDs remain
    # extensible. Mechanically carry the actual switch into the JS wire owner.
    frame = source['deps/nghttp2/lib/nghttp2_frame.c']
    check = section('deps/nghttp2/lib/nghttp2_frame.c', 'int nghttp2_iv_check(', '\n}',)
    switch = check[check.index('    switch (iv[i].settings_id) {'):]
    switch = switch[:switch.rindex('    }') + 5]
    switch = switch.replace('iv[i].settings_id', 'id').replace('iv[i].value', 'value')
    switch = switch.replace('(uint32_t)', '').replace('return 0;', 'return false;')
    switch = re.sub(r'\bNGHTTP2_\w+\b', lambda m: str(values[m[0]]), switch)
    default_entries = [(name, values['DEFAULT_SETTINGS_' + name]) for name in
                       re.findall(r'V\((\w+)\)', macro('src/node_http2.h', 'HTTP2_SETTINGS'))]
    order = [(values['NGHTTP2_SETTINGS_' + name], 'IDX_SETTINGS_' + name) for name, _ in default_entries]
    replacements = {
        '/* NODE_HTTP2_CONSTANTS */': json.dumps(constants, separators=(',', ':')),
        '/* NODE_HTTP2_DEFAULTS */': '\n'.join('            settingsBuffer[IDX_SETTINGS_' + name + '] = ' + str(value) + '; flags |= 1 << IDX_SETTINGS_' + name + ';' for name, value in default_entries),
        '/* NODE_HTTP2_ORDER */': '\n'.join('            if (flags & (1 << ' + index + ')) { entries[count * 2] = ' + str(wire) + '; entries[count * 2 + 1] = settingsBuffer[' + index + ']; count++; }' for wire, index in order),
        '/* NODE_HTTP2_WIRE_VALIDATION */': switch,
    }
    replacements.update({'/* NODE_HTTP2_' + name.upper() + ' */': text for name, text in sections.items()})
    adapter = (ROOT / 'http2-settings-adapter.js').read_text()
    for marker, replacement in replacements.items():
        if adapter.count(marker) != 1:
            raise ValueError('Review HTTP/2 settings adapter marker: ' + marker)
        adapter = adapter.replace(marker, replacement)
    return {'bundle': adapter, 'constants': constants,
            'selectedSectionHashes': {name: hashlib.sha256(text.encode()).hexdigest() for name, text in sections.items()},
            'settingsOrder': order, 'protocolValues': values}


if __name__ == '__main__':
    print(json.dumps({key: value for key, value in render().items() if key != 'bundle'}, indent=2))
