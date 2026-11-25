#!/usr/bin/env python3
"""Stage whole, authenticated Node tracing units and their native declarations."""
import argparse
import hashlib
import json
import re
from pathlib import Path


def prepare(manifest, output):
    document = json.loads(manifest.read_text())
    records = {row['path']: row for row in document['files']}
    if output.resolve().is_relative_to(manifest.parent.resolve()):
        raise ValueError('output must be outside immutable import')
    builtins = output.parent / 'trace-builtins-upstream'
    originals = ['deps/v8/src/builtins/builtins-trace.cc',
                 'deps/v8/src/common/message-template.h',
                 'deps/v8/src/strings/unicode.h', 'deps/v8/src/strings/unicode-inl.h',
                 'deps/v8/third_party/utf8-decoder/utf8-decoder.h']
    for name in originals:
        data = (manifest.parent / 'upstream' / name).read_bytes()
        record = records[name]
        if len(data) != record['bytes'] or hashlib.sha256(data).hexdigest() != record['sha256']:
            raise ValueError('tracing builtin source mismatch: ' + name)
        destination = builtins / name.removeprefix('deps/v8/')
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
    for name in ['src/api/api-inl.h', 'src/builtins/builtins-utils-inl.h',
                 'src/builtins/builtins.h', 'src/json/json-stringifier.h',
                 'src/logging/counters.h', 'src/objects/objects-inl.h',
                 'src/roots/roots-inl.h', 'src/tracing/perfetto-sdk.h',
                 'src/tracing/traced-value.h']:
        destination = builtins / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text('#include "kandelo-node/trace-builtin-native-api.h"\n')
    for name in ['src/base/bit-field.h', 'src/base/vector.h', 'src/base/logging.h',
                 'src/common/globals.h', 'src/utils/utils.h']:
        destination = builtins / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text('#include "kandelo-node/trace-unicode-native-api.h"\n')
    messages = (builtins / 'src/common/message-template.h').read_text().replace('\\\n','')
    expected = {
        'TraceEventCategoryError': 'Trace event category must be a string.',
        'TraceEventNameError': 'Trace event name must be a string.',
        'TraceEventNameLengthError': 'Trace event name must not be an empty string.',
        'TraceEventPhaseError': 'Trace event phase must be a number.',
        'TraceEventIDError': 'Trace event id must be a number.',
    }
    for key, text in expected.items():
        if not re.search(r'T\(' + key + r',\s*"' + re.escape(text) + r'"\)', messages):
            raise ValueError('unreviewed original trace error: ' + key)
    header = '#pragma once\nnamespace kandelo_trace_builtin_api::internal {\nenum class MessageTemplate {\n'
    header += ''.join('k'+key+',\n' for key in expected) + '};\n'
    header += 'inline const char* TraceMessage(MessageTemplate message) {\nswitch(message) {\n'
    header += ''.join('case MessageTemplate::k'+key+': return '+json.dumps(text)+';\n' for key,text in expected.items())
    header += '}\nreturn nullptr;\n}\n}\n'
    (builtins / 'messages.generated.h').write_text(header)
    return {'completeNativeFiles': len(originals), 'functionBodiesExtracted': False,
            'javascriptGenerated': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    arguments = parser.parse_args()
    print(json.dumps(prepare(arguments.manifest, arguments.output)))
