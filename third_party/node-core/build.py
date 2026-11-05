#!/usr/bin/env python3
"""Bundle pinned, unmodified Node sources without network or npm."""
from pathlib import Path
import ast
import hashlib
import json
import re
import runpy
import sys

root = Path(__file__).resolve().parent
manifest = json.loads((root / 'sources.json').read_text())
target = json.loads((root.parents[1] / 'packages/registry/node-compat/target.json').read_text())
if manifest['version'] != target['version'] or manifest['commit'] != target['source']['commit']:
    raise ValueError('Node core sources and API target must use the same release/commit')
for name, item in manifest['tlsState']['sources'].items():
    if hashlib.sha256((root / item['path']).read_bytes()).hexdigest() != item['sha256']:
        raise ValueError('TLS reference identity mismatch: ' + name)
entries = []
for name, item in manifest['modules'].items():
    raw = (root / item['path']).read_bytes()
    if hashlib.sha256(raw).hexdigest() != item['sha256']:
        raise ValueError(f'Node source hash mismatch: {name}')
    source = raw.decode()
    if name == 'internal/assert/utils':
        old = '  ErrorCaptureStackTrace(err, fn);'
        if source.count(old) != 1:
            raise ValueError('review assertion source-expression stack capability')
        source = source.replace(old, '  if (typeof ErrorCaptureStackTrace !== "function") return;\n' + old)
        # This engine has no Node error-source binding. Preserve the default
        # assertion failure when no expression is available, rather than feed
        # an undefined message into the upstream message validator.
        old = 'messageArgs = [getErrMessage(fn)];'
        if source.count(old) != 1:
            raise ValueError('review the assertion diagnostic adaptation')
        source = source.replace(old, 'const expression = getErrMessage(fn);\n'
                                '      messageArgs = expression === undefined ? [] : [expression];')
    if name == 'internal/assert/assertion_error':
        # Retain the Error constructor's actual engine stack when native
        # recapture is absent. Node's stack filtering remains unimplemented.
        old = '    ErrorCaptureStackTrace(this, stackStartFn || stackStartFunction);'
        if source.count(old) != 1:
            raise ValueError('review assertion error stack capability')
        source = source.replace(old, '    if (typeof ErrorCaptureStackTrace === "function") {\n' + old + '\n    }')
    entries.append(json.dumps(name) + ': function(module, exports, require, primordials, internalBinding, process) {\n' + source + '\n}')
license_text = (root / 'LICENSE').read_text().split('The Node.js license applies', 1)[0]
bundle = '/* Node.js ' + manifest['version'] + '\n' + license_text + '\n*/\n'
inspection = (root / 'inspection-adapter.js').read_text()
for name, item in manifest['inspection'].items():
    raw = (root / item['path']).read_bytes()
    if hashlib.sha256(raw).hexdigest() != item['sha256']:
        raise ValueError(f'Node inspection source hash mismatch: {name}')
    marker = '/* NODE_' + ('INSPECTION' if name == 'inspect' else name.upper()) + ' */'
    if inspection.count(marker) != 1:
        raise ValueError(f'Missing or ambiguous inspection marker: {name}')
    inspection = inspection.replace(marker, raw.decode('utf-8'))
bundle += inspection + '\n'
event_factories = []
for name, item in manifest['eventPlatform'].items():
    raw = (root / item['path']).read_bytes()
    if hashlib.sha256(raw).hexdigest() != item['sha256']:
        raise ValueError(f'Node event platform source hash mismatch: {name}')
    source = raw.decode('utf-8')

    if name == 'internal/per_context/domexception':
        # Node writes a V8 private symbol. The engine bridge defines the
        # equivalent SpiderMonkey private-name slot without exposing a key.
        for receiver in ['self', 'this']:
            old = receiver + '[transfer_mode_private_symbol] = kCloneable;'
            if source.count(old) != 1:
                raise ValueError('Review DOMException private clone registration')
            source = source.replace(old, 'internalBinding("util").setCloneMode(' + receiver + ', kCloneable);')
    if name == 'internal/events/public_helpers':
        source = (root / 'event-helpers-prelude.js').read_text() + '\n' + source
        source += '\nmodule.exports = { once, on, getEventListeners, getMaxListeners, listenerCount };\n'
    event_factories.append(json.dumps(name) + ': function(module, exports, require, primordials, internalBinding, process, privateSymbols, perIsolateSymbols) {\n' + source + '\n}')
event_platform = (root / 'event-platform-adapter.js').read_text()
if event_platform.count('/* NODE_EVENT_MODULES */') != 1:
    raise ValueError('Missing or ambiguous Node event platform marker')
bundle += event_platform.replace('/* NODE_EVENT_MODULES */', ',\n'.join(event_factories)) + '\n'
async_factories = []
for name, item in manifest['asyncPlatform'].items():
    raw = (root / item['path']).read_bytes()
    if hashlib.sha256(raw).hexdigest() != item['sha256']:
        raise ValueError(f'Node async source hash mismatch: {name}')
    async_factories.append(json.dumps(name) + ': function(module, exports, require, primordials, internalBinding) {\n' + raw.decode('utf-8') + '\n}')
async_platform = (root / 'async-platform-adapter.js').read_text()
item = manifest['asyncResource']
raw = (root / item['path']).read_bytes()
if hashlib.sha256(raw).hexdigest() != item['sha256']:
    raise ValueError('Node AsyncResource source hash mismatch')
for marker, replacement in [('/* NODE_ASYNC_MODULES */', ',\n'.join(async_factories)), ('/* NODE_ASYNC_RESOURCE */', raw.decode('utf-8'))]:
    if async_platform.count(marker) != 1:
        raise ValueError('Missing or ambiguous async platform marker: ' + marker)
    async_platform = async_platform.replace(marker, replacement)
codec_generator = runpy.run_path(str(root / 'generate-codec-contexts.py'))
_, native_provider_ids = codec_generator['native_providers'](root, manifest)
provider_item = manifest['cryptoRandomJobs']['sources']['nativeProviders']
provider_raw = (root / provider_item['path']).read_bytes()
if hashlib.sha256(provider_raw).hexdigest() != provider_item['sha256']:
    raise ValueError('Crypto native provider reference mismatch')
provider_text = provider_raw.decode()
crypto_start = provider_text.index('#define NODE_ASYNC_CRYPTO_PROVIDER_TYPES(V)')
crypto_end = provider_text.index('#else', crypto_start)
import re
crypto_names = re.findall(r'^\s+V\(([A-Z_0-9]+)\)', provider_text[crypto_start:crypto_end], re.M)
if len(set(crypto_names)) != len(crypto_names): raise ValueError('Duplicate crypto providers')
# This engine actually links OpenSSL. Non-crypto provider positions stay intact.
crypto_provider_base = len(native_provider_ids)
native_provider_ids.update({name: crypto_provider_base + index for index, name in enumerate(crypto_names)})

provider_marker = '/* NODE_ASYNC_PROVIDER_MAP */'
if async_platform.count(provider_marker) != 1:
    raise ValueError('Missing or ambiguous public async provider map')
async_platform = async_platform.replace(provider_marker, ',\n'.join(
    name + ': ' + str(value) for name, value in native_provider_ids.items()))
item = manifest['eventEmitterAsyncResource']
raw = (root / item['path']).read_bytes()
if hashlib.sha256(raw).hexdigest() != item['sha256']:
    raise ValueError('Node EventEmitterAsyncResource source hash mismatch')
marker = '/* NODE_EVENT_EMITTER_ASYNC_RESOURCE */'
if async_platform.count(marker) != 1:
    raise ValueError('Missing or ambiguous EventEmitterAsyncResource marker')
async_platform = async_platform.replace(marker, raw.decode('utf-8'))
item = manifest['tickObject']
raw = (root / item['path']).read_bytes()
if hashlib.sha256(raw).hexdigest() != item['sha256']:
    raise ValueError('Node TickObject source hash mismatch')
marker = '/* NODE_TICK_OBJECT */'
if async_platform.count(marker) != 1:
    raise ValueError('Missing or ambiguous TickObject marker')
async_platform = async_platform.replace(marker, raw.decode('utf-8'))
bundle += async_platform + '\n'
path_factories = []
for name, item in manifest['pathPlatform'].items():
    raw = (root / item['path']).read_bytes()
    if hashlib.sha256(raw).hexdigest() != item['sha256']:
        raise ValueError(f'Node path source hash mismatch: {name}')
    source = raw.decode('utf-8')
    if name == 'internal/fs/glob':
        source += '\nmodule.exports = { createMatcher, matchGlobPattern };\n'
    if name == 'internal/util/get_lazy':
        source += '\nmodule.exports = getLazy;\n'
    path_factories.append(json.dumps(name) + ': function(module, exports, require, primordials, process) {\n' + source + '\n}')
for name, item in manifest['pathLicenses'].items():
    raw = (root / item['path']).read_bytes()
    if hashlib.sha256(raw).hexdigest() != item['sha256']:
        raise ValueError(f'Node path license hash mismatch: {name}')
    bundle += '\n/* ' + name + '\n' + raw.decode('utf-8') + '\n*/\n'
path_platform = (root / 'path-platform-adapter.js').read_text()
marker = '/* NODE_PATH_MODULES */'
if path_platform.count(marker) != 1:
    raise ValueError('Missing or ambiguous Node path platform marker')
bundle += path_platform.replace(marker, ',\n'.join(path_factories)) + '\n'
value_helpers_prelude = (root / 'value-helpers-prelude.js').read_text()
value_factories = []
for name, item in manifest['valuesPlatform'].items():
    raw = (root / item['path']).read_bytes()
    if hashlib.sha256(raw).hexdigest() != item['sha256']:
        raise ValueError(f'Node values source hash mismatch: {name}')
    source = raw.decode('utf-8')
    if name == 'internal/errors':
        # This embedding does not implement V8 stack recapture/limits yet.
        # Keep real engine stacks instead of calling a missing intrinsic or
        # suppressing their capture. Exact Node stack filtering stays a gap.
        old = 'function isErrorStackTraceLimitWritable() {'
        if source.count(old) != 1:
            raise ValueError('Review Node diagnostic stack capability guard')
        source = source.replace(old, old + '\n  if (typeof ErrorCaptureStackTrace !== "function") return false;')
        old = 'Error.stackTraceLimit && ErrorCaptureStackTrace(error, wrappedFn);'
        if source.count(old) != 1:
            raise ValueError('Review Node diagnostic recapture guard')
        source = source.replace(old, 'Error.stackTraceLimit && typeof ErrorCaptureStackTrace === "function" && ErrorCaptureStackTrace(error, wrappedFn);')
    if name == 'internal/util/debuglog':
        source = 'const { RegExp, RegExpPrototypeExec, StringPrototypeToLowerCase, StringPrototypeToUpperCase, ObjectDefineProperty, SafeArrayIterator } = primordials;\nconst { inspect, format, formatWithOptions } = require("internal/util/inspect");\n' + source + '\nmodule.exports = { debuglog, initializeDebugEnv };\n'
    if name == 'internal/util/core_helpers':
        source = value_helpers_prelude + '\n' + source + '\nmodule.exports = { isError, getDeprecationWarningEmitter, normalizeEncoding, once, assignFunctionName, deprecate, deprecateInstantiation, emitExperimentalWarning, promisify, convertToValidSignal, convertProcessSignalToExitCode, customPromisifyArgs: kCustomPromisifyArgsSymbol };\n'
    value_factories.append(json.dumps(name) + ': function(module, exports, require, primordials, internalBinding, process) {\n' + source + '\n}')
values_platform = (root / 'values-platform-adapter.js').read_text()
marker = '/* NODE_VALUES_MODULES */'
if values_platform.count(marker) != 1:
    raise ValueError('Missing or ambiguous Node values platform marker')
bundle += values_platform.replace(marker, ',\n'.join(value_factories)) + '\n'

# Public StringDecoder is unchanged. Its byte-state layout and encoding tags
# come from the pinned native protocol, not a parallel hard-coded JS table.
import re
decoder_sources = {}
for name, item in manifest['stringDecoder']['sources'].items():
    raw = (root / item['path']).read_bytes()
    if hashlib.sha256(raw).hexdigest() != item['sha256']:
        raise ValueError('Node string decoder source hash mismatch: ' + name)
    decoder_sources[name] = raw.decode('utf-8')
def decoder_enum(source, declaration):
    match = re.search(re.escape(declaration) + r'\s*\{([^}]+)\}', source)
    if not match:
        raise ValueError('Review string decoder enum: ' + declaration)
    values = {}
    next_value = 0
    for entry in match[1].split(','):
        entry = entry.strip()
        if not entry:
            continue
        name, separator, value = entry.partition('=')
        name = name.strip()
        if separator:
            value = value.strip()
            next_value = values[value] if value in values else int(value)
        if not re.fullmatch(r'\w+', name):
            raise ValueError('Review string decoder enum member: ' + entry)
        values[name] = next_value
        next_value += 1
    return values
