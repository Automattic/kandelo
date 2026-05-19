#ifndef NODE_COMPAT_NATIVE_H
#define NODE_COMPAT_NATIVE_H

#include "quickjs.h"

JSModuleDef *js_init_module_node_native(JSContext *ctx, const char *module_name);

#endif
