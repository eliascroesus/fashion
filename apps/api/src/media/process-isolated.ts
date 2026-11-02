import { Worker } from 'node:worker_threads';
import { ImageRejectedError, type ProcessedImage } from './image.ts';

type WorkerReply =
  { ok: true; result: ProcessedImage } | { ok: false; rejected: boolean; message: string };

/** processImage in a short-lived worker thread (see image-worker.ts). */
export function processImageIsolated(input: Buffer): Promise<ProcessedImage> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./image-worker.ts', import.meta.url), {
      workerData: { input },
      // Don't inherit the server's flags (e.g. `--import instrument.ts`).
      execArgv: [],
    });
    let settled = false;
    worker.once('message', (reply: WorkerReply) => {
      settled = true;
      if (reply.ok) {
        // Buffers arrive as plain Uint8Arrays after crossing threads.
        const variants = reply.result.variants.map((v) => ({ ...v, body: Buffer.from(v.body) }));
        resolve({ ...reply.result, variants });
      } else {
        reject(reply.rejected ? new ImageRejectedError(reply.message) : new Error(reply.message));
      }
      void worker.terminate();
    });
    worker.once('error', (error) => {
      settled = true;
      reject(error);
    });
    worker.once('exit', (code) => {
      if (!settled) reject(new Error(`Image worker stopped (exit code ${String(code)}).`));
    });
  });
}
