import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderSearch } from "lucide-react";

import "@/lib/i18n";
import { isMonospace, loadFont, type LoadedFont } from "@/fontLoader";
import { isWoff2, toSfnt, toWoff2 } from "@/woff2";
import { inspectTTC, isTTC, type TTCFace } from "@/ttc";
import { DEFAULT_PARAMS, type Params } from "@/params";
import {
  SUBSET_DEFAULT,
  SUBSET_PRESETS,
  estimateKept,
  loadCharsets,
  resolveUnicodes,
  type SubsetPresetId,
  type SubsetState,
} from "@/lib/subset";
import { renderPreview } from "@/preview";
import { ensureShaping, shapeMonoRun } from "@/shaper";
import { generateFont, type ExportProgress } from "@/exporter";
import { buildStandaloneArchive, fontFileName } from "@/lib/mergeScript";
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
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { LANGS } from "@/lib/i18n";
import { MONO_PRESETS, type MonoPreset } from "@/lib/monoPresets";
import {
  listLocalFonts,
  supportsLocalFonts,
  type SystemFontData,
} from "@/localFonts";
import { SystemFontPicker } from "@/components/SystemFontPicker";

const CJK_BG = "#ff85a1";
const MONO_BG = "#70d6ff";
const MERGE_BG = "#ffd166";
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

/** One numeric param as a NumberField + Slider row (see SLIDERS). */
function SliderRow({
  def,
  value,
  disabled,
  onCommit,
}: {
  def: SliderDef;
  value: number;
  disabled: boolean;
  onCommit: (v: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <div>
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
          onCommit={onCommit}
        />
      </div>
      <Slider
        value={[value]}
        min={def.min}
        max={def.max}
        step={def.step}
        onValueChange={(v) => {
          const arr = Array.isArray(v) ? v : [v];
          onCommit(arr[0] ?? value);
        }}
        disabled={disabled}
        className="pb-2"
      />
    </div>
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
  /** current variation-axis values ({} for non-variable fonts) */
  coords: Record<string, number>;
}

/** Default axis location of a variable font (one entry per axis). */
function defaultCoords(v?: LoadedFont["variation"]): Record<string, number> {
  if (!v) return {};
  return Object.fromEntries(v.axes.map((a) => [a.tag, a.default]));
}

interface AxisRange {
  min: number;
  default: number;
  max: number;
}

/** wght axis of a loaded font, if it is a variable font with one. */
function wghtAxis(font: LoadedFont | null): AxisRange | undefined {
  const axis = font?.variation?.axes.find((a) => a.tag === "wght");
  if (!axis) return undefined;
  return { min: axis.min, default: axis.default, max: axis.max };
}

/** One mono -> CJK wght correspondence point (both in user-space values). */
interface WeightAnchor {
  mono: number;
  cjk: number;
}

/** Default map: align the two fonts' min/default/max. */
function defaultWeightMap(mono: AxisRange, cjk: AxisRange): WeightAnchor[] {
  return [
    { mono: mono.min, cjk: cjk.min },
    { mono: mono.default, cjk: cjk.default },
    { mono: mono.max, cjk: cjk.max },
  ];
}

/**
 * Piecewise-linear mono -> CJK through the anchors (sorted by mono);
 * clamps outside the anchor span. Handles uneven ranges and uneven
 * weight-change speeds between the two fonts.
 */
function mapWeight(anchors: WeightAnchor[], value: number): number {
  const sorted = [...anchors].sort((a, b) => a.mono - b.mono);
  if (sorted.length === 0) return value;
  const first = sorted[0]!;
  if (value <= first.mono) return first.cjk;
  const last = sorted[sorted.length - 1]!;
  if (value >= last.mono) return last.cjk;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]!;
    const b = sorted[i + 1]!;
    if (value >= a.mono && value <= b.mono) {
      const span = b.mono - a.mono;
      const t = span === 0 ? 0 : (value - a.mono) / span;
      return a.cjk + t * (b.cjk - a.cjk);
    }
  }
  return last.cjk;
}

/** Clamp anchor lists to both axes' ranges and keep them sorted/monotonic. */
function sanitizeAnchors(
  anchors: WeightAnchor[],
  mono: AxisRange,
  cjk: AxisRange,
): WeightAnchor[] {
  const clamped = anchors.map((a) => ({
    mono: Math.min(mono.max, Math.max(mono.min, a.mono)),
    cjk: Math.min(cjk.max, Math.max(cjk.min, a.cjk)),
  }));
  clamped.sort((a, b) => a.mono - b.mono);
  for (let i = 1; i < clamped.length; i++) {
    if (clamped[i]!.cjk < clamped[i - 1]!.cjk) {
      clamped[i]!.cjk = clamped[i - 1]!.cjk;
    }
  }
  return clamped;
}

