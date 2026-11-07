#!/usr/bin/env python3
"""Complete pinned conditional constants over real SDK/OpenSSL headers."""
from pathlib import Path
import argparse,hashlib,json,re

def render(root):
    manifest=json.loads((root/'sources.json').read_text())
    target=json.loads((root.parents[1]/'packages/registry/node-compat/target.json').read_text())
    if (manifest['version'],manifest['commit']) != (target['version'],target['source']['commit']):
        raise ValueError('Public constants target mismatch')
    spec=manifest['publicConstants'];sources={}
    for key,item in spec['sources'].items():
        raw=(root/item['path']).read_bytes()
        if hashlib.sha256(raw).hexdigest()!=item['sha256']:raise ValueError('Public constants source identity: '+key)
        sources[key]=raw.decode()
    def selected(name):
        item=spec['selections'][name];text=sources[item['source']]
        if text.count(item['start'])!=1:raise ValueError('Public constants section: '+name)
        a=text.index(item['start']);section=text[a:a+item['length']]
        if hashlib.sha256(section.encode()).hexdigest()!=item['sha256']:raise ValueError('Public constants section identity: '+name)
        return section
    preserved_names = sorted(set(re.findall(r'^\s*#\s*define\s+(\w+)', '\n'.join(selected(name) for name in ['cryptoPreamble', 'cryptoHeader', 'priorities', 'priority']), re.M)) | {'NODE_DEFINE_CONSTANT', 'NODE_DEFINE_STRING_CONSTANT'})
    output='''// Generated complete pinned conditional definitions, not host value snapshots.
#ifndef KANDELO_NODE_PUBLIC_CONSTANTS_H
#define KANDELO_NODE_PUBLIC_CONSTANTS_H
#include <errno.h>
#include <dlfcn.h>
#include <openssl/ec.h>
#include <openssl/ssl.h>
#ifndef OPENSSL_NO_ENGINE
#include <openssl/engine.h>
#endif
// The declared engine recipe requires and links actual packaged OpenSSL.
// Reject a contradictory build rather than publishing an empty crypto bag.
#ifndef HAVE_OPENSSL
#define KANDELO_CONSTANTS_RESTORE_HAVE_OPENSSL
#define HAVE_OPENSSL 1
#elif !HAVE_OPENSSL
#error Public crypto constants require the declared OpenSSL backend
#endif
'''
    # Unity embedding is a shared translation unit. Preserve existing real
    # header macro state while keeping Node's legacy fallback definitions
    # local to this constant producer. LLVM supports push_macro/pop_macro.
    output+=''.join('#pragma push_macro("'+name+'")\n' for name in preserved_names)
    output+=selected('cryptoPreamble')+'\n'+selected('cryptoHeader')+'\n'+selected('priorities')+'\n'
    output+='''namespace kandelo::node_constants {
namespace uv {
'''+selected('udpEnum')+'''
}
inline const char* DefaultCipherList() { return DEFAULT_CIPHER_LIST_CORE; }
// The callback creates the owning engine's actual readonly/permanent,
// enumerable native property; no type/value or macro applicability is invented.
#define NODE_DEFINE_CONSTANT(target, name) \\
  do { if (!define(#name, static_cast<double>(name))) return false; } while (0)
#define NODE_DEFINE_STRING_CONSTANT(target, name, value) \\
  do { if (!define(name, value)) return false; } while (0)
'''
    for name in ['errno','windowserror','priority','crypto','dlopen']:
        section=selected(name);head=section[:section.index('{')]
        body=section[section.index('{')+1:section.rindex('}')]
        function=re.search(r'void (\w+)\(',head).group(1)
        output+='template<class Define> bool '+function+'(Define define) {'+body+'\n  return true;\n}\n'
    output+='''#undef NODE_DEFINE_CONSTANT
#undef NODE_DEFINE_STRING_CONSTANT
}  // namespace kandelo::node_constants
#ifdef KANDELO_CONSTANTS_RESTORE_HAVE_OPENSSL
#undef HAVE_OPENSSL
#undef KANDELO_CONSTANTS_RESTORE_HAVE_OPENSSL
#endif
'''
    output+=''.join('#pragma pop_macro("'+name+'")\n' for name in reversed(preserved_names))
    output+='#endif\n'
    return output

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--output',type=Path,required=True);args=p.parse_args()
    args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(render(Path(__file__).resolve().parent))
