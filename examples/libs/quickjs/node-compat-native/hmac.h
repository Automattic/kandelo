#ifndef NODE_COMPAT_NATIVE_HMAC_H
#define NODE_COMPAT_NATIVE_HMAC_H

#include "quickjs.h"

int node_native_hmac_init(JSContext *ctx);

JSValue js_node_native_create_hmac(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv);

#endif
