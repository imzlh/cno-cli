import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert';

Deno.test('webapi upstream: FileReader constants and initial state', () => {
    const reader = new FileReader();
    strictEqual(reader.readyState, FileReader.EMPTY);
    strictEqual(FileReader.EMPTY, 0);
    strictEqual(FileReader.LOADING, 1);
    strictEqual(FileReader.DONE, 2);
});

Deno.test('webapi upstream: FileReader reads Blob text and dispatches ordered events', async () => {
    await new Promise<void>((resolve) => {
        const reader = new FileReader();
        const calls: string[] = [];

        reader.addEventListener('loadstart', () => calls.push('listener-loadstart'));
        reader.addEventListener('progress', (event) => {
            strictEqual(reader.readyState, FileReader.LOADING);
            strictEqual((event as ProgressEvent).lengthComputable, true);
            calls.push('listener-progress');
        });
        reader.addEventListener('load', () => calls.push('listener-load'));
        reader.addEventListener('loadend', () => calls.push('listener-loadend-1'));
        reader.onloadend = (event) => {
            calls.push('onloadend');
            strictEqual(reader.readyState, FileReader.DONE);
            strictEqual(reader.result, 'Hello World');
            strictEqual(event.lengthComputable, true);
        };
        reader.addEventListener('loadend', () => {
            calls.push('listener-loadend-2');
            deepStrictEqual(calls, [
                'listener-loadstart',
                'listener-progress',
                'listener-load',
                'listener-loadend-1',
                'onloadend',
                'listener-loadend-2',
            ]);
            resolve();
        });

        reader.readAsText(new Blob(['Hello World']));
    });
});

Deno.test('webapi upstream: FileReader skips first loadend when load starts another read', async () => {
    const reader = new FileReader();
    await new Promise<void>((resolve) => {
        const seen: string[] = [];

        reader.onload = () => {
            seen.push(String(reader.result));
            if (reader.result === 'First load') {
                reader.readAsText(new Blob(['Second load']));
            }
        };
        reader.onloadend = () => {
            deepStrictEqual(seen, ['First load', 'Second load']);
            strictEqual(reader.result, 'Second load');
            resolve();
        };

        reader.readAsText(new Blob(['First load']));
    });
});

Deno.test('webapi upstream: FileReader reads ArrayBuffer and data URL', async () => {
    await new Promise<void>((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            ok(reader.result instanceof ArrayBuffer);
            strictEqual(new TextDecoder().decode(reader.result), 'Hello World');
            resolve();
        };
        reader.readAsArrayBuffer(new Blob(['Hello World']));
    });

    await new Promise<void>((resolve) => {
        const reader = new FileReader();
        reader.onloadend = (event) => {
            strictEqual(reader.result, 'data:application/octet-stream;base64,SGVsbG8gV29ybGQ=');
            strictEqual(event.lengthComputable, true);
            resolve();
        };
        reader.readAsDataURL(new Blob(['Hello World']));
    });
});

Deno.test('webapi upstream: FileReader reads binary string and rejects concurrent reads', async () => {
    await new Promise<void>((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            strictEqual(reader.result, '\x00A\xff');
            resolve();
        };
        reader.readAsBinaryString(new Blob([new Uint8Array([0, 65, 255])]));
    });

    await new Promise<void>((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            strictEqual(reader.result, 'busy');
            resolve();
        };
        reader.readAsText(new Blob(['busy']));
        throws(() => reader.readAsText(new Blob(['second'])), /InvalidStateError/);
    });
});

Deno.test('webapi upstream: FileReader abort before read is a no-op', async () => {
    const reader = new FileReader();
    let fired = false;
    reader.onabort = () => { fired = true; };
    reader.onloadend = () => { fired = true; };

    reader.abort();
    strictEqual(reader.readyState, FileReader.EMPTY);
    strictEqual(reader.result, null);
    strictEqual(reader.error, null);
    await new Promise((resolve) => setTimeout(resolve, 5));
    strictEqual(fired, false);
});

Deno.test('webapi upstream: FileReader abort cancels load and emits abort loadend', async () => {
    await new Promise<void>((resolve) => {
        const reader = new FileReader();
        const calls: string[] = [];

        reader.onload = () => calls.push('load');
        reader.onabort = () => calls.push('abort');
        reader.onloadend = (event) => {
            calls.push('loadend');
            deepStrictEqual(calls, ['abort', 'loadend']);
            strictEqual(reader.readyState, FileReader.DONE);
            strictEqual(reader.result, null);
            strictEqual(event.lengthComputable, false);
            resolve();
        };

        reader.readAsDataURL(new Blob(['Hello World']));
        reader.abort();
    });
});

Deno.test('webapi upstream: ImageData constructs unorm8 data with defaults', () => {
    const imageData = new ImageData(16, 9);
    strictEqual(imageData.data.constructor, Uint8ClampedArray);
    strictEqual(imageData.data.length, 16 * 9 * 4);
    strictEqual(imageData.width, 16);
    strictEqual(imageData.height, 9);
    strictEqual(imageData.pixelFormat, 'rgba-unorm8');
    strictEqual(imageData.colorSpace, 'srgb');
});

Deno.test('webapi upstream: ImageData accepts existing data and settings', () => {
    const unorm8 = new Uint8ClampedArray(16 * 9 * 4);
    const imageData = new ImageData(unorm8, 16, 9, { colorSpace: 'display-p3' });
    strictEqual(imageData.data, unorm8);
    strictEqual(imageData.width, 16);
    strictEqual(imageData.height, 9);
    strictEqual(imageData.pixelFormat, 'rgba-unorm8');
    strictEqual(imageData.colorSpace, 'display-p3');

    const float16 = new Float16Array(16 * 9 * 4);
    const floatData = new ImageData(float16, 16, undefined, { pixelFormat: 'rgba-float16' });
    strictEqual(floatData.data, float16);
    strictEqual(floatData.height, 9);
    strictEqual(floatData.pixelFormat, 'rgba-float16');
});

Deno.test('webapi upstream: ImageData validates dimensions data length and settings', () => {
    throws(() => new ImageData(0, 1), RangeError);
    throws(() => new ImageData(1, -1), RangeError);
    throws(() => new ImageData(1.5, 1), RangeError);
    throws(() => new ImageData(new Uint8ClampedArray(3), 1), RangeError);
    throws(() => new ImageData(new Uint8ClampedArray(8), 1, 3), RangeError);
    throws(() => new ImageData(new Uint8ClampedArray(4), 1, 1, { pixelFormat: 'rgba-float16' }), TypeError);
    throws(() => new ImageData(new Float16Array(4), 1, 1, { pixelFormat: 'rgba-unorm8' }), TypeError);
    throws(() => new ImageData(1, 1, { colorSpace: 'bad' as PredefinedColorSpace }), TypeError);
    throws(() => new ImageData(1, 1, { pixelFormat: 'bad' as ImageDataPixelFormat }), TypeError);
});
