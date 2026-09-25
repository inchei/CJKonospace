import mergePy from "@/lib/mergeScript";

const PYODIDE_VERSION = "0.27.7";
const PYODIDE_BASE = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

interface GenRequest {
  mono: ArrayBuffer;
  cjk: ArrayBuffer;
  params: unknown;
}

type GenMessage =
  | { type: "progress"; stage: string; value?: number }
  | { type: "done"; data: ArrayBuffer; meta: unknown }
  | { type: "error"; message: string };

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
  postMessage(m: GenMessage): void;
  addEventListener(
    type: "message",
    cb: (ev: MessageEvent<GenRequest>) => void,
  ): void;
};
const post = (m: GenMessage) => scope.postMessage(m);

let pyodidePromise: Promise<PyodideLike> | null = null;

function loadPyodideOnce(): Promise<PyodideLike> {
  if (!pyodidePromise) {
    pyodidePromise = (async () => {
      post({ type: "progress", stage: "runtime" });
      const mod = (await import(
        /* @vite-ignore */ `${PYODIDE_BASE}pyodide.mjs`
      )) as { loadPyodide(opts: { indexURL: string }): Promise<PyodideLike> };
      const py = await mod.loadPyodide({ indexURL: PYODIDE_BASE });
      post({ type: "progress", stage: "packages" });
      await py.loadPackage(["fonttools", "brotli"]);
      return py;
    })();
  }
  return pyodidePromise;
}

scope.addEventListener("message", (ev: MessageEvent<GenRequest>) => {
  void (async () => {
    try {
      const { mono, cjk, params } = ev.data;
      const py = await loadPyodideOnce();
      py.FS.writeFile("mono.ttf", new Uint8Array(mono));
      py.FS.writeFile("cjk.ttf", new Uint8Array(cjk));
      py.FS.writeFile("params.json", JSON.stringify(params));
      py.FS.writeFile("merge_font.py", mergePy);
      py.globals.set("js_progress", (stage: string, value?: number) =>
        post({ type: "progress", stage, value }),
      );
      await py.runPythonAsync(`
import json, merge_font
with open("params.json") as f:
    __params = json.load(f)
__meta = merge_font.merge("mono.ttf", "cjk.ttf", "out.ttf", __params, progress=js_progress)
with open("meta.json", "w") as f:
    json.dump(__meta, f)
`);
      const out = py.FS.readFile("out.ttf");
      const data = out.buffer.slice(
        out.byteOffset,
        out.byteOffset + out.byteLength,
      ) as ArrayBuffer;
      const meta = JSON.parse(
        new TextDecoder().decode(py.FS.readFile("meta.json")),
      );
      post({ type: "done", data, meta });
    } catch (e) {
      post({
        type: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  })();
});