decoder_fields = decoder_enum(decoder_sources['fields'], 'enum Fields')
if not re.search(r'uint8_t state_\[kNumFields\] = \{\};', decoder_sources['fields']):
    raise ValueError('Review string decoder storage layout/size')
decoder_fields['kSize'] = decoder_fields['kNumFields']
decoder_encodings = decoder_enum(decoder_sources['encodings'], 'enum encoding')
decoder_encoding_names = {}
for tag, name in re.findall(r'ADD_TO_ENCODINGS_ARRAY\((\w+), "(\w+)"\);', decoder_sources['native']):
    decoder_encoding_names[decoder_encodings[tag]] = name
if set(decoder_encoding_names) != set(range(len(decoder_encoding_names))):
    raise ValueError('Review string decoder sparse encoding map')
decoder = (root / 'string-decoder-adapter.js').read_text()
for marker, replacement in [
    ('/* NODE_STRING_DECODER_CONSTANTS */', json.dumps(decoder_fields)),
    ('/* NODE_STRING_DECODER_ENCODINGS */', json.dumps([
        decoder_encoding_names[i] for i in range(len(decoder_encoding_names))])),
    ('/* NODE_STRING_DECODER_PUBLIC */', decoder_sources['public']),
]:
    if decoder.count(marker) != 1:
        raise ValueError('Missing or ambiguous string decoder marker: ' + marker)
    decoder = decoder.replace(marker, replacement)
bundle += decoder + '\n'

address_factories = []
for name, item in manifest['addressRules']['sources'].items():
    raw = (root / item['path']).read_bytes()
    if hashlib.sha256(raw).hexdigest() != item['sha256']:
        raise ValueError('Node address/rule source hash mismatch: ' + name)
    if name in ('blocklist', 'socketaddress'):
        address_factories.append(json.dumps('internal/' + name) +
            ': function(module, exports, require, primordials, internalBinding) {\n' + raw.decode('utf-8') + '\n}')
address_platform = (root / 'address-rules-adapter.js').read_text()
marker = '/* NODE_ADDRESS_RULE_MODULES */'
if address_platform.count(marker) != 1:
    raise ValueError('Missing or ambiguous address/rule module marker')
address_platform = address_platform.replace(marker, ',\n'.join(address_factories))
net_source = (root / manifest['addressRules']['sources']['net']['path']).read_text()
start, end = '  get BlockList() {', '  BoundSocket,'
if net_source.count(start) != 1 or net_source.count(end) != 1:
    raise ValueError('Review pinned net address-class namespace getters')
net_getters = net_source[net_source.index(start):net_source.index(end)]
marker = '/* NODE_ADDRESS_NET_GETTERS */'
if address_platform.count(marker) != 1:
    raise ValueError('Missing or ambiguous net address getter marker')
bundle += address_platform.replace(marker, net_getters) + '\n'
if (root / 'address-inet.h').read_text() != runpy.run_path(str(root / 'generate-address-inet.py'))['render']():
    raise ValueError('Regenerate pinned native address parser')
native_errors = (root / manifest['addressRules']['sources']['nativeErrors']['path']).read_text()
if 'V(ERR_INVALID_ADDRESS, Error)' not in native_errors or 'V(ERR_INVALID_ADDRESS, "Invalid socket address")' not in native_errors:
    raise ValueError('Review native SocketAddress error representation')
item = manifest['bufferNumeric']
raw = (root / item['path']).read_bytes()
if hashlib.sha256(raw).hexdigest() != item['sha256']:
    raise ValueError('Node numeric Buffer source hash mismatch')
source = raw.decode('utf-8')
sections = {}
for name, selector in item['sections'].items():
    start, end = selector['start'], selector['endExclusive']
    if source.count(start) != 1 or source.count(end) != 1:
        raise ValueError('Ambiguous Node numeric Buffer section: ' + name)
    first = source.index(start)
    section = source[first:source.index(end, first)]
    if hashlib.sha256(section.encode('utf-8')).hexdigest() != selector['sha256']:
        raise ValueError('Node numeric Buffer section hash mismatch: ' + name)
    sections[name] = section
numeric = (root / 'buffer-numeric-adapter.js').read_text()
for marker, replacement in [
    ('/* NODE_BUFFER_NUMERIC_ALGORITHMS */', sections['prefix'] + sections['algorithms']),
    ('/* NODE_BUFFER_NUMERIC_PROTOTYPE */', sections['prototype']),
]:
    if numeric.count(marker) != 1:
        raise ValueError('Missing or ambiguous numeric Buffer marker: ' + marker)
    numeric = numeric.replace(marker, replacement)
bundle += numeric + '\n'
fs_inputs = {}
for name, item in manifest['fsTruncation']['sources'].items():
    raw = (root / item['path']).read_bytes()
    if hashlib.sha256(raw).hexdigest() != item['sha256']:
        raise ValueError('Node filesystem source hash mismatch: ' + name)
    fs_inputs[name] = raw.decode('utf-8')
fs_sections = {}
for name, selector in manifest['fsTruncation']['sections'].items():
    source = fs_inputs[selector['source']]
    if source.count(selector['start']) != 1:
        raise ValueError('Ambiguous filesystem function: ' + name)
    start = source.index(selector['start'])
    section = source[start:start + selector['length']]
    if hashlib.sha256(section.encode('utf-8')).hexdigest() != selector['sha256']:
        raise ValueError('Node filesystem section hash mismatch: ' + name)
    fs_sections[name] = section
fs_truncate = (root / 'fs-truncate-adapter.js').read_text()
for marker, replacement in [
    ('/* NODE_FS_VFS_STATE */', fs_sections['vfsState']),
    ('/* NODE_FS_TRUNCATION_FUNCTIONS */', '\n'.join(value for name, value in fs_sections.items() if name != 'vfsState')),
]:
    if fs_truncate.count(marker) != 1:
        raise ValueError('Missing or ambiguous filesystem marker: ' + marker)
    fs_truncate = fs_truncate.replace(marker, replacement)
bundle += fs_truncate + '\n'

# Filesystem utilities and descriptor methods use exact pinned source sections.
def filesystem_sections(item):
    source = (root / item['source']['path']).read_bytes()
    if hashlib.sha256(source).hexdigest() != item['source']['sha256']:
        raise ValueError('Filesystem source hash mismatch')
    source = source.decode('utf-8')
    sections = {}
    for name, selector in item['sections'].items():
        if source.count(selector['start']) != 1:
            raise ValueError('Ambiguous filesystem section: ' + name)
        start = source.index(selector['start'])
        section = source[start:start + selector['length']]
        if hashlib.sha256(section.encode()).hexdigest() != selector['sha256']:
            raise ValueError('Filesystem section hash mismatch: ' + name)
        sections[name] = section
    return sections
uv_spec = manifest['uvErrorPlatform']
uv_texts = {}
for name, item in uv_spec['sources'].items():
    raw = (root / item['path']).read_bytes()
    if hashlib.sha256(raw).hexdigest() != item['sha256']:
        raise ValueError('UV error platform input mismatch: ' + name)
    uv_texts[name] = raw.decode('utf-8')
uv_adapter = (root / 'uv-platform-adapter.js').read_text()
for name, item in uv_spec['helpers'].items():
    source = uv_texts[item['source']]
    start = source.index(item['start'])
    section = source[start:start + item['length']]
    if hashlib.sha256(section.encode()).hexdigest() != item['sha256']:
        raise ValueError('UV helper selection mismatch: ' + name)
    marker = '/* NODE_UV_' + ('ERRMAP_HELPER' if name == 'error-map' else 'UTIL_HELPERS') + ' */'
    if uv_adapter.count(marker) != 1:
        raise ValueError('UV adapter marker missing: ' + marker)
    uv_adapter = uv_adapter.replace(marker, section)
bundle += uv_adapter + '\n'
uv_renderer = runpy.run_path(str(root / 'generate-uv-error-table.py'))
if (root / 'uv-error-table.h').read_text() != uv_renderer['render'](root):
    raise ValueError('UV native error table is stale')
public_util = filesystem_sections(manifest['utilPublic'])
public_util_adapter = (root / 'util-public-adapter.js').read_text()
marker = '/* NODE_PUBLIC_UTIL_FUNCTIONS */'
if public_util_adapter.count(marker) != 1:
    raise ValueError('Review public util function marker')
bundle += public_util_adapter.replace(marker, '\n'.join(public_util.values())) + '\n'
digest_manifest = manifest['digests']
digest_sections = {}
for name, item in digest_manifest['sources'].items():
    if hashlib.sha256((root / item['path']).read_bytes()).hexdigest() != item['sha256']:
        raise ValueError('Digest reference source mismatch: ' + name)
for name, selector in digest_manifest['algorithms'].items():
    source = (root / digest_manifest['sources'][selector['source']]['path']).read_text()
    if source.count(selector['start']) != 1:
        raise ValueError('Ambiguous digest source: ' + name)
    start = source.index(selector['start'])
    section = source[start:start + selector['length']]
    if hashlib.sha256(section.encode()).hexdigest() != selector['sha256']:
        raise ValueError('Digest section identity mismatch: ' + name)
    digest_sections[name] = section
digest_adapter = (root / 'crypto-digest-adapter.js').read_text()
for marker, name in [('HASH', 'hash'), ('NORMALIZATION', 'normalization'),
                     ('FILTER_NAMES', 'filterNames'), ('BYTE_VALIDATION', 'getArrayBufferOrView'),
                     ('BUFFER_BYTES', 'getBufferSourceBytes')]:
    token = '/* NODE_DIGEST_' + marker + ' */'
    if digest_adapter.count(token) != 1:
        raise ValueError('Review digest source marker: ' + marker)
    digest_adapter = digest_adapter.replace(token, digest_sections[name])
bundle += digest_adapter + '\n'
incremental_spec = manifest['incrementalCrypto']
for name, item in incremental_spec['sources'].items():
    if hashlib.sha256((root / item['path']).read_bytes()).hexdigest() != item['sha256']:
        raise ValueError('Incremental crypto reference mismatch: ' + name)
incremental_sections = {}
for name, item in incremental_spec['sections'].items():
    text = (root / incremental_spec['sources'][item['source']]['path']).read_text()
    if text.count(item['start']) != 1:
        raise ValueError('Ambiguous incremental crypto selection: ' + name)
    offset = text.index(item['start']); section = text[offset:offset + item['length']]
    if hashlib.sha256(section.encode()).hexdigest() != item['sha256']:
        raise ValueError('Incremental crypto selection identity mismatch: ' + name)
    incremental_sections[name] = section
incremental_adapter = (root / 'incremental-crypto-adapter.js').read_text()
for marker, replacement in [
    ('/* NODE_INCREMENTAL_KEY_TYPES */', incremental_sections['keyTypes']),
    ('/* NODE_INCREMENTAL_PREPARE_KEY */', incremental_sections['prepareKey']),
    ('/* NODE_INCREMENTAL_STRING_OPTION */', incremental_sections['stringOption']),
    ('/* NODE_INCREMENTAL_CLASSES */', incremental_sections['classes']),
    ('/* NODE_INCREMENTAL_CREATORS */', '\n'.join(incremental_sections[x] for x in ['createHash', 'createHmac'])),
    ('/* NODE_INCREMENTAL_PUBLIC_CONSTRUCTORS */', incremental_sections['publicConstructors']),
]:
    if incremental_adapter.count(marker) != 1:
        raise ValueError('Review incremental crypto marker: ' + marker)
    incremental_adapter = incremental_adapter.replace(marker, replacement)
bundle += incremental_adapter + '\n'
dotenv = manifest['dotenv']
for name, item in dotenv['sources'].items():
    if hashlib.sha256((root / item['path']).read_bytes()).hexdigest() != item['sha256']:
        raise ValueError('Dotenv reference source mismatch: ' + name)
dotenv_selector = dotenv['loadEnvFile']
dotenv_source = (root / dotenv['sources'][dotenv_selector['source']]['path']).read_text()
if dotenv_source.count(dotenv_selector['start']) != 1:
    raise ValueError('Ambiguous loadEnvFile source')
dotenv_start = dotenv_source.index(dotenv_selector['start'])
dotenv_function = dotenv_source[dotenv_start:dotenv_start + dotenv_selector['length']]
if hashlib.sha256(dotenv_function.encode()).hexdigest() != dotenv_selector['sha256']:
    raise ValueError('loadEnvFile selection identity mismatch')
dotenv_adapter = (root / 'dotenv-platform-adapter.js').read_text()
if dotenv_adapter.count('/* NODE_LOAD_ENV_FILE */') != 1:
    raise ValueError('Review dotenv public source marker')
bundle += dotenv_adapter.replace('/* NODE_LOAD_ENV_FILE */', dotenv_function) + '\n'
dotenv_renderer = runpy.run_path(str(root / 'generate-dotenv.py'))
if (root / 'dotenv-parser.h').read_text() != dotenv_renderer['render'](root):
    raise ValueError('Dotenv native parser is stale')
