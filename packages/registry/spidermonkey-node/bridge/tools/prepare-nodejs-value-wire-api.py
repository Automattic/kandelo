#!/usr/bin/env python3
"""Guard engine-heap sections of the whole pinned V8 serialization unit."""
import argparse,hashlib,json,re,subprocess,tempfile
from pathlib import Path

MARK_OPEN=b'#if 0 // KANDELO_NODE_V8_HEAP_SECTION\n'
MARK_CLOSE=b'\n#endif // KANDELO_NODE_V8_HEAP_SECTION\n'

def prepare(manifest,output,patch):
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
    # Runtime source edits are reviewable patches, not hidden substitutions.
    output.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='wire-source-',dir=output) as staging:
        staging=Path(staging)
        target=staging/'deps/v8/src/objects/value-serializer.cc'
        target.parent.mkdir(parents=True);target.write_bytes(raw)
        def apply(reverse=False):
            command=['patch','--batch','-p1','-F0','-d',str(staging)]
            if reverse:command.append('--reverse')
            result=subprocess.run(command,input=patch.read_bytes(),capture_output=True)
            diagnostic=(result.stdout+result.stderr).decode()
            if result.returncode or re.search(r'fuzz|offset',diagnostic,re.I):
                raise ValueError('review wire source patch: '+diagnostic)
        apply();adapted=target.read_bytes()
        apply(reverse=True)
        if target.read_bytes()!=raw:raise ValueError('wire source patch is not reversible')
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
    if recovered!=adapted:raise ValueError('whole adapted source unit not recoverable')
    target=output/'v8-source-api/value-serializer-wire.cc';target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(projected)
    (output/'v8-source-api/v8-value-serializer-version.h').write_bytes(version)
    (output/'v8-source-api/v8-value-serializer.h').write_bytes(adapted_public)
    return {'sources':sources,'wholePublicHeaderRecoverable':True,'publicHeaderSha256':hashlib.sha256(adapted_public).hexdigest(),'wholeOriginalCppUnitRecoverable':True,
      'sourceBodiesNotExtracted':True,'compiledPartitions':'original complete byte/tag/varint/string/buffer/header routines and protocol enums',
      'uncompiledPartitions':'V8 heap/GC/object graph and unused engine entry implementations; these do not implement the SpiderMonkey graph adapter',
      'maintainedSourcePatchSha256':hashlib.sha256(patch.read_bytes()).hexdigest(),
      'engineAdaptations':['version error callback','size_t buffer-growth overflow refusal','empty buffer pointer safety'],
      'projectedSha256':hashlib.sha256(projected).hexdigest(),
      'originalSha256':hashlib.sha256(raw).hexdigest(),
      'versionHeaderSha256':hashlib.sha256(version).hexdigest(),
      'runtimeQualified':False,'valueGraphImplemented':False}
if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--manifest',type=Path,required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--patch',type=Path,required=True);a=p.parse_args()
    print(json.dumps(prepare(a.manifest,a.output,a.patch)))
