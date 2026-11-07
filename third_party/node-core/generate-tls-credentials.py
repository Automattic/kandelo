#!/usr/bin/env python3
"""Select unchanged pinned credential algorithms over real owned SSL_CTX state."""
from pathlib import Path
import argparse,hashlib,json
root=Path(__file__).resolve().parent

def verified():
 spec=json.loads((root/'tls-credentials-sources.json').read_text());target=json.loads((root/'sources.json').read_text())
 if (spec['version'],spec['commit'])!=(target['version'],target['commit']):raise ValueError('TLS credential target pin mismatch')
 sources={}
 for name,item in spec['sources'].items():
  data=(root/item['path']).read_bytes()
  if hashlib.sha256(data).hexdigest()!=item['sha256']:raise ValueError('TLS credential source identity: '+name)
  sources[name]=data.decode()
 result={}
 for name,item in spec['selections'].items():
  source=sources[item['source']]
  if source.count(item['start'])!=1:raise ValueError('TLS credential ambiguous selection: '+name)
  at=source.index(item['start']);text=source[at:at+item['length']]
  if hashlib.sha256(text.encode()).hexdigest()!=item['sha256']:raise ValueError('TLS credential selection identity: '+name)
  result[name]=text
 return result

def header():
 selected=verified();text=(root/'tls-credential-operations.h').read_text()
 for name,marker in [('chainMaterial','// NODE_TLS_CHAIN_MATERIAL'),('chainPEM','// NODE_TLS_CHAIN_PEM'),('privateKey','// NODE_TLS_PRIVATE_KEY')]:
  body=selected[name]
  if name.startswith('chain'):
   body=body.replace('CHECK(!*issuer_);','CredentialCheck(!*issuer_);').replace('CHECK(!*cert);','CredentialCheck(!*cert);')
  else:
   body=body.replace('const ByteSource*','const Password*').replace('ByteSource empty_passphrase;','Password empty_passphrase{nullptr,0};')
  if text.count(marker)!=1:raise ValueError('TLS credential header marker: '+name)
  text=text.replace(marker,body)
 return text

def to_buf():return verified()['toBuf']

if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--header',type=Path,required=True);args=p.parse_args();args.header.parent.mkdir(parents=True,exist_ok=True);args.header.write_text(header())
