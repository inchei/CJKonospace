import mergePy from "@/lib/mergeScript";

const PYODIDE_VERSION = "0.27.7";
const PYODIDE_BASE = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

interface Request {
  id: number;
  op: "merge";
  mono: ArrayBuffer;
  cjk: ArrayBuffer;
  params: unknown;
}

type Response =
  | { id: number; type: "progress"; stage: string; value?: number }
  | { id: number; type: "done"; data: ArrayBuffer; meta?: unknown }
  | { id: number; type: "error"; message: string };

interface PyodideLike {
  FS: {
    writeFile(path: string, data: Uint8Array | string): void;
    readFile(path: string): Uint8Array;
  };
  globals: { set(name: string, value: unknown): void };
  runPythonAsync(code: string): Promise<unknown>;
  loadPackage(names: string[]): Promise<void>;
}

const scope = self as unknown as {
  postMessage(m: Response): void;
  addEventListener(
    type: "message",
    cb: (ev: MessageEvent<Request>) => void,
  ): void;
};

let pyodidePromise: Promise<PyodideLike> | null = null;

function loadPyodideOnce(
  post: (m: Response) => void,
  id: number,
): Promise<PyodideLike> {
  if (!pyodidePromise) {
    pyodidePromise = (async () => {
      post({ id, type: "progress", stage: "runtime" });
      const mod = (await import(
        /* @vite-ignore */ `${PYODIDE_BASE}pyodide.mjs`
      )) as { loadPyodide(opts: { indexURL: string }): Promise<PyodideLike> };
      const py = await mod.loadPyodide({ indexURL: PYODIDE_BASE });
      post({ id, type: "progress", stage: "packages" });
      await py.loadPackage(["fonttools", "brotli"]);
      return py;
    })().catch((e) => {
      pyodidePromise = null; // allow a retry on the next request
      throw e;
    });
  }
  return pyodidePromise;
}

function slice(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength,
  ) as ArrayBuffer;
}

async function runMerge(
  py: PyodideLike,
  req: Request,
  post: (m: Response) => void,
): Promise<ArrayBuffer> {
  py.FS.writeFile("mono.ttf", new Uint8Array(req.mono));
  py.FS.writeFile("cjk.ttf", new Uint8Array(req.cjk));
  py.FS.writeFile("params.json", JSON.stringify(req.params));
  py.FS.writeFile("merge_font.py", mergePy);
  py.globals.set("js_progress", (stage: string, value?: number) =>
    post({ id: req.id, type: "progress", stage, value }),
  );
  await py.runPythonAsync(`
import json, merge_font
with open("params.json") as f:
    __params = json.load(f)
__meta = merge_font.merge("mono.ttf", "cjk.ttf", "out.ttf", __params, progress=js_progress)
with open("meta.json", "w") as f:
    json.dump(__meta, f)
`);
  return slice(py.FS.readFile("out.ttf"));
}

scope.addEventListener("message", (ev: MessageEvent<Request>) => {
  void (async () => {
    const req = ev.data;
    const post = (m: Response) => scope.postMessage(m);
    try {
      const py = await loadPyodideOnce(post, req.id);
      const data = await runMerge(py, req, post);
      const meta = JSON.parse(
        new TextDecoder().decode(py.FS.readFile("meta.json")),
      );
      post({ id: req.id, type: "done", data, meta });
    } catch (e) {
      post({
        id: req.id,
        type: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  })();
});
