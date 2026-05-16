#include "hash.h"
#include "cutils.h"

#include <openssl/evp.h>
#include <string.h>

static JSClassID hash_class_id;

static void hash_finalizer(JSRuntime *rt, JSValue val)
{
    EVP_MD_CTX *mctx = JS_GetOpaque(val, hash_class_id);
    if (mctx)
        EVP_MD_CTX_free(mctx);
}

static const JSClassDef hash_class = {
    .class_name = "Hash",
    .finalizer = hash_finalizer,
};

static const EVP_MD *resolve_md(const char *algo)
{
    if (!strcmp(algo, "sha1"))   return EVP_sha1();
    if (!strcmp(algo, "sha256")) return EVP_sha256();
    if (!strcmp(algo, "sha512")) return EVP_sha512();
    if (!strcmp(algo, "md5"))    return EVP_md5();
    return NULL;
}

static JSValue js_hash_update(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    EVP_MD_CTX *mctx = JS_GetOpaque(this_val, hash_class_id);
    if (!mctx)
        return JS_ThrowTypeError(ctx, "Hash: digest() already called");
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "Hash.update: data required");

    if (JS_IsString(argv[0])) {
        size_t len;
        const char *str = JS_ToCStringLen(ctx, &len, argv[0]);
        if (!str) return JS_EXCEPTION;
        int rc = EVP_DigestUpdate(mctx, str, len);
        JS_FreeCString(ctx, str);
        if (rc != 1) return JS_ThrowInternalError(ctx, "EVP_DigestUpdate failed");
        return JS_DupValue(ctx, this_val);
    }

    size_t len;
    uint8_t *buf = JS_GetUint8Array(ctx, &len, argv[0]);
    if (!buf) return JS_ThrowTypeError(ctx, "Hash.update: data must be string or Uint8Array/Buffer");
    if (EVP_DigestUpdate(mctx, buf, len) != 1)
        return JS_ThrowInternalError(ctx, "EVP_DigestUpdate failed");
    return JS_DupValue(ctx, this_val);
}

static JSValue js_hash_digest(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    EVP_MD_CTX *mctx = JS_GetOpaque(this_val, hash_class_id);
    if (!mctx)
        return JS_ThrowTypeError(ctx, "Hash: digest() already called");

    unsigned char md[EVP_MAX_MD_SIZE];
    unsigned int md_len = 0;
    int rc = EVP_DigestFinal_ex(mctx, md, &md_len);
    EVP_MD_CTX_free(mctx);
    JS_SetOpaque(this_val, NULL);
    if (rc != 1)
        return JS_ThrowInternalError(ctx, "EVP_DigestFinal_ex failed");
    return JS_NewUint8ArrayCopy(ctx, md, md_len);
}

static const JSCFunctionListEntry hash_proto_funcs[] = {
    JS_CFUNC_DEF("update", 1, js_hash_update),
    JS_CFUNC_DEF("digest", 0, js_hash_digest),
};

int node_native_hash_init(JSContext *ctx)
{
    JSRuntime *rt = JS_GetRuntime(ctx);
    if (hash_class_id == 0)
        JS_NewClassID(rt, &hash_class_id);
    if (!JS_IsRegisteredClass(rt, hash_class_id)) {
        if (JS_NewClass(rt, hash_class_id, &hash_class) < 0)
            return -1;
    }

    JSValue proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, proto, hash_proto_funcs,
                               countof(hash_proto_funcs));
    JS_SetClassProto(ctx, hash_class_id, proto);
    return 0;
}

JSValue js_node_native_create_hash(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
    if (argc < 1 || !JS_IsString(argv[0]))
        return JS_ThrowTypeError(ctx, "createHash: algorithm string required");

    const char *algo = JS_ToCString(ctx, argv[0]);
    if (!algo) return JS_EXCEPTION;
    const EVP_MD *md = resolve_md(algo);
    JS_FreeCString(ctx, algo);
    if (!md)
        return JS_ThrowTypeError(ctx, "createHash: unsupported algorithm");

    EVP_MD_CTX *mctx = EVP_MD_CTX_new();
    if (!mctx)
        return JS_ThrowOutOfMemory(ctx);
    if (EVP_DigestInit_ex(mctx, md, NULL) != 1) {
        EVP_MD_CTX_free(mctx);
        return JS_ThrowInternalError(ctx, "EVP_DigestInit_ex failed");
    }

    JSValue obj = JS_NewObjectClass(ctx, hash_class_id);
    if (JS_IsException(obj)) {
        EVP_MD_CTX_free(mctx);
        return obj;
    }
    JS_SetOpaque(obj, mctx);
    return obj;
}
