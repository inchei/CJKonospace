import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import "@/lib/i18n";
import { loadFont, type LoadedFont } from "@/fontLoader";
import { isWoff2, toSfnt, toWoff2 } from "@/woff2";
import { inspectTTC, isTTC, type TTCFace } from "@/ttc";
import { DEFAULT_PARAMS, type Params } from "@/params";
import { renderPreview } from "@/preview";
import { ensureShaping, shapeMonoRun } from "@/shaper";
import { generateFont, type ExportProgress } from "@/exporter";
import { buildStandaloneScript } from "@/lib/mergeScript";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { LANGS } from "@/lib/i18n";
import { MONO_PRESETS, type MonoPreset } from "@/lib/monoPresets";

const CJK_BG = "#ff85a1";
const MONO_BG = "#70d6ff";
const REPO_URL = "https://github.com/inchei/CJKonospace";

// long labels in the narrow sidebar: wrap instead of overflowing the fixed-height,
// nowrap default button styles
const WRAP_BTN = "h-auto min-w-0 whitespace-normal py-2 leading-tight";

/** Slider labels go through i18n keys; defs keep numeric info only */
interface SliderDef {
  key: keyof Params;
  labelKey: string;
  min: number;
  max: number;
  step: number;
  disabledWhen?: (p: Params) => boolean;
  slot?: "cjk" | "mono";
  format?: (v: number) => string;
}

const SLIDERS: SliderDef[] = [
  { key: "fontSize", labelKey: "params.fontSize", min: 12, max: 160, step: 1 },
  {
    key: "monoAdvMul",
    labelKey: "params.monoAdvMul",
    min: 0.5,
    max: 2,
    step: 0.01,
    slot: "mono",
    format: f2,
  },
  {
    key: "monoGlyphScale",
    labelKey: "params.monoGlyphScale",
    min: 0.3,
    max: 2,
    step: 0.01,
    slot: "mono",
    format: f2,
  },
  {
    key: "monoGlyphScaleY",
    labelKey: "params.monoGlyphScaleY",
    min: 0.3,
    max: 2,
    step: 0.01,
    slot: "mono",
    format: f2,
  },
  {
    key: "monoBaselineOffset",
    labelKey: "params.monoBaselineOffset",
    min: -40,
    max: 40,
    step: 0.5,
    slot: "mono",
    format: f1,
  },
  {
    key: "cjkAdvMul",
    labelKey: "params.cjkAdvMul",
    min: 0.5,
    max: 3,
    step: 0.01,
    slot: "cjk",
    disabledWhen: (p) => p.lock2to1,
    format: f2,
  },
  {
    key: "cjkGlyphScale",
    labelKey: "params.cjkGlyphScale",
    min: 0.3,
    max: 2,
    step: 0.01,
    slot: "cjk",
    format: f2,
  },
  {
    key: "cjkGlyphScaleY",
    labelKey: "params.cjkGlyphScaleY",
    min: 0.3,
    max: 2,
    step: 0.01,
    slot: "cjk",
    format: f2,
  },
  {
    key: "cjkBaselineOffset",
    labelKey: "params.cjkBaselineOffset",
    min: -40,
    max: 40,
    step: 0.5,
    slot: "cjk",
    format: f1,
  },
];

function f2(v: number) {
  return v.toFixed(2);
}
function f1(v: number) {
  return v.toFixed(1);
}

/**
 * Numeric field paired with a slider: type a value or drag, clamped to range.
 * The registry has no Number component, so this composes the official Input
 * (a generic <input>, type="number") with slider-specific behaviour.
 */
