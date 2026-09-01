/* Minimal Node-API addon for process.dlopen / require('.node') tests. */
#define NAPI_VERSION 8
#include "node_api.h"
#include <stdint.h>
#include <stdlib.h>

static int attachment_finalizer_calls;

static void AttachmentFinalizer(napi_env env, void *data, void *hint) {
    (void)env;
    (void)hint;
    attachment_finalizer_calls++;
    free(data);
}

static napi_value Hello(napi_env env, napi_callback_info info) {
    (void)info;
    napi_value result;
    napi_status st = napi_create_string_utf8(env, "from-napi", NAPI_AUTO_LENGTH, &result);
    if (st != napi_ok) return NULL;
    return result;
}

static napi_value GetDataViewInfo(napi_env env, napi_callback_info info) {
    size_t argc = 1, length = 0, offset = 0;
    napi_value argv[1], result, value, arraybuffer;
    void *data;
    napi_status st = napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
    if (st != napi_ok || argc != 1) return NULL;
    st = napi_get_dataview_info(env, argv[0], &length, &data, &arraybuffer, &offset);
    if (st != napi_ok) return NULL;
    st = napi_create_object(env, &result);
    if (st != napi_ok) return NULL;
    st = napi_create_uint32(env, (uint32_t)offset, &value);
    if (st != napi_ok || napi_set_named_property(env, result, "offset", value) != napi_ok) return NULL;
    st = napi_create_uint32(env, (uint32_t)length, &value);
    if (st != napi_ok || napi_set_named_property(env, result, "length", value) != napi_ok) return NULL;
    st = napi_set_named_property(env, result, "buffer", arraybuffer);
    if (st != napi_ok) return NULL;
    return result;
}

/* mode 0 = napi_wrap, mode 1 = napi_add_finalizer. Returns status * 100
 * plus the number of finalizer calls made synchronously by the failed API. */
static napi_value TryFailedAttachment(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value argv[2];
    int32_t mode = -1;
    napi_value result;
    napi_status st = napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
    if (st != napi_ok || argc != 2) return NULL;
    st = napi_get_value_int32(env, argv[0], &mode);
    if (st != napi_ok) return NULL;

    void *payload = malloc(1);
    if (!payload) return NULL;
    int before = attachment_finalizer_calls;
    if (mode == 0) {
        st = napi_wrap(env, argv[1], payload, AttachmentFinalizer, NULL, NULL);
    } else if (mode == 1) {
        st = napi_add_finalizer(env, argv[1], payload, AttachmentFinalizer, NULL, NULL);
    } else {
        free(payload);
        return NULL;
    }

    int synchronous_calls = attachment_finalizer_calls - before;
    if (st != napi_ok && synchronous_calls == 0) free(payload);
    if (napi_create_int32(env, (int32_t)st * 100 + synchronous_calls, &result) != napi_ok) {
        return NULL;
    }
    return result;
}

NAPI_MODULE_INIT() {
    napi_value fn;
    napi_status st = napi_create_function(env, "hello", NAPI_AUTO_LENGTH, Hello, NULL, &fn);
    if (st != napi_ok) return NULL;
    st = napi_set_named_property(env, exports, "hello", fn);
    if (st != napi_ok) return NULL;

    napi_value tag;
    st = napi_create_string_utf8(env, "cno-napi-fixture", NAPI_AUTO_LENGTH, &tag);
    if (st != napi_ok) return NULL;
    st = napi_set_named_property(env, exports, "tag", tag);
    if (st != napi_ok) return NULL;

    st = napi_create_function(env, "tryFailedAttachment", NAPI_AUTO_LENGTH,
                              TryFailedAttachment, NULL, &fn);
    if (st != napi_ok) return NULL;
    st = napi_set_named_property(env, exports, "tryFailedAttachment", fn);
    if (st != napi_ok) return NULL;

    st = napi_create_function(env, "getDataViewInfo", NAPI_AUTO_LENGTH,
                              GetDataViewInfo, NULL, &fn);
    if (st != napi_ok) return NULL;
    st = napi_set_named_property(env, exports, "getDataViewInfo", fn);
    if (st != napi_ok) return NULL;

    return exports;
}