/** Drop the wght entry: in merge mode it is interpolated, not pinned. */
function stripWght(coords: Record<string, number>): Record<string, number> {
  const rest = { ...coords };
  delete rest.wght;
  return rest;
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
    coords: {},
  });
  const [mono, setMono] = useState<SlotState>({
    font: null,
    error: null,
    busy: false,
    busyLabel: null,
    ttc: null,
    coords: {},
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
    format?: string;
    variable?: boolean;
    warnings?: string[];
  }>({ status: "idle" });
  // advanced generation options (also settable via CLI params.json)
  const [advFamily, setAdvFamily] = useState("");
  const [advStyle, setAdvStyle] = useState("");
  const [advFormat, setAdvFormat] = useState<"ttf" | "woff2">("ttf");
  // merge the shared wght axis into a variable output (both fonts must expose it)
  const [advMergeWght, setAdvMergeWght] = useState(false);
  /** shared preview weight on the mono wght user scale (null = mono default) */
  const [weightPreview, setWeightPreview] = useState<number | null>(null);
  /**
   * mono -> CJK wght anchor map (null = fvar-derived defaults);
   * the backend pairs masters through this map, so uneven ranges and
   * uneven weight-change speeds stay aligned
   */
  const [weightMap, setWeightMap] = useState<WeightAnchor[] | null>(null);
  /** output wght range override (null = mono endpoint); narrows the axis */
  const [axisMin, setAxisMin] = useState<number | null>(null);
  const [axisMax, setAxisMax] = useState<number | null>(null);
  const monoIsMonospace = useMemo(
    () => (mono.font ? isMonospace(mono.font.font) : true),
    [mono.font],
  );
  const monoWght = wghtAxis(mono.font);
  const cjkWght = wghtAxis(cjk.font);
  // a new font brings a new fvar: drop custom anchors/range back to defaults
  useEffect(() => {
    setWeightMap(null);
    setAxisMin(null);
    setAxisMax(null);
  }, [mono.font, cjk.font]);
  /** merge mode is only real when the user opted in and both fonts expose wght */
  const mergeActive = advMergeWght && Boolean(monoWght && cjkWght);
  /** narrowed output range on the mono wght user scale (defaults = full range) */
  const outMin = axisMin ?? monoWght?.min ?? 100;
  const outMax = axisMax ?? monoWght?.max ?? 900;
  const anchors: WeightAnchor[] =
    mergeActive && monoWght && cjkWght
      ? (weightMap ?? defaultWeightMap(monoWght, cjkWght))
      : [];
  /** preview weight on the mono wght user scale; the output axis follows mono */
  const previewWeight = weightPreview ?? monoWght?.default ?? 400;
  const previewMonoWght = monoWght
    ? Math.min(outMax, Math.max(outMin, previewWeight))
    : previewWeight;
  // CJK follows the anchor map, so mismatched ranges/speeds stay aligned
  const previewCjkWght = mergeActive
    ? mapWeight(anchors, previewMonoWght)
    : undefined;
  const effMonoCoords = useMemo(
    () =>
      mergeActive ? { ...mono.coords, wght: previewMonoWght } : mono.coords,
    [mergeActive, mono.coords, previewMonoWght],
  );
  const effCjkCoords = useMemo(
    () =>
      mergeActive && previewCjkWght !== undefined
        ? { ...cjk.coords, wght: previewCjkWght }
        : cjk.coords,
    [mergeActive, cjk.coords, previewCjkWght],
  );
  const genUrlRef = useRef<string | null>(null);
  const genBytesRef = useRef<ArrayBuffer | null>(null);
  const [woff2, setWoff2] = useState<{ busy: boolean; error: string | null }>({
    busy: false,
    error: null,
  });
  // offline bundle export in progress (fflate import + zip, usually < 2s)
  const [exportBusy, setExportBusy] = useState(false);
  // CJK subset: preset ranges + custom text, resolved to codepoints lazily
  const [subset, setSubset] = useState<SubsetState>(SUBSET_DEFAULT);
  const [subsetUnicodes, setSubsetUnicodes] = useState<number[] | null>(null);
  const [subsetEstimate, setSubsetEstimate] = useState<number | null>(null);
  // Local Font Access API picker (Chromium only; hidden elsewhere)
  const supportsSystemFonts = supportsLocalFonts();
  const [pickerSlot, setPickerSlot] = useState<"cjk" | "mono" | null>(null);
  const [systemFonts, setSystemFonts] = useState<{
    status: "loading" | "ready" | "error";
    fonts: SystemFontData[];
    error?: string;
  }>({ status: "loading", fonts: [] });

  useEffect(() => {
    let cancelled = false;
    if (subset.presets.length === 0 && subset.text === "") {
      setSubsetUnicodes([]);
      setSubsetEstimate(null);
      return;
    }
    (async () => {
      const charsets = await loadCharsets();
      if (cancelled) return;
      const unicodes = resolveUnicodes(charsets, subset);
      if (cancelled) return;
      setSubsetUnicodes(unicodes);
      setSubsetEstimate(
        cjk.font && unicodes.length > 0
          ? estimateKept(cjk.font, unicodes)
          : null,
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [subset, cjk.font]);

  useEffect(
    () => () => {
      if (genUrlRef.current) URL.revokeObjectURL(genUrlRef.current);
    },
    [],
  );

  /** The exact object handed to merge_font.py (wasm and CLI share it). */
  function buildMergePayload() {
    // spaces are legal in family names; only strip characters that are
    // illegal in names/files, and join the two families with a space
    const sanitize = (s: string) =>
      s
        .replace(/[\\/:*?"<>|]+/g, "")
        .replace(/\s+/g, " ")
        .trim();
    const joined = [
      sanitize(cjk.font?.meta.familyName ?? ""),
      sanitize(mono.font?.meta.familyName ?? ""),
    ]
      .filter((s) => s !== "")
      .join(" ");
    return {
      fs: params.fontSize,
      lock2to1: params.lock2to1,
      lineHeight: params.lineHeight,
      format: advFormat,
      familyName: advFamily.trim() || joined || "CJKonospace",
      styleName: advStyle.trim(),
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
        ...(subsetUnicodes && subsetUnicodes.length > 0
          ? { subset: { unicodes: subsetUnicodes } }
          : {}),
      },
      // static instance location per font; {} means "keep as-is".
      // in wght-merge mode the wght entry is interpolated, not pinned
      variations: {
        mono: mergeActive ? stripWght(mono.coords) : mono.coords,
        cjk: mergeActive ? stripWght(cjk.coords) : cjk.coords,
      },
      // merge the shared wght axis into a variable output (Python side)
      mergeWght: mergeActive,
      // anchor map the backend pairs masters through: [mono user, cjk user]
      ...(mergeActive
        ? {
            weightMap: anchors.map((a) => [a.mono, a.cjk]),
            axisRange: { min: outMin, max: outMax },
          }
        : {}),
    };
  }

  /** Export an offline bundle (build.py + both fonts): unzip and `uv run build.py`. */
  async function handleExportBuild() {
    const monoFont = mono.font;
    const cjkFont = cjk.font;
    if (!monoFont || !cjkFont || exportBusy) return;
    setExportBusy(true);
    try {
      const pick = (
        font: LoadedFont,
        ttc: SlotState["ttc"],
      ): { name: string; data: Uint8Array } => {
        // TTC slots contribute the whole collection (face picked via ttcIndex);
        // otherwise the (possibly woff2-decompressed) sfnt, extension fixed
        // to match the actual bytes
        const raw = ttc?.buffer ?? font.buffer;
        const data = new Uint8Array(raw);
        return {
          name: fontFileName(ttc?.fileName ?? font.meta.fileName, data),
          data,
        };
      };
      const { blob, zipName } = await buildStandaloneArchive({
        mono: pick(monoFont, mono.ttc),
        cjk: pick(cjkFont, cjk.ttc),
        params: buildMergePayload(),
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = zipName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } finally {
      setExportBusy(false);
    }
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
      const format = payload.format === "woff2" ? "woff2" : "ttf";
      const url = URL.createObjectURL(
        new Blob([data], {
          type: format === "woff2" ? "font/woff2" : "font/ttf",
        }),
      );
      genUrlRef.current = url;
      genBytesRef.current = data;
      setWoff2({ busy: false, error: null });
      const face = new FontFace("CJKonoGenerated", data);
      await face.load();
      document.fonts.add(face);
      setGen({
        status: "done",
        url,
        fileName: `${family}.${format}`,
        added: meta.added,
        format,
        // the backend is the source of truth (it may fall back to static)
        variable: Boolean(meta.variable),
        warnings: meta.warnings ?? [],
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
          monoCoords: effMonoCoords,
          cjkCoords: effCjkCoords,
          subsetUnicodes,
          shapeMono: (font, text) => shapeMonoRun(font, text, effMonoCoords),
        },
        { showGrid, hint: t("previewHint") },
      );
    }
  }, [
    cjk,
    mono,
    params,
    showGrid,
    t,
    subsetUnicodes,
    effMonoCoords,
    effCjkCoords,
  ]);

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

  /** Load a slot from any named byte source (a File, or an OS font blob). */
  async function loadSlot(
    slot: "cjk" | "mono",
    source: { name: string; arrayBuffer(): Promise<ArrayBuffer> },
  ) {
    const setter = slot === "cjk" ? setCjk : setMono;
    setGen({ status: "idle" });
    setter((s) => ({ ...s, busy: true, busyLabel: null, error: null }));
    try {
      const buf = await source.arrayBuffer();
      if (isWoff2(buf)) {
        setter((s) => ({ ...s, busyLabel: t("load.woff2") }));
      }
      const sfnt = await toSfnt(buf);
      let font: LoadedFont;
      let ttc: SlotState["ttc"] = null;
      if (isTTC(sfnt)) {
        const faces = inspectTTC(sfnt);
        const index = pickTtcFace(faces, lang);
        font = loadFont(sfnt, source.name, index);
        ttc = { buffer: sfnt, fileName: source.name, faces, index };
      } else {
        font = loadFont(sfnt, source.name);
      }
      setter({
        font,
        error: null,
        busy: false,
        busyLabel: null,
        ttc,
        coords: defaultCoords(font.variation),
      });
    } catch (e) {
      setter({
        font: null,
        error: (e as Error).message,
        busy: false,
        busyLabel: null,
        ttc: null,
        coords: {},
      });
    }
  }

  async function setSlot(slot: "cjk" | "mono", file: File | undefined) {
    if (!file) return;
    await loadSlot(slot, file);
  }

  /** Enumerate OS fonts. Must stay within the click gesture for the prompt. */
  function openSystemFonts(slot: "cjk" | "mono") {
    setPickerSlot(slot);
    setSystemFonts({ status: "loading", fonts: [] });
    listLocalFonts()
      .then((fonts) => setSystemFonts({ status: "ready", fonts }))
      .catch((e) =>
        setSystemFonts({
          status: "error",
          fonts: [],
          error: e instanceof Error ? e.message : String(e),
        }),
      );
  }

  /** Load the picked OS font via the shared slot path (handles TTC, woff2…). */
  async function selectSystemFont(font: SystemFontData) {
    const slot = pickerSlot;
    setPickerSlot(null);
    if (!slot) return;
    const name = `${font.postscriptName || font.family || "font"}.ttf`;
    await loadSlot(slot, {
      name,
      arrayBuffer: async () => (await font.blob()).arrayBuffer(),
    });
  }

  /** Re-unpack a loaded TTC with another face selected. */
  function setSlotFace(slot: "cjk" | "mono", index: number) {
    const setter = slot === "cjk" ? setCjk : setMono;
    const source = (slot === "cjk" ? cjk : mono).ttc;
    if (!source) return;
    try {
      const font = loadFont(source.buffer, source.fileName, index);
      setter((s) => ({
        ...s,
        font,
        ttc: { ...source, index },
        coords: defaultCoords(font.variation),
        error: null,
      }));
    } catch (e) {
      setter((s) => ({ ...s, error: (e as Error).message }));
    }
  }

  /** Set one variation axis of a slot. */
  function setAxis(slot: "cjk" | "mono", tag: string, value: number) {
    const setter = slot === "cjk" ? setCjk : setMono;
    setter((s) => ({ ...s, coords: { ...s.coords, [tag]: value } }));
  }

  /** Jump to a named instance (partial location merged onto the current axes). */
  function setInstance(slot: "cjk" | "mono", coords: Record<string, number>) {
    const setter = slot === "cjk" ? setCjk : setMono;
    setter((s) => ({ ...s, coords: { ...s.coords, ...coords } }));
  }

  /** Edit one weight-map anchor (materializing the defaults on first edit). */
  function commitAnchor(index: number, patch: Partial<WeightAnchor>) {
    if (!monoWght || !cjkWght) return;
    const base = weightMap ?? defaultWeightMap(monoWght, cjkWght);
    const next = base.map((a, i) => (i === index ? { ...a, ...patch } : a));
    setWeightMap(sanitizeAnchors(next, monoWght, cjkWght));
  }

  /** Drop an anchor (at least two must remain to define the map). */
  function removeAnchor(index: number) {
    if (!monoWght || !cjkWght) return;
    const base = weightMap ?? defaultWeightMap(monoWght, cjkWght);
    if (base.length <= 2) return;
    setWeightMap(
      sanitizeAnchors(
        base.filter((_, i) => i !== index),
        monoWght,
        cjkWght,
      ),
    );
  }

  /** Insert an anchor in the middle of the widest mono gap, on the curve. */
  function addAnchor() {
    if (!monoWght || !cjkWght) return;
    const base = [...(weightMap ?? defaultWeightMap(monoWght, cjkWght))].sort(
      (a, b) => a.mono - b.mono,
    );
    if (base.length < 2) return;
    let gapIndex = 0;
    let gapSize = -Infinity;
    for (let i = 0; i < base.length - 1; i++) {
      const size = base[i + 1]!.mono - base[i]!.mono;
      if (size > gapSize) {
        gapSize = size;
        gapIndex = i;
      }
    }
    const a = base[gapIndex]!;
    const b = base[gapIndex + 1]!;
    const mid = { mono: (a.mono + b.mono) / 2, cjk: (a.cjk + b.cjk) / 2 };
    setWeightMap(sanitizeAnchors([...base, mid], monoWght, cjkWght));
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
        coords: {},
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
    if (stage === "instance") return t("gen.stageInstance");
    if (stage === "masters") return t("gen.stageMasters");
    if (stage === "varlib") return t("gen.stageVarlib");
    if (stage === "subset") return t("gen.stageSubset");
    if (stage === "convert") return t("gen.stageConvert");
    if (stage === "cjk") return t("gen.stageMerge");
    if (stage === "cmap") return t("gen.stageCmap");
    if (stage === "save") return t("gen.stageSave");
    if (stage) return t("gen.stageMerge");
    return t("gen.downloading");
  }

  /** Backend warning codes (merge_font.py meta["warnings"]) -> UI text. */
  function warningText(code: string) {
    if (code === "no-wght-axis") return t("gen.warnNoWghtAxis");
    if (code === "cff-variable") return t("gen.warnCffVariable");
    if (code === "mono-outline-ignored") return t("gen.warnMonoOutline");
    return code;
  }

  /** Set a numeric param, mirroring glyph X/Y when an aspect ratio is locked. */
  const setNum = (key: keyof Params, value: number) =>
    setParams((p) => {
      if (p.monoAspectLock && key === "monoGlyphScale") {
        return { ...p, monoGlyphScale: value, monoGlyphScaleY: value };
      }
      if (p.monoAspectLock && key === "monoGlyphScaleY") {
        return { ...p, monoGlyphScale: value, monoGlyphScaleY: value };
      }
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
                instanceLabel={t("load.instance")}
                onAxis={(tag, v) => setAxis("cjk", tag, v)}
                onInstance={(c) => setInstance("cjk", c)}
                vfWarningLabel={t("load.vfWarning")}
                hideWght={mergeActive}
                onSystemFont={
                  supportsSystemFonts ? () => openSystemFonts("cjk") : undefined
                }
                systemFontLabel={t("load.systemFont")}
                subset={{
                  label: t("subset.label"),
                  presets: SUBSET_PRESETS.map((id) => ({
                    id,
                    label: t(`subset.p_${id}`),
                  })),
                  state: subset,
                  estimate:
                    subsetEstimate !== null
                      ? t("subset.estimate", {
                          count: subsetEstimate.toLocaleString(lang),
                        })
                      : null,
                  customLabel: t("subset.custom"),
                  fillLabel: t("subset.fill"),
                  onChange: (patch) => setSubset((s) => ({ ...s, ...patch })),
                  onTogglePreset: (id) =>
                    setSubset((s) => ({
                      ...s,
                      presets: s.presets.includes(id)
                        ? s.presets.filter((p) => p !== id)
                        : [...s.presets, id],
                    })),
                  onFillSample: () =>
                    setSubset((s) => ({ ...s, text: params.text })),
                }}
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
                instanceLabel={t("load.instance")}
                onAxis={(tag, v) => setAxis("mono", tag, v)}
                onInstance={(c) => setInstance("mono", c)}
                hideWght={mergeActive}
                onSystemFont={
                  supportsSystemFonts
                    ? () => openSystemFonts("mono")
                    : undefined
                }
                systemFontLabel={t("load.systemFont")}
                warning={
                  mono.font && !monoIsMonospace ? t("load.monoWarn") : undefined
                }
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

              <Accordion>
                <AccordionItem value="cjk">
                  <AccordionTrigger
                    className="p-2 text-xs"
                    style={{ backgroundColor: CJK_BG, color: "#0a0a0a" }}
                  >
                    {t("load.cjk")}
                  </AccordionTrigger>
                  <AccordionContent>
                    <div className="flex flex-col gap-4">
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
                      {SLIDERS.filter((d) => d.slot === "cjk").map((def) => (
                        <SliderRow
                          key={def.key}
                          def={def}
                          value={params[def.key] as number}
                          disabled={def.disabledWhen?.(params) ?? false}
                          onCommit={(v) => setNum(def.key, v)}
                        />
                      ))}
                    </div>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>

              <Accordion>
                <AccordionItem value="mono">
                  <AccordionTrigger
                    className="p-2 text-xs"
                    style={{ backgroundColor: MONO_BG, color: "#0a0a0a" }}
                  >
                    {t("load.mono")}
                  </AccordionTrigger>
                  <AccordionContent>
                    <div className="flex flex-col gap-4">
                      <label className="flex items-center gap-2 text-sm font-base">
                        <Checkbox
                          checked={params.monoAspectLock}
                          onCheckedChange={(checked) =>
                            set("monoAspectLock", Boolean(checked))
                          }
                          aria-label={t("params.monoAspectLock")}
                        />
                        {t("params.monoAspectLock")}
                      </label>
                      {SLIDERS.filter((d) => !d.slot || d.slot === "mono").map(
                        (def) => (
                          <SliderRow
                            key={def.key}
                            def={def}
                            value={params[def.key] as number}
                            disabled={def.disabledWhen?.(params) ?? false}
                            onCommit={(v) => setNum(def.key, v)}
                          />
                        ),
                      )}
                    </div>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>

              {monoWght && cjkWght && (
                <Accordion>
                  <AccordionItem value="merge">
                    <AccordionTrigger
                      className="p-2 text-xs"
                      style={{ backgroundColor: MERGE_BG, color: "#0a0a0a" }}
                    >
                      {t("gen.mergeAxis")}
                    </AccordionTrigger>
                    <AccordionContent>
                      <div className="flex flex-col gap-4">
                        <Badge className="bg-main text-black whitespace-normal">
                          {t("load.vfWarning")}
                        </Badge>
                        <label className="flex items-center gap-2 text-sm font-base">
                          <Checkbox
                            checked={advMergeWght}
                            onCheckedChange={(c) => setAdvMergeWght(Boolean(c))}
                            aria-label={t("gen.mergeWght")}
                          />
                          {t("gen.mergeWght")}
                        </label>

                        {mergeActive && monoWght && (
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-heading text-xs whitespace-nowrap">
                              {t("gen.axisRange")}
                            </span>
                            <NumberField
                              value={outMin}
                              min={monoWght.min}
                              max={Math.max(monoWght.min, outMax - 1)}
                              step={1}
                              color={MONO_BG}
                              ariaLabel={`${t("gen.axisRange")} min`}
                              onCommit={(v) => setAxisMin(v)}
                            />
                            <span
                              aria-hidden="true"
                              className="shrink-0 text-xs"
                            >
                              –
                            </span>
                            <NumberField
                              value={outMax}
                              min={Math.min(monoWght.max, outMin + 1)}
                              max={monoWght.max}
                              step={1}
                              color={MONO_BG}
                              ariaLabel={`${t("gen.axisRange")} max`}
                              onCommit={(v) => setAxisMax(v)}
                            />
                          </div>
                        )}

                        {mergeActive && monoWght && (
                          <div>
                            <div className="mb-1 flex items-center justify-between gap-2">
                              <Label className="text-xs">
                                {t("gen.previewWeight")}
                              </Label>
                              <NumberField
                                value={previewWeight}
                                min={outMin}
                                max={outMax}
                                step={1}
                                ariaLabel={t("gen.previewWeight")}
                                onCommit={(v) => setWeightPreview(v)}
                              />
                            </div>
                            <Slider
                              value={[previewWeight]}
                              min={outMin}
                              max={outMax}
                              step={1}
                              onValueChange={(v) => {
                                const arr = Array.isArray(v) ? v : [v];
                                setWeightPreview(arr[0] ?? previewWeight);
                              }}
                              className="pb-2"
                            />
                          </div>
                        )}
                        {mergeActive && monoWght && cjkWght && (
                          <div className="flex flex-col gap-1.5">
                            <span className="font-heading text-xs">
                              {t("gen.weightMap")}
                            </span>
                            {anchors.map((a, i) => (
                              <div
                                key={i}
                                className="flex flex-wrap items-center gap-1.5"
                              >
                                <NumberField
                                  value={a.mono}
                                  min={monoWght.min}
                                  max={monoWght.max}
                                  step={1}
                                  color={MONO_BG}
                                  ariaLabel={`${t("gen.weightMap")} mono`}
                                  onCommit={(v) => commitAnchor(i, { mono: v })}
                                />
                                <span
                                  aria-hidden="true"
                                  className="shrink-0 text-xs"
                                >
                                  →
                                </span>
                                <NumberField
                                  value={a.cjk}
                                  min={cjkWght.min}
                                  max={cjkWght.max}
                                  step={1}
                                  color={CJK_BG}
                                  ariaLabel={`${t("gen.weightMap")} CJK`}
                                  onCommit={(v) => commitAnchor(i, { cjk: v })}
                                />
                                <Button
                                  type="button"
                                  variant="neutral"
                                  size="icon-sm"
                                  className="shrink-0"
                                  disabled={anchors.length <= 2}
                                  onClick={() => removeAnchor(i)}
                                  aria-label={t("gen.weightMapRemove")}
                                >
                                  ✕
                                </Button>
                              </div>
                            ))}
                            <Button
                              type="button"
                              variant="neutral"
                              size="sm"
                              className={WRAP_BTN}
                              onClick={addAnchor}
                            >
                              {t("gen.weightMapAdd")}
                            </Button>
                            <p className="text-xs font-base opacity-70">
                              {t("gen.weightMapHint")}
                            </p>
                          </div>
                        )}
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              )}

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
              {(!mono.font || !cjk.font) && gen.status !== "running" && (
                <p className="text-xs font-base opacity-70">
                  {t("gen.needBoth")}
                </p>
              )}
              <Button
                className={WRAP_BTN}
                onClick={handleGenerate}
                disabled={!mono.font || !cjk.font || gen.status === "running"}
              >
                {gen.status === "running"
                  ? t("gen.generating")
                  : t("gen.button")}
              </Button>

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
                    {gen.variable && (
                      <span className="text-xs font-base">
                        · {t("gen.variableOut")}
                      </span>
                    )}
                  </div>
                  {(gen.warnings ?? []).map((w) => (
                    <p
                      key={w}
                      className="text-xs font-base break-words opacity-70"
                    >
                      ⚠ {warningText(w)}
                    </p>
                  ))}
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
                  {gen.format !== "woff2" && (
                    <Button
                      className={WRAP_BTN}
                      variant="neutral"
                      size="sm"
                      onClick={handleDownloadWoff2}
                      disabled={woff2.busy}
                    >
                      {woff2.busy
                        ? t("gen.compressing")
                        : t("gen.downloadWoff2")}
                    </Button>
                  )}
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
                  disabled={!mono.font || !cjk.font || exportBusy}
                >
                  {t("gen.exportBuild")}
                </Button>
                <p className="text-xs font-base break-all opacity-70">
                  {t("gen.cliHint")}
                </p>
              </div>
              <Accordion>
                <AccordionItem value="advanced">
                  <AccordionTrigger className="p-2 text-xs">
                    {t("gen.advanced")}
                  </AccordionTrigger>
                  <AccordionContent>
                    <div className="flex flex-col gap-2">
                      <label className="flex flex-col gap-1 text-xs font-base">
                        <span className="font-heading">
                          {t("gen.familyName")}
                        </span>
                        <Input
                          value={advFamily}
                          placeholder={
                            cjk.font || mono.font
                              ? buildMergePayload().familyName
                              : "CJKonospace"
                          }
                          onChange={(e) => setAdvFamily(e.target.value)}
                          aria-label={t("gen.familyName")}
                        />
                      </label>
                      <label className="flex flex-col gap-1 text-xs font-base">
                        <span className="font-heading">
                          {t("gen.styleName")}
                        </span>
                        <Input
                          value={advStyle}
                          placeholder={mono.font?.meta.styleName || "Regular"}
                          onChange={(e) => setAdvStyle(e.target.value)}
                          aria-label={t("gen.styleName")}
                        />
                      </label>
                      <div>
                        <div className="mb-1 flex items-center justify-between gap-2">
                          <Label className="text-xs">
                            {t("gen.lineHeight")}
                          </Label>
                          <NumberField
                            value={params.lineHeight}
                            min={1}
                            max={2}
                            step={0.05}
                            format={f2}
                            ariaLabel={t("gen.lineHeight")}
                            onCommit={(v) => setNum("lineHeight", v)}
                          />
                        </div>
                        <Slider
                          value={[params.lineHeight]}
                          min={1}
                          max={2}
                          step={0.05}
                          onValueChange={(v) => {
                            const arr = Array.isArray(v) ? v : [v];
                            setNum("lineHeight", arr[0] ?? params.lineHeight);
                          }}
                          className="pb-2"
                        />
                      </div>
                      <div className="flex flex-col gap-1 text-xs font-base">
                        <span className="font-heading">{t("gen.format")}</span>
                        <RadioGroup
                          className="flex flex-row gap-4"
                          value={advFormat}
                          onValueChange={(v) =>
                            setAdvFormat(v === "woff2" ? "woff2" : "ttf")
                          }
                          aria-label={t("gen.format")}
                        >
                          {(["ttf", "woff2"] as const).map((f) => (
                            <label
                              key={f}
                              className="flex items-center gap-2 font-base"
                            >
                              <RadioGroupItem value={f} />
                              {f.toUpperCase()}
                            </label>
                          ))}
                        </RadioGroup>
                      </div>
                    </div>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </CardContent>
          </Card>
        </div>

        <Card className="sticky top-0 self-start overflow-hidden p-0">
          <div className="max-h-[80vh] overflow-auto p-3">
            <canvas ref={canvasRef} className="block" />
          </div>
        </Card>
      </main>

      {pickerSlot && (
        <SystemFontPicker
          status={systemFonts.status}
          fonts={systemFonts.fonts}
          error={systemFonts.error}
          onSelect={selectSystemFont}
          onClose={() => setPickerSlot(null)}
          labels={{
            title: t("load.systemFont"),
            search: t("load.systemFontSearch"),
            empty: t("load.systemFontEmpty"),
            loading: t("load.systemFontLoading"),
            error: t("load.systemFontError"),
            cancel: t("load.systemFontCancel"),
          }}
        />
      )}
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
  instanceLabel,
  onAxis,
  onInstance,
  vfWarningLabel,
  subset,
  presets,
  presetLabel,
  presetPlaceholder,
  downloadingLabel,
  onPreset,
  onSystemFont,
  systemFontLabel,
  warning,
  hideWght,
}: {
  label: string;
  color: string;
  slot: SlotState;
  onFile: (f: File | undefined) => void;
  emptyLabel: string;
  vfNote: string;
  ttcLabel?: string;
  onTtcFace?: (index: number) => void;
  instanceLabel?: string;
  onAxis?: (tag: string, value: number) => void;
  onInstance?: (coords: Record<string, number>) => void;
  vfWarningLabel?: string;
  subset?: {
    label: string;
    presets: { id: SubsetPresetId; label: string }[];
    state: SubsetState;
    estimate: string | null;
    customLabel: string;
    fillLabel: string;
    onChange: (patch: Partial<SubsetState>) => void;
    onTogglePreset: (id: SubsetPresetId) => void;
    onFillSample: () => void;
  };
  presets?: MonoPreset[];
  presetLabel?: string;
  presetPlaceholder?: string;
  downloadingLabel?: string;
  onPreset?: (p: MonoPreset) => void;
  onSystemFont?: () => void;
  systemFontLabel?: string;
  warning?: string;
  /** hide the wght axis row: in merge mode it is driven by the shared preview */
  hideWght?: boolean;
}) {
  const font = slot.font;
  const meta = font?.meta;
  const variation = font?.variation;
  const visibleAxes = variation
    ? variation.axes.filter((a) => !(hideWght && a.tag === "wght"))
    : [];
  const instanceIndex =
    variation && variation.instances.length > 0
      ? variation.instances.findIndex((inst) =>
          variation.axes.every(
            (a) => slot.coords[a.tag] === inst.coords[a.tag],
          ),
        )
      : -1;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-stretch gap-2">
        <label
          className={cn(
            buttonVariants({ variant: "neutral", size: "sm" }),
            "min-w-0 flex-1 cursor-pointer bg-cover",
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
        {onSystemFont && (
          <Button
            type="button"
            variant="neutral"
            size="icon-sm"
            className="shrink-0"
            disabled={slot.busy}
            onClick={onSystemFont}
            title={systemFontLabel}
            aria-label={systemFontLabel}
          >
            <FolderSearch />
          </Button>
        )}
      </div>
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
      {subset && (
        <Accordion>
          <AccordionItem value="subset" disabled={slot.busy}>
            <AccordionTrigger className="p-2 text-xs">
              {subset.label}
            </AccordionTrigger>
            <AccordionContent>
              <div className="flex flex-col gap-2">
                {subset.presets.map((p) => (
                  <label
                    key={p.id}
                    className="flex items-center gap-2 text-xs font-base"
                  >
                    <Checkbox
                      checked={subset.state.presets.includes(p.id)}
                      disabled={slot.busy}
                      onCheckedChange={() => subset.onTogglePreset(p.id)}
                      aria-label={p.label}
                    />
                    {p.label}
                  </label>
                ))}
                {subset.estimate && (
                  <p className="text-xs font-base opacity-70">
                    {subset.estimate}
                  </p>
                )}
                <label className="flex flex-col gap-1 text-xs font-base">
                  <span className="font-heading">{subset.customLabel}</span>
                  <Textarea
                    rows={2}
                    value={subset.state.text}
                    disabled={slot.busy}
                    onChange={(e) => subset.onChange({ text: e.target.value })}
                  />
                </label>
                <Button
                  variant="neutral"
                  size="sm"
                  className={WRAP_BTN}
                  onClick={subset.onFillSample}
                  disabled={slot.busy}
                >
                  {subset.fillLabel}
                </Button>
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
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
      {warning && (
        <div className="rounded-base border-2 border-border bg-[#ffd166] px-3 py-2 text-xs font-base break-words text-black">
          {warning}
        </div>
      )}
      {variation && visibleAxes.length > 0 && (
        <div className="flex flex-col gap-2 rounded-base border-2 border-border bg-secondary-background p-2">
          {vfWarningLabel && (
            <Badge className="bg-main text-black whitespace-normal">
              {vfWarningLabel}
            </Badge>
          )}
          {variation.instances.length > 0 && (
            <label className="flex flex-col gap-1 text-xs font-base">
              <span className="font-heading">{instanceLabel}</span>
              <select
                className="w-full min-w-0 rounded-base border-2 border-border bg-secondary-background px-2 py-1.5 text-xs font-base"
                value={instanceIndex >= 0 ? String(instanceIndex) : ""}
                disabled={slot.busy}
                onChange={(e) => {
                  const inst = variation.instances[Number(e.target.value)];
                  if (inst) onInstance?.(inst.coords);
                }}
                aria-label={instanceLabel}
              >
                <option value="">—</option>
                {variation.instances.map((inst, i) => (
                  <option key={i} value={String(i)}>
                    {inst.name || `#${i}`}
                  </option>
                ))}
              </select>
            </label>
          )}
          {visibleAxes.map((axis) => {
            const value = slot.coords[axis.tag] ?? axis.default;
            return (
              <div key={axis.tag} className="flex flex-col gap-1">
                <div className="flex items-center justify-between text-xs font-base">
                  <span>
                    {axis.name} <span className="opacity-60">({axis.tag})</span>
                  </span>
                  <span>{Math.round(value * 1000) / 1000}</span>
                </div>
                <input
                  type="range"
                  className="w-full accent-black"
                  min={axis.min}
                  max={axis.max}
                  step={Math.max((axis.max - axis.min) / 100, 0.001)}
                  value={value}
                  disabled={slot.busy}
                  onChange={(e) => onAxis?.(axis.tag, Number(e.target.value))}
                  aria-label={`${axis.name} (${axis.tag})`}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