function NumberField({
  value,
  min,
  max,
  step,
  format,
  color,
  onCommit,
  ariaLabel,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
  color?: string;
  onCommit: (v: number) => void;
  ariaLabel: string;
}) {
  const fmt = format ?? String;
  const [text, setText] = useState(() => fmt(value));
  const [focused, setFocused] = useState(false);
  const [seen, setSeen] = useState(value);

  // mirror an externally changed value into the field, unless the user is editing
  if (!focused && value !== seen) {
    setSeen(value);
    setText(fmt(value));
  }

  const clamp = (n: number) => Math.min(max, Math.max(min, n));

  return (
    <Input
      type="number"
      inputMode="decimal"
      value={text}
      min={min}
      max={max}
      step={step}
      aria-label={ariaLabel}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        const n = Number(text);
        const next = text.trim() === "" || Number.isNaN(n) ? value : clamp(n);
        setText(fmt(next));
        onCommit(next);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
      onChange={(e) => {
        const raw = e.target.value;
        setText(raw);
        const n = Number(raw);
        if (raw.trim() !== "" && !Number.isNaN(n)) onCommit(clamp(n));
      }}
      className={cn(
        "h-7 w-20 shrink-0 px-1.5 py-0 text-right text-xs",
        color && "text-black",
      )}
      style={color ? { backgroundColor: color } : undefined}
    />
  );
}

interface SlotState {
  font: LoadedFont | null;
  error: string | null;
  busy: boolean;
  /** overrides the generic "downloading" label while busy (e.g. woff2 dependency) */
  busyLabel: string | null;
  /** set when the chosen file was a TTC, so the face can be switched later */
  ttc: {
    buffer: ArrayBuffer;
    fileName: string;
    faces: TTCFace[];
    index: number;
  } | null;
}

/** Prefer the TTC face matching the UI language (Noto CJK ships JP/KR/SC/TC/HK). */
function pickTtcFace(faces: TTCFace[], lang: string): number {
  const token = lang.startsWith("zh-Hant")
    ? "TC"
    : lang.startsWith("zh-Hans")
      ? "SC"
      : lang.startsWith("ja")
        ? "JP"
        : lang.startsWith("ko")
          ? "KR"
          : "";
  if (token) {
    const found = faces.find((f) =>
      new RegExp(`(^|[^A-Za-z])${token}($|[^A-Za-z])`).test(f.family),
    );
    if (found) return found.index;
  }
  return faces[0]?.index ?? 0;
}

