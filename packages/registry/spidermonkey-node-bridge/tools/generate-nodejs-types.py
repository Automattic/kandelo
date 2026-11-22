#!/usr/bin/env python3
"""Generate only native predicate export metadata from complete pinned source."""
import argparse
import hashlib
import json
from pathlib import Path
import re

def generate(manifest,output):
    doc=json.loads(manifest.read_text())
    row=next(x for x in doc['files'] if x['path']=='src/node_types.cc')
    data=(manifest.parent/'upstream'/row['path']).read_bytes()
    if len(data)!=row['bytes'] or hashlib.sha256(data).hexdigest()!=row['sha256']:
        raise ValueError('native types identity mismatch')
    source=data.decode()
    block=re.search(r'#define VALUE_METHOD_MAP\(V\)(.*?)\n\n',source,re.S)
    entries=re.findall(r'V\(([A-Za-z0-9_]+)\)',block[1])
    if len(entries)!=24 or len(set(entries))!=24 or re.sub(r'V\([A-Za-z0-9_]+\)|[\\\s]','',block[1]):
        raise ValueError('unreviewed native predicate declaration grammar')
    compounds=re.findall(r'SetFastMethodNoSideEffect\(context,\s*target,\s*"is([A-Za-z0-9_]+)"',source)
    if compounds!=['AnyArrayBuffer','BoxedPrimitive']:
        raise ValueError('unreviewed native compound predicate inventory')
    entries+=compounds
    if output.resolve().is_relative_to(manifest.parent.resolve()):
        raise ValueError('output must be outside immutable import')
    lines=['// Native export declarations only; engine predicates live in the embedding.',
           '#ifndef KANDELO_NODE_TYPE_DECLARATIONS_H','#define KANDELO_NODE_TYPE_DECLARATIONS_H',
           '#define KANDELO_NODE_TYPE_METHODS(V) \\']
    lines += [f'  V({name}, "is{name}")'+(' \\' if i<len(entries)-1 else '') for i,name in enumerate(entries)]
    lines+=['#endif',''];output.parent.mkdir(parents=True,exist_ok=True);output.write_text('\n'.join(lines))
    return {'nativeSourceSha256':row['sha256'],'methods':len(entries),'javascriptGenerated':False,'runtimeClassificationsGenerated':False}
if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--manifest',required=True,type=Path);p.add_argument('--output',required=True,type=Path);a=p.parse_args();print(json.dumps(generate(a.manifest,a.output)))
