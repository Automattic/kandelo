#!/usr/bin/env python3
"""Embed exact pinned response ownership sections, never a substitute server."""
from pathlib import Path
import hashlib,json

def generate(root):
    spec=json.loads((root/'http-server-response-sources.json').read_text())
    core=json.loads((root/'sources.json').read_text())
    if spec!=core['httpServerResponse'] or (spec['version'],spec['commit'])!=(core['version'],core['commit']):
        raise ValueError('ServerResponse must retain the audited exact Node source pin')
    sources={}
    for n,x in spec['sources'].items():
        data=(root/x['path']).read_bytes()
        if hashlib.sha256(data).hexdigest()!=x['sha256']:raise ValueError('HTTP server source mismatch: '+n)
        sources[n]=data.decode()
    sections={}
    for n,x in spec['sections'].items():
        text=sources[x['source']]
        if text.count(x['start'])!=1:raise ValueError('Ambiguous HTTP server selection: '+n)
        at=text.index(x['start']);section=text[at:at+x['length']]
        if hashlib.sha256(section.encode()).hexdigest()!=x['sha256']:raise ValueError('HTTP server selection mismatch: '+n)
        sections[n]=section
    predicates=[]
    for n in ['headerCharacters','chunkExpression']:
        x=core['httpHeaders']['sections'][n];item=core['httpHeaders']['sources'][x['source']]
        data=(root/item['path']).read_bytes()
        if hashlib.sha256(data).hexdigest()!=item['sha256']:raise ValueError('HTTP predicate pin mismatch')
        text=data.decode();at=text.index(x['start']);section=text[at:at+x['length']]
        if hashlib.sha256(section.encode()).hexdigest()!=x['sha256']:raise ValueError('HTTP predicate selection mismatch')
        predicates.append(section)
    result=(root/'http-server-response-adapter.js').read_text()
    for marker,text in {'PREDICATES':predicates[0],'CHUNK_EXPRESSION':predicates[1],'TRACE':sections['trace'],'RESPONSE':sections['response'],'CLOSE':sections['close']}.items():
        key='/* NODE_HTTP_SERVER_'+marker+' */'
        if result.count(key)!=1:raise ValueError('HTTP server marker mismatch: '+marker)
        result=result.replace(key,text)
    return result
