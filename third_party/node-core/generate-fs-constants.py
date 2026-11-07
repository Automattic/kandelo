#!/usr/bin/env python3
"""Generate guest SDK filesystem constants using unchanged pinned Node/uv data."""
from pathlib import Path
import argparse,hashlib,json,re

def generate(root):
    manifest=json.loads((root/'sources.json').read_text())
    target=json.loads((root.parents[1]/'packages/registry/node-compat/target.json').read_text())
    if manifest['version']!=target['version'] or manifest['commit']!=target['source']['commit']:
        raise ValueError('Filesystem metadata must share the exact Node target')
    inputs={}
    for name,item in manifest['fsConstants'].items():
        raw=(root/item['path']).read_bytes()
        if hashlib.sha256(raw).hexdigest()!=item['sha256']:
            raise ValueError('Filesystem constant source hash mismatch: '+name)
        inputs[name]=raw.decode()
    macros=re.findall(r'^#define\s+(\w+)',inputs['portable']+inputs['posix'],re.M)
    license=(root/'LICENSE').read_text().split('The Node.js license applies',1)[0]
    return ('/* Node.js '+manifest['version']+'\n'+license+'\n*/\n'
        '#include <fcntl.h>\n#include <sys/stat.h>\n#include <unistd.h>\n'
        'namespace {\n'+inputs['portable']+inputs['posix']+
        '\nstatic bool KandeloNativeFsConstants(JSContext* cx, unsigned argc, Value* vp) {\n'
        '  CallArgs args = CallArgsFromVp(argc, vp);\n'
        '  RootedObject target(cx, JS_NewObjectWithGivenProto(cx, nullptr, nullptr));\n'
        '  if (!target) return false;\n'
        '#define NODE_DEFINE_CONSTANT(object, name) \\\n'
        '  do { if (!JS_DefineProperty(cx, object, #name, double(name), \\\n'
        '        JSPROP_ENUMERATE | JSPROP_READONLY | JSPROP_PERMANENT)) return false; } while (0)\n'+
        inputs['body']+'\n#undef NODE_DEFINE_CONSTANT\n'
        '  args.rval().setObject(*target); return true;\n}\n'+
        '\n'.join('#undef '+name for name in macros)+'\n}  // namespace\n')

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args();args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(generate(Path(__file__).resolve().parent))
