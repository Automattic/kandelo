#!/usr/bin/env python3
"""Stage complete verified Node native sources and declaration shims."""
from pathlib import Path
import argparse,hashlib,json,re
def prepare(manifest,output):
 doc=json.loads(manifest.read_text());files={x['path']:x for x in doc['files']}
 if output.resolve().is_relative_to(manifest.parent.resolve()):raise ValueError('output must be outside immutable import')
 def verified(name):
  row=files[name];b=(manifest.parent/'upstream'/name).read_bytes()
  if len(b)!=row['bytes'] or hashlib.sha256(b).hexdigest()!=row['sha256']:raise ValueError('native codec identity mismatch: '+name)
  return b
 names=['src/string_decoder.cc','src/string_decoder.h','src/string_decoder-inl.h','src/string_bytes.cc','src/string_bytes.h','src/node_buffer.h','src/node_buffer.cc','src/aliased_buffer.h','src/aliased_buffer-inl.h','src/node_i18n.cc','src/node_i18n.h','src/api/encoding.cc','src/base_object_types.h','src/node_snapshotable.h','src/node_diagnostics_channel.cc','src/node_diagnostics_channel.h','src/node_process_methods.cc','src/node_process_object.cc','src/node_process.h','src/node_process-inl.h','src/node_mutex.h','src/node_dotenv.h','src/path.h','src/permission/permission_base.h','src/node_revert.h']
 for name in names:
  output.mkdir(parents=True,exist_ok=True);target=output/(name[4:] if name.startswith('src/permission/')else Path(name).name);target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(verified(name))
 for name in ['src/node_dotenv.cc','src/path.cc','src/node_env_var.cc','deps/ada/ada.h','src/api/exceptions.cc','src/node_errors.cc']:
  (output/Path(name).name).write_bytes(verified(name))
 # Compile complete resource bodies in their own include directory. Their
 # binding is not activated while consumed backends remain unavailable.
 resource=output.parent/'resource-upstream';resource.mkdir(parents=True,exist_ok=True)
 for name in ['async_wrap.cc','async_wrap.h','async_wrap-inl.h','async_context_frame.h']:
  (resource/name).write_bytes(verified('src/'+name))
 for name in ['base_object.h','base_object-inl.h','node_internals.h','v8.h']:
  (resource/name).write_text('#include "shell/node-upstream/codec-native-api.h"\n')
 for name in ['env-inl.h','node_external_reference.h','util-inl.h']:
  (resource/name).write_text('#include "shell/node-upstream/resource-native-api.h"\n')
 (resource/'node_errors.h').write_text('#include "shell/node-upstream/fatal-errors-native-api.h"\n')
 (resource/'tracing').mkdir(exist_ok=True)
 (resource/'tracing/traced_value.h').write_text('#include "shell/node-upstream/tracing-upstream/tracing/traced_value.h"\n')
 (output/'node_file.h').write_text('#include "shell/node-upstream/process-native-api.h"\n')
 (output/'node_url.h').write_text('#include "shell/node-upstream/process-native-api.h"\n')
 for name in ['node_report.h','node_v8_platform-inl.h']:
  (output/name).write_text('#include "shell/node-upstream/fatal-errors-native-api.h"\n')
 # Keep the complete original formatting algorithms in their own include
 # directory, leaving other consumers' declaration-only debug shims intact.
 support=output/'process-support';support.mkdir(parents=True,exist_ok=True)
 for name in ['async_wrap.h','env.h','util.h','util-inl.h']:
  (support/name).write_text('#include "shell/node-upstream/codec-native-api.h"\n')
 for name in ['debug_utils.h','debug_utils-inl.h']:
  (support/name).write_bytes(verified('src/'+name))
 # These are only the complete declarative provider-name macro tables. No
 # function/class bodies or executable algorithm fragments are extracted.
 async_header=verified('src/async_wrap.h')
 start=async_header.index(b'#define NODE_ASYNC_NON_CRYPTO_PROVIDER_TYPES(V)')
 end=async_header.index(b'\nclass Environment;',start)
 tables=async_header[start:end]
 if b'{' in tables or b'}' in tables or tables.count(b'#define NODE_ASYNC_')!=4:
  raise ValueError('unreviewed async-provider metadata tables')
 (support/'async-provider-metadata.h').write_bytes(tables+b'\n')
 enum=re.search(rb'enum encoding \{.*?\n\};',verified('src/node.h'),re.S)
 if not enum or re.sub(rb'\s+',b' ',enum[0])!=b'enum encoding { ASCII, UTF8, BASE64, UCS2, BINARY, HEX, BUFFER, BASE64URL, LATIN1 = BINARY };':raise ValueError('unreviewed original codec enum')
 include=b'#include "shell/node-upstream/codec-native-api.h"\n'
 for name in ['memory_tracker.h','memory_tracker-inl.h','node_blob.h','node_debug.h','v8-fast-api-calls.h','node_errors.h','node_external_reference.h','util.h','v8.h','v8-external-memory-accounter.h','base_object.h','base_object-inl.h','env.h','node_internals.h','util-inl.h','async_wrap-inl.h','debug_utils-inl.h','node_metadata.h','node_options-inl.h','node_realm-inl.h']:(output/name).write_bytes(include)
 declarations=b'''enum encoding ParseEncoding(const char*, enum encoding);
enum encoding ParseEncoding(v8::Isolate*, v8::Local<v8::Value>, enum encoding);
enum encoding ParseEncoding(v8::Isolate*, v8::Local<v8::Value>, v8::Local<v8::Value>, enum encoding);
'''
 (output/'node.h').write_bytes(b'#ifndef KANDELO_CODEC_NODE_METADATA_H\n#define KANDELO_CODEC_NODE_METADATA_H\n'+include+b'namespace node {\n'+enum[0]+b'\n'+declarations+b'}\n#endif\n')
 (output/'env-inl.h').write_text('#include "shell/node-upstream/codecs-upstream/node.h"\n')
 policy=output.parent/'error-policy-upstream';policy.mkdir(parents=True,exist_ok=True)
 (policy/'node_errors.h').write_bytes(verified('src/node_errors.h'))
 (policy/'debug_utils-inl.h').write_text('#include "shell/node-upstream/process-native-api.h"\n')
 for name in ['env.h','v8.h']:(policy/name).write_bytes(include)
 (policy/'node_buffer.h').write_text('#include "shell/node-upstream/codecs-upstream/node_buffer.h"\n')
 (output/'node_errors.h').write_text('#include "shell/node-upstream/error-policy-native-api.h"\n')
 engine_include=output.parent/'utility-engine-includes';engine_include.mkdir(parents=True,exist_ok=True)
 (engine_include/'v8.h').write_bytes(include)
 utility=output.parent/'utilities-upstream';utility.mkdir(parents=True,exist_ok=True)
 for name in ['util.h','util-inl.h','util.cc','node_concepts.h','node_union_bytes.h','node_exit_code.h','node_revert.h']:
  (utility/name).write_bytes(verified('src/'+name))
 for name in ['v8.h','v8-inspector.h','v8-profiler.h','v8-isolate.h','v8-value.h','node.h']:
  (utility/name).write_bytes(include)
 for name in ['node_internals.h','node_snapshot_builder.h','node_v8_platform-inl.h']:
  (utility/name).write_text('#include "shell/node-upstream/utility-support-native-api.h"\n')
 for name in ['env-inl.h','debug_utils-inl.h']:
  (utility/name).write_text('#include "shell/node-upstream/process-native-api.h"\n')
 for name in ['node_buffer.h','string_bytes.h']:
  (utility/name).write_text('#include "shell/node-upstream/codecs-upstream/'+name+'"\n')
 (utility/'node_errors.h').write_text('#include "shell/node-upstream/error-policy-native-api.h"\n')
 debug=output.parent/'debugging-upstream';debug.mkdir(parents=True,exist_ok=True)
 for name in ['debug_utils.cc','debug_utils.h','debug_utils-inl.h']:
  (debug/name).write_bytes(verified('src/'+name))
 for name in ['async_wrap.h','env.h','util.h','util-inl.h']:
  (debug/name).write_bytes(include)
 for name in ['env-inl.h','node_internals.h']:
  (debug/name).write_text('#include "shell/node-upstream/debugging-native-api.h"\n')
 (output/'errors.generated.h').unlink(missing_ok=True)
 return {'completeNativeFiles':len(names)+23,'wholeOriginalDebugUtilities':True,'wholeOriginalUtilities':True,'wholeOriginalErrorPolicyHeader':True,'asyncProviderMetadataMacros':4,'fullEncodingEnumOnly':True,'functionBodiesExtracted':False,'javascriptGenerated':False}
if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--manifest',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args();print(json.dumps(prepare(a.manifest,a.output)))
