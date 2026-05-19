#include "hmac.h"
#include "cutils.h"

#include <openssl/evp.h>
#include <openssl/params.h>
#include <string.h>

static JSClassID hmac_class_id;

static void hmac_finalizer(JSRuntime *rt, JSValue val)
{
    EVP_MAC_CTX *mctx = JS_GetOpaque(val, hmac_class_id);
    if (mctx)
        EVP_MAC_CTX_free(mctx);
}

static const JSClassDef hmac_class = {
    .class_name = "Hmac",
    .finalizer = hmac_finalizer,
};

static const char *resolve_digest(const char *algo)
{
    if (!strcmp(algo, "sha1"))   return "SHA1";
    if (!strcmp(algo, "sha256")) return "SHA256";
    if (!strcmp(algo, "sha512")) return "SHA512";
    if (!strcmp(algo, "md5"))    return "MD5";
    return NULL;
}

static JSValue js_hmac_update(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    EVP_MAC_CTX *mctx = JS_GetOpaque(this_val, hmac_class_id);
    if (!mctx)
        return JS_ThrowTypeError(ctx, "Hmac: digest() already called");
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "Hmac.update: data required");

    if (JS_IsString(argv[0])) {
        size_t len;
        const char *str = JS_ToCStringLen(ctx, &len, argv[0]);
        if (!str) return JS_EXCEPTION;
        int rc = EVP_MAC_update(mctx, (const unsigned char *)str, len);
        JS_FreeCString(ctx, str);
        if (rc != 1) return JS_ThrowInternalError(ctx, "EVP_MAC_update failed");
        return JS_DupValue(ctx, this_val);
    }

    size_t len;
    uint8_t *buf = JS_GetUint8Array(ctx, &len, argv[0]);
    if (!buf) return JS_ThrowTypeError(ctx, "Hmac.update: data must be string or Uint8Array/Buffer");
    if (EVP_MAC_update(mctx, buf, len) != 1)
        return JS_ThrowInternalError(ctx, "EVP_MAC_update failed");
    return JS_DupValue(ctx, this_val);
}

static JSValue js_hmac_digest(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    EVP_MAC_CTX *mctx = JS_GetOpaque(this_val, hmac_class_id);
    if (!mctx)
        return JS_ThrowTypeError(ctx, "Hmac: digest() already called");

    unsigned char md[EVP_MAX_MD_SIZE];
    size_t md_len = 0;
    int rc = EVP_MAC_final(mctx, md, &md_len, sizeof(md));
    EVP_MAC_CTX_free(mctx);
    JS_SetOpaque(this_val, NULL);
    if (rc != 1)
        return JS_ThrowInternalError(ctx, "EVP_MAC_final failed");
    return JS_NewUint8ArrayCopy(ctx, md, md_len);
}

static const JSCFunctionListEntry hmac_proto_funcs[] = {
    JS_CFUNC_DEF("update", 1, js_hmac_update),
    JS_CFUNC_DEF("digest", 0, js_hmac_digest),
};

int node_native_hmac_init(JSContext *ctx)
{
    JSRuntime *rt = JS_GetRuntime(ctx);
    if (hmac_class_id == 0)
        JS_NewClassID(rt, &hmac_class_id);
    if (!JS_IsRegisteredClass(rt, hmac_class_id)) {
        if (JS_NewClass(rt, hmac_class_id, &hmac_class) < 0)
            return -1;
    }

    JSValue proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, proto, hmac_proto_funcs,
                               countof(hmac_proto_funcs));
    JS_SetClassProto(ctx, hmac_class_id, proto);
    return 0;
}

JSValue js_node_native_create_hmac(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
    if (argc < 1 || !JS_IsString(argv[0]))
        return JS_ThrowTypeError(ctx, "createHmac: algorithm string required");
    if (argc < 2)
        return JS_ThrowTypeError(ctx, "createHmac: key required");

    const char *algo = JS_ToCString(ctx, argv[0]);
    if (!algo) return JS_EXCEPTION;
    const char *digest = resolve_digest(algo);
    JS_FreeCString(ctx, algo);
    if (!digest)
        return JS_ThrowTypeError(ctx, "createHmac: unsupported algorithm");

    const uint8_t *key_buf = NULL;
    size_t key_len = 0;
    const char *key_str = NULL;
    if (JS_IsString(argv[1])) {
        key_str = JS_ToCStringLen(ctx, &key_len, argv[1]);
        if (!key_str) return JS_EXCEPTION;
        key_buf = (const uint8_t *)key_str;
    } else {
        key_buf = JS_GetUint8Array(ctx, &key_len, argv[1]);
        if (!key_buf)
            return JS_ThrowTypeError(ctx, "createHmac: key must be string or Uint8Array/Buffer");
    }

    EVP_MAC *mac = EVP_MAC_fetch(NULL, "HMAC", NULL);
    if (!mac) {
        if (key_str) JS_FreeCString(ctx, key_str);
        return JS_ThrowInternalError(ctx, "EVP_MAC_fetch(HMAC) failed");
    }
    EVP_MAC_CTX *mctx = EVP_MAC_CTX_new(mac);
    EVP_MAC_free(mac);
    if (!mctx) {
        if (key_str) JS_FreeCString(ctx, key_str);
        return JS_ThrowOutOfMemory(ctx);
    }

    OSSL_PARAM params[2];
    params[0] = OSSL_PARAM_construct_utf8_string("digest", (char *)digest, 0);
    params[1] = OSSL_PARAM_construct_end();

    int rc = EVP_MAC_init(mctx, key_buf, key_len, params);
    if (key_str) JS_FreeCString(ctx, key_str);
    if (rc != 1) {
        EVP_MAC_CTX_free(mctx);
        return JS_ThrowInternalError(ctx, "EVP_MAC_init failed");
    }

    JSValue obj = JS_NewObjectClass(ctx, hmac_class_id);
    if (JS_IsException(obj)) {
        EVP_MAC_CTX_free(mctx);
        return obj;
    }
    JS_SetOpaque(obj, mctx);
    return obj;
}
