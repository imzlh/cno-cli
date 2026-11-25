#include "tjs.h"
#include "utils.h"

#include <string.h>

#ifdef TEST_HTTP2
extern void h2_ns_init(JSContext *ctx, JSValue ns);
#endif
#ifdef TEST_QUIC
extern void qc_ns_init(JSContext *ctx, JSValue ns);
#endif

static void evaluate(JSContext *ctx, const char *source) {
    JSValue result = JS_Eval(ctx, source, strlen(source), "<protocol-runtime>", JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(result)) {
        JSValue error = JS_GetException(ctx);
        tjs_dump_error(ctx, error);
        JS_FreeValue(ctx, error);
        CHECK(false);
    }
    JS_FreeValue(ctx, result);
}

static void install(JSContext *ctx, bool reverse) {
    JSValue global = JS_GetGlobalObject(ctx);
    for (unsigned index = 0; index < 2; index++) {
        if ((index == 0) != reverse) {
#ifdef TEST_HTTP2
            JSValue module = JS_NewObject(ctx);
            h2_ns_init(ctx, module);
            CHECK(!JS_HasException(ctx));
            CHECK(JS_SetPropertyStr(ctx, global, "h2", module) >= 0);
#endif
        } else {
#ifdef TEST_QUIC
            JSValue module = JS_NewObject(ctx);
            qc_ns_init(ctx, module);
            CHECK(!JS_HasException(ctx));
            CHECK(JS_SetPropertyStr(ctx, global, "quic", module) >= 0);
#endif
        }
    }
    JS_FreeValue(ctx, global);
}

static void exercise(JSContext *ctx) {
#ifdef TEST_HTTP2
    evaluate(ctx,
        "globalThis.session = new h2.Session(false);"
        "let sent = 0; session.onsend = data => sent += data.byteLength;"
        "session.flush(); if (sent === 0) throw new Error('missing H2 preface');");
#endif
#ifdef TEST_QUIC
    evaluate(ctx,
        "globalThis.socket = new quic.Socket({host:'127.0.0.1', port:0});"
        "if (!(socket.localAddress.port > 0)) throw new Error('missing QUIC bound address');");
#endif
}

static void close_explicitly(JSContext *ctx) {
#ifdef TEST_HTTP2
    evaluate(ctx, "session.destroy(); session.destroy();");
#endif
#ifdef TEST_QUIC
    evaluate(ctx, "socket.close(); socket.close();");
#endif
}

#ifdef TEST_QUIC
static JSValue deny_quic_network(JSContext *ctx, const TJSCapability *capability,
                                void *userdata) {
    unsigned *calls = userdata;
    if (TJS_CAP_CATEGORY(capability->mask) != TJS_CAP_NETWORK)
        return TJS_CAPABILITY_PASS;
    CHECK(strcmp(capability->details.resource, "127.0.0.1") == 0);
    if (strcmp(capability->api, "quic.listen") == 0)
        CHECK_EQ(TJS_CAP_OPERATIONS(capability->mask), TJS_CAP_IO_LISTEN);
    else {
        CHECK(strcmp(capability->api, "quic.connect") == 0);
        CHECK_EQ(TJS_CAP_OPERATIONS(capability->mask), TJS_CAP_IO_CONNECT);
    }
    (*calls)++;
    return JS_ThrowTypeError(ctx, "protocol network denied");
}

static void check_network_capabilities(TJSRuntime *runtime) {
    unsigned calls = 0;
    CHECK(TJS_SetCapabilityHook(runtime, deny_quic_network, &calls, 0));
    evaluate(TJS_GetMainContext(runtime),
        "for (const operation of ["
        "() => new quic.Socket({isServer:true,host:'127.0.0.1',port:0}),"
        "() => socket.connect('127.0.0.1',4433)]) {"
        "let denied = false;"
        "try { operation(); } catch (error) { denied = error.message === 'protocol network denied'; }"
        "if (!denied) throw new Error('QUIC bypassed network capability hook');"
        "}");
    CHECK_EQ(calls, 2);
    CHECK(TJS_SetCapabilityHook(runtime, NULL, NULL, 0));
}
#endif

int main(void) {
    TJSRuntime *first = TJS_NewRuntime();
    TJSRuntime *second = TJS_NewRuntime();
    CHECK(first && second);
    JSContext *first_ctx = TJS_GetMainContext(first);
    JSContext *second_ctx = TJS_GetMainContext(second);
    install(first_ctx, false);

    install(second_ctx, true);
    exercise(first_ctx);
    exercise(second_ctx);
#ifdef TEST_QUIC
    check_network_capabilities(first);
#endif

    App *other = TJS_NewApp(first);
    CHECK(other);
    JSContext *other_ctx = TJS_GetJSContext(other);
    JS_AddIntrinsicBaseObjects(other_ctx);
    JS_AddIntrinsicEval(other_ctx);
    JS_AddIntrinsicTypedArrays(other_ctx);
    install(other_ctx, true);
    exercise(other_ctx);
    close_explicitly(other_ctx);
    close_explicitly(first_ctx);
    TJS_FreeRuntime(second);
    TJS_FreeRuntime(first);
    return 0;
}