export default function App() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;

  // keep <html lang> and <title> in sync with the active language
  useEffect(() => {
    document.documentElement.lang = lang;
    document.title = t("docTitle");
  }, [lang, t]);

  const [cjk, setCjk] = useState<SlotState>({
    font: null,
    error: null,
    busy: false,
    busyLabel: null,
    ttc: null,
  });
  const [mono, setMono] = useState<SlotState>({
    font: null,
    error: null,
    busy: false,
    busyLabel: null,
    ttc: null,
  });
  const [params, setParams] = useState<Params>(() => ({
    ...DEFAULT_PARAMS,
    text: t("sampleText"),
  }));
  // true once the user edits the sample text; untouched text follows the language
  const textTouched = useRef(false);
  const [showGrid, setShowGrid] = useState(true);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [testText, setTestText] = useState(() => t("sampleText"));
  const [gen, setGen] = useState<{
    status: "idle" | "running" | "done" | "error";
    stage?: string;
    value?: number;
    error?: string;
    url?: string;
    fileName?: string;
    added?: number;
  }>({ status: "idle" });
  const genUrlRef = useRef<string | null>(null);
  const genBytesRef = useRef<ArrayBuffer | null>(null);
  const [woff2, setWoff2] = useState<{ busy: boolean; error: string | null }>({
    busy: false,
    error: null,
  });

  useEffect(
    () => () => {
      if (genUrlRef.current) URL.revokeObjectURL(genUrlRef.current);
    },
    [],
  );

  /** The exact object handed to merge_font.py (wasm and CLI share it). */
  function buildMergePayload() {
    const sanitize = (s: string) => s.replace(/[\\/:*?"<>|\s]+/g, "");
    const joined =
      `${sanitize(cjk.font?.meta.familyName ?? "")}_${sanitize(mono.font?.meta.familyName ?? "")}`.replace(
        /^_+|_+$/g,
        "",
      );
    return {
      fs: params.fontSize,
      lock2to1: params.lock2to1,
      familyName: joined || "CJKonospace",
      styleName: "Regular",
      mono: {
        advMul: params.monoAdvMul,
        gsx: params.monoGlyphScale,
        gsy: params.monoGlyphScaleY,
        baseline: params.monoBaselineOffset,
        ttcIndex: mono.ttc?.index ?? 0,
      },
      cjk: {
        advMul: params.cjkAdvMul,
        gsx: params.cjkGlyphScale,
        gsy: params.cjkGlyphScaleY,
        baseline: params.cjkBaselineOffset,
        ttcIndex: cjk.ttc?.index ?? 0,
      },
    };
  }

  function download(filename: string, content: string, type: string) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  /** Export a self-contained build.py (fontTools only, params baked in). */
  function handleExportBuild() {
    if (!mono.font || !cjk.font) return;
    download(
      "build.py",
      buildStandaloneScript(buildMergePayload()),
      "text/x-python",
    );
  }

  async function handleGenerate() {
    if (!mono.font || !cjk.font) return;
    setGen({ status: "running" });
    const payload = buildMergePayload();
    const family = payload.familyName;
    try {
      const { data, meta } = await generateFont(
        { mono: mono.font.buffer, cjk: cjk.font.buffer, params: payload },
        (p: ExportProgress) =>
          setGen((g) => ({
            ...g,
            status: "running",
            stage: p.stage,
            value: p.value,
          })),
      );
      if (genUrlRef.current) URL.revokeObjectURL(genUrlRef.current);
      const url = URL.createObjectURL(new Blob([data], { type: "font/ttf" }));
      genUrlRef.current = url;
      genBytesRef.current = data;
      setWoff2({ busy: false, error: null });
      const face = new FontFace("CJKonoGenerated", data);
      await face.load();
      document.fonts.add(face);
      setGen({
        status: "done",
        url,
        fileName: `${family}.ttf`,
        added: meta.added,
      });
    } catch (e) {
      setGen({
        status: "error",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /** Repackage the generated TTF as WOFF2 (lazy woff2-encoder) and download it. */
  async function handleDownloadWoff2() {
    const bytes = genBytesRef.current;
    if (!bytes || !gen.fileName) return;
    setWoff2({ busy: true, error: null });
    try {
      const out = await toWoff2(bytes.slice(0));
      const url = URL.createObjectURL(new Blob([out], { type: "font/woff2" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = gen.fileName.replace(/\.ttf$/, ".woff2");
      a.click();
      URL.revokeObjectURL(url);
      setWoff2({ busy: false, error: null });
    } catch (e) {
      setWoff2({
        busy: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (canvas) {
      renderPreview(
        canvas,
        {
          cjkFont: cjk.font,
          monoFont: mono.font,
          params,
          overrides: {},
          shapeMono: (font, text) => shapeMonoRun(font, text),
        },
        { showGrid, hint: t("previewHint") },
      );
    }
  }, [cjk, mono, params, showGrid, t]);

  useEffect(draw, [draw, showGrid]);

  // swap in the new language's sample text unless the user customized it
  useEffect(() => {
    if (!textTouched.current) {
      setParams((p) => ({ ...p, text: t("sampleText") }));
    }
  }, [lang, t]);

  // harfbuzz loads lazily; re-draw shaped once ready (falls back silently before that)
  const drawRef = useRef(draw);
  drawRef.current = draw;
  useEffect(() => {
    ensureShaping().then((ok) => {
      if (ok) drawRef.current();
    });
  }, []);

  async function setSlot(slot: "cjk" | "mono", file: File | undefined) {
    if (!file) return;
    const setter = slot === "cjk" ? setCjk : setMono;
    setGen({ status: "idle" });
    setter((s) => ({ ...s, busy: true, busyLabel: null, error: null }));
    try {
      const buf = await file.arrayBuffer();
      if (isWoff2(buf)) {
        setter((s) => ({ ...s, busyLabel: t("load.woff2") }));
      }
      const sfnt = await toSfnt(buf);
      if (isTTC(sfnt)) {
        const faces = inspectTTC(sfnt);
        const index = pickTtcFace(faces, lang);
        setter({
          font: loadFont(sfnt, file.name, index),
          error: null,
          busy: false,
          busyLabel: null,
          ttc: { buffer: sfnt, fileName: file.name, faces, index },
        });
      } else {
        setter({
          font: loadFont(sfnt, file.name),
          error: null,
          busy: false,
          busyLabel: null,
          ttc: null,
        });
      }
    } catch (e) {
      setter({
        font: null,
        error: (e as Error).message,
        busy: false,
        busyLabel: null,
        ttc: null,
      });
    }
  }

  /** Re-unpack a loaded TTC with another face selected. */
  function setSlotFace(slot: "cjk" | "mono", index: number) {
    const setter = slot === "cjk" ? setCjk : setMono;
    const source = (slot === "cjk" ? cjk : mono).ttc;
    if (!source) return;
    try {
      setter((s) => ({
        ...s,
        font: loadFont(source.buffer, source.fileName, index),
        ttc: { ...source, index },
        error: null,
      }));
    } catch (e) {
      setter((s) => ({ ...s, error: (e as Error).message }));
    }
  }

  /** Download a monospace preset (same sources as syntaxFont) through the shared loadFont path */
  async function downloadPreset(slot: "cjk" | "mono", preset: MonoPreset) {
    const setter = slot === "cjk" ? setCjk : setMono;
    setGen({ status: "idle" });
    setter((s) => ({ ...s, busy: true, busyLabel: null, error: null }));
    try {
      const res = await fetch(preset.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      setter({
        font: loadFont(await toSfnt(buf), `${preset.family}.ttf`),
        error: null,
        busy: false,
        busyLabel: null,
        ttc: null,
      });
    } catch (e) {
      setter((s) => ({
        ...s,
        busy: false,
        busyLabel: null,
        error: `${t("load.downloadFailed")} (${preset.family}: ${(e as Error).message})`,
      }));
    }
  }

  const set = <K extends keyof Params>(key: K, value: Params[K]) =>
    setParams((p) => ({ ...p, [key]: value }));

  function stageText(stage?: string) {
    if (stage === "runtime") return t("gen.stageRuntime");
    if (stage === "packages") return t("gen.stagePackages");
    if (stage === "convert") return t("gen.stageConvert");
    if (stage === "cjk") return t("gen.stageMerge");
    if (stage === "cmap") return t("gen.stageCmap");
    if (stage === "save") return t("gen.stageSave");
    if (stage) return t("gen.stageMerge");
    return t("gen.downloading");
  }

  /** Set a numeric param, mirroring CJK X/Y when the aspect ratio is locked. */
  const setNum = (key: keyof Params, value: number) =>
    setParams((p) => {
      if (p.cjkAspectLock && key === "cjkGlyphScale") {
        return { ...p, cjkGlyphScale: value, cjkGlyphScaleY: value };
      }
      if (p.cjkAspectLock && key === "cjkGlyphScaleY") {
        return { ...p, cjkGlyphScale: value, cjkGlyphScaleY: value };
      }
      return { ...p, [key]: value };
    });

  return (
    <div className="min-h-screen scrollbar">
      <header className="bg-main border-b-4 border-border">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-4 gap-y-2 pb-4 pl-[max(1.5rem,env(safe-area-inset-left))] pr-[max(1.5rem,env(safe-area-inset-right))] pt-[max(1rem,env(safe-area-inset-top))]">
          <div className="flex items-center gap-2">
            <img
              src={`${import.meta.env.BASE_URL}logo.svg`}
              alt=""
              aria-hidden="true"
              draggable={false}
              className="pointer-events-none hidden h-10 w-10 shrink-0 select-none sm:block"
            />
            <h1 className="font-heading text-2xl uppercase tracking-wide text-main-foreground">
              {t("title")}
            </h1>
          </div>
          <Badge className="hidden bg-foreground text-background shadow-shadow sm:inline-flex">
            {t("tagline")}
          </Badge>
          <nav
            className="ml-auto flex flex-wrap shadow-shadow border-2 border-border"
            aria-label="Language"
          >
            {LANGS.map((l) => (
              <button
                key={l.code}
                type="button"
                onClick={() => i18n.changeLanguage(l.code)}
                className={cn(
                  "px-2 py-1 text-xs font-heading border-r-2 border-border last:border-r-0 transition-colors",
                  lang === l.code
                    ? "bg-foreground text-background"
                    : "bg-secondary-background hover:bg-main hover:text-main-foreground",
                )}
                lang={l.code}
              >
                {l.label}
              </button>
            ))}
          </nav>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            aria-label="GitHub"
            className="flex size-8 shrink-0 items-center justify-center border-2 border-border bg-secondary-background shadow-shadow transition-colors hover:bg-main"
          >
            <svg
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true"
              className="size-4"
            >
              <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
            </svg>
          </a>
        </div>
      </header>

      <main className="mx-auto grid max-w-[1400px] gap-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] pl-[max(1.5rem,env(safe-area-inset-left))] pr-[max(1.5rem,env(safe-area-inset-right))] pt-6 lg:grid-cols-[340px_1fr]">
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>{t("load.title")}</CardTitle>
              <CardDescription>{t("load.desc")}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <FontSlotInfo
                label={t("load.cjk")}
                color={CJK_BG}
                slot={cjk}
                onFile={(f) => setSlot("cjk", f)}
                emptyLabel={t("load.empty")}
                vfNote={t("vfNote")}
                ttcLabel={t("load.ttcFace")}
                onTtcFace={(i) => setSlotFace("cjk", i)}
              />
              <FontSlotInfo
                label={t("load.mono")}
                color={MONO_BG}
                slot={mono}
                onFile={(f) => setSlot("mono", f)}
                emptyLabel={t("load.empty")}
                vfNote={t("vfNote")}
                ttcLabel={t("load.ttcFace")}
                onTtcFace={(i) => setSlotFace("mono", i)}
                presetLabel={t("load.preset")}
                presetPlaceholder={t("load.presetPlaceholder")}
                downloadingLabel={t("load.downloading")}
                presets={MONO_PRESETS}
                onPreset={(p) => downloadPreset("mono", p)}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("params.title")}</CardTitle>
              <CardDescription>{t("params.desc")}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <label className="flex items-center gap-2 text-sm font-base">
                <Checkbox
                  checked={params.lock2to1}
                  onCheckedChange={(checked) =>
                    set("lock2to1", Boolean(checked))
                  }
                  aria-label={t("params.lock")}
                />
                {t("params.lock")}
              </label>

              <label className="flex items-center gap-2 text-sm font-base">
                <Checkbox
                  checked={params.cjkAspectLock}
                  onCheckedChange={(checked) =>
                    set("cjkAspectLock", Boolean(checked))
                  }
                  aria-label={t("params.cjkAspectLock")}
                />
                {t("params.cjkAspectLock")}
              </label>

              {SLIDERS.map((def) => {
                const value = params[def.key] as number;
                const disabled = def.disabledWhen?.(params) ?? false;
                return (
                  <div key={def.key}>
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <Label className="text-xs">{t(def.labelKey)}</Label>
                      <NumberField
                        value={value}
                        min={def.min}
                        max={def.max}
                        step={def.step}
                        format={def.format}
                        color={
                          def.slot === "cjk"
                            ? CJK_BG
                            : def.slot === "mono"
                              ? MONO_BG
                              : undefined
                        }
                        ariaLabel={t(def.labelKey)}
                        onCommit={(v) => setNum(def.key, v)}
                      />
                    </div>
                    <Slider
                      value={[value]}
                      min={def.min}
                      max={def.max}
                      step={def.step}
                      onValueChange={(v) => {
                        const arr = Array.isArray(v) ? v : [v];
                        const nv = arr[0] ?? value;
                        setNum(def.key, nv);
                      }}
                      disabled={disabled}
                      className="pb-2"
                    />
                  </div>
                );
              })}

              <Button
                variant="neutral"
                size="sm"
                onClick={() => {
                  textTouched.current = false;
                  setParams({ ...DEFAULT_PARAMS, text: t("sampleText") });
                }}
              >
                {t("params.reset")}
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("view.title")}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <label className="flex items-center gap-2 text-sm font-base">
                <Checkbox
                  checked={showGrid}
                  onCheckedChange={(c) => setShowGrid(Boolean(c))}
                  aria-label={t("view.grid")}
                />
                {t("view.grid")}
              </label>
              <div className="flex flex-col gap-1.5">
                <Label>{t("view.sample")}</Label>
                <Textarea
                  rows={5}
                  value={params.text}
                  onChange={(e) => {
                    textTouched.current = true;
                    set("text", e.target.value);
                  }}
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("gen.title")}</CardTitle>
              <CardDescription>{t("gen.desc")}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <Button
                className={WRAP_BTN}
                onClick={handleGenerate}
                disabled={!mono.font || !cjk.font || gen.status === "running"}
              >
                {gen.status === "running"
                  ? t("gen.generating")
                  : t("gen.button")}
              </Button>

              {(!mono.font || !cjk.font) && gen.status !== "running" && (
                <p className="text-xs font-base opacity-70">
                  {t("gen.needBoth")}
                </p>
              )}

              {gen.status === "running" && (
                <p className="text-xs font-base" aria-live="polite">
                  {stageText(gen.stage)}
                  {typeof gen.value === "number" ? ` ${gen.value}%` : ""}
                </p>
              )}

              {gen.status === "error" && (
                <p className="text-xs font-base break-all">
                  ✗ {t("gen.failed")}: {gen.error}
                </p>
              )}

              {gen.status === "done" && (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge className="bg-main-green text-black">
                      {t("gen.done")}
                    </Badge>
                    <span className="text-xs font-base">
                      {gen.added} glyphs
                    </span>
                  </div>
                  <a
                    href={gen.url}
                    download={gen.fileName}
                    className={cn(
                      buttonVariants({ variant: "neutral", size: "sm" }),
                      "w-full break-all",
                      WRAP_BTN,
                    )}
                  >
                    {t("gen.download")}
                  </a>
                  <Button
                    className={WRAP_BTN}
                    variant="neutral"
                    size="sm"
                    onClick={handleDownloadWoff2}
                    disabled={woff2.busy}
                  >
                    {woff2.busy ? t("gen.compressing") : t("gen.downloadWoff2")}
                  </Button>
                  {woff2.error && (
                    <p className="text-xs font-base break-all">
                      ✗ {woff2.error}
                    </p>
                  )}
                  <div className="flex flex-col gap-1.5">
                    <Label>{t("gen.testLabel")}</Label>
                    <Textarea
                      rows={4}
                      value={testText}
                      onChange={(e) => setTestText(e.target.value)}
                      className="font-generated"
                    />
                    <p className="text-xs font-base opacity-70">
                      {t("gen.testHint")}
                    </p>
                  </div>
                </>
              )}

              <div className="flex flex-col gap-2 border-t-2 border-border pt-3">
                <Button
                  className={WRAP_BTN}
                  variant="neutral"
                  size="sm"
                  onClick={handleExportBuild}
                  disabled={!mono.font || !cjk.font}
                >
                  {t("gen.exportBuild")}
                </Button>
                <p className="text-xs font-base break-all opacity-70">
                  {t("gen.cliHint")}
                </p>
              </div>
            </CardContent>
          </Card>
        </div>

        <Card className="sticky top-0 self-start overflow-hidden p-0">
          <div className="max-h-[80vh] overflow-auto p-3">
            <canvas ref={canvasRef} className="block" />
          </div>
        </Card>
      </main>
    </div>
  );
}

function FontSlotInfo({
  label,
  color,
  slot,
  onFile,
  emptyLabel,
  vfNote,
  ttcLabel,
  onTtcFace,
  presets,
  presetLabel,
  presetPlaceholder,
  downloadingLabel,
  onPreset,
}: {
  label: string;
  color: string;
  slot: SlotState;
  onFile: (f: File | undefined) => void;
  emptyLabel: string;
  vfNote: string;
  ttcLabel?: string;
  onTtcFace?: (index: number) => void;
  presets?: MonoPreset[];
  presetLabel?: string;
  presetPlaceholder?: string;
  downloadingLabel?: string;
  onPreset?: (p: MonoPreset) => void;
}) {
  const font = slot.font;
  const meta = font?.meta;
  return (
    <div className="flex flex-col gap-2">
      <label
        className={cn(
          buttonVariants({ variant: "neutral", size: "sm" }),
          "w-full cursor-pointer bg-cover",
        )}
        style={{
          backgroundColor: color,
          color: "#0a0a0a",
        }}
      >
        {slot.busy ? (slot.busyLabel ?? downloadingLabel ?? "…") : label}
        <input
          type="file"
          accept=".ttf,.otf,.ttc,.woff,.woff2"
          className="sr-only"
          disabled={slot.busy}
          onChange={(e) => {
            onFile(e.target.files?.[0]);
            e.currentTarget.value = "";
          }}
        />
      </label>
      {slot.ttc && slot.ttc.faces.length > 1 && (
        <label className="flex flex-col gap-1 text-xs font-base">
          <span className="font-heading">{ttcLabel}</span>
          <select
            className="w-full min-w-0 rounded-base border-2 border-border bg-secondary-background px-2 py-1.5 text-xs font-base shadow-shadow disabled:opacity-50"
            value={slot.ttc.index}
            disabled={slot.busy}
            onChange={(e) => onTtcFace?.(Number(e.target.value))}
            aria-label={ttcLabel}
          >
            {slot.ttc.faces.map((f) => (
              <option key={f.index} value={f.index}>
                {f.family}
                {f.style ? ` · ${f.style}` : ""}
              </option>
            ))}
          </select>
        </label>
      )}
      {presets && onPreset && (
        <label className="flex flex-col gap-1 text-xs font-base">
          <span className="font-heading">{presetLabel}</span>
          <select
            className="w-full min-w-0 rounded-base border-2 border-border bg-secondary-background px-2 py-1.5 text-xs font-base shadow-shadow disabled:opacity-50"
            disabled={slot.busy}
            defaultValue=""
            onChange={(e) => {
              const p = presets.find((x) => x.name === e.target.value);
              e.target.value = "";
              if (p) onPreset(p);
            }}
            aria-label={presetLabel}
          >
            <option value="" disabled>
              {slot.busy
                ? (slot.busyLabel ?? downloadingLabel ?? "…")
                : (presetPlaceholder ?? "…")}
            </option>
            {presets.map((p) => (
              <option
                key={p.name}
                value={p.name}
                title={`${p.license} · ${p.homepage}`}
              >
                {p.family}
              </option>
            ))}
          </select>
        </label>
      )}
      <div
        className={cn(
          "rounded-base border-2 border-border px-3 py-2 text-xs font-base break-words",
          slot.error
            ? "bg-[#ff4d50] text-[#1a1a1a]"
            : font
              ? "bg-main-green text-black"
              : "bg-secondary-background",
        )}
      >
        {slot.error
          ? `✗ ${slot.error}`
          : meta
            ? `${meta.familyName} ${meta.styleName ? `· ${meta.styleName}` : ""} · ${meta.unitsPerEm}upm${meta.isVariable ? ` · ${vfNote}` : ""}`
            : emptyLabel}
      </div>
    </div>
  );
}
