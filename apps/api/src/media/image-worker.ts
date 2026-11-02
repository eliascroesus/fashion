// Runs processImage in its own thread: the server keeps answering while a
// photo decodes, and HEIC's WebAssembly memory is released when it exits.
import { parentPort, workerData } from 'node:worker_threads';
import { ImageRejectedError, processImage } from './image.ts';

const { input } = workerData as { input: Uint8Array };
try {
  const result = await processImage(Buffer.from(input.buffer, input.byteOffset, input.byteLength));
  parentPort?.postMessage({ ok: true, result });
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    rejected: error instanceof ImageRejectedError,
    message: error instanceof Error ? error.message : String(error),
  });
}
