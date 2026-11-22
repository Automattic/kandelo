#!/usr/bin/env python3
"""Stage the complete original continuation source and declaration adapters."""
import argparse
import hashlib
import json
from pathlib import Path

def prepare(manifest,output):
    if output.resolve().is_relative_to(manifest.parent.resolve()):
        raise ValueError('output must be outside immutable import')
    records={row['path']:row for row in json.loads(manifest.read_bytes())['files']}
    output.mkdir(parents=True,exist_ok=True)
    for name in ['src/async_context_frame.cc','src/async_context_frame.h']:
        data=(manifest.parent/'upstream'/name).read_bytes();row=records[name]
        if len(data)!=row['bytes'] or hashlib.sha256(data).hexdigest()!=row['sha256']:
            raise ValueError('original continuation source identity mismatch: '+name)
        (output/Path(name).name).write_bytes(data)
    for name in ['base_object.h','env-inl.h','node_errors.h','node_external_reference.h','tracing/traced_value.h','util-inl.h','debug_utils-inl.h','v8.h']:
        destination=output/name;destination.parent.mkdir(parents=True,exist_ok=True)
        destination.write_text('#include "shell/node-upstream/continuation-native-api.h"\n')
    return {'completeOriginalFiles':2,'nativeFunctionBodiesExtracted':False,'javascriptGenerated':False}

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest',required=True,type=Path)
    parser.add_argument('--output',required=True,type=Path)
    args=parser.parse_args();print(json.dumps(prepare(args.manifest,args.output)))
