#!/usr/bin/env python3
"""Stage complete verified decoder/StringBytes sources and declaration shims."""
from pathlib import Path
import argparse,hashlib,json,re
def prepare(manifest,output):
 doc=json.loads(manifest.read_text());files={x['path']:x for x in doc['files']}
 if output.resolve().is_relative_to(manifest.parent.resolve()):raise ValueError('output must be outside immutable import')
 def verified(name):
  row=files[name];b=(manifest.parent/'upstream'/name).read_bytes()
  if len(b)!=row['bytes'] or hashlib.sha256(b).hexdigest()!=row['sha256']:raise ValueError('native codec identity mismatch: '+name)
  return b
 names=['src/string_decoder.cc','src/string_decoder.h','src/string_decoder-inl.h','src/string_bytes.cc','src/string_bytes.h','src/node_buffer.h','src/node_buffer.cc','src/aliased_buffer.h','src/aliased_buffer-inl.h','src/node_i18n.cc','src/node_i18n.h','src/api/encoding.cc']
 for name in names:
  output.mkdir(parents=True,exist_ok=True);(output/Path(name).name).write_bytes(verified(name))
 enum=re.search(rb'enum encoding \{.*?\n\};',verified('src/node.h'),re.S)
 if not enum or re.sub(rb'\s+',b' ',enum[0])!=b'enum encoding { ASCII, UTF8, BASE64, UCS2, BINARY, HEX, BUFFER, BASE64URL, LATIN1 = BINARY };':raise ValueError('unreviewed original codec enum')
 include=b'#include "shell/node-upstream/codec-native-api.h"\n'
 for name in ['memory_tracker.h','memory_tracker-inl.h','node_blob.h','node_debug.h','v8-fast-api-calls.h','node_errors.h','node_external_reference.h','util.h','v8.h','v8-external-memory-accounter.h','base_object.h','base_object-inl.h','env.h','node_internals.h','util-inl.h']:(output/name).write_bytes(include)
 declarations=b'''enum encoding ParseEncoding(const char*, enum encoding);
enum encoding ParseEncoding(v8::Isolate*, v8::Local<v8::Value>, enum encoding);
enum encoding ParseEncoding(v8::Isolate*, v8::Local<v8::Value>, v8::Local<v8::Value>, enum encoding);
'''
 (output/'node.h').write_bytes(b'#ifndef KANDELO_CODEC_NODE_METADATA_H\n#define KANDELO_CODEC_NODE_METADATA_H\n'+include+b'namespace node {\n'+enum[0]+b'\n'+declarations+b'}\n#endif\n')
 (output/'env-inl.h').write_text('#include "shell/node-upstream/codecs-upstream/node.h"\n')
 errors=verified('src/node_errors.h').decode();metadata=[]
 for code in ['ERR_INVALID_ARG_TYPE','ERR_ENCODING_INVALID_ENCODED_DATA']:
  if not re.search(r'V\('+code+r',\s*TypeError\)',errors):raise ValueError('unreviewed native ICU error type: '+code)
 for code,kind in [('ERR_OUT_OF_RANGE','RangeError'),('ERR_BUFFER_OUT_OF_BOUNDS','RangeError'),('ERR_BUFFER_CONTEXT_NOT_AVAILABLE','Error')]:
  if not re.search(r'V\('+code+r',\s*'+kind+r'\)',errors):raise ValueError('unreviewed native Buffer error type: '+code)
 for name,code,kind,text in [
  ('StringTooLong','ERR_STRING_TOO_LONG','Error','Cannot create a string longer than 0x%x characters'),
  ('BufferTooLarge','ERR_BUFFER_TOO_LARGE','Error','Cannot create a Buffer larger than 0x%zx bytes'),
  ('AllocationFailed','ERR_MEMORY_ALLOCATION_FAILED','RangeError','Failed to allocate memory')]:
  if not re.search(r'V\('+code+r',\s*'+kind+r'\)',errors) or json.dumps(text) not in errors:raise ValueError('unreviewed native error metadata: '+code)
  metadata.append('inline constexpr Error '+name+'{'+json.dumps(code)+','+json.dumps(text)+','+str(kind=='RangeError').lower()+'};')
 (output/'errors.generated.h').write_text('namespace kandelo_codec_metadata {\nstruct Error { const char* code; const char* text; bool range; };\n'+'\n'.join(metadata)+'\n}\n')
 return {'completeNativeFiles':len(names),'fullEncodingEnumOnly':True,'functionBodiesExtracted':False,'javascriptGenerated':False}
if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--manifest',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args();print(json.dumps(prepare(a.manifest,a.output)))
