#!/usr/bin/env bash
# Focused source control; supplements normal rebuilt GTK consumer acceptance.
set -euo pipefail
source_root=${1:?patched pinned GTK source root is required}
before_root=${2:?pinned GTK source root before this repair is required}
work_dir=${3:?private output directory is required}
: "${KANDELO_DEV_SHELL_TOOL_PATH:?enter scripts/dev-shell.sh}"
wasm_cc="${LLVM_PREFIX:?enter the declared dev shell}/bin/clang"
test_dir=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$work_dir"

# Extract the actual private class declaration and actual default definitions
# plus class initializer. Only unrelated GObject/opaque dependency types are
# stubbed; callback signatures, assignments and bodies are not reimplemented.
python3 - "$source_root" "$before_root" "$work_dir" <<'PY'
from pathlib import Path
import hashlib,json,re,sys
source,before,work=map(Path,sys.argv[1:])
def klass(root):
 text=(root/'gtk/gtkapplicationprivate.h').read_text()
 return re.search(r'typedef struct\n\{\n  GObjectClass parent_class;.*?\} GtkApplicationImplClass;',text,re.S).group()
class_text=klass(source)
assert class_text==klass(before),'repair must not change private slot declarations'
fields=re.findall(r'(void|guint|gboolean)\s+\(\*\s*(\w+)\)\s*\((.*?)\);',class_text,re.S)
assert len(fields)==14
app_header=(source/'gtk/gtkapplication.h').read_text()
enum=re.search(r'typedef enum\s*\{[^}]+\} GtkApplicationInhibitFlags;',app_header,re.S).group()
assert enum in (before/'gtk/gtkapplication.h').read_text()
header='''/* Source-extracted GtkApplicationImplClass; no GTK library emulation. */
typedef unsigned int guint;
typedef int gboolean;
typedef char gchar;
typedef void *gpointer;
typedef struct { void *unused; } GObjectClass;
typedef struct GtkApplicationImpl GtkApplicationImpl;
typedef struct GtkWindow GtkWindow;
typedef struct GMenuModel GMenuModel;
typedef struct GVariant GVariant;
#define FALSE 0
'''+enum+'\n'+class_text+'\nvoid control_register (GtkApplicationImplClass *);\n'
(work/'class.h').write_text(header)
identities={}
for name,root in [('before',before),('after',source)]:
 text=(root/'gtk/gtkapplicationimpl.c').read_text()
 # Skip only includes, G_DEFINE_TYPE and instance_init; retain every default
 # definition and the complete actual class_init, including original casts.
 start=text.index('static guint do_nothing') if name=='before' else text.index('/* Each default must have')
 end=text.index('\n\nvoid\ngtk_application_impl_startup',start)
 body=text[start:end]
 assignments=re.findall(r'class->(\w+)\s*=',body)
 assert assignments==[name for _,name,_ in fields]
 (work/(name+'.c')).write_text('#include "class.h"\n'+body+'\nvoid control_register (GtkApplicationImplClass *class) { gtk_application_impl_class_init (class); }\n')
 identities[name]={leaf:hashlib.sha256((root/'gtk'/leaf).read_bytes()).hexdigest() for leaf in ['gtkapplicationimpl.c','gtkapplicationprivate.h','gtkapplication.h']}
args={'impl':'(GtkApplicationImpl *) impl_data','register_session':'1','platform_data':'(GVariant *) window_data','window':'(GtkWindow *) window_data','app_menu':'(GMenuModel *) window_data','menubar':'(GMenuModel *) window_data','flags':'GTK_APPLICATION_INHIBIT_LOGOUT','reason':'reason','cookie':'0xfedcba98u'}
caller='''#include "class.h"
int run_case (int which) {
  GtkApplicationImplClass class;
  unsigned char impl_data[32], window_data[32], saved_class[sizeof class];
  char reason[] = "unchanged";
  int result = 0;
  for (unsigned i=0; i<sizeof class; ++i) ((unsigned char *)&class)[i] = 0;
  for (unsigned i=0; i<32; ++i) { impl_data[i] = 0x5a; window_data[i] = 0xa5; }
  control_register (&class);
  for (unsigned i=0; i<sizeof class; ++i) saved_class[i] = ((unsigned char *)&class)[i];
  switch (which) {
'''
for index,(ret,name,decl) in enumerate(fields):
 names=[re.search(r'(\w+)\s*$',arg).group(1) for arg in decl.split(',')]
 call='class.'+name+' ('+', '.join(args[n] for n in names)+')'
 caller+='    case '+str(index)+': '+('result = ' if ret!='void' else '')+call+'; break;\n'
caller+='''    default: return -1;
  }
  if (result != 0) return -2;
  for (unsigned i=0; i<sizeof class; ++i) if (saved_class[i] != ((unsigned char *)&class)[i]) return -3;
  for (unsigned i=0; i<32; ++i) if (impl_data[i] != 0x5a || window_data[i] != 0xa5) return -4;
  if (reason[0] != 'u' || reason[8] != 'd' || reason[9] != 0) return -5;
  return 0;
}
'''
(work/'invoke.c').write_text(caller)
(work/'inventory.json').write_text(json.dumps({'slots':[name for _,name,_ in fields],'sourceSha256':identities},indent=2)+'\n')
PY

for optimization in 0 2; do
  "$wasm_cc" --target=wasm32-unknown-unknown -O"$optimization" -ffreestanding -nostdlib \
    -Werror=incompatible-function-pointer-types -I"$work_dir" -c "$work_dir/invoke.c" -o "$work_dir/invoke-O$optimization.o"
  for state in before after; do
    "$wasm_cc" --target=wasm32-unknown-unknown -O"$optimization" -ffreestanding -nostdlib \
      -Werror=incompatible-function-pointer-types -I"$work_dir" -c "$work_dir/$state.c" -o "$work_dir/$state-O$optimization.o"
    "$LLVM_PREFIX/bin/wasm-ld" --no-entry --export=run_case \
      "$work_dir/$state-O$optimization.o" "$work_dir/invoke-O$optimization.o" -o "$work_dir/$state-O$optimization.wasm"
  done
  node "$test_dir/run-application-default-vfuncs.mjs" "$work_dir" "$optimization"
done
