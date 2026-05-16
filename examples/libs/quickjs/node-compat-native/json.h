#ifndef NODE_COMPAT_NATIVE_JSON_H
#define NODE_COMPAT_NATIVE_JSON_H

#include "quickjs.h"

JSValue js_node_native_json_parse(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv);

#endif
