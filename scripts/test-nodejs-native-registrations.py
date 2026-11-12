#!/usr/bin/env python3
"""Exercise false-positive, multiline and conditional registry-index boundaries."""
from pathlib import Path
import importlib.util
import json
import sys

spec = importlib.util.spec_from_file_location('registration_index', 'scripts/index-nodejs-native-registrations.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
rows = []


def check(name, callback):
    try:
        callback()
        rows.append({'name': name, 'status': 'pass'})
    except Exception as error:
        rows.append({'name': name, 'status': 'fail', 'error': str(error)})


def expect(condition):
    if not condition:
        raise AssertionError('registration-index control failed')


check('multiline-mksnapshot-shaped-registration-is-indexed', lambda: expect(
    module.registration_sites('NODE_BINDING_CONTEXT_AWARE_INTERNAL(\n mksnapshot,\n node::Init)')[0]['name'] == 'mksnapshot'))
check('comments-and-quoted-strings-do-not-create-fake-registrations', lambda: expect(
    module.registration_sites('// NODE_BINDING_CONTEXT_AWARE_INTERNAL(fake, X)\n'
                              '/* NODE_BINDING_PER_ISOLATE_INIT(fake, X) */\n'
                              'const char* s="NODE_BINDING_EXTERNAL_REFERENCE(fake, X)";') == []))
check('raw-strings-with-custom-delimiters-do-not-create-sites', lambda: expect(
    module.registration_sites('auto text=u8R"tag(NODE_BINDING_CONTEXT_AWARE_INTERNAL(fake, X))tag";\n'
                              'NODE_BINDING_CONTEXT_AWARE_INTERNAL(real, Init)')[0]['name'] == 'real'))
check('macro-definitions-and-continuation-bodies-are-not-registrations', lambda: expect(
    module.registration_sites('#define FORWARD(x) \\\n NODE_BINDING_CONTEXT_AWARE_INTERNAL(x, Init)\n'
                              '#define NODE_BINDING_CONTEXT_AWARE_INTERNAL(x,y) y\n') == []))


def conditional():
    result = module.registration_sites('#if PLATFORM_A\nNODE_BINDING_CONTEXT_AWARE_INTERNAL(a, A)\n'
                                       '#elif PLATFORM_B\nNODE_BINDING_CONTEXT_AWARE_INTERNAL(b, B)\n'
                                       '#else\nNODE_BINDING_CONTEXT_AWARE_INTERNAL(c, C)\n#endif\n')
    expect([r['name'] for r in result] == ['a', 'b', 'c'])
    expect(result[2]['preprocessorGuards'][0]['previousArms'] == ['#if PLATFORM_A', '#elif PLATFORM_B'])
    expect(result[2]['preprocessorGuards'][0]['arm'] == '#else')


check('every-preprocessor-arm-is-preserved-without-evaluation', conditional)


def nested():
    result = module.registration_sites('#ifdef OUTER\n#if INNER \\\n && MORE\nNODE_BINDING_PER_ISOLATE_INIT(x, node::Initialize)\n#endif\n#endif\n')
    expect(len(result[0]['preprocessorGuards']) == 2)
    expect(result[0]['line'] == 4)
    expect('MORE' in result[0]['preprocessorGuards'][1]['opening'])


check('nested-multiline-guards-retain-lines-and-both-conditions', nested)
check('nested-initializer-parentheses-retain-expression', lambda: expect(
    module.registration_sites('NODE_BINDING_EXTERNAL_REFERENCE(x, Select(A(), B()))')[0]['initializerExpression'] == 'Select(A(), B())'))
check('digit-separators-and-escaped-character-literals-are-safe', lambda: expect(
    module.registration_sites("const auto n=1'000;const char c='\\'';\nNODE_BINDING_CONTEXT_AWARE_INTERNAL(x, Init)")[0]['name'] == 'x'))
check('unicode-comment-offsets-preserve-correct-source-line', lambda: expect(
    module.registration_sites('// ü\nNODE_BINDING_CONTEXT_AWARE_INTERNAL(x, Init)')[0]['line'] == 2))


def rejected(source, message):
    try:
        module.registration_sites(source)
    except ValueError as error:
        expect(message in str(error))
    else:
        raise AssertionError('malformed input silently accepted')


check('unclosed-registration-fails-loudly', lambda: rejected('NODE_BINDING_CONTEXT_AWARE_INTERNAL(x, Init', 'unclosed native'))
check('unknown-registration-argument-shapes-fail-loudly', lambda: rejected('NODE_BINDING_CONTEXT_AWARE_INTERNAL("x", Init)', 'unreviewed native'))
check('unclosed-preprocessor-guards-fail-loudly', lambda: rejected('#if FEATURE\n', 'unclosed preprocessor'))
check('unmatched-preprocessor-branches-fail-loudly', lambda: rejected('#else\n', 'unmatched preprocessor'))
check('unterminated-raw-string-fails-loudly', lambda: rejected('R"tag(unclosed', 'unterminated C++ raw'))
failures = sum(row['status'] == 'fail' for row in rows)
Path(sys.argv[1]).write_text(json.dumps({'scope': 'Native registration syntax controls; not C++ compilation or binding conformance',
                                      'controls': len(rows), 'failures': failures, 'observations': rows}, indent=2)+'\n')
print(json.dumps({'controls': len(rows), 'failures': failures}))
raise SystemExit(1 if failures else 0)
