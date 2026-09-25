export interface ExportProgress {
  stage: string;
  value?: number;
}

export interface GenerateResult {
  data: ArrayBuffer;
  meta: { added?: number; upem?: number };
}

interface WorkerDone {
  type: "done";
  data: ArrayBuffer;
  meta: GenerateResult["meta"];
}
interface WorkerProgress {
  type: "progress";
  stage: string;
  value?: number;
}
interface WorkerError {
  type: "error";
  message: string;
}
type WorkerMessage = WorkerDone | WorkerProgress | WorkerError;

/**
 * Run the fontTools merge (mono as base, CJK appended) inside a Web Worker.
 * Buffers are cloned (not transferred) so the caller keeps using them.
 */
export function generateFont(
  input: { mono: ArrayBuffer; cjk: ArrayBuffer; params: unknown },
  onProgress: (p: ExportProgress) => void,
): Promise<GenerateResult> {
  const { mono, cjk, params } = input;
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./export/mergeWorker.ts", import.meta.url),
      { type: "module" },
    );
    const cleanup = () => worker.terminate();
    worker.onmessage = (ev: MessageEvent<WorkerMessage>) => {
      const m = ev.data;
      if (m.type === "progress") {
        onProgress({ stage: m.stage, value: m.value });
      } else if (m.type === "done") {
        cleanup();
        resolve({ data: m.data, meta: m.meta });
      } else {
        cleanup();
        reject(new Error(m.message));
      }
    };
    worker.onerror = (ev) => {
      cleanup();
      reject(new Error(ev.message || "worker error"));
    };
    worker.postMessage({ mono, cjk, params });
  });
}