pool_sections = filesystem_sections(manifest['bufferPool'])
constructor_adapter = (root / 'buffer-constructor-adapter.js').read_text()
for marker, name in [('/* NODE_BUFFER_CONSTRUCTOR_WARNING */','warning'), ('/* NODE_BUFFER_CONSTRUCTOR */','constructor'), ('/* NODE_BUFFER_CONSTRUCTOR_IS_BUFFER */','isBuffer'), ('/* NODE_BUFFER_POOL_INIT */','poolInit'), ('/* NODE_BUFFER_POOL_ALIGN */','poolAlign'), ('/* NODE_BUFFER_POOL_ALLOCATE */','allocate'), ('/* NODE_BUFFER_POOL_ARRAY */','fromArrayLike'), ('/* NODE_BUFFER_POOL_PUBLIC_ALLOC */','allocUnsafe')]:
    if constructor_adapter.count(marker) != 1:
        raise ValueError('Review Buffer constructor/pool marker: ' + marker)
    constructor_adapter = constructor_adapter.replace(marker, pool_sections[name])
bundle += constructor_adapter + '\n'
unpooled = filesystem_sections(manifest['bufferUnpooled'])
allocator = filesystem_sections({'source': manifest['fsHandle']['buffer'],
                                 'sections': manifest['fsHandle']['buffer']['sections']})
unpooled_adapter = (root / 'buffer-unpooled-adapter.js').read_text()
marker = '/* NODE_BUFFER_UNPOOLED */'
if unpooled_adapter.count(marker) != 1:
    raise ValueError('Review unpooled Buffer marker')
bundle += unpooled_adapter.replace(marker, '\n'.join([*unpooled.values(), *allocator.values()])) + '\n'
codec_sections = filesystem_sections(manifest['bufferCodecs'])
codec_wrappers = filesystem_sections(manifest['bufferCodecWrappers'])
for name, item in manifest['bufferCodecNativeReference']['sources'].items():
    if hashlib.sha256((root / item['path']).read_bytes()).hexdigest() != item['sha256']:
        raise ValueError('Buffer codec native reference mismatch: ' + name)
codec_adapter = (root / 'buffer-codecs-adapter.js').read_text()
for marker, replacement in [
    ('/* NODE_BUFFER_CODECS_WRAPPERS */', codec_wrappers['writeWrappers']),
    ('/* NODE_BUFFER_CODECS_ALGORITHMS */', '\n'.join(codec_sections.values())),
    ('/* NODE_BUFFER_CODECS_PROTOTYPE */', codec_wrappers['prototype']),
]:
    if codec_adapter.count(marker) != 1:
        raise ValueError('Review Buffer codec marker: ' + marker)
    codec_adapter = codec_adapter.replace(marker, replacement)
bundle += codec_adapter + '\n'
byte_sections = filesystem_sections(manifest['bufferBytes'])
byte_adapter = (root / 'buffer-bytes-adapter.js').read_text()
marker = '/* NODE_BUFFER_BYTE_ALGORITHMS */'
if byte_adapter.count(marker) != 1:
    raise ValueError('Review public Buffer byte algorithm marker')
bundle += byte_adapter.replace(marker, '\n'.join(byte_sections.values())) + '\n'
diagnostics_item = manifest['diagnosticsPlatform']
diagnostics_raw = (root / diagnostics_item['source']['path']).read_bytes()
if hashlib.sha256(diagnostics_raw).hexdigest() != diagnostics_item['source']['sha256']:
    raise ValueError('Node diagnostics source hash mismatch')
diagnostics_weak = filesystem_sections(diagnostics_item['weakReference'])['WeakReference']
diagnostics_adapter = (root / 'diagnostics-platform-adapter.js').read_text()
for marker, replacement in [
    ('/* NODE_DIAGNOSTICS_WEAK_REFERENCE */', diagnostics_weak),
    ('/* NODE_DIAGNOSTICS_MODULE */', diagnostics_raw.decode('utf-8')),
]:
    if diagnostics_adapter.count(marker) != 1:
        raise ValueError('Review diagnostics marker: ' + marker)
    diagnostics_adapter = diagnostics_adapter.replace(marker, replacement)
bundle += diagnostics_adapter + '\n'
random_sync = filesystem_sections(manifest['cryptoRandomSync'])
random_adapter = (root / 'crypto-random-sync-adapter.js').read_text()
marker = '/* NODE_CRYPTO_RANDOM_SYNC */'
if random_adapter.count(marker) != 1:
    raise ValueError('Review synchronous crypto random marker')
random_adapter = random_adapter.replace(marker, '\n'.join(random_sync.values()))
for name, marker in [('web', '/* NODE_CRYPTO_RANDOM_WEB_WRAPPER */'), ('public', '/* NODE_CRYPTO_RANDOM_PUBLIC_WRAPPER */')]:
    wrapper = filesystem_sections(manifest['cryptoRandomSyncWrappers'][name])
    if random_adapter.count(marker) != 1:
        raise ValueError('Review crypto random wrapper marker: ' + name)
    random_adapter = random_adapter.replace(marker, '\n'.join(wrapper.values()))
bundle += random_adapter + '\n'
readline_item = manifest['readlinePlatform']
readline_sources = {}
for name, item in readline_item['sources'].items():
    raw = (root / item['path']).read_bytes()
    if hashlib.sha256(raw).hexdigest() != item['sha256']:
        raise ValueError('Readline source hash mismatch: ' + name)
    readline_sources[name] = raw.decode('utf-8')
readline_sections = {}
for name, selector in readline_item['sections'].items():
    source = readline_sources[selector['source']]
    if source.count(selector['start']) != 1:
        raise ValueError('Ambiguous readline helper: ' + name)
    start = source.index(selector['start'])
    section = source[start:start + selector['length']]
    if hashlib.sha256(section.encode()).hexdigest() != selector['sha256']:
        raise ValueError('Readline helper hash mismatch: ' + name)
    readline_sections[name] = section
readline_modules = {
    'internal/readline/callbacks': readline_sources['callbacks'],
    'internal/readline/promises': readline_sources['promises'],
}
for name, item in manifest['readlineInterfaces']['sources'].items():
    raw = (root / item['path']).read_bytes()
    if hashlib.sha256(raw).hexdigest() != item['sha256']:
        raise ValueError('Readline interface source identity mismatch: ' + name)
    readline_modules[name] = raw.decode('utf-8')
readline_factories = [json.dumps(name) + ': function(module, exports, require, primordials, process) {\n' + source + '\n}' for name, source in readline_modules.items()]
readline_adapter = (root / 'readline-platform-adapter.js').read_text()
for marker, replacement in [
    ('/* NODE_TTY_ISATTY */', readline_sections['isatty']),
    ('/* NODE_READLINE_MODULES */', ',\n'.join(readline_factories)),
]:
    if readline_adapter.count(marker) != 1:
        raise ValueError('Review readline marker: ' + marker)
    readline_adapter = readline_adapter.replace(marker, replacement)
bundle += readline_adapter + '\n'
os_sources = {}
for name, item in manifest['osPlatform']['sources'].items():
    raw = (root / item['path']).read_bytes()
    if hashlib.sha256(raw).hexdigest() != item['sha256']:
        raise ValueError('OS source identity mismatch: ' + name)
    os_sources[name] = raw.decode('utf-8')
selector = manifest['osPlatform']['cidr']
source = os_sources[selector['source']]
if source.count(selector['start']) != 1:
    raise ValueError('Ambiguous OS CIDR helper')
start = source.index(selector['start'])
cidr = source[start:start + selector['length']]
if hashlib.sha256(cidr.encode()).hexdigest() != selector['sha256']:
    raise ValueError('OS CIDR helper identity mismatch')
os_adapter = (root / 'os-platform-adapter.js').read_text()
for marker, replacement in [('/* NODE_OS_MODULE */', os_sources['os']), ('/* NODE_OS_CIDR */', cidr)]:
    if os_adapter.count(marker) != 1:
        raise ValueError('Review OS source marker: ' + marker)
    os_adapter = os_adapter.replace(marker, replacement)
bundle += os_adapter + '\n'
query_sources = {}
for name, item in manifest['queryCodecs']['sources'].items():
    raw = (root / item['path']).read_bytes()
    if hashlib.sha256(raw).hexdigest() != item['sha256']:
        raise ValueError('Query/Unicode codec source identity mismatch: ' + name)
    query_sources[name] = raw.decode('utf-8')
query_factories = [json.dumps(name) + ': function(module, exports, require, primordials, internalBinding, process) {\n' + source + '\n}' for name, source in query_sources.items() if name != 'originReference']
query_adapter = (root / 'query-codecs-platform-adapter.js').read_text()
marker = '/* NODE_QUERY_CODECS_MODULES */'
if query_adapter.count(marker) != 1:
    raise ValueError('Review query/Unicode codec source marker')
bundle += query_adapter.replace(marker, ',\n'.join(query_factories)) + '\n'
console_manifest = manifest['consolePlatform']
console_sources = {}
for name, item in console_manifest['sources'].items():
    raw = (root / item['path']).read_bytes()
    if hashlib.sha256(raw).hexdigest() != item['sha256']:
        raise ValueError('Console source identity mismatch: ' + name)
    console_sources[name] = raw.decode('utf-8')
# V8 stack recapture is absent in the current guest engine. Keep a real
# engine Error stack when unavailable; exact filtering/formatting is still
# an implementation gap, never fabricated caller frames or a platform pass.
old = '    ErrorCaptureStackTrace(err, trace);'
if console_sources['internal/console/constructor'].count(old) != 1:
    raise ValueError('Review Console native stack capability adaptation')
console_sources['internal/console/constructor'] = console_sources['internal/console/constructor'].replace(old, '''    if (typeof ErrorCaptureStackTrace === 'function') {
      ErrorCaptureStackTrace(err, trace);
    } else {
      const actualError = new primordials.Error(err.message);
      actualError.name = err.name;
      const header = primordials.ErrorPrototypeToString(actualError);
      const stack = actualError.stack;
      err.stack = typeof stack === 'string' && !primordials.StringPrototypeStartsWith(stack, header) ?
        header + '\\n' + stack : stack;
    }''')
console_factories = [json.dumps(name) + ': function(module, exports, require, primordials, internalBinding, process) {\n' + source + '\n}' for name, source in console_sources.items() if name not in ['bootstrapReference', 'utilReference']]
console_adapter = (root / 'console-platform-adapter.js').read_text()
selector = console_manifest['exposeNamespace']
source = console_sources['utilReference']
if source.count(selector['start']) != 1:
    raise ValueError('Ambiguous global Console namespace owner')
start = source.index(selector['start'])
expose = source[start:start + selector['length']]
if hashlib.sha256(expose.encode()).hexdigest() != selector['sha256']:
    raise ValueError('Global Console namespace source mismatch')
for marker, replacement in [('/* NODE_CONSOLE_MODULES */', ',\n'.join(console_factories)),
                            ('/* NODE_CONSOLE_EXPOSE_NAMESPACE */', expose)]:
    if console_adapter.count(marker) != 1:
        raise ValueError('Review Console source marker: ' + marker)
    console_adapter = console_adapter.replace(marker, replacement)
bundle += console_adapter + '\n'
http_item = manifest['httpHeaders']
http_sources = {}
for name, item in http_item['sources'].items():
    raw = (root / item['path']).read_bytes()
    if hashlib.sha256(raw).hexdigest() != item['sha256']:
        raise ValueError('HTTP header source hash mismatch: ' + name)
    http_sources[name] = raw.decode('utf-8')
http_sections = {}
for name, selector in http_item['sections'].items():
    source = http_sources[selector['source']]
    if source.count(selector['start']) != 1:
        raise ValueError('Ambiguous HTTP section: ' + name)
    start = source.index(selector['start'])
    section = source[start:start + selector['length']]
    if hashlib.sha256(section.encode()).hexdigest() != selector['sha256']:
        raise ValueError('HTTP section hash mismatch: ' + name)
    http_sections[name] = section
http_adapter = (root / 'http-headers-adapter.js').read_text()
http_parts = [http_sections['token'], http_sections['headerCharacters'],
    'const RE_TE_CHUNKED = ({' + http_sections['chunkExpression'] + '}).chunkExpression;',
    *[http_sections[name] for name in ['container', 'connectionClose', 'fieldPredicates', 'policy',
        'fieldSerialization', 'validators', 'unique', 'methods', 'headersSent', 'pathRegexp', 'pathAccessor', 'statusCodes']]]
for marker, replacement in [
    ('/* NODE_HTTP_HEADER_ALGORITHMS */', '\n'.join(http_parts)),
    ('/* NODE_HTTP_REQUEST_METHOD */', http_sections['method']),
    ('/* NODE_HTTP_REQUEST_VALIDATION */', http_sections['validationOptions']),
]:
    if http_adapter.count(marker) != 1:
        raise ValueError('Review HTTP header marker: ' + marker)
    http_adapter = http_adapter.replace(marker, replacement)
bundle += http_adapter + '\n'
incoming_item = manifest['httpIncoming']
incoming_raw = (root / incoming_item['path']).read_bytes()
if hashlib.sha256(incoming_raw).hexdigest() != incoming_item['sha256']:
    raise ValueError('Node IncomingMessage source hash mismatch')
