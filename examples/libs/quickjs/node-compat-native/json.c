#include "json.h"

#include <stdint.h>

#include "yyjson.h"

static JSValue yy_to_jsvalue(JSContext *ctx, yyjson_val *val)
{
    switch (yyjson_get_type(val)) {
    case YYJSON_TYPE_NULL:
        return JS_NULL;
    case YYJSON_TYPE_BOOL:
        return JS_NewBool(ctx, yyjson_get_bool(val));
    case YYJSON_TYPE_NUM:
        switch (yyjson_get_subtype(val)) {
        case YYJSON_SUBTYPE_REAL:
            return JS_NewFloat64(ctx, yyjson_get_real(val));
        case YYJSON_SUBTYPE_SINT:
            return JS_NewInt64(ctx, yyjson_get_sint(val));
        case YYJSON_SUBTYPE_UINT: {
            uint64_t u = yyjson_get_uint(val);
            if (u <= (uint64_t)INT64_MAX)
                return JS_NewInt64(ctx, (int64_t)u);
            return JS_NewFloat64(ctx, (double)u);
        }
        }
        return JS_UNDEFINED;
    case YYJSON_TYPE_STR:
        return JS_NewStringLen(ctx, yyjson_get_str(val), yyjson_get_len(val));
    case YYJSON_TYPE_ARR: {
        JSValue arr = JS_NewArray(ctx);
        if (JS_IsException(arr))
            return arr;
        size_t idx, max;
        yyjson_val *elem;
        yyjson_arr_foreach(val, idx, max, elem) {
            JSValue v = yy_to_jsvalue(ctx, elem);
            if (JS_IsException(v)) {
                JS_FreeValue(ctx, arr);
                return v;
            }
            if (JS_SetPropertyUint32(ctx, arr, (uint32_t)idx, v) < 0) {
                JS_FreeValue(ctx, arr);
                return JS_EXCEPTION;
            }
        }
        return arr;
    }
    case YYJSON_TYPE_OBJ: {
        JSValue obj = JS_NewObject(ctx);
        if (JS_IsException(obj))
            return obj;
        size_t idx, max;
        yyjson_val *key, *value;
        yyjson_obj_foreach(val, idx, max, key, value) {
            const char *kstr = yyjson_get_str(key);
            size_t klen = yyjson_get_len(key);
            JSValue v = yy_to_jsvalue(ctx, value);
            if (JS_IsException(v)) {
                JS_FreeValue(ctx, obj);
                return v;
            }
            JSAtom atom = JS_NewAtomLen(ctx, kstr, klen);
            if (atom == JS_ATOM_NULL) {
                JS_FreeValue(ctx, v);
                JS_FreeValue(ctx, obj);
                return JS_EXCEPTION;
            }
            if (JS_DefinePropertyValue(ctx, obj, atom, v,
                                       JS_PROP_C_W_E) < 0) {
                JS_FreeAtom(ctx, atom);
                JS_FreeValue(ctx, obj);
                return JS_EXCEPTION;
            }
            JS_FreeAtom(ctx, atom);
        }
        return obj;
    }
    default:
        return JS_UNDEFINED;
    }
}

JSValue js_node_native_json_parse(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv)
{
    size_t len;
    const char *input = JS_ToCStringLen(ctx, &len, argv[0]);
    if (!input)
        return JS_EXCEPTION;

    yyjson_read_err err;
    yyjson_doc *doc = yyjson_read_opts((char *)input, len,
                                       YYJSON_READ_NOFLAG, NULL, &err);
    JSValue result;
    if (!doc) {
        result = JS_ThrowSyntaxError(ctx,
            "JSON.parse: %s at position %zu", err.msg, err.pos);
    } else {
        result = yy_to_jsvalue(ctx, yyjson_doc_get_root(doc));
        yyjson_doc_free(doc);
    }
    JS_FreeCString(ctx, input);
    return result;
}
