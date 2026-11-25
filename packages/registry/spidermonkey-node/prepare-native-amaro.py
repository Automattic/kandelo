"""Install the declared native Amaro consumer without eager library linkage."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil

p = argparse.ArgumentParser()
p.add_argument('--source', type=Path, required=True)
p.add_argument('--provider', type=Path, required=True)
p.add_argument('--adapter', type=Path, required=True)
p.add_argument('--output', type=Path, required=True)
args = p.parse_args()
args.output.mkdir(exist_ok=False, parents=True)
provider = args.provider.resolve()
imports = json.loads((provider / 'share/kandelo/amaro/native-imports.json').read_text())
if imports['schema'] != 1:
    raise ValueError('Unknown native Amaro import contract')
import re
symbols = imports['mainExecutableExports']
if not all(isinstance(name, str) and re.fullmatch(r'[A-Za-z0-9_.$]+', name) for name in symbols):
    raise ValueError('Invalid native Amaro symbol')
# Keep actual C runtime definitions available to the ordinary guest dlopen.
# The side module itself never enters Node's DT_NEEDED/startup dependency graph.
(args.output / 'link-flags.txt').write_text(''.join('-Wl,--export=' + name + '\n' for name in symbols))
shutil.copy2(args.adapter, args.source / 'src/node_amaro.cc')
for name in ['kandelo_amaro.h', 'kandelo_amaro_values.h']:
    shutil.copy2(provider / 'include' / name, args.source / 'src' / name)
shutil.copy2(provider / 'share/kandelo/amaro/index.js', args.source / 'deps/amaro/dist/index.js')
def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()
receipt = {
    'scope': 'native Amaro consumer build inputs; no runtime acceptance',
    'provider': str(provider),
    'librarySha256': digest(provider / 'lib/libnode-amaro.so'),
    'wrapperBundleSha256': digest(provider / 'share/kandelo/amaro/index.js'),
    'adapterSha256': digest(args.adapter),
    'mainExecutableExports': symbols,
    'programExtensionImports': imports['programExtensionImports'],
    'eagerSharedLibraryLinkage': False,
}
(args.output / 'PROVIDER.json').write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps(receipt))
