export interface ExportProgress {
  stage: string;
  value?: number;
}

export interface GenerateResult {
  data: ArrayBuffer;
  meta: { added?: number; upem?: number };
}

interface Request {
  id: number;
  op: "merge";
  mono: ArrayBuffer;
  cjk: ArrayBuffer;
  params: unknown;
}

type WorkerResponse =
  | { id: number; type: "progress"; stage: string; value?: number }
  | {
      id: number;
      type: "done";
      data: ArrayBuffer;
      meta?: GenerateResult["meta"];
    }
  | { id: number; type: "error"; message: string };

interface Pending {
  resolve: (r: Extract<WorkerResponse, { type: "done" }>) => void;
  reject: (e: Error) => void;
  onProgress: (p: ExportProgress) => void;
}

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, Pending>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./export/mergeWorker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const m = ev.data;
      const p = pending.get(m.id);
      if (!p) return;
      if (m.type === "progress") {
        p.onProgress({ stage: m.stage, value: m.value });
      } else if (m.type === "done") {
        pending.delete(m.id);
        p.resolve(m);
      } else {
        pending.delete(m.id);
        p.reject(new Error(m.message));
      }
    };
    worker.onerror = (ev) => {
      const err = new Error(ev.message || "worker error");
      for (const p of pending.values()) p.reject(err);
      pending.clear();
    };
  }
  return worker;
}

/**
 * Run the fontTools merge (mono as base, CJK appended) inside the shared worker.
 * The worker (and its pyodide runtime) is reused across calls. Buffers are
 * cloned (not transferred) so the caller keeps using them.
 */
export function generateFont(
  input: { mono: ArrayBuffer; cjk: ArrayBuffer; params: unknown },
  onProgress: (p: ExportProgress) => void,
): Promise<GenerateResult> {
  const id = ++seq;
  return new Promise<Extract<WorkerResponse, { type: "done" }>>(
    (resolve, reject) => {
      pending.set(id, { resolve, reject, onProgress });
      getWorker().postMessage({
        id,
        op: "merge",
        mono: input.mono,
        cjk: input.cjk,
        params: input.params,
      } as Request);
    },
  ).then(({ data, meta }) => ({ data, meta: meta ?? {} }));
}