incoming_adapter = (root / 'http-incoming-adapter.js').read_text()
if incoming_adapter.count('/* NODE_HTTP_INCOMING */') != 1:
    raise ValueError('Review Node IncomingMessage source marker')
bundle += incoming_adapter.replace('/* NODE_HTTP_INCOMING */', incoming_raw.decode('utf-8')) + '\n'
identity_item = manifest['networkIdentity']
identity_sources = {}
for name, item in identity_item['sources'].items():
    raw = (root / item['path']).read_bytes()
    if hashlib.sha256(raw).hexdigest() != item['sha256']:
        raise ValueError('Network identity source hash mismatch: ' + name)
    identity_sources[name] = raw.decode('utf-8')
for name, adapter, marker in [
    ('net', 'network-ip-adapter.js', '/* NODE_NETWORK_IP_GRAMMAR */'),
    ('url', 'domain-platform-adapter.js', '/* NODE_PUBLIC_DOMAIN_HELPERS */'),
    ('tls', 'tls-identity-adapter.js', '/* NODE_TLS_IDENTITY */'),
]:
    selector = identity_item['sections'][name]
    source = identity_sources[selector['source']]
    if source.count(selector['start']) != 1:
        raise ValueError('Ambiguous network identity section: ' + name)
    start = source.index(selector['start'])
    section = source[start:start + selector['length']]
    if hashlib.sha256(section.encode()).hexdigest() != selector['sha256']:
        raise ValueError('Network identity section hash mismatch: ' + name)
    text = (root / adapter).read_text()
    if text.count(marker) != 1:
        raise ValueError('Review network identity marker: ' + name)
    bundle += text.replace(marker, section) + '\n'
bundle += '\n/*\n' + (root / 'licenses/uv-inet.txt').read_text().replace('*/', '* /') + '\n*/\n'
vm_sources = {}
for name, item in manifest['vmPlatform']['sources'].items():
    raw = (root / item['path']).read_bytes()
    if hashlib.sha256(raw).hexdigest() != item['sha256']:
        raise ValueError('Node VM source hash mismatch: ' + name)
    vm_sources[name] = raw.decode('utf-8')
selector = manifest['vmPlatform']['importOptionId']
source = vm_sources['internal']
if source.count(selector['start']) != 1:
    raise ValueError('Ambiguous VM option-ID source')
start = source.index(selector['start'])
section = source[start:start + selector['length']]
if hashlib.sha256(section.encode()).hexdigest() != selector['sha256']:
    raise ValueError('VM option-ID section hash mismatch')
vm_adapter = (root / 'vm-platform-adapter.js').read_text()
for marker, replacement in [('/* NODE_VM_IMPORT_OPTION_ID */', section),
                            ('/* NODE_PUBLIC_VM */', vm_sources['public'])]:
    if vm_adapter.count(marker) != 1:
        raise ValueError('Review VM marker: ' + marker)
    vm_adapter = vm_adapter.replace(marker, replacement)
bundle += vm_adapter + '\n'
sqlite_sources = {}
for name, item in manifest['sqlitePlatform']['sources'].items():
    raw = (root / item['path']).read_bytes()
    if hashlib.sha256(raw).hexdigest() != item['sha256']:
        raise ValueError('Node SQLite source hash mismatch: ' + name)
    sqlite_sources[name] = raw.decode('utf-8')
sqlite_adapter = (root / 'sqlite-platform-adapter.js').read_text()
sqlite_limits, sqlite_limit_names = runpy.run_path(str(root / 'generate-sqlite-constants.py'))['limits'](root)
if '--check' in sys.argv:
    if (root / 'sqlite-limit-names.h').read_text() != sqlite_limits:
        raise ValueError('SQLite limit mapping header is stale')
else:
    (root / 'sqlite-limit-names.h').write_text(sqlite_limits)
if sqlite_adapter.count('/* NODE_SQLITE_LIMIT_NAMES */') != 1:
    raise ValueError('Review SQLite limit-name embedding')
sqlite_adapter = sqlite_adapter.replace('/* NODE_SQLITE_LIMIT_NAMES */', json.dumps(sqlite_limit_names))
marker = '/* NODE_PUBLIC_SQLITE */'
if sqlite_adapter.count(marker) != 1:
    raise ValueError('Review SQLite public module marker')
bundle += sqlite_adapter.replace(marker, sqlite_sources['public']) + '\n'
runpy.run_path(str(root / 'generate-sqlite-constants.py'))['generate'](root)
web_data = manifest['webData']
web_data_sources = {}
for name, item in web_data['sources'].items():
    raw = (root / item['path']).read_bytes()
    if hashlib.sha256(raw).hexdigest() != item['sha256']:
        raise ValueError('Web data source hash mismatch: ' + name)
    web_data_sources[name] = raw.decode('utf-8')
file_adapter = (root / 'file-platform-adapter.js').read_text()
marker = '/* NODE_FILE_MODULE */'
if file_adapter.count(marker) != 1:
    raise ValueError('Review File module marker')
bundle += file_adapter.replace(marker, web_data_sources['file']) + '\n'
web_iterator_parts = []
for name, selector in web_data['iteratorSections'].items():
    source = web_data_sources[selector['source']]
    if source.count(selector['start']) != 1:
        raise ValueError('Ambiguous web iterator section: ' + name)
    start = source.index(selector['start'])
    section = source[start:start + selector['length']]
    if hashlib.sha256(section.encode()).hexdigest() != selector['sha256']:
        raise ValueError('Web iterator section hash mismatch: ' + name)
    web_iterator_parts.append(section)
web_header_parts = []
for name, selector in web_data['headerSections'].items():
    source = web_data_sources[selector['source']]
    if source.count(selector['start']) != 1:
        raise ValueError('Ambiguous web header section: ' + name)
    start = source.index(selector['start'])
    section = source[start:start + selector['length']]
    if hashlib.sha256(section.encode()).hexdigest() != selector['sha256']:
        raise ValueError('Web header section hash mismatch: ' + name)
    web_header_parts.append(section)
web_iterator = "const { webidl } = require('../webidl');\n" + '\n'.join(web_iterator_parts + web_header_parts) + '\nmodule.exports = { iteratorMixin, isValidHeaderName, isValidHeaderValue, setHeader };\n'
web_data_factories = []
for name, source in [*[(key, web_data_sources[key]) for key in ['webidl', 'runtimeFeatures', 'formdata', 'headers', 'websocketEvents', 'coreSymbols']], ('iterator', web_iterator)]:
    web_data_factories.append(json.dumps(name) + ': function(module, exports, require) {\n' + source + '\n}')
web_license = (root / web_data['license']['path']).read_bytes()
if hashlib.sha256(web_license).hexdigest() != web_data['license']['sha256']:
    raise ValueError('Undici license hash mismatch')
bundle += '\n/* Undici\n' + web_license.decode('utf-8') + '\n*/\n'
formdata_adapter = (root / 'formdata-platform-adapter.js').read_text()
marker = '/* NODE_FORMDATA_MODULES */'
if formdata_adapter.count(marker) != 1:
    raise ValueError('Review FormData module marker')
bundle += formdata_adapter.replace(marker, ',\n'.join(web_data_factories)) + '\n'
shared = filesystem_sections(manifest['fsShared'])
# Keep the actual engine stack if V8-specific stack recapture is absent.
for old in ['    ErrorCaptureStackTrace(err, handleErrorFromBinding);',
            '    ErrorCaptureStackTrace(ctx.error, handleErrorFromBinding);']:
    if shared['handleErrorFromBinding'].count(old) != 1:
        raise ValueError('Review filesystem sync error recapture')
    shared['handleErrorFromBinding'] = shared['handleErrorFromBinding'].replace(
        old, old.replace('    ErrorCapture', '    if (ErrorCaptureStackTrace !== undefined) ErrorCapture'))

stats = (root / 'fs-stats-adapter.js').read_text()
marker = '/* NODE_FS_SHARED_UTILITIES */'
if stats.count(marker) != 1:
    raise ValueError('Review shared filesystem marker')
bundle += stats.replace(marker, '\n'.join([*shared.values(), *filesystem_sections(manifest['fsSync']).values()])) + '\n'

handle_sections = filesystem_sections(manifest['fsHandle'])
handle = handle_sections['class']
# Transfer stays unregistered until native fd movement/rollback exists. Retain
# the public method/ref/close source, but do not expose destructive transfer
# hooks that could invalidate a handle without transferring ownership.
statement = '    markTransferMode(this, false, true);\n'
if handle.count(statement) != 1:
    raise ValueError('Review FileHandle transfer registration')
handle = handle.replace(statement, '')
start, end = handle.index('  [kTransfer]() {'), handle.index('  [kRef]() {')
handle = handle[:start] + handle[end:]
handle_sections['class'] = handle
old = '  ErrorCaptureStackTrace(error, handleErrorFromBinding);'
if handle_sections['handleErrorFromBinding'].count(old) != 1:
    raise ValueError('Review FileHandle stack recapture')
handle_sections['handleErrorFromBinding'] = handle_sections['handleErrorFromBinding'].replace(
    old, '  if (ErrorCaptureStackTrace !== undefined) ErrorCaptureStackTrace(error, handleErrorFromBinding);')
for helper in ['readFileInOneRoundTrip', 'writeFileInOneRoundTrip']:
    for old in ['        ErrorCaptureStackTrace(err, ' + helper + ');' if helper == 'writeFileInOneRoundTrip' else
                '        ErrorCaptureStackTrace(error, ' + helper + ');',
                '      ErrorCaptureStackTrace(accessError, ' + helper + ');']:
        if handle_sections[helper].count(old) != 1:
            raise ValueError('Review whole-file promise stack recapture: ' + helper)
        handle_sections[helper] = handle_sections[helper].replace(
            old, old.replace('ErrorCaptureStackTrace(', 'if (ErrorCaptureStackTrace !== undefined) ErrorCaptureStackTrace(', 1))
handle_adapter = (root / 'fs-handle-adapter.js').read_text()
marker = '/* NODE_FILE_HANDLE */'
if handle_adapter.count(marker) != 1:
    raise ValueError('Review FileHandle marker')
bundle += handle_adapter.replace(marker, '\n'.join(handle_sections.values())) + '\n'


bundle += (root / 'file-jobs-adapter.js').read_text() + '\n'
file_sync = (root / 'file-sync-adapter.js').read_text()
marker = '/* NODE_FS_WHOLE_SYNC */'
if file_sync.count(marker) != 1:
    raise ValueError('Review whole-file sync marker')
bundle += file_sync.replace(marker, '\n'.join(filesystem_sections(manifest['fsWholeSync']).values())) + '\n'

callback_sections = filesystem_sections(manifest['fsCallbacks'])
callback_adapter = (root / 'fs-callback-adapter.js').read_text()
item = manifest['fsReadContext']; read_context = (root / item['path']).read_bytes()
if hashlib.sha256(read_context).hexdigest() != item['sha256']:
    raise ValueError('Read-file context source hash mismatch')
context_marker = '/* NODE_FS_READ_CONTEXT */'
if callback_adapter.count(context_marker) != 1:
    raise ValueError('Review read-file context marker')
callback_adapter = callback_adapter.replace(context_marker, read_context.decode('utf-8'))
marker = '/* NODE_FS_CALLBACKS */'
if callback_adapter.count(marker) != 1:
    raise ValueError('Review callback filesystem marker')
bundle += callback_adapter.replace(marker, '\n'.join(callback_sections.values())) + '\n'
directory_public = filesystem_sections(manifest['directoryPublic'])
directory_promises = filesystem_sections(manifest['directoryPromise'])
directory_options = filesystem_sections(manifest['directoryOptions'])
for name, item in manifest['directoryNativeReference']['sources'].items():
    if hashlib.sha256((root / item['path']).read_bytes()).hexdigest() != item['sha256']:
        raise ValueError('Directory native reference mismatch: ' + name)
old = '  ErrorCaptureStackTrace(error, handleErrorFromBinding);'
if directory_promises['error'].count(old) != 1:
    raise ValueError('Review directory promise stack recapture')
directory_promises['error'] = directory_promises['error'].replace(
    old, '  if (ErrorCaptureStackTrace !== undefined) ErrorCaptureStackTrace(error, handleErrorFromBinding);')
directory_adapter = (root / 'directory-platform-adapter.js').read_text()
for marker, replacement in [
    ('/* NODE_DIRECTORY_SHARED */', '\n'.join([directory_public.pop('makeCallback'),
        directory_public.pop('vfsVoid'), *directory_options.values(), directory_promises.pop('error')])),
    ('/* NODE_DIRECTORY_PUBLIC */', '\n'.join(directory_public.values())),
    ('/* NODE_DIRECTORY_PROMISES */', '\n'.join(directory_promises.values())),
]:
    if directory_adapter.count(marker) != 1:
        raise ValueError('Review directory source marker: ' + marker)
    directory_adapter = directory_adapter.replace(marker, replacement)
