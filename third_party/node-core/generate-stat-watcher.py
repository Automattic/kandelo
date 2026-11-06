#!/usr/bin/env python3
"""Select unchanged Node26 stat-watcher algorithms from the complete pin."""
from pathlib import Path
import argparse, hashlib, json
root=Path(__file__).resolve().parent

def assemble():
    manifest=json.loads((root/'stat-watcher-sources.json').read_text())
    target=json.loads((root.parents[1]/'packages/registry/node-compat/target.json').read_text())
    if manifest['version']!=target['version'] or manifest['commit']!=target['source']['commit']:
        raise ValueError('Stat watcher pin differs from the audited target')
    sources={}
    for name,item in manifest['sources'].items():
        raw=(root/item['path']).read_bytes()
        if hashlib.sha256(raw).hexdigest()!=item['sha256']:
            raise ValueError('Stat watcher source identity: '+name)
        sources[name]=raw.decode('utf8')
    sections={}
    for name,item in manifest['selections'].items():
        source=sources[item['source']]
        if source.count(item['start'])!=1: raise ValueError('Stat watcher selection: '+name)
        a=source.index(item['start']);b=source.index(item['end'],a);sections[name]=source[a:b]
        if hashlib.sha256(sections[name].encode()).hexdigest()!=item['sha256']:
            raise ValueError('Stat watcher selected source identity: '+name)
    if (sections['nativeStatConversion'].rstrip('\n')+'\n')!=sources['deps/uv/src/to-stat.inc']:
        raise ValueError('Native stat conversion differs from unchanged source')
    text=(root/'stat-watcher-platform-adapter.js').read_text()
    for marker,name in [('NODE_STAT_WATCHER_SYMBOLS','symbols'),('NODE_STAT_WATCHER_PUBLIC','statWatcher'),('NODE_FS_WATCH_FILE','watchFile')]:
        token='/* '+marker+' */'
        if text.count(token)!=1: raise ValueError('Stat watcher adapter marker: '+marker)
        text=text.replace(token,sections[name])
    return text

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--output',type=Path);args=parser.parse_args()
    text=assemble()
    if args.output:
        args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(text)
    else: print(text,end='')
