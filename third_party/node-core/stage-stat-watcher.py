#!/usr/bin/env python3
"""Stage the real native stat-poll owner with explicit include-only aliases."""
from pathlib import Path
import argparse,hashlib,json,runpy
root=Path(__file__).resolve().parent

def stage(shell):
    # The same source/pin checks used by public bundling guard all references.
    runpy.run_path(str(root/'generate-stat-watcher.py'))['assemble']()
    output={}
    def put(name,text):
        path=shell/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_text(text)
        output[name]=hashlib.sha256(path.read_bytes()).hexdigest()
    put('kandelo-node-stat-poll.h',(root/'stat-poll.h').read_text())
    text=(root/'stat-poll.cc').read_text()
    aliases={'stat-poll.h':'shell/kandelo-node-stat-poll.h','native-retained-memory.h':'shell/native-retained-memory.h',
        'upstream/stat-poll/deps/uv/src/fs-poll.c':'shell/stat-poll-reference/fs-poll.c',
        'upstream/stat-poll/deps/uv/src/to-stat.inc':'shell/stat-poll-reference/to-stat.h'}
    for old,new in aliases.items():
        token='#include "'+old+'"'
        if text.count(token)!=1:raise ValueError('Stat-poll owning include boundary: '+old)
        text=text.replace(token,'#include "'+new+'"')
    put('kandelo-node-stat-poll.cc',text)
    source=(root/'upstream/stat-poll/deps/uv/src/fs-poll.c').read_text()
    for old in ['uv.h','uv-common.h','unix/internal.h','win/internal.h','win/handle-inl.h']:
        token='#include "'+old+'"'
        if token not in source:raise ValueError('Stat-poll upstream include boundary: '+old)
        source=source.replace(token,'#include "shell/stat-poll-port/'+old+'"')
    put('stat-poll-reference/fs-poll.c',source)
    put('stat-poll-reference/to-stat.h','#ifndef KANDELO_STAT_POLL_TO_STAT_H\n#define KANDELO_STAT_POLL_TO_STAT_H\n'+
        (root/'upstream/stat-poll/deps/uv/src/to-stat.inc').read_text()+'\n#endif\n')
    for path in sorted((root/'stat-poll-port').rglob('*.h')):
        put('stat-poll-port/'+str(path.relative_to(root/'stat-poll-port')),path.read_text())
    put('kandelo-node-stat-watcher-staging.json',json.dumps({'sourcePin':'Node26.13.0','transformations':'Include-path aliases and selected static-function header guard only; algorithm bodies unchanged. Private handle storage is not libuv ABI.','files':output},indent=2)+'\n')
    return output

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--shell-dir',required=True,type=Path);args=parser.parse_args();stage(args.shell_dir)