bundle += directory_adapter + '\n'
tempdir_public = filesystem_sections(manifest['tempdirPublic'])
tempdir_promises = filesystem_sections(manifest['tempdirPromise'])
tempdir_warning = filesystem_sections(manifest['tempdirWarnings'])
old = '  ErrorCaptureStackTrace(error, handleErrorFromBinding);'
if tempdir_promises['error'].count(old) != 1:
    raise ValueError('Review temporary-directory promise stack recapture')
tempdir_promises['error'] = tempdir_promises['error'].replace(
    old, '  if (ErrorCaptureStackTrace !== undefined) ErrorCaptureStackTrace(error, handleErrorFromBinding);')
tempdir_adapter = (root / 'tempdir-platform-adapter.js').read_text()
for marker, replacement in [
    ('/* NODE_TEMPDIR_SHARED */', '\n'.join([tempdir_public.pop('makeCallback'),
        tempdir_public.pop('vfsResult'), *tempdir_warning.values(), tempdir_promises.pop('error')])),
    ('/* NODE_TEMPDIR_PUBLIC */', '\n'.join(tempdir_public.values())),
    ('/* NODE_TEMPDIR_PROMISES */', '\n'.join(tempdir_promises.values())),
]:
    if tempdir_adapter.count(marker) != 1:
        raise ValueError('Review temporary-directory source marker: ' + marker)
    tempdir_adapter = tempdir_adapter.replace(marker, replacement)
bundle += tempdir_adapter + '\n'
metadata_spec = manifest['pathMetadata']
metadata_sources = {}
metadata_sections = {}
for name, item in metadata_spec['sources'].items():
    raw = (root / item['path']).read_bytes()
    if hashlib.sha256(raw).hexdigest() != item['sha256']:
        raise ValueError('Path metadata source identity mismatch: ' + name)
    metadata_sources[name] = raw.decode('utf-8')
for name, item in metadata_spec['selections'].items():
    text = metadata_sources[item['source']]
    if text.count(item['start']) != 1:
        raise ValueError('Ambiguous path metadata selection: ' + name)
    offset = text.index(item['start'])
    section = text[offset:offset + item['length']]
    if hashlib.sha256(section.encode()).hexdigest() != item['sha256']:
        raise ValueError('Path metadata section identity mismatch: ' + name)
    metadata_sections[name] = section
error_section = metadata_sections.pop('promises-handleErrorFromBinding')
old = '  ErrorCaptureStackTrace(error, handleErrorFromBinding);'
if error_section.count(old) != 1:
    raise ValueError('Review metadata promise stack capture')
error_section = error_section.replace(old, '  if (ErrorCaptureStackTrace !== undefined) ErrorCaptureStackTrace(error, handleErrorFromBinding);')
metadata_adapter = (root / 'path-metadata-adapter.js').read_text()
for marker, content in [
    ('/* NODE_METADATA_SHARED */', '\n'.join([metadata_sections.pop('public-makeCallback'), metadata_sections.pop('public-vfsVoid'), error_section])),
    ('/* NODE_METADATA_PUBLIC */', '\n'.join(value for key, value in metadata_sections.items() if key.startswith('public-'))),
    ('/* NODE_METADATA_PROMISES */', '\n'.join(value for key, value in metadata_sections.items() if key.startswith('promises-'))),
]:
    if metadata_adapter.count(marker) != 1:
        raise ValueError('Review path metadata marker: ' + marker)
    metadata_adapter = metadata_adapter.replace(marker, content)
bundle += (root / 'fs-system-errors-adapter.js').read_text() + '\n' + metadata_adapter + '\n'
readdir_spec = manifest['readdirPlatform']
for name, item in readdir_spec['sources'].items():
    if hashlib.sha256((root / item['path']).read_bytes()).hexdigest() != item['sha256']:
        raise ValueError('Readdir reference hash mismatch: ' + name)
readdir_sections = {}
for name, item in readdir_spec['sections'].items():
    text = (root / readdir_spec['sources'][item['source']]['path']).read_text()
    if text.count(item['start']) != 1:
        raise ValueError('Ambiguous readdir section: ' + name)
    start = text.index(item['start'])
    section = text[start:start + item['length']]
    if hashlib.sha256(section.encode()).hexdigest() != item['sha256']:
        raise ValueError('Readdir section hash mismatch: ' + name)
    readdir_sections[name] = section
old = '  ErrorCaptureStackTrace(error, handleErrorFromBinding);'
if readdir_sections['error'].count(old) != 1:
    raise ValueError('Review readdir promise stack recapture')
readdir_sections['error'] = readdir_sections['error'].replace(
    old, '  if (ErrorCaptureStackTrace !== undefined) ErrorCaptureStackTrace(error, handleErrorFromBinding);')
dirent_generator = runpy.run_path(str(root / 'generate-dirent-types.py'))
dirent_enum = dirent_generator['render'](root)
dirent_names = re.findall(r'^  (UV_DIRENT_[A-Z]+)', dirent_enum, re.M)
if len(dirent_names) != 8 or len(set(dirent_names)) != 8:
    raise ValueError('Review libuv directory-entry enum')
readdir_adapter = (root / 'readdir-platform-adapter.js').read_text()
for marker, replacement in [
    ('/* NODE_READDIR_UTILS */', readdir_sections['classes'] + readdir_sections['helpers']),
    ('/* NODE_READDIR_SHARED */', '\n'.join(readdir_sections[x] for x in ['makeCallback', 'vfsResult', 'error'])),
    ('/* NODE_READDIR_PUBLIC */', readdir_sections['public']),
    ('/* NODE_READDIR_PROMISE */', readdir_sections['promise']),
    ('/* NODE_DIRENT_ENUM_NAMES */', ', '.join(dirent_names)),
    ('/* NODE_DIRENT_ENUM_VALUES */', ', '.join(name + ': ' + str(index) for index, name in enumerate(dirent_names))),
]:
    if readdir_adapter.count(marker) != 1:
        raise ValueError('Review readdir embedding marker: ' + marker)
    readdir_adapter = readdir_adapter.replace(marker, replacement)
bundle += readdir_adapter + '\n'

dir_spec = manifest['dirPlatform']
for name, item in dir_spec['sources'].items():
    if hashlib.sha256((root / item['path']).read_bytes()).hexdigest() != item['sha256']:
        raise ValueError('Persistent Dir source identity mismatch: ' + name)
dir_module = (root / dir_spec['sources']['public']['path']).read_text()
dir_adapter = (root / 'dir-platform-adapter.js').read_text()
if dir_adapter.count('/* NODE_DIR_MODULE */') != 1:
    raise ValueError('Review persistent Dir module marker')
bundle += dir_adapter.replace('/* NODE_DIR_MODULE */', dir_module) + '\n'

removal_spec = manifest['removalPlatform']
for name, item in removal_spec['sources'].items():
    if hashlib.sha256((root / item['path']).read_bytes()).hexdigest() != item['sha256']:
        raise ValueError('Removal reference hash mismatch: ' + name)
def removal_section(name):
    item = removal_spec['sections'][name]
    text = (root / removal_spec['sources'][item['source']]['path']).read_text()
    if text.count(item['start']) != 1: raise ValueError('Removal section start: ' + name)
    start = text.index(item['start'])
    result = text[start:start + item['length']]
    if hashlib.sha256(result.encode()).hexdigest() != item['sha256']:
        raise ValueError('Removal section identity: ' + name)
    return result
removal_adapter = (root / 'removal-platform-adapter.js').read_text()
for marker, text in {
    '/* NODE_REMOVAL_RIMRAF */': (root / removal_spec['sources']['rimraf']['path']).read_text(),
    '/* NODE_REMOVAL_VALIDATION */': removal_section('defaultOptions') + removal_section('validateOptions'),
    '/* NODE_REMOVAL_PUBLIC */': removal_section('publicRm') + removal_section('publicRmSync'),
    '/* NODE_REMOVAL_PROMISE */': removal_section('promiseRm'),
}.items():
    if removal_adapter.count(marker) != 1: raise ValueError('Removal marker mismatch: ' + marker)
    removal_adapter = removal_adapter.replace(marker, text)
bundle += removal_adapter + '\n'
record_sections = filesystem_sections(manifest['moduleRecords'])
require_sections = filesystem_sections(manifest['moduleRequireHelper'])
pending_sections = filesystem_sections(manifest['modulePendingDeprecation'])
for name, item in manifest['moduleRecordNativeReference']['sources'].items():
    if hashlib.sha256((root / item['path']).read_bytes()).hexdigest() != item['sha256']:
        raise ValueError('Module record native reference mismatch: ' + name)
for name, item in manifest['childProcessReference']['sources'].items():
    if hashlib.sha256((root / item['path']).read_bytes()).hexdigest() != item['sha256']:
        raise ValueError('Child process native reference mismatch: ' + name)
# These target fields are native private symbols, not public JS Symbols.
# WeakMap owners preserve their unobservable storage in this embedding.
adaptations = {
    'constructor': [('this[kFirstModuleParent] = parent;', 'firstParents.set(this, parent);'),
                    ('this[kLastModuleParent] = parent;', 'lastParents.set(this, parent);')],
    'parentAccessors': [('return this[kFirstModuleParent];', 'return firstParents.get(this);'),
                        ('this[kFirstModuleParent] = value;', 'firstParents.set(this, value);')],
    'createRequire': [('m[kURL] = fileURL.href;', 'urls.set(m, fileURL.href);')],
    'load': [('this[kFormat]', 'formats.get(this)'),
             ('this[kModuleExport] = exports;', 'compiledExports.set(this, exports);')],
}
for section, replacements in adaptations.items():
    for old, new in replacements:
        expected = 2 if section == 'load' and old == 'this[kFormat]' else 1
        if record_sections[section].count(old) != expected:
            raise ValueError('Review private module field adaptation: ' + section)
        record_sections[section] = record_sections[section].replace(old, new)
old = 'cursor[kFirstModuleParent]'
if require_sections['requireStack'].count(old) != 1:
    raise ValueError('Review private require-stack field')
require_sections['requireStack'] = require_sections['requireStack'].replace(old, 'firstParents.get(cursor)')
package_spec = manifest['packages']
for name, item in package_spec['sources'].items():
    if hashlib.sha256((root / item['path']).read_bytes()).hexdigest() != item['sha256']:
        raise ValueError('Package reader source identity mismatch: ' + name)
package_sections = {}
for name, item in package_spec['sections'].items():
    text = (root / package_spec['sources'][item['source']]['path']).read_text()
    if text.count(item['start']) != 1:
        raise ValueError('Review package section: ' + name)
    offset = text.index(item['start']); value = text[offset:offset + item['length']]
    if hashlib.sha256(value.encode()).hexdigest() != item['sha256']:
        raise ValueError('Package section identity mismatch: ' + name)
    package_sections[name] = value
package_adapter = (root / 'package-reader-adapter.js').read_text()
if package_adapter.count('/* NODE_PACKAGE_READER */') != 1:
    raise ValueError('Review package reader embedding')
bundle += package_adapter.replace('/* NODE_PACKAGE_READER */',
    (root / package_spec['sources']['reader']['path']).read_text()).replace(
    '/* NODE_PACKAGE_CLEAN_VFS */', package_sections['cleanVfs']) + '\n'


policy = manifest['packagePolicy']
policy_sections = {}
for name, item in policy['sources'].items():
    if hashlib.sha256((root / item['path']).read_bytes()).hexdigest() != item['sha256']:
        raise ValueError('Package policy source mismatch: ' + name)
for name, item in policy['sections'].items():
    text = (root / policy['sources'][item['source']]['path']).read_text()
    start = text.index(item['start'])
    section = text[start:start + item['length']]
    if text.count(item['start']) != 1 or hashlib.sha256(section.encode()).hexdigest() != item['sha256']:
        raise ValueError('Package policy section mismatch: ' + name)
    policy_sections[name] = section
policy_adapter = (root / 'package-policy-adapter.js').read_text()
for marker, section in [('CJS_CONDITIONS','cjsConditions'),('ESM_CONDITIONS','esmConditions'),('LAZY','getLazy'),('CWD','cwd'),('LEGACY_EXTENSIONS','legacyExtensions')]:
    key = '/* NODE_PACKAGE_POLICY_' + marker + ' */'
    if policy_adapter.count(key) != 1: raise ValueError('Review policy marker: ' + key)
    policy_adapter = policy_adapter.replace(key, policy_sections[section])
policy_factories = []
for name, key in [('resolve','internal/modules/esm/resolve'),('format','internal/modules/esm/get_format'),('map','internal/modules/package_map')]:
    policy_factories.append(json.dumps(key) + ':function(module,exports,require,primordials,internalBinding,process) {\n' + (root / policy['sources'][name]['path']).read_text() + '\n}')
policy_adapter = policy_adapter.replace('/* NODE_PACKAGE_POLICY_MODULES */', ',\n'.join(policy_factories))
constants = (root / policy['sources']['nativeConstants']['path']).read_text()
import re
for name, marker in [('JAVASCRIPT','JS'),('WASM','WASM')]:
    match = re.search(r'^#define EXTENSIONLESS_FORMAT_' + name + r' \((\d+)\)$', constants, re.M)
    if match is None: raise ValueError('Review extensionless protocol tag: ' + name)
    policy_adapter = policy_adapter.replace('/* NODE_PACKAGE_POLICY_FORMAT_' + marker + ' */', match[1])
