#!/usr/bin/env python3
"""Bind TLS verification error names to the unchanged audited ncrypto switch."""
import argparse,hashlib,json
from pathlib import Path

def render(root):
    m=json.loads((root/'sources.json').read_text());g=m['tlsState']
    t=json.loads((root.parents[1]/'packages/registry/node-compat/target.json').read_text())
    if (m['version'],m['commit'])!=(t['version'],t['source']['commit']):raise ValueError('TLS target pin mismatch')
    for name,item in g['sources'].items():
        if hashlib.sha256((root/item['path']).read_bytes()).hexdigest()!=item['sha256']:raise ValueError('TLS source mismatch: '+name)
    item=g['errorCode'];text=(root/g['sources'][item['source']]['path']).read_text();a=text.index(item['start']);body=text[a:a+item['length']]
    if text.count(item['start'])!=1 or hashlib.sha256(body.encode()).hexdigest()!=item['sha256']:raise ValueError('TLS error code selection mismatch')
    signature='const char* X509Pointer::ErrorCode(int32_t err)'
    if body.count(signature)!=1:raise ValueError('TLS error signature changed')
    body=body.replace(signature,'inline const char* VerificationErrorCode(int32_t err)',1)
    header=(root/'tls-state.h').read_text()
    if header.count('// NODE_TLS_VERIFY_ERROR_CODE')!=1:raise ValueError('TLS header marker mismatch')
    return header.replace('// NODE_TLS_VERIFY_ERROR_CODE',body)
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--output',type=Path,required=True);a=p.parse_args();a.output.write_text(render(Path(__file__).resolve().parent))
