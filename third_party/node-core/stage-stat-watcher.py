#!/usr/bin/env python3
"""Stage the real native stat-poll owner with explicit include-only aliases."""
from pathlib import Path
import argparse,hashlib,json,runpy,shutil
root=Path(__file__).resolve().parent

def stage(shell):
    # The same source/pin checks used by public bundling guard all references.
    runpy.run_path(str(root/'generate-stat-watcher.py'))['assemble']()
    output={}
    for old in ['stat-poll-reference']:
        shutil.rmtree(shell/old, ignore_errors=True)
    def put(name,text):
        path=shell/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_text(text)
        output[name]=hashlib.sha256(path.read_bytes()).hexdigest()
    put('kandelo-node-stat-poll.h',(root/'stat-poll.h').read_text())
    text=(root/'stat-poll.cc').read_text()
    aliases={'stat-poll.h':'shell/kandelo-node-stat-poll.h','native-retained-memory.h':'shell/native-retained-memory.h',
        'upstream/stat-poll/deps/uv/src/fs-poll.c':'kandelo-node/stat-poll/fs-poll.c',
        'upstream/stat-poll/deps/uv/src/to-stat.inc':'kandelo-node/stat-poll/to-stat.inc'}
    for old,new in aliases.items():
        token='#include "'+old+'"'
        if text.count(token)!=1:raise ValueError('Stat-poll owning include boundary: '+old)
        text=text.replace(token,('#include <'+new+'>') if old.startswith('upstream/') else '#include "'+new+'"')
    put('kandelo-node-stat-poll.cc',text)
    vendor = shell.parents[2] / 'third_party/kandelo-node/stat-poll'
    vendor.mkdir(parents=True, exist_ok=True)
    for name in ['fs-poll.c', 'to-stat.inc']:
        data = (root/'upstream/stat-poll/deps/uv/src'/name).read_bytes()
        (vendor/name).write_bytes(data)
        output[str((vendor/name).relative_to(shell.parents[2]))] = hashlib.sha256(data).hexdigest()
    port = shell / 'stat-poll-port'
    if port.exists():
        shutil.rmtree(port)
    for path in sorted((root/'stat-poll-port').rglob('*.h')):
        destination = port/path.relative_to(root/'stat-poll-port')
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(path.read_bytes())
        output[str(destination.relative_to(shell.parents[2]))] = hashlib.sha256(destination.read_bytes()).hexdigest()
    put('kandelo-node-stat-watcher-staging.json',json.dumps({'sourcePin':'Node26.13.0','transformations':'Owner include aliases and third-party placement only; imported reference bytes unchanged. Private handle storage is not libuv ABI.','identityPhase':'Before final engine include canonicalization; final owner identities are in kandelo-node-native-sources.json', 'files':output},indent=2)+'\n')
    return output

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--shell-dir',required=True,type=Path);args=parser.parse_args();stage(args.shell_dir)
