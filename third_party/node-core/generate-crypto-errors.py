#!/usr/bin/env python3
"""Pin Node's real queue/decoration algorithms at the native adapter boundary."""
from pathlib import Path
import argparse,hashlib,json,re
root=Path(__file__).resolve().parent

def sources():
 spec=json.loads((root/'crypto-errors-sources.json').read_text());target=json.loads((root/'sources.json').read_text())
 if(spec['version'],spec['commit'])!=(target['version'],target['commit']):raise ValueError('Crypto error target mismatch')
 texts={}
 for name,item in spec['sources'].items():
  data=(root/item['path']).read_bytes()
  if hashlib.sha256(data).hexdigest()!=item['sha256']:raise ValueError('Crypto error source identity: '+name)
  texts[name]=data.decode()
 selected={}
 for name,item in spec['selections'].items():
  text=texts[item['source']];start=text.index(item['start']);body=text[start:start+item['length']]
  if hashlib.sha256(body.encode()).hexdigest()!=item['sha256']:raise ValueError('Crypto error algorithm identity: '+name)
  selected[name]=body
 return texts,selected

def render():
 text,selected=sources();header=(root/'crypto-errors-template.h').read_text();upper='inline '+selected['upper']
 body=selected['decorate'];start=body.index('{');body='template<class Set> inline bool DescribeError(unsigned long err,Set set) '+body[start:]
 body=body.replace('return JustVoid();','return true;').replace('return Nothing<void>();','return false;')
 body=body.replace('#if NCRYPTO_USE_OPENSSL3_PROVIDER','#if !defined(OPENSSL_IS_BORINGSSL) && OPENSSL_VERSION_MAJOR >= 3')
 body=body.replace('  Isolate* isolate = env->isolate();\n  Local<Context> context = isolate->GetCurrentContext();\n','')
 for value,name in [('ls','library'),('fs','function'),('rs','reason')]:
  old='obj->Set(context, env->'+name+'_string(),\n                 OneByteString(isolate, '+value+')).IsNothing()'
  if body.count(old)!=1:raise ValueError('Crypto error string-set adapter: '+name)
  body=body.replace(old,'!set("'+name+'", '+value+')')
 old='obj->Set(env->isolate()->GetCurrentContext(),\n             env->code_string(),\n             OneByteString(env->isolate(), code)).IsNothing()'
 if body.count(old)!=1:raise ValueError('Crypto error code-set adapter')
 body=body.replace(old,'!set("code", code)')
 capture=selected['capture'].replace('void CryptoErrorStore::Capture()', 'void Capture()').replace('std::ranges::reverse(errors_);','std::reverse(errors_.begin(),errors_.end());')
 macro=text['src/node_errors.h'];a=macro.index('#define ERRORS_WITH_CODE(V)');b=macro.index('// If the macros are used',a);entries=re.findall(r'V\((ERR_\w+),\s*(\w+)\)',macro[a:b]);kinds='inline std::optional<ErrorKind> NativeNodeKind(std::string_view code) {\n'
 for code,kind in entries:kinds+='  if(code=="'+code+'")return ErrorKind::'+kind+';\n'
 kinds+='  return std::nullopt;\n}\ninline bool IsNativeNodeCode(std::string_view code){return NativeNodeKind(code).has_value();}\n'
 empty=re.search(r'V\(OK, \"([^\"]+)\"\)',text['src/crypto/crypto_util.h']).group(1)
 for marker,value in [('EMPTY_MESSAGE','inline constexpr const char* EmptyStoreMessage(){return '+json.dumps(empty)+';}'),('UPPER',upper),('DECORATE',body),('CAPTURE',capture),('NODE_KINDS',kinds)]:
  key='// NODE_CRYPTO_'+marker
  if header.count(key)!=1:raise ValueError('Crypto error marker: '+marker)
  header=header.replace(key,value)
 return header
if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--output',type=Path);p.add_argument('--check',action='store_true');args=p.parse_args();output=args.output or root/'crypto-errors.h';body=render();
 if args.check:
  if not output.exists() or output.read_text()!=body:raise ValueError('Stale generated crypto error owner')
 else:
  output.parent.mkdir(parents=True,exist_ok=True);output.write_text(body)