bundle += policy_adapter + '\n'
record_adapter = (root / 'module-record-platform-adapter.js').read_text()
for marker, section in [('SELF','self'),('RESOLVE','resolveFilename'),('FINALIZE','finalize'),('WATCH','watch')]:
    key = '/* NODE_MODULE_POLICY_' + marker + ' */'
    if record_adapter.count(key) != 1: raise ValueError('Review record policy marker: ' + key)
    record_adapter = record_adapter.replace(key, policy_sections[section])

for marker, replacement in [
    ('/* NODE_MODULE_RECORDS */', '\n'.join([*pending_sections.values(),
        *[record_sections[n] for n in ['updateChildren', 'constructor', 'preloading', 'parentAccessors', 'parentDescriptor']]])),
    ('/* NODE_MODULE_WRAPPERS */', record_sections['wrappers']),
    ('/* NODE_MODULE_REQUIRE */', '\n'.join([record_sections['require'], record_sections['createRequire'],
        require_sections['requireFactory'], require_sections['requireStack']])),
    ('/* NODE_MODULE_LOOKUP */', '\n'.join(record_sections[n] for n in ['nodePaths', 'lookupPaths', 'initPaths'])),
    ('/* NODE_MODULE_LOAD */', '\n'.join(record_sections[n] for n in ['longestExtension', 'extensionForFormat', 'load'])),
    ('/* NODE_MODULE_PACKAGES */', '\n'.join(package_sections[n] for n in ['readPackage', 'tryPackage', 'tryFiles'])),
    ('/* NODE_MODULE_JSON */', require_sections['stripBOM'] + record_sections['json']),
]:
    if record_adapter.count(marker) != 1:
        raise ValueError('Review module record marker: ' + marker)
    record_adapter = record_adapter.replace(marker, replacement)
bundle += record_adapter + '\n'

public_stream_sections = filesystem_sections(manifest['fsStreams'])
public_stream_adapter = (root / 'fs-streams-adapter.js').read_text()
for marker, replacement in [
    ('/* NODE_FS_STREAM_FACTORIES */', '\n'.join(value for name, value in public_stream_sections.items() if name != 'accessors')),
    ('/* NODE_FS_STREAM_ACCESSORS */', public_stream_sections['accessors']),
]:
    if public_stream_adapter.count(marker) != 1:
        raise ValueError('Review public filesystem stream marker')
    public_stream_adapter = public_stream_adapter.replace(marker, replacement)
bundle += public_stream_adapter + '\n'
stream_factories = []
for name, item in manifest['streamPlatform'].items():
    raw = (root / item['path']).read_bytes()
    if hashlib.sha256(raw).hexdigest() != item['sha256']:
        raise ValueError(f'Node stream source hash mismatch: {name}')

    source = raw.decode('utf-8')
    if name == 'internal/webstreams/adapters':
        source = (root / 'web-adapters-prelude.js').read_text() + '\n' + source + '\nmodule.exports = { newWritableStreamFromStreamWritable, newReadableStreamFromStreamReadable, newStreamWritableFromWritableStream, newStreamReadableFromReadableStream, newReadableWritablePairFromDuplex, newStreamDuplexFromReadableWritablePair, kValidateChunk, kDestroyOnSyncError };\n'
    stream_factories.append(json.dumps(name) + ': function(module, exports, require, primordials, internalBinding, process) {\n' + source + '\n}')
stream_platform = (root / 'stream-platform-adapter.js').read_text()
bundle += (root / 'compression-binding-adapter.js').read_text() + '\n'
marker = '/* NODE_STREAM_MODULES */'
if stream_platform.count(marker) != 1:
    raise ValueError('Missing or ambiguous Node stream platform marker')
bundle += stream_platform.replace(marker, ',\n'.join(stream_factories)) + '\n'
fd_item = manifest['fdStreams']
fd_raw = (root / fd_item['source']['path']).read_bytes()
if hashlib.sha256(fd_raw).hexdigest() != fd_item['source']['sha256']:
    raise ValueError('Stdio source identity mismatch')
fd_text = fd_raw.decode('utf-8')
selector = fd_item['dummyDestroy']
if fd_text.count(selector['start']) != 1:
    raise ValueError('Ambiguous stdio destroy source')
start = fd_text.index(selector['start'])
section = fd_text[start:start + selector['length']]
if hashlib.sha256(section.encode()).hexdigest() != selector['sha256']:
    raise ValueError('Stdio destroy selection mismatch')
fd_adapter = (root / 'fd-stream-platform-adapter.js').read_text()
marker = '/* NODE_STDIO_DUMMY_DESTROY */'
if fd_adapter.count(marker) != 1:
    raise ValueError('Review stdio destroy marker')
bundle += fd_adapter.replace(marker, section) + '\n'
port_factories = []
for name, item in manifest['portsPlatform'].items():
    raw = (root / item['path']).read_bytes()
    if hashlib.sha256(raw).hexdigest() != item['sha256']:
        raise ValueError('Port source identity mismatch: ' + name)
    if name in ['nativeReference', 'nativeErrors']:
        continue
    source = raw.decode('utf-8')
    if name == 'internal/worker/io':
        old = 'obj[transfer_mode_private_symbol] &= ~kCloneable;'
        if source.count(old) != 1:
            raise ValueError('Review private public clone mark')
        source = source.replace(old, 'internalBinding("messaging").markAsUncloneable(obj);')
    port_factories.append(json.dumps(name) + ': function(module, exports, require, primordials, internalBinding, process) {\n' + source + '\n}')
port_adapter = (root / 'ports-platform-adapter.js').read_text()
marker = '/* NODE_PORT_MODULES */'
if port_adapter.count(marker) != 1:
    raise ValueError('Review worker IO module marker')
native_errors = (root / manifest['portsPlatform']['nativeErrors']['path']).read_text()
port_error_messages = {}
for code in ['ERR_CONSTRUCT_CALL_INVALID', 'ERR_CONSTRUCT_CALL_REQUIRED']:
    prefix = 'V(' + code + ', "'
    if native_errors.count(prefix) != 1 or ('V(' + code + ', TypeError)') not in native_errors:
        raise ValueError('Review native constructor error: ' + code)
    port_error_messages[code] = native_errors.split(prefix, 1)[1].split('"', 1)[0]
port_adapter = port_adapter.replace('/* NODE_PORT_NATIVE_ERRORS */', json.dumps(port_error_messages))
bundle += port_adapter.replace(marker, ',\n'.join(port_factories)) + '\n'
testing_sources = {}
for name, item in manifest['testingPlatform']['sources'].items():
    raw = (root / item['path']).read_bytes()
    if hashlib.sha256(raw).hexdigest() != item['sha256']:
        raise ValueError('Testing source identity mismatch: ' + name)
    testing_sources[name] = raw.decode('utf-8')
testing_sections = {}
for name, selector in manifest['testingPlatform']['sections'].items():
    text = testing_sources[selector['source']]
    if text.count(selector['start']) != 1:
        raise ValueError('Ambiguous testing source selection: ' + name)
    start = text.index(selector['start'])
    section = text[start:start + selector['length']]
    if hashlib.sha256(section.encode()).hexdigest() != selector['sha256']:
        raise ValueError('Testing selection mismatch: ' + name)
    testing_sections[name] = section
testing_factories = []
for name, text in testing_sources.items():
    if name == 'test-owner-reference':
        name = 'internal/test_runner/test'
    elif name == 'harness-reference':
        name = 'internal/test_runner/harness'
    elif name.endswith('-reference'):
        continue
    testing_factories.append(json.dumps(name) + ': function(module, exports, require, primordials, internalBinding, process) {\n' + text + '\n}')
if 'V(GenericUserError, 1)' not in testing_sources['exit-codes-reference']:
    raise ValueError('Review test harness generic-error exit code')
import re
test_option_defaults = {}
for flag, field in manifest['testingPlatform']['optionDefaultFields'].items():
    header = testing_sources['options-reference']
    boolean = re.search(r'DEFINE_BOOL_FIELD\(' + re.escape(field) + r'\) = (true|false);', header)
    number = re.search(r'uint64_t ' + re.escape(field) + r' = (\d+);', header)
    string = re.search(r'std::string ' + re.escape(field) + r'(?: = "([^"]*)")?;', header)
    vector = re.search(r'std::vector<std::string> ' + re.escape(field) + r';', header)
    if boolean:
        value = boolean.group(1) == 'true'
    elif number:
        value = int(number.group(1))
    elif string:
        value = string.group(1) or ''
    elif vector:
        value = []
    else:
        raise ValueError('Review pinned test option default: ' + flag)
    test_option_defaults[flag] = value
testing_adapter = (root / 'testing-platform-adapter.js').read_text()
for marker, replacement in [('/* NODE_TESTING_MODULES */', ',\n'.join(testing_factories)),
                            ('/* NODE_TEST_DEPRECATE_PROPERTY */', testing_sections['deprecateProperty']),
                            ('/* NODE_TEST_OPTION_DEFAULTS */', json.dumps(list(test_option_defaults.items())))]:
    if testing_adapter.count(marker) != 1:
        raise ValueError('Review testing marker: ' + marker)
    testing_adapter = testing_adapter.replace(marker, replacement)
bundle += testing_adapter + '\n'
clock_item = manifest['processClock']
clock_raw = (root / clock_item['source']['path']).read_bytes()
if hashlib.sha256(clock_raw).hexdigest() != clock_item['source']['sha256']:
    raise ValueError('Process clock source identity mismatch')
clock_text = clock_raw.decode('utf-8')
selector = clock_item['algorithms']
if clock_text.count(selector['start']) != 1:
    raise ValueError('Ambiguous hrtime source')
start = clock_text.index(selector['start'])
clock_section = clock_text[start:start + selector['length']]
if hashlib.sha256(clock_section.encode()).hexdigest() != selector['sha256']:
    raise ValueError('Hrtime source selection mismatch')
clock_adapter = (root / 'process-clock-adapter.js').read_text()
if clock_adapter.count('/* NODE_HRTIME_ALGORITHMS */') != 1:
    raise ValueError('Review process clock marker')
bundle += clock_adapter.replace('/* NODE_HRTIME_ALGORITHMS */', clock_section) + '\n'
usage_spec = manifest['processUsage']
usage_item = usage_spec['source']
usage_raw = (root / usage_item['path']).read_bytes()
if hashlib.sha256(usage_raw).hexdigest() != usage_item['sha256']:
    raise ValueError('Process usage source identity mismatch')
usage_source = usage_raw.decode()
usage_adapter = (root / 'process-usage-adapter.js').read_text()
for key, marker in [('usage', '/* NODE_PROCESS_USAGE */'), ('resource', '/* NODE_PROCESS_RESOURCE */')]:
    selected = usage_spec['sections'][key]
    if usage_source.count(selected['start']) != 1 or usage_adapter.count(marker) != 1:
        raise ValueError('Process usage selection ambiguous: ' + key)
    offset = usage_source.index(selected['start'])
    text = usage_source[offset:offset + selected['length']]
    if hashlib.sha256(text.encode()).hexdigest() != selected['sha256']:
        raise ValueError('Process usage section identity mismatch: ' + key)
    usage_adapter = usage_adapter.replace(marker, text)
bundle += usage_adapter + '\n'

process_state = (root / 'process-state-adapter.js').read_text()
for name, item in manifest['processState']['sources'].items():
    raw = (root / item['path']).read_bytes()
    if hashlib.sha256(raw).hexdigest() != item['sha256']:
        raise ValueError('Process state source mismatch: ' + name)
    if name in manifest['processState']['algorithms']:
        selector = manifest['processState']['algorithms'][name]
        source = raw.decode('utf-8')
        if source.count(selector['start']) != 1:
            raise ValueError('Ambiguous process state algorithm: ' + name)
        start = source.index(selector['start'])
        section = source[start:start + selector['length']]
        if hashlib.sha256(section.encode()).hexdigest() != selector['sha256']:
            raise ValueError('Process state algorithm identity mismatch: ' + name)
        marker = '/* NODE_UMASK_' + name.upper() + ' */'
        if process_state.count(marker) != 1:
            raise ValueError('Review process state marker: ' + marker)
        process_state = process_state.replace(marker, section)
bundle += process_state + '\n'

lifetime_spec = manifest['processLifetime']
license_item = lifetime_spec['license']
license_raw = (root / license_item['path']).read_bytes()
if hashlib.sha256(license_raw).hexdigest() != license_item['sha256']:
    raise ValueError('Process finalization license identity mismatch')
bundle += '\n/*\n' + license_raw.decode('utf-8') + '\n*/\n'
lifetime_sources = {}
for name, item in lifetime_spec['sources'].items():
    raw = (root / item['path']).read_bytes()
    if hashlib.sha256(raw).hexdigest() != item['sha256']:
        raise ValueError('Process lifetime source identity mismatch: ' + name)
    lifetime_sources[name] = raw.decode('utf-8')
