#ifndef NODE_COMPAT_NATIVE_HASH_H
#define NODE_COMPAT_NATIVE_HASH_H

#include "quickjs.h"

int node_native_hash_init(JSContext *ctx);

JSValue js_node_native_create_hash(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv);

#endif
