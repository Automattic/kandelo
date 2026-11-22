#!/usr/bin/env python3
"""Guard engine-heap sections of the whole pinned V8 serialization unit."""
import argparse,hashlib,json,re
from pathlib import Path

MARK_OPEN=b'#if 0 // KANDELO_NODE_V8_HEAP_SECTION\n'
MARK_CLOSE=b'\n#endif // KANDELO_NODE_V8_HEAP_SECTION\n'

def prepare(manifest,output):
    doc=json.loads(manifest.read_text())
    if doc['version']!='26.13.0' or doc['source']['sha256']!='986ead18ef18256831bae3e57d94aef680a7b84cfd4044f3e8471f833fbd7191':
        raise ValueError('review serialization source before upgrading Node')
    if output.resolve().is_relative_to(manifest.parent.resolve()):
        raise ValueError('cannot change raw upstream')
    rows={r['path']:r for r in doc['files']};sources=[]
    def read(name):
        raw=(manifest.parent/'upstream'/name).read_bytes();row=rows[name]
        if len(raw)!=row['bytes'] or hashlib.sha256(raw).hexdigest()!=row['sha256']:
            raise ValueError('raw source changed: '+name)
        sources.append({'path':name,'sha256':row['sha256']});return raw
    raw=read('deps/v8/src/objects/value-serializer.cc')
    version=read('deps/v8/include/v8-value-serializer-version.h')
    public=read('deps/v8/include/v8-value-serializer.h')
    includes=b''.join(line for line in public.splitlines(keepends=True) if line.startswith(b'#include \"v8-') or line.startswith(b'#include \"v8config.h\"'))
    # The complete public class declarations use the shared rooted source API.
    if len(includes.splitlines())!=3 or public.count(includes)!=1:
        raise ValueError('review changed serializer public includes')
    adapted_public=public.replace(includes,b'// Source interfaces supplied by engine-native-api.h.\n',1)
    if adapted_public.replace(b'// Source interfaces supplied by engine-native-api.h.\n',includes,1)!=public:
        raise ValueError('public header not recoverable')
    # Ordinary engine exception transport replaces V8's private exception factory.
    replacements=[
      (b'isolate_->Throw(*isolate_->factory()->NewError(\n          MessageTemplate::kDataCloneDeserializationVersionError));',
       b'ReportVersionError();'),
      (b'  size_t new_size = old_size + bytes;',
       b'  if (bytes > std::numeric_limits<size_t>::max() - old_size) {\n'
       b'    out_of_memory_ = true;\n    return Nothing<uint8_t*>();\n  }\n'
       b'  size_t new_size = old_size + bytes;'),
      (b'  return Just(&buffer_[old_size]);',
       b'  return Just(buffer_ ? buffer_ + old_size : nullptr);'),
      (b'  size_t requested_capacity =\n      std::max(required_capacity, buffer_capacity_ * 2) + 64;',
       b'  if (required_capacity > std::numeric_limits<size_t>::max() - 64) {\n'
       b'    out_of_memory_ = true;\n    return Nothing<bool>();\n  }\n'
       b'  size_t doubled_capacity = buffer_capacity_ > (std::numeric_limits<size_t>::max() - 64) / 2\n'
       b'      ? required_capacity : buffer_capacity_ * 2;\n'
       b'  size_t requested_capacity = std::max(required_capacity, doubled_capacity) + 64;')
    ]
    adapted=raw
    for old,new in replacements:
        if adapted.count(old)!=1:raise ValueError('review changed source anchor')
        adapted=adapted.replace(old,new,1)
    def span(start,end):
        if adapted.count(start)!=1 or adapted.count(end)!=1:raise ValueError('ambiguous source partition')
        a=adapted.index(start);b=adapted.index(end,a)
        if not a<b:raise ValueError('invalid source partition')
        return a,b
    ranges=[
      span(b'namespace v8 {\nnamespace internal {',b'// WARNING: This serialization'),
      span(b'static const uint32_t kLatestVersion',b'namespace {\n// For serializing JSArrayBufferView'),
      span(b'template <typename T>\nstatic size_t BytesNeededForVarint',b'ValueSerializer::ValueSerializer('),
      span(b'ValueSerializer::~ValueSerializer()',b'void ValueSerializer::WriteBigIntContents('),
      span(b'void ValueSerializer::WriteRawBytes(',b'void ValueSerializer::TransferArrayBuffer('),
      span(b'Maybe<bool> ValueDeserializer::ReadHeader()',b'void ValueDeserializer::TransferArrayBuffer('),
    ]
    tail=adapted.rindex(b'}  // namespace internal')
    ranges.append((tail,len(adapted)))
    cursor=0;parts=[]
    for a,b in sorted(ranges):
        if cursor<a:parts.extend([MARK_OPEN,adapted[cursor:a],MARK_CLOSE])
        parts.append(adapted[a:b]);cursor=b
    if cursor<len(adapted):parts.extend([MARK_OPEN,adapted[cursor:],MARK_CLOSE])
    projected=b''.join(parts)
    recovered=projected.replace(MARK_OPEN,b'').replace(MARK_CLOSE,b'')
    for old,new in reversed(replacements):
        if recovered.count(new)!=1:raise ValueError('source adaptation not reversible')
        recovered=recovered.replace(new,old,1)
    if recovered!=raw:raise ValueError('whole original unit not recoverable')
    target=output/'v8-source-api/value-serializer-wire.cc';target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(projected)
    (output/'v8-source-api/v8-value-serializer-version.h').write_bytes(version)
    (output/'v8-source-api/v8-value-serializer.h').write_bytes(adapted_public)
    return {'sources':sources,'wholePublicHeaderRecoverable':True,'publicHeaderSha256':hashlib.sha256(adapted_public).hexdigest(),'wholeOriginalCppUnitRecoverable':True,
      'sourceBodiesNotExtracted':True,'compiledPartitions':'original complete byte/tag/varint/string/buffer/header routines and protocol enums',
      'uncompiledPartitions':'V8 heap/GC/object graph and unused engine entry implementations; these do not implement the SpiderMonkey graph adapter',
      'engineAdaptations':['version error callback','size_t buffer-growth overflow refusal','empty buffer pointer safety'],
      'projectedSha256':hashlib.sha256(projected).hexdigest(),
      'originalSha256':hashlib.sha256(raw).hexdigest(),
      'versionHeaderSha256':hashlib.sha256(version).hexdigest(),
      'runtimeQualified':False,'valueGraphImplemented':False}
if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--manifest',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
    print(json.dumps(prepare(a.manifest,a.output)))
