"""Stage the reviewed native parser owner without eager shared-library linkage."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil

p = argparse.ArgumentParser()
p.add_argument('--source', type=Path, required=True)
p.add_argument('--provider', type=Path, required=True)
p.add_argument('--adapter', type=Path, required=True)
p.add_argument('--output', type=Path, required=True)
args = p.parse_args()
args.output.mkdir(exist_ok=False, parents=True)
provider = args.provider.resolve()
imports = json.loads((provider / 'share/kandelo/undici-llhttp/native-imports.json').read_text())
source = json.loads((provider / 'share/kandelo/undici-llhttp/SOURCE.json').read_text())
if imports['schema'] != 1 or source['nodeVersion'] != '26.13.0' or source['llhttpVersion'] != '9.3.1':
    raise ValueError('Incompatible Undici native parser build contract')
symbols = imports['mainExecutableExports']
if not all(isinstance(name, str) and re.fullmatch(r'[A-Za-z0-9_.$]+', name) for name in symbols):
    raise ValueError('Invalid native parser dependency symbol')
(args.output / 'link-flags.txt').write_text(''.join('-Wl,--export=' + name + '\n' for name in symbols))
shutil.copy2(args.adapter, args.source / 'src/node_undici_llhttp.cc')
shutil.copy2(provider / 'include/kandelo_undici_llhttp.h', args.source / 'src/kandelo_undici_llhttp.h')

def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

receipt = {
    'scope': 'Native version of Undici Wasm helper; build inputs, no acceptance',
    'provider': str(provider), 'source': source,
    'librarySha256': digest(provider / 'lib/libnode-undici-llhttp.so'),
    'adapterSha256': digest(args.adapter),
    'headerSha256': digest(provider / 'include/kandelo_undici_llhttp.h'),
    'mainExecutableExports': symbols,
    'programExtensionImports': imports['programExtensionImports'],
    'eagerSharedLibraryLinkage': False,
    'migrationBack': 'Restore original Undici Wasm factory after equivalent guest Wasm qualification',
}
(args.output / 'PROVIDER.json').write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps(receipt))
