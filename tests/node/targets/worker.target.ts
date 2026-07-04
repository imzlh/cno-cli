// Worker target for worker_threads test.
import { parentPort, workerData } from 'node:worker_threads';
if (parentPort) {
    parentPort.on('message', (msg) => {
        if (msg === 'ping') parentPort.postMessage({ reply: 'pong', data: workerData });
        if (msg === 'done') parentPort.postMessage('finished');
    });
}
// signal ready
parentPort?.postMessage('online');
