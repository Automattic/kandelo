#ifndef KANDELO_NODE_VM_MODULE_HOOKS_H
#define KANDELO_NODE_VM_MODULE_HOOKS_H
#include "js/TypeDecls.h"
namespace js::shell {
// VM script sources own actual traced compiled-code/registry associations.
bool KandeloVmScriptDynamic(JSContext* cx, JS::HandleValue privateValue,
                            JS::HandleObject request, JS::HandleObject promise,
                            bool* handled);
// The ordinary loader keeps its hooks. Dispatch only records whose private
// value is the actual VM native owner; every other request falls through.
bool KandeloVmModuleResolve(JSContext* cx, JS::HandleValue privateValue,
                            JS::HandleObject request,
                            JS::MutableHandleObject result, bool* handled);
bool KandeloVmModuleMetadata(JSContext* cx, JS::HandleValue privateValue,
                             JS::HandleObject meta, bool* handled);
bool KandeloVmModuleDynamic(JSContext* cx, JS::HandleValue privateValue,
                            JS::HandleObject request, JS::HandleObject promise,
                            bool* handled);
}
#endif
