#!/usr/bin/env python3
import argparse,collections,datetime,hashlib,json,struct,subprocess,sys
from pathlib import Path
parser=argparse.ArgumentParser(description='Host-native source-registry composition check; not guest Node conformance')
parser.add_argument('--work-dir',required=True,type=Path,help='new private build/evidence directory')
args=parser.parse_args()
stage=Path(__file__).resolve().parents[3]
work=args.work_dir.resolve();work.mkdir(parents=True,exist_ok=False)
def run(args,name,stdout=None):
 with (work/(name+'.stderr')).open('wb') as err:
  if stdout is not None:
   with stdout.open('wb') as stream:subprocess.run([str(x) for x in args],stdout=stream,stderr=err,check=True)
  else:
   with (work/(name+'.stdout')).open('wb') as stream:subprocess.run([str(x) for x in args],stdout=stream,stderr=err,check=True)
node=stage/'third_party/nodejs';upstream=node/'upstream/src';tool=work/'nodejs-builtin-metadata'
run(['clang++','-std=c++20','-Wall','-Wextra','-Werror','-I',upstream,stage/'scripts/nodejs-builtin-metadata.cpp',upstream/'builtin_info.cc','-o',tool],'metadata-build')
include=work/'node-source-registry.generated.h'
run([sys.executable,stage/'scripts/generate-nodejs-source-registry.py','--manifest',node/'sources.json','--metadata-tool',tool,'--output',include],'registry-generate')
control=work/'source-registry-controls';native=node/'native'
run(['clang++','-std=c++17','-Wall','-Wextra','-Werror','-I',native,'-I',work,native/'builtin-source-registry.cpp',stage/'tests/nodejs/upstream/source-registry-controls.cpp','-o',control],'registry-build')
frames=work/'registry-frames.bin';run([control],'registry-controls',stdout=frames)
manifest=json.loads((node/'sources.json').read_text());byid={f['builtinId']:f for f in manifest['files'] if f['builtinId']}
independent=json.loads((stage/'tests/nodejs/upstream/source-registration.json').read_text());kinds={f['id']:f['kind'] for f in independent['manifest']}
# Inspect original checked-in wrapper declarations independently of generated data.
expected_args={
 'kBootstrapRealm':['process','getLinkedBinding','getInternalBinding','primordials'],
 'kBootstrapScript':['process','require','internalBinding','primordials'],
 'kMainScript':['process','require','internalBinding','primordials'],
 'kPerContextScript':['exports','primordials','privateSymbols','perIsolateSymbols'],
 'kFunction':['exports','require','module','process','internalBinding','primordials'],
 'kSourceTextModule':[]}
counts=collections.Counter();total=0
with frames.open('rb') as f:
 def integer():
  b=f.read(8);assert len(b)==8;return struct.unpack('<Q',b)[0]
 def data():
  n=integer();b=f.read(n);assert len(b)==n;return b
 def text():return data().decode('ascii')
 n=integer();assert n==len(byid)==443
 for _ in range(n):
  identifier,path,filename,kind=text(),text(),text(),text();arguments=[text() for _ in range(integer())];body=data()
  source=byid.pop(identifier);assert source['path']==path and filename=='node:'+identifier
  assert hashlib.sha256(body).hexdigest()==source['sha256'] and len(body)==source['bytes']
  assert body==(node/'upstream'/path).read_bytes()
  assert kind==kinds[identifier] and arguments==expected_args[kind]
  counts[kind]+=1;total+=len(body)
 assert not byid and f.read()==b''
tested_inputs=['scripts/generate-nodejs-source-registry.py','scripts/nodejs-builtin-metadata.cpp','third_party/nodejs/native/builtin-source-registry.cpp','third_party/nodejs/native/builtin-source-registry.h','tests/nodejs/upstream/source-registry-controls.cpp']
record={'testedInputSha256':{name:hashlib.sha256((stage/name).read_bytes()).hexdigest() for name in tested_inputs},'completedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'scope':'host-native source registry/metadata composition only; not SpiderMonkey compilation or guest startup','sourceManifestSha256':hashlib.sha256((node/'sources.json').read_bytes()).hexdigest(),'sources':n,'exactSourceBytes':total,'kinds':dict(counts),'allSourceBytesAndMetadataMatched':True,'lookupBoundsMissingAndEmbeddedNulControlsPassed':True,'compiler':'clang++ in scripts/dev-shell.sh','metadataToolSha256':hashlib.sha256(tool.read_bytes()).hexdigest(),'metadataSourceSha256':hashlib.sha256((stage/'scripts/nodejs-builtin-metadata.cpp').read_bytes()).hexdigest(),'upstreamMetadataInputs':{name:hashlib.sha256((upstream/name).read_bytes()).hexdigest() for name in ['builtin_info.cc','builtin_info.h']},'guestCompilerBuilt':False,'guestStartupRun':False,'fullProductBuild':False}
(work/'result.json').write_text(json.dumps(record,indent=2)+'\n')
# Keep identities/evidence while reclaiming the large temporary generated include,
# native binary source payload and framed byte dump after comparison.
for p in [include,control,frames]:p.unlink()
print(json.dumps(record,indent=2))