lifetime_adapter = (root / 'process-lifetime-adapter.js').read_text()
for name, item in lifetime_spec['selections'].items():
    source = lifetime_sources[item['source']]
    if source.count(item['start']) != 1:
        raise ValueError('Ambiguous process lifetime selection: ' + name)
    start = source.index(item['start'])
    section = source[start:start + item['length']]
    if hashlib.sha256(section.encode()).hexdigest() != item['sha256']:
        raise ValueError('Process lifetime selection identity mismatch: ' + name)
    marker = '/* NODE_PROCESS_LIFETIME_' + name.upper() + ' */'
    if lifetime_adapter.count(marker) != 1:
        raise ValueError('Review process lifetime marker: ' + name)
    lifetime_adapter = lifetime_adapter.replace(marker, section)
marker = '/* NODE_PROCESS_FINALIZATION */'
if lifetime_adapter.count(marker) != 1:
    raise ValueError('Review process finalization module marker')
bundle += lifetime_adapter.replace(marker, lifetime_sources['finalization']) + '\n'
for name, item in manifest['environmentObject']['sources'].items():
    if hashlib.sha256((root / item['path']).read_bytes()).hexdigest() != item['sha256']:
        raise ValueError('Environment source identity mismatch: ' + name)
syntax_spec = manifest['moduleSyntax']
for name, item in syntax_spec['sources'].items():
    if hashlib.sha256((root / item['path']).read_bytes()).hexdigest() != item['sha256']:
        raise ValueError('Module syntax source mismatch: ' + name)
selector = syntax_spec['formatSetup']
source = (root / syntax_spec['sources'][selector['source']]['path']).read_text()
if source.count(selector['start']) != 1:
    raise ValueError('Ambiguous CJS format source')
start = source.index(selector['start'])
section = source[start:start + selector['length']]
if hashlib.sha256(section.encode()).hexdigest() != selector['sha256']:
    raise ValueError('CJS format section mismatch')
syntax_adapter = (root / 'module-syntax-platform-adapter.js').read_text()
if syntax_adapter.count('/* NODE_CJS_FORMAT_SETUP */') != 1:
    raise ValueError('Review CJS format marker')
syntax_adapter = syntax_adapter.replace('/* NODE_CJS_FORMAT_SETUP */', section)
selector = syntax_spec['entrySelection']
source = (root / syntax_spec['sources'][selector['source']]['path']).read_text()
if source.count(selector['start']) != 1:
    raise ValueError('Ambiguous entry selection source')
start = source.index(selector['start'])
section = source[start:start + selector['length']]
if hashlib.sha256(section.encode()).hexdigest() != selector['sha256']:
    raise ValueError('Entry selection section mismatch')
if syntax_adapter.count('/* NODE_ENTRY_FORMAT_SELECTION */') != 1:
    raise ValueError('Review entry format marker')
bundle += syntax_adapter.replace('/* NODE_ENTRY_FORMAT_SELECTION */', section) + '\n'
keys_spec = manifest['keysPlatform']
for name, item in keys_spec['sources'].items():
    if hashlib.sha256((root / item['path']).read_bytes()).hexdigest() != item['sha256']:
        raise ValueError('Key source identity mismatch: ' + name)
key_source = (root / keys_spec['sources']['lib/internal/crypto/keys.js']['path']).read_text()
key_util_source = (root / keys_spec['sources'][keys_spec['bigInt']['source']]['path']).read_text()
selector = keys_spec['bigInt']
a = key_util_source.index(selector['start'])
key_bigint = key_util_source[a:a + selector['length']]
if hashlib.sha256(key_bigint.encode()).hexdigest() != selector['sha256']:
    raise ValueError('Key BigInt helper identity mismatch')
key_adapter = (root / 'keys-platform-adapter.js').read_text()
for marker, replacement in [
    ('/* NODE_KEY_BIGINT */', key_bigint),
    ('/* NODE_KEY_MODULES */', '"internal/crypto/keys": function(module, exports, require, primordials, internalBinding) {\n' + key_source + '\n}'),
]:
    if key_adapter.count(marker) != 1:
        raise ValueError('Review key marker: ' + marker)
    key_adapter = key_adapter.replace(marker, replacement)
bundle += key_adapter + '\n'
cipher_spec = manifest['cipherPlatform']
cipher_sources = {}
for name, item in cipher_spec['sources'].items():
    raw = (root / item['path']).read_bytes()
    if hashlib.sha256(raw).hexdigest() != item['sha256']:
        raise ValueError('Cipher source identity mismatch: ' + name)
    cipher_sources[name] = raw.decode('utf-8')
cipher_selected = {}
for name, item in cipher_spec['selections'].items():
    text = cipher_sources[item['source']]
    if text.count(item['start']) != 1:
        raise ValueError('Ambiguous cipher selection: ' + name)
    offset = text.index(item['start'])
    selected = text[offset:offset + item['length']]
    if hashlib.sha256(selected.encode()).hexdigest() != item['sha256']:
        raise ValueError('Cipher section identity mismatch: ' + name)
    cipher_selected[name] = selected
cipher_adapter = (root / 'cipher-platform-adapter.js').read_text()
for marker, replacement in [
    ('/* NODE_CIPHER_PUBLIC */', cipher_sources['lib/internal/crypto/cipher.js']),
    ('/* NODE_CIPHER_CREATORS */', cipher_selected['creators']),
    ('/* NODE_CIPHER_HELPERS */', cipher_selected['stringOption']),
]:
    if cipher_adapter.count(marker) != 1:
        raise ValueError('Review cipher embedding marker: ' + marker)
    cipher_adapter = cipher_adapter.replace(marker, replacement)
bundle += cipher_adapter + '\n'

kdf_spec = manifest['kdfPlatform']
kdf_factories = []
for name, item in kdf_spec['sources'].items():
    raw = (root / item['path']).read_bytes()
    if hashlib.sha256(raw).hexdigest() != item['sha256']:
        raise ValueError('KDF source identity mismatch: ' + name)
    if name == 'src/crypto/crypto_util.h' and raw.count(
            b'enum CryptoJobMode { kCryptoJobAsync, kCryptoJobSync, kCryptoJobWebCrypto };') != 1:
        raise ValueError('Review pinned KDF job-mode enum values')
    if name in ['lib/internal/crypto/pbkdf2.js', 'lib/internal/crypto/scrypt.js', 'lib/internal/crypto/argon2.js', 'lib/internal/crypto/hkdf.js']:
        module_name = name.removeprefix('lib/').removesuffix('.js')
        kdf_factories.append(json.dumps(module_name) + ': function(module, exports, require, primordials, internalBinding) {\n' + raw.decode('utf-8') + '\n}')
kdf_adapter = (root / 'kdf-platform-adapter.js').read_text()
kdf_helpers = []
for name, item in kdf_spec['byteHelpers'].items():
    source = (root / kdf_spec['sources'][item['source']]['path']).read_text()
    if source.count(item['start']) != 1:
        raise ValueError('Ambiguous KDF helper: ' + name)
    start = source.index(item['start'])
    section = source[start:start + item['length']]
    if hashlib.sha256(section.encode()).hexdigest() != item['sha256']:
        raise ValueError('KDF helper mismatch: ' + name)
    kdf_helpers.append(section)
if kdf_adapter.count('/* NODE_KDF_BYTE_HELPERS */') != 1:
    raise ValueError('Review KDF byte-helper marker')
kdf_adapter = kdf_adapter.replace('/* NODE_KDF_BYTE_HELPERS */', '\n'.join(kdf_helpers))
marker = '/* NODE_KDF_MODULES */'
if kdf_adapter.count(marker) != 1:
    raise ValueError('Review KDF module marker')
bundle += kdf_adapter.replace(marker, ',\n'.join(kdf_factories)) + '\n'
for name, item in manifest['dnsOwnerReferences'].items():
    raw = (root / item['path']).read_bytes()
    if hashlib.sha256(raw).hexdigest() != item['sha256']:
        raise ValueError('DNS owner reference identity mismatch: ' + name)
# DNS/observer algorithms retain exact full inputs and selected-section hashes.
def selected_platform_source(spec, name):
    item = spec['sources'][name]
    raw = (root / item['path']).read_bytes()
    if hashlib.sha256(raw).hexdigest() != item['sha256']:
        raise ValueError('Platform source identity mismatch: ' + name)
    return raw.decode('utf-8')

def selected_platform_section(spec, name):
    item = spec['selections'][name]
    text = selected_platform_source(spec, item['source'])
    if text.count(item['start']) != 1:
        raise ValueError('Ambiguous platform section: ' + name)
    start = text.index(item['start'])
    result = text[start:start + item['length']]
    if hashlib.sha256(result.encode()).hexdigest() != item['sha256']:
        raise ValueError('Platform section identity mismatch: ' + name)
    return result

util_algorithms = manifest['utilAlgorithms']
for name, item in util_algorithms['sources'].items():
    selected_platform_source(util_algorithms, name)
algorithm_factories = []
for name in util_algorithms['modules']:
    algorithm_factories.append(json.dumps(name) + ': function(module, exports, require, primordials, internalBinding, process) {\n' + selected_platform_source(util_algorithms, name) + '\n}')
myers_source = 'const { ArrayPrototypePush, Int32Array, StringPrototypeEndsWith } = primordials;\nconst { ERR_OUT_OF_RANGE } = require("internal/errors").codes;\n' + selected_platform_section(util_algorithms, 'myers') + '\nmodule.exports = { myersDiff };\n'
algorithm_factories.append('"internal/assert/myers_diff": function(module, exports, require, primordials) {\n' + myers_source + '\n}')
timeout_expression = selected_platform_section(util_algorithms, 'timeoutMax').split('=', 1)[1].strip().rstrip(';')
if timeout_expression != '2 ** 31 - 1': raise ValueError('Review util timeout maximum')
algorithm_adapter = (root / 'util-algorithms-adapter.js').read_text()
for marker, text in {
    '/* NODE_UTIL_ALGORITHM_MODULES */': ',\n'.join(algorithm_factories),
    '/* NODE_UTIL_TIMEOUT_MAX */': timeout_expression,
    '/* NODE_UTIL_ALGORITHM_PROPERTIES */': selected_platform_section(util_algorithms, 'controlsProperties'),
}.items():
    if algorithm_adapter.count(marker) != 1: raise ValueError('Util algorithm marker mismatch: ' + marker)
    algorithm_adapter = algorithm_adapter.replace(marker, text)
bundle += algorithm_adapter + '\n'

random_jobs = manifest['cryptoRandomJobs']
for name in random_jobs['sources']: selected_platform_source(random_jobs, name)
# Match Node's complete actual OpenSSL error-library prefixes, including RAND.
error_source = selected_platform_source(random_jobs, 'nativeUtil')
only_start = error_source.index('#define OSSL_ERROR_CODES_MAP_OPENSSL_ONLY(V) ', error_source.index('#else', error_source.index('#ifdef OPENSSL_IS_BORINGSSL')))
only_end = error_source.index('#endif', only_start)
map_start = error_source.index('#define OSSL_ERROR_CODES_MAP(V) ')
map_end = error_source.index('#define V(name) case ERR_LIB_', map_start)
error_libraries = re.findall(r'V\(([A-Z0-9_]+)\)', error_source[map_start:map_end]) + re.findall(r'V\(([A-Z0-9_]+)\)', error_source[only_start:only_end])
selected_error_libraries = re.findall(r'case ERR_LIB_([A-Z0-9_]+): lib = ', (root / 'digest-operations.h').read_text())
if error_libraries != selected_error_libraries: raise ValueError('Review OpenSSL error-library normalization')

random_job_adapter = (root / 'crypto-random-jobs-adapter.js').read_text()
random_header = selected_platform_source(random_jobs, 'nativeUtilHeader')
if 'kCryptoJobAsync' not in random_header: raise ValueError('Review crypto job mode')
# The exact enum is retained as a checked source, not invented from a provider ID.
import re
mode = re.search(r'enum CryptoJobMode \{ ([^}]+) \};', random_header)
if not mode or mode.group(1).split(', ') != ['kCryptoJobAsync', 'kCryptoJobSync', 'kCryptoJobWebCrypto']:
    raise ValueError('Review pinned crypto job enum')
random_job_adapter = random_job_adapter.replace('/* NODE_RANDOM_ASYNC_MODE */', str(mode.group(1).split(', ').index('kCryptoJobAsync')))
random_job_adapter = random_job_adapter.replace('/* NODE_RANDOM_JOB_FUNCTIONS */', '\n'.join(selected_platform_section(random_jobs, name) for name in random_jobs['selections']))
bundle += random_job_adapter + '\n'

perf_spec = manifest['performanceObserverPlatform']
performance = (root / 'performance-observer-adapter.js').read_text()
body = selected_platform_section(perf_spec, 'observerBody')
adaptation = perf_spec['supportedTypesAdaptation']
a = body.index(adaptation['start'])
old = body[a:a + adaptation['length']]
if hashlib.sha256(old.encode()).hexdigest() != adaptation['sha256'] or body.count(old) != 1:
    raise ValueError('Review actual producer capability adaptation')
