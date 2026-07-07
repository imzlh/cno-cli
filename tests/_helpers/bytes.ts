const engine = import.meta.use('engine');

export const encodeUtf8 = (text: string): Uint8Array => engine.encodeString(text);

export const decodeUtf8 = (data: string | Uint8Array | ArrayBufferLike): string => {
    return typeof data === 'string' ? data : engine.decodeString(data);
};
