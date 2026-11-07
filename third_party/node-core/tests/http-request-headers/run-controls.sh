#!/usr/bin/env bash
set -euo pipefail
# Explicit no-global-setup. Tiny native llhttp owner builds only; no resolver,
# engine/kernel/product build or overall suite.
repo_root=$(cd "$(dirname "$0")/../../../.." && pwd)
: "${NODE26_REFERENCE:?Exact pinned native binary required}"
: "${NODE26_SOURCE:?Exact pinned Node source directory required}"
: "${HTTP_HEADERS_DIR:?Fresh absolute evidence directory required}"
mkdir -p "$HTTP_HEADERS_DIR"
python3 - "$repo_root" <<'PY'
from pathlib import Path
import os,subprocess,json,hashlib,shutil
repo=Path(__import__('sys').argv[1]);source=Path(os.environ['NODE26_SOURCE']);node=Path(os.environ['NODE26_REFERENCE']);out=Path(os.environ['HTTP_HEADERS_DIR']);sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest();runs=[]
assert sha(node)=='533bd644c5ae0e0ea3a80e433aad16b817447ccba1e1eea701875eac80cb75d4'
spec=json.loads((repo/'packages/registry/node-llhttp/sources.json').read_text());assert(spec['nodeVersion'],spec['nodeSourceCommit'])==('26.13.0','18b32a3b1552e199a01f1a8d9fd64aa756d3b75b')
assert all(sha(source/name)==value for name,value in spec['inputFiles'].items())
objects=[]
def run(name,args,env=None):
 try:
  result=subprocess.run([str(arg)for arg in args],cwd=repo,capture_output=True,timeout=60,env=env);stdout,stderr=result.stdout,result.stderr;code=result.returncode;timeout=False
 except subprocess.TimeoutExpired as error:stdout,stderr=error.stdout or b'',error.stderr or b'';code=None;timeout=True
 (out/(name+'.stdout')).write_bytes(stdout);(out/(name+'.stderr')).write_bytes(stderr);runs.append({'name':name,'command':[str(arg)for arg in args],'exit':code,'timedOut':timeout});(out/'runs.json').write_text(json.dumps(runs,indent=2)+'\n');assert code==0 and not timeout,runs[-1]
run('bundle-generate',['python3',repo/'third_party/node-core/build.py'])
for name in ['llhttp','api','http']:
 obj=out/(name+'.o');run('compile-'+name,[shutil.which('clang'),'-std=c99','-O1','-I'+str(source/'deps/llhttp/include'),'-c',source/('deps/llhttp/src/'+name+'.c'),'-o',obj]);objects.append(obj)
for name,fixture in [('request-owner',repo/'third_party/node-core/tests/http-request-headers/owner.cpp'),('response-owner',repo/'host/test/fixtures/node-http-parser-owner.cpp')]:
 run('compile-'+name,[shutil.which('clang++'),'-std=c++20','-O1','-I'+str(source/'deps/llhttp/include'),'-I'+str(repo/'third_party/node-core'),fixture,*objects,'-o',out/name])
run('request-controls',[node,'--expose-internals',repo/'third_party/node-core/tests/http-request-headers/control.cjs'],env={**os.environ,'HTTP_HEADERS_OWNER':str(out/'request-owner'),'HTTP_HEADERS_REPORT':str(out/'request-report.json')})
run('unchanged-response-controls',[node,'--expose-internals',repo/'host/test/fixtures/node-http-parser-controls.cjs'],env={**os.environ,'KANDELO_HTTP_PARSER_OWNER':str(out/'response-owner')})
(out/'provenance.json').write_text(json.dumps({'sourcePin':spec,'nativeReferenceSha256':sha(node),'portableOwnerHeaderSha256':sha(repo/'third_party/node-core/http-parser.h'),'candidateJSFactorySha256':sha(repo/'third_party/node-core/http-parser-platform-adapter.js'),'currentBundleSha256':sha(repo/'third_party/node-core/node-core.js'),'artifacts':{name:sha(out/name)for name in ['request-owner','response-owner']},'nativeCompileAttempts':5,'productionJSAPICompiled':False,'guestConformance':False,'globalSetup':0,'engineBuilds':0,'overallSuites':0},indent=2)+'\n')
print(json.dumps({'runs':runs,'nativeCompiles':5,'scope':'Actual portable owner/native Node differential and request frontend component; no guest/production JSAPI/backing validation'}))
PY
