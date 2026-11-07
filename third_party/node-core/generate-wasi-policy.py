#!/usr/bin/env python3
"""Derive real WASI wire/policy helpers from the exact audited uvwasi pin."""
from pathlib import Path
import hashlib,json,re,sys
root=Path(__file__).resolve().parent
spec=json.loads((root/'wasi-sources.json').read_text())
target=json.loads((root.parents[1]/'packages/registry/node-compat/target.json').read_text())
if spec['version']!=target['version'] or spec['commit']!=target['source']['commit']:raise ValueError('WASI target differs from audited pin')
for n,x in spec['sources'].items():
 if hashlib.sha256((root/x['path']).read_bytes()).hexdigest()!=x['sha256']:raise ValueError('WASI source mismatch: '+n)
def source(n):return (root/spec['sources'][n]['path']).read_text()
rights=source('deps/uvwasi/src/wasi_rights.h');rights=rights[rights.index('#define UVWASI__RIGHTS_ALL'):rights.index('\n\nuvwasi_errno_t uvwasi__get_rights')]
policy=source('deps/uvwasi/src/wasi_rights.c');policy=policy[policy.index('uvwasi_errno_t uvwasi__get_rights'):];policy=policy.replace('uvwasi__get_rights','Rights').replace('uv_file','int').replace('uv_guess_handle(fd) == UV_TTY','::isatty(fd)').replace('UV_FS_O_RDONLY','O_RDONLY').replace('UV_FS_O_WRONLY','O_WRONLY').replace('UV_FS_O_RDWR','O_RDWR')
# The imported constants/body remain unchanged except actual POSIX boundary names.
errors=[]
for native,wasi in re.findall(r'case UV_(E\w+):\s+return (UVWASI_\w+);',source('deps/uvwasi/src/uv_mapping.c')):
 if native=='ENOTEMPTY':continue
 errors.append('#ifdef '+native+'\n    case '+native+': return '+wasi+';\n#endif\n')
# Native POSIX error codes are positive; translate known errors before fallback.
err='inline uvwasi_errno_t FromErrno(int error) {\n  switch(error) {\n'+''.join(errors)+'#if defined(ENOTEMPTY) && ENOTEMPTY != EEXIST\n    case ENOTEMPTY: return UVWASI_ENOTEMPTY;\n#endif\n    case 0:return UVWASI_ESUCCESS;\n    default:return UVWASI_ENOSYS;\n  }\n}\n'
names=source('deps/uvwasi/src/uvwasi.c');a=names.index('const char* uvwasi_embedder_err_code_to_string(');names=names[a:];brace=names.index('{');depth=1;i=brace+1
while depth:
 depth+=int(names[i]=='{')-int(names[i]=='}');i+=1
names=names[:i].replace('uvwasi_embedder_err_code_to_string','ErrorName')
path=source('deps/uvwasi/src/path_resolver.c')
helpers=path[path.index('static int uvwasi__is_absolute_path'):path.index('static uvwasi_errno_t uvwasi__combine_paths')]
normalize=path[path.index('uvwasi_errno_t uvwasi__normalize_path'):path.index('\n\nstatic int uvwasi__is_path_sandboxed')]
normalize='#define IS_SLASH(c) ((c) == \'/\')\n'+helpers+normalize+'\n#undef IS_SLASH\n'
text='// Generated from exact pinned uvwasi rights/error policies; see wasi-sources.json.\n#ifndef KANDELO_WASI_POLICY_H\n#define KANDELO_WASI_POLICY_H\n#include <cerrno>\n#include <fcntl.h>\n#include <unistd.h>\n#include <cstring>\n#include <wasi_types.h>\nnamespace kandelo::wasi {\n'+normalize+rights+'\n'+policy+'\n'+err+names+'\n} // namespace kandelo::wasi\n#endif\n'


def assemble():
 adapter=(root/'wasi-platform-adapter.js').read_text()
 if adapter.count('/* NODE_WASI_MODULE */')!=1:raise ValueError('WASI module insertion marker')
 return adapter.replace('/* NODE_WASI_MODULE */',source('lib/wasi.js'))

if __name__=='__main__':
 p=root/'wasi-policy.h'
 if '--check' in sys.argv:
  if not p.exists() or p.read_text()!=text:raise ValueError('Stale generated WASI policy')
 else:p.write_text(text)
