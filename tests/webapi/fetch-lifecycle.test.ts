import { rejects, strictEqual } from 'node:assert';
import { setFetchInterceptHook } from '../../cno/src/utils/network-hooks.ts';

/**
 * A rejected CDP interception happens before curl.perform() creates its
 * completion callback. It must still detach the request's abort listener.
 */
Deno.test({ name: 'fetch cleanup: rejected interception detaches the request abort listener', timeout: 10000 }, async () => {
    const proto = AbortSignal.prototype as AbortSignal & {
        addEventListener: typeof AbortSignal.prototype.addEventListener;
        removeEventListener: typeof AbortSignal.prototype.removeEventListener;
    };
    const originalAdd = proto.addEventListener;
    const originalRemove = proto.removeEventListener;
    let abortAdds = 0;
    let abortRemoves = 0;

    proto.addEventListener = function(type: string, ...args: any[]): void {
        if (type === 'abort') abortAdds++;
        Reflect.apply(originalAdd, this, [type, ...args] as any);
    } as typeof proto.addEventListener;
    proto.removeEventListener = function(type: string, ...args: any[]): void {
        if (type === 'abort') abortRemoves++;
        Reflect.apply(originalRemove, this, [type, ...args] as any);
    } as typeof proto.removeEventListener;

    // A small structural signal avoids counting Request.followSignal's source
    // listener; only performFetch's derived signal uses the native prototype.
    const source = {
        aborted: false,
        reason: undefined,
        addEventListener() {},
        removeEventListener() {},
    } as unknown as AbortSignal;
    const failure = new Error('interceptor failed');
    setFetchInterceptHook({ onRequest: async () => { throw failure; } });
    try {
        await rejects(
            fetch('http://127.0.0.1:1/', { signal: source }),
            (error: unknown) => error === failure,
        );
        strictEqual(abortAdds, 1, 'fetch must register one derived abort listener');
        strictEqual(abortRemoves, 1, 'fetch must remove the derived abort listener on interceptor failure');
    } finally {
        setFetchInterceptHook(null);
        proto.addEventListener = originalAdd;
        proto.removeEventListener = originalRemove;
    }
});