body = body.replace(old, adaptation['replacement'])
header = selected_platform_source(perf_spec, 'src/node_perf_common.h')
entry_types = ['GC', 'HTTP', 'HTTP2', 'NET', 'DNS', 'QUIC']
entry_macro = header[header.index('#define NODE_PERFORMANCE_ENTRY_TYPES(V)'):header.index('enum PerformanceMilestone')]
import re
if re.findall(r'V\((\w+),', entry_macro) != entry_types:
    raise ValueError('Review performance entry protocol constants')
for marker, text in {
    '/* NODE_PERFORMANCE_TIMELINE_MODULES */': ',\n'.join(
        json.dumps(name.removeprefix('lib/').removesuffix('.js')) + ': function(module, exports, require, primordials, internalBinding) {\n' +
        selected_platform_source(perf_spec, name) + '\n}'
        for name in ['lib/internal/perf/usertiming.js', 'lib/internal/perf/resource_timing.js',
                     'lib/internal/perf/performance.js', 'lib/internal/perf/nodetiming.js', 'lib/internal/perf/timerify.js']),
    '/* NODE_PERFORMANCE_MILESTONE_CONSTANTS */': '\n'.join(
        'NODE_PERFORMANCE_MILESTONE_' + name + ': ' + str(i) + ','
        for i, name in enumerate(re.findall(r'V\((\w+),', header[header.index('#define NODE_PERFORMANCE_MILESTONES(V)'):header.index('#define NODE_PERFORMANCE_ENTRY_TYPES(V)')]))),
    '/* NODE_PERFORMANCE_REPLACEABLE_GLOBAL */': selected_platform_section(perf_spec, 'replaceableGlobal'),
    '/* NODE_PERFORMANCE_ENTRY */': selected_platform_source(perf_spec, 'lib/internal/perf/performance_entry.js'),
    '/* NODE_PERFORMANCE_ENTRY_TYPES */': '\n'.join('const NODE_PERFORMANCE_ENTRY_TYPE_' + name + ' = ' + str(i) + ';' for i, name in enumerate(entry_types)),
    '/* NODE_PERFORMANCE_OBSERVER_BODY */': body,
    '/* NODE_PERFORMANCE_OBSERVER_PRODUCER */': selected_platform_section(perf_spec, 'producer'),
}.items():
    if performance.count(marker) != 1: raise ValueError('Performance marker mismatch: ' + marker)
    performance = performance.replace(marker, text)
bundle += performance + '\n'
# Native record references constrain the portable decoder; they are not
# installed as a public Resolver before its actual channel/request bridge.
for name, item in manifest['dnsRecords']['sources'].items():
    if hashlib.sha256((root / item['path']).read_bytes()).hexdigest() != item['sha256']:
        raise ValueError('DNS record reference hash mismatch: ' + name)

dns_spec = manifest['dnsLookupPlatform']
dns_lookup = (root / 'dns-lookup-platform-adapter.js').read_text()
dns_modules = []
for source in dns_spec['sources']:
    name = source.removeprefix('lib/').removesuffix('.js')
    dns_modules.append(repr(name) + ': function(module, require, internalBinding, primordials, process) {\n' +
        selected_platform_source(dns_spec, source) + '\n}')
name_spec = dns_spec['assignFunctionName']
name_source = (root / name_spec['source']).read_text()
name_start = name_source.index(name_spec['start'])
name_function = name_source[name_start:name_start + name_spec['length']]
if hashlib.sha256(name_function.encode()).hexdigest() != name_spec['sha256']:
    raise ValueError('DNS assignFunctionName source mismatch')
for marker, text in {
    '/* NODE_DNS_MODULES */': ',\n'.join(dns_modules),
    '/* NODE_DNS_ASSIGN_FUNCTION_NAME */': name_function,
}.items():
    if dns_lookup.count(marker) != 1: raise ValueError('DNS module marker mismatch: ' + marker)
    dns_lookup = dns_lookup.replace(marker, text)
bundle += dns_lookup + '\n'
clone_factories = []
for name, item in manifest['clonePlatform'].items():
    raw = (root / item['path']).read_bytes()
    if hashlib.sha256(raw).hexdigest() != item['sha256']:
        raise ValueError(f'Node clone protocol source hash mismatch: {name}')

    source = raw.decode('utf-8')
    old = 'obj[transfer_mode_private_symbol] = mode;'
    if source.count(old) != 1:
        raise ValueError('Review engine private clone registration')
    source = source.replace(old, 'internalBinding("util").setCloneMode(obj, mode);')
    clone_factories.append(json.dumps(name) + ': function(module, exports, require, primordials, internalBinding) {\n' + source + '\n}')
clone_platform = (root / 'clone-platform-adapter.js').read_text()
marker = '/* NODE_CLONE_CONSTANTS */'
if clone_platform.count(marker) != 1:
    raise ValueError('Missing or ambiguous clone constants marker')
clone_platform = clone_platform.replace(marker, json.dumps({
    key: manifest['cloneProtocolConstants'][key]
    for key in ['kDisallowCloneAndTransfer', 'kTransferable', 'kCloneable']
}))
marker = '/* NODE_CLONE_MODULES */'
if clone_platform.count(marker) != 1:
    raise ValueError('Missing or ambiguous Node clone platform marker')
bundle += clone_platform.replace(marker, ',\n'.join(clone_factories)) + '\n'


# Native codec metadata uses unchanged constant expressions. Context algorithms
# remain separately pinned and checked by their embedding generator.
for key, item in manifest['compressionEmbeddingReferences'].items():
    raw = (root / item['path']).read_bytes()
    if hashlib.sha256(raw).hexdigest() != item['sha256']:
        raise ValueError('Node compression embedding reference hash mismatch: ' + key)
for key, item in manifest['compressionNative'].items():
    raw = (root / item['path']).read_bytes()
    if hashlib.sha256(raw).hexdigest() != item['sha256']:
        raise ValueError(f'Node compression {key} hash mismatch')
    patch = (root.parents[1] / 'packages/registry/spidermonkey/patches/0044-kandelo-node-codec-backend.patch').read_text()
    if ''.join('+' + line + '\n' for line in raw.decode('utf-8').splitlines()) not in patch:
        raise ValueError(f'Node compression {key} differs from its pinned native source')
codec_generator['generate'](root)
for key in ['builtinPolicy', 'getBuiltinModule', 'nativeCli']:
    item = manifest[key]
    raw = (root / item['path']).read_bytes()
    if hashlib.sha256(raw).hexdigest() != item['sha256']:
        raise ValueError(f'Node {key} source hash mismatch')
    if key == 'nativeCli':
        patch = (root.parents[1] / 'packages/registry/spidermonkey/patches/0043-kandelo-node-stream-iter.patch').read_text()
        if ''.join('+' + line + '\n' for line in raw.decode('utf-8').splitlines()) not in patch:
            raise ValueError('Node environment tokenizer differs from the pinned native input')
policy_platform = (root / 'builtin-policy-adapter.js').read_text()
for marker, key in [('/* NODE_BUILTIN_POLICY */', 'builtinPolicy'), ('/* NODE_GET_BUILTIN_MODULE */', 'getBuiltinModule')]:
    if policy_platform.count(marker) != 1:
        raise ValueError('Missing or ambiguous public builtin policy marker')
    policy_platform = policy_platform.replace(marker, (root / manifest[key]['path']).read_text())
bundle += policy_platform + '\n'




source_map_spec = manifest['sourceMapPlatform']
for item in source_map_spec['sources'].values():
    if hashlib.sha256((root / item['path']).read_bytes()).hexdigest() != item['sha256']:
        raise ValueError('SourceMap source identity mismatch: ' + item['path'])
source_map_adapter = (root / 'source-map-platform-adapter.js').read_text()
marker = '/* NODE_PUBLIC_SOURCE_MAP */'
if source_map_adapter.count(marker) != 1:
    raise ValueError('Review public SourceMap marker')
bundle += source_map_adapter.replace(marker, (root / source_map_spec['sources']['lib/internal/source_map/source_map.js']['path']).read_text()) + '\n'
http_parser_spec = manifest['httpParser']
for name, item in http_parser_spec['sources'].items():
    if hashlib.sha256((root / item['path']).read_bytes()).hexdigest() != item['sha256']:
        raise ValueError('HTTP parser source identity mismatch: ' + name)
selector = http_parser_spec['clientOptions']
source = (root / http_parser_spec['sources'][selector['source']]['path']).read_text()
if source.count(selector['start']) != 1:
    raise ValueError('Ambiguous HTTP client option selection')
start = source.index(selector['start'])
section = source[start:start + selector['length']]
if hashlib.sha256(section.encode()).hexdigest() != selector['sha256']:
    raise ValueError('HTTP client option selection identity mismatch')
if (root.parents[1] / 'packages/registry/node-compat/bootstrap.js').read_text().count(section) != 1:
    raise ValueError('HTTP client options differ from the pinned source')
http_parser_adapter = (root / 'http-parser-platform-adapter.js').read_text()
for name, item in http_parser_spec['selections'].items():
    source = (root / http_parser_spec['sources'][item['source']]['path']).read_text()
    if source.count(item['start']) != 1:
        raise ValueError('Ambiguous HTTP parser selection: ' + name)
    start = source.index(item['start'])
    section = source[start:start + item['length']]
    if hashlib.sha256(section.encode()).hexdigest() != item['sha256']:
        raise ValueError('HTTP parser selection identity mismatch: ' + name)
    marker = '/* NODE_HTTP_' + ('PARSER_CALLBACKS' if name == 'callbacks' else 'PREPARE_ERROR') + ' */'
    if http_parser_adapter.count(marker) != 1:
        raise ValueError('Review HTTP parser marker: ' + name)
    http_parser_adapter = http_parser_adapter.replace(marker, section)
bundle += http_parser_adapter + '\n'
marks_spec = manifest['objectMarks']
for name, item in marks_spec['sources'].items():
    if hashlib.sha256((root / item['path']).read_bytes()).hexdigest() != item['sha256']:
        raise ValueError('Object mark source identity mismatch: ' + name)
item = marks_spec['selections']['transferMarks']
source = (root / marks_spec['sources'][item['source']]['path']).read_text()
if source.count(item['start']) != 1:
    raise ValueError('Ambiguous object mark selection')
start = source.index(item['start'])
section = source[start:start + item['length']]
if hashlib.sha256(section.encode()).hexdigest() != item['sha256']:
    raise ValueError('Object mark selection identity mismatch')
for old, new in [
    ('obj[untransferable_object_private_symbol] = true;', 'platform.native.objectMark("transfer", obj);'),
    ('obj[untransferable_object_private_symbol] !== undefined', 'platform.native.objectMark("markedTransfer", obj)'),
]:
    if section.count(old) != 1:
        raise ValueError('Review private object mark access: ' + old)
    section = section.replace(old, new)
marks_adapter = (root / 'object-marks-platform-adapter.js').read_text()
marker = '/* NODE_OBJECT_TRANSFER_MARKS */'
if marks_adapter.count(marker) != 1:
    raise ValueError('Review public object mark marker')
bundle += marks_adapter.replace(marker, section) + '\n'
url_paths = manifest['urlPaths']
for name in url_paths['sources']:
    selected_platform_source(url_paths, name)
url_path_adapter = (root / 'url-path-platform-adapter.js').read_text()
encoding_source = selected_platform_section(url_paths, 'encodeReference')
encoded_chars = re.findall(r"ENCODE_CHAR\(('(?:\\.|[^'])+'), '([0-9A-F])', '([0-9A-F])'\)", encoding_source)
encodings = {ord(ast.literal_eval(char)): '%' + high + low for char, high, low in encoded_chars}
if len(encodings) != 15 or encodings.get(0) != '%00' or encodings.get(92) != '%5C':
    raise ValueError('Review Node native path encoding table')
for marker, value in {
    '/* NODE_PATH_ENCODING_TABLE */': json.dumps(encodings)[1:-1],
    '/* NODE_URL_PERCENT_DECODE */': selected_platform_section(url_paths, 'percentDecode'),
    '/* NODE_URL_LIKE_PREDICATE */': selected_platform_section(url_paths, 'isURL'),
    '/* NODE_URL_HTTP_OPTIONS */': selected_platform_section(url_paths, 'httpOptions'),
    '/* NODE_URL_PATH_CONVERSIONS */': selected_platform_section(url_paths, 'conversions'),
}.items():
    if url_path_adapter.count(marker) != 1:
        raise ValueError('Review URL path marker: ' + marker)
    url_path_adapter = url_path_adapter.replace(marker, value)
bundle += url_path_adapter + '\n'
bundle += (root / 'worker-platform-adapter.js').read_text() + '\n'
bundle += (root / 'adapter.js').read_text().replace('/* UPSTREAM_MODULES */', ',\n'.join(entries))
dest = root / 'node-core.js'
if '--check' in sys.argv:
    if dest.read_text() != bundle:
        raise SystemExit('Node core bundle needs regeneration')
else:
    dest.write_text(bundle)
