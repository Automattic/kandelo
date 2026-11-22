#!/usr/bin/env python3
"""Stage complete pinned native options sources and declaration-only shims."""
import argparse,hashlib,json,re
from pathlib import Path

def prepare(manifest,output):
    doc=json.loads(manifest.read_text());files={x['path']:x for x in doc['files']}
    if output.resolve().is_relative_to(manifest.parent.resolve()):raise ValueError('output must be outside immutable import')
    def verified(name):
        row=files[name];data=(manifest.parent/'upstream'/name).read_bytes()
        if len(data)!=row['bytes'] or hashlib.sha256(data).hexdigest()!=row['sha256']:raise ValueError('native source identity mismatch: '+name)
        return data
    names=['src/node_options.cc','src/node_options.h','src/node_options-inl.h','src/node_mutex.h','src/node_constants.h','src/quic/guard.h','deps/ncrypto/ncrypto.h']
    for name in names:
        relative=name[4:] if name.startswith('src/') else 'ncrypto.h';p=output/relative;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(verified(name))
    enum=re.search(rb'enum OptionEnvvarSettings \{.*?\n\};',verified('src/node.h'),re.S)
    if not enum:raise ValueError('native environment setting enum missing')
    if re.findall(rb'(k\w+)\s*=\s*(\d+)',enum[0])!=[(b'kAllowedInEnvvar',b'0'),(b'kDisallowedInEnvvar',b'1')]:raise ValueError('unreviewed native environment setting enum')
    include=b'#include "shell/node-upstream/options-native-api.h"\n'
    for name in ['env-inl.h','node_binding.h','node_errors.h','node_external_reference.h','node_internals.h','node_sea.h','util.h','v8.h']:(output/name).write_bytes(include)
    (output/'node.h').write_bytes(include+b'namespace node {\n'+enum[0]+b'\n}\n')
    return {'completeNativeFiles':len(names),'enumMetadataOnly':True,'javascriptGenerated':False,'functionBodiesExtracted':False}
if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--manifest',required=True,type=Path);p.add_argument('--output',required=True,type=Path);a=p.parse_args();print(json.dumps(prepare(a.manifest,a.output)))
