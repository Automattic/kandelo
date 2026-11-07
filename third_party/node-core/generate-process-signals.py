#!/usr/bin/env python3
"""Verify the pin and select unchanged process signal JS/conditional constants."""
from pathlib import Path
import argparse,hashlib,json,re
root=Path(__file__).resolve().parent

def sources():
    m=json.loads((root/'process-signals-sources.json').read_text())
    target=json.loads((root.parents[1]/'packages/registry/node-compat/target.json').read_text())
    if m['version']!=target['version'] or m['commit']!=target['source']['commit']:
        raise ValueError('Process signal target differs from audited pin')
    out={}
    for name,item in m['sources'].items():
        data=(root/item['path']).read_bytes()
        if hashlib.sha256(data).hexdigest()!=item['sha256']:raise ValueError('Signal source identity: '+name)
        out[name]=data.decode()
    return m,out

def assemble():
    _,s=sources();text=(root/'process-signals-platform-adapter.js').read_text()
    marker='/* NODE_PROCESS_SIGNALS */'
    if text.count(marker)!=1:raise ValueError('Signal source insertion marker')
    return text.replace(marker,s['lib/internal/process/signal.js'])

def constants():
    m,s=sources();text=s['src/node_constants.cc'];start='void DefineSignalConstants(Local<Object> target) {'
    a=text.index(start)+len(start);b=text.index('\n}\n',a);body=text[a:b]
    if hashlib.sha256(body.encode()).hexdigest()!=m['signalConstantsBodySha256']:raise ValueError('Signal constant body identity')
    body=re.sub(r'NODE_DEFINE_CONSTANT\(target, (\w+)\);',r'if (!define("\1", \1)) return false;',body)
    return '// Generated conditional names from the pinned node_constants.cc.\n#ifndef KANDELO_NODE_SIGNAL_CONSTANTS_H_\n#define KANDELO_NODE_SIGNAL_CONSTANTS_H_\n#include <signal.h>\nnamespace kandelo::signals {\ntemplate<class Define> bool DefineConstants(Define define) {'+body+'\n  return true;\n}\n}\n#endif\n'

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--shell-dir',type=Path);args=p.parse_args()
    js=assemble();header=constants()
    if args.shell_dir:
        args.shell_dir.mkdir(parents=True,exist_ok=True)
        (args.shell_dir/'kandelo-node-signal-constants.h').write_text(header)
        owner=(root/'signal-owner.h').read_text()
        (args.shell_dir/'kandelo-node-signal-owner.h').write_text(owner)
    else: print(js,end='')
