/* Minimal Node-API addon for process.dlopen / require('.node') tests. */
#define NAPI_VERSION 8
#include "node_api.h"

static napi_value Hello(napi_env env, napi_callback_info info) {
    (void)info;
    napi_value result;
    napi_status st = napi_create_string_utf8(env, "from-napi", NAPI_AUTO_LENGTH, &result);
    if (st != napi_ok) return NULL;
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

    return exports;
}
