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
 whole_files=[]
 def write_whole(target,name,data=None):
  original=verified(name)
  target.write_bytes(original if data is None else data)
  whole_files.append({'source':name,'staged':str(target.relative_to(output.parent)),'declarationExtensionOnly':data is not None})
 names=['src/string_decoder.cc','src/string_decoder.h','src/string_decoder-inl.h','src/string_bytes.cc','src/string_bytes.h','src/node_buffer.h','src/node_buffer.cc','src/aliased_buffer.h','src/aliased_buffer-inl.h','src/node_i18n.cc','src/node_i18n.h','src/api/encoding.cc','src/base_object_types.h','src/node_snapshotable.h','src/node_diagnostics_channel.cc','src/node_diagnostics_channel.h','src/node_process_methods.cc','src/node_process_object.cc','src/node_process.h','src/node_process-inl.h','src/node_mutex.h','src/node_dotenv.h','src/path.h','src/permission/permission_base.h','src/node_revert.h']
 for name in names:
  output.mkdir(parents=True,exist_ok=True);target=output/(name[4:] if name.startswith('src/permission/')else Path(name).name);target.parent.mkdir(parents=True,exist_ok=True);write_whole(target,name)
 for name in ['src/node_dotenv.cc','src/path.cc','src/node_env_var.cc','deps/ada/ada.h','src/api/exceptions.cc','src/node_errors.cc']:
  write_whole(output/Path(name).name,name)
 # Compile complete resource bodies in their own include directory. Their
 # binding is not activated while consumed backends remain unavailable.
 resource=output.parent/'resource-upstream';resource.mkdir(parents=True,exist_ok=True)
 for name in ['async_wrap.cc','async_wrap.h','async_wrap-inl.h','async_context_frame.h','req_wrap.h','req_wrap-inl.h','handle_wrap.h','handle_wrap.cc','signal_wrap.cc']:
  write_whole(resource/name,'src/'+name)
 for name in ['node_internals.h','v8.h','env.h','util.h','util-inl.h','env-inl.h','node_realm-inl.h','cppgc_helpers.h','v8-profiler.h']:
  (resource/name).write_text('#include "shell/node-upstream/codec-native-api.h"\n')
 owner_names=['base_object.cc','base_object.h','base_object-inl.h','memory_tracker.h','memory_tracker-inl.h','node_messaging.h','node_v8_embedder.h','node_context_data.h','node_concepts.h','cleanup_queue.h','cleanup_queue-inl.h','cleanup_queue.cc']
 for name in owner_names:
  data=verified('src/'+name)
  if name=='base_object.h':
   # A declaration-only embedding hook exposes original ref state to native
   # shutdown guards. Preserve every original field and function body.
   anchor=b'  friend class CleanupQueue;\n'
   if data.count(anchor)!=1:raise ValueError('unreviewed BaseObject embedding extension anchor')
   data=data.replace(anchor,anchor+b'  friend struct NativeBaseObjectAccess;\n')
  write_whole(resource/name,'src/'+name,data if name=='base_object.h' else None)
 (resource/'node_mutex.h').write_text('#include "shell/node-upstream/tracing-upstream/node_mutex.h"\n')
 (resource/'base_object_types.h').write_text('#include "shell/node-upstream/codecs-upstream/base_object_types.h"\n')
 permission_header_names=['node_file.h','stream_base.h']
 for name in permission_header_names:
  write_whole(resource/name,'src/'+name)
 permissions=resource/'permission';permissions.mkdir(exist_ok=True)
 permission_names=['permission.h','permission.cc','permission_base.h','boolean_permission.h','fs_permission.h','fs_permission.cc']
 for name in permission_names:
  write_whole(permissions/name,'src/permission/'+name)
 for name in ['debug_utils.h','debug_utils-inl.h','node_debug.h','node_errors.h']:
  (resource/name).write_text('#include "shell/node-upstream/process-native-api.h"\n')
 (resource/'node_diagnostics_channel.h').write_text('#include "shell/node-upstream/codecs-upstream/node_diagnostics_channel.h"\n')
 (resource/'node.h').write_text('#include "shell/node-upstream/codecs-upstream/node.h"\n')
 (resource/'node_snapshotable.h').write_text('#include "shell/node-upstream/codecs-upstream/node_snapshotable.h"\n')
 (resource/'aliased_buffer.h').write_text('#include "shell/node-upstream/codecs-upstream/aliased_buffer.h"\n')
 (resource/'path.h').write_text('#include "shell/node-upstream/codecs-upstream/path.h"\n')
 for name in ['v8-fast-api-calls.h','v8-template.h']:
  (resource/name).write_text('#include "shell/node-upstream/codec-native-api.h"\n')
 for name in ['node_external_reference.h']:
  (resource/name).write_text('#include "shell/node-upstream/resource-native-api.h"\n')
 (resource/'node_process-inl.h').write_text('#include "shell/node-upstream/process-native-api.h"\n')
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
  write_whole(support/name,'src/'+name)
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
 internals=output.parent/'internals-upstream';internals.mkdir(parents=True,exist_ok=True)
 write_whole(internals/'node_internals.h','src/node_internals.h')
 for name in ['env.h','node_binding.h','node_file_utils.h','util.h','v8.h']:
  (internals/name).write_bytes(include)
 (internals/'node.h').write_text('#include "shell/node-upstream/codecs-upstream/node.h"\n')
 (internals/'node_mutex.h').write_text('#include "shell/node-upstream/tracing-upstream/node_mutex.h"\n')
 (internals/'tracing').mkdir(exist_ok=True)
 (internals/'tracing/trace_event.h').write_text('#include "shell/node-upstream/trace-native.h"\n')
 for name in ['memory_tracker.h','memory_tracker-inl.h','node_blob.h','node_debug.h','v8-fast-api-calls.h','node_errors.h','node_external_reference.h','util.h','v8.h','v8-external-memory-accounter.h','base_object.h','base_object-inl.h','env.h','node_internals.h','util-inl.h','async_wrap-inl.h','debug_utils-inl.h','node_metadata.h','node_options-inl.h','node_realm-inl.h']:(output/name).write_bytes(include)
 for name in ['base_object.h','base_object-inl.h','memory_tracker.h','memory_tracker-inl.h']:
  (output/name).write_text('#include "shell/node-upstream/resource-upstream/'+name+'"\n')
 declarations=b'''enum encoding ParseEncoding(const char*, enum encoding);
enum encoding ParseEncoding(v8::Isolate*, v8::Local<v8::Value>, enum encoding);
enum encoding ParseEncoding(v8::Isolate*, v8::Local<v8::Value>, v8::Local<v8::Value>, enum encoding);
'''
 (output/'node.h').write_bytes(b'#ifndef KANDELO_CODEC_NODE_METADATA_H\n#define KANDELO_CODEC_NODE_METADATA_H\n'+include+b'namespace node {\n'+enum[0]+b'\n'+declarations+b'}\n#endif\n')
 (output/'env-inl.h').write_text('#include "shell/node-upstream/codecs-upstream/node.h"\n')
 policy=output.parent/'error-policy-upstream';policy.mkdir(parents=True,exist_ok=True)
 write_whole(policy/'node_errors.h','src/node_errors.h')
 (policy/'debug_utils-inl.h').write_text('#include "shell/node-upstream/process-native-api.h"\n')
 for name in ['env.h','v8.h']:(policy/name).write_bytes(include)
 (policy/'node_buffer.h').write_text('#include "shell/node-upstream/codecs-upstream/node_buffer.h"\n')
 (output/'node_errors.h').write_text('#include "shell/node-upstream/error-policy-native-api.h"\n')
 (output/'node_internals.h').write_text('#include "shell/node-upstream/internals-native-api.h"\n')
 engine_include=output.parent/'utility-engine-includes';engine_include.mkdir(parents=True,exist_ok=True)
 (engine_include/'v8.h').write_bytes(include)
 utility=output.parent/'utilities-upstream';utility.mkdir(parents=True,exist_ok=True)
 for name in ['util.h','util-inl.h','util.cc','node_concepts.h','node_union_bytes.h','node_exit_code.h','node_revert.h']:
  write_whole(utility/name,'src/'+name)
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
  write_whole(debug/name,'src/'+name)
 for name in ['async_wrap.h','env.h','util.h','util-inl.h']:
  (debug/name).write_bytes(include)
 for name in ['env-inl.h','node_internals.h']:
  (debug/name).write_text('#include "shell/node-upstream/debugging-native-api.h"\n')
 (output/'errors.generated.h').unlink(missing_ok=True)
 return {'completeNativeFiles':len(whole_files),'wholeFiles':whole_files,'wholeOriginalBaseObjectFunctionBodies':True,'baseObjectHeaderEmbeddingExtension':'friend NativeBaseObjectAccess declaration only','wholeOriginalMemoryTracker':True,'wholeOriginalCleanupQueue':True,'wholeOriginalPermissionFunctionBodies':True,'wholeOriginalPermissionFilesystemRequestHeader':True,'permissionEnvironmentInitializationImplemented':False,'wholeOriginalNodeInternals':True,'wholeOriginalDebugUtilities':True,'wholeOriginalUtilities':True,'wholeOriginalErrorPolicyHeader':True,'asyncProviderMetadataMacros':4,'fullEncodingEnumOnly':True,'functionBodiesExtracted':False,'javascriptGenerated':False}
if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--manifest',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args();print(json.dumps(prepare(a.manifest,a.output)))
