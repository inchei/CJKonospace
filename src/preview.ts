import type { LoadedFont } from "./fontLoader";
import type { Glyph } from "opentype.js";
import type { Override, Params } from "./params";
import type { ShapedGlyph } from "./shaper";
import type { Slot } from "./types";

/** Default line-height multiplier for the generated font (see wasm/merge_font.py). */
const LINE_HEIGHT = 1.3;

export interface RenderInput {
  cjkFont: LoadedFont | null;
  monoFont: LoadedFont | null;
  params: Params;
  overrides: Record<string, Override>;
  /** variation-axis locations for variable fonts ({} = default instance) */
  monoCoords?: Record<string, number>;
  cjkCoords?: Record<string, number>;
  /**
   * CJK subset being generated (null/empty = full font). Characters outside
   * the subset fall through to the mono path, matching the merge output:
   * the mono glyph shows when the mono font has it, otherwise .notdef.
   */
  subsetUnicodes?: number[] | null;
  /**
   * Shape one mono-font run. Return null to fall back to per-char layout
   * (e.g. harfbuzz still loading). CJK runs are always laid out per char.
   */
  shapeMono?: (font: LoadedFont, text: string) => ShapedGlyph[] | null;
}

export interface RenderOptions {
  showGrid: boolean;
  /** Empty-state hint text (localizable) */
  hint?: string;
}

interface CharItem {
  kind: "char";
  ch: string;
  slot: Slot;
  ov: Override | undefined;
  /** slot advance in px (after multipliers / 2:1 lock) */
  advPx: number;
  /** glyph's own advance in px, used to center the em box in the slot */
  natAdvPx: number;
}

interface ShapedItem {
  kind: "shaped";
  gid: number;
  /** x-offset in px (scaled by monoAdvMul, like advances) */
  dxPx: number;
  /** y-offset in px, positive = up */
  dyPx: number;
  slot: "mono";
  ov: Override | undefined;
  /** slot advance in px */
  advPx: number;
  /** shaped glyph's own advance in px */
  natAdvPx: number;
}

type DrawItem = CharItem | ShapedItem;

/** Map an hb cluster (UTF-16 offset into the run) back to its char. */
function charAtCluster(
  chars: string[],
  starts: number[],
  from: number,
  cluster: number,
): string {
  let ch = chars[chars.length - 1]!;
  for (let k = 0; k < starts.length; k++) {
    if (starts[k]! <= cluster) ch = chars[from + k]!;
    else break;
  }
  return ch;
}

function isCJK(ch: string): boolean {
  const c = ch.codePointAt(0);
  if (c === undefined) return false;
  return (
    (c >= 0x2e80 && c <= 0x9fff) || // CJK radicals to ideographs
    (c >= 0x3400 && c <= 0x4dbf) ||
    (c >= 0xf900 && c <= 0xfaff) || // compatibility ideographs
    (c >= 0x3000 && c <= 0x303f) || // CJK punctuation
    (c >= 0xff00 && c <= 0xff60) || // fullwidth forms
    (c >= 0x3130 && c <= 0x318f) || // Hangul compatibility jamo
    (c >= 0xac00 && c <= 0xd7af) || // Hangul syllables
    (c >= 0x3040 && c <= 0x30ff) // hiragana/katakana
  );
}

function drawGlyph(
  ctx: CanvasRenderingContext2D,
  glyph: Glyph,
  originX: number,
  originY: number,
  scale: number,
  sx: number,
  sy: number,
) {
  ctx.save();
  ctx.translate(originX, originY);
  ctx.transform(sx * scale, 0, 0, -sy * scale, 0, 0); // font space is y-up
  ctx.beginPath();
  for (const c of glyph.path.commands) {
    switch (c.type) {
      case "M":
        ctx.moveTo(c.x!, c.y!);
        break;
      case "L":
        ctx.lineTo(c.x!, c.y!);
        break;
      case "C":
        ctx.bezierCurveTo(c.x1!, c.y1!, c.x2!, c.y2!, c.x!, c.y!);
        break;
      case "Q":
        ctx.quadraticCurveTo(c.x1!, c.y1!, c.x!, c.y!);
        break;
      case "Z":
        ctx.closePath();
        break;
    }
  }
  ctx.fill();
  ctx.restore();
}

function refLine(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: string,
  dash: number[] = [],
  width = 1.5,
) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.restore();
}

export function renderPreview(
  canvas: HTMLCanvasElement,
  input: RenderInput,
  opts: RenderOptions,
) {
  const { cjkFont, monoFont, params, overrides } = input;
  const ctx = canvas.getContext("2d")!;
  const dpr = window.devicePixelRatio || 1;
  // content-box width of the scroll container; the canvas grows past it on overflow
  const parent = canvas.parentElement;
  let viewW = canvas.clientWidth;
  if (parent) {
    const ps = getComputedStyle(parent);
    viewW = Math.max(
      0,
      parent.clientWidth -
        parseFloat(ps.paddingLeft) -
        parseFloat(ps.paddingRight),
    );
  }
  // Follow the system dark-mode preference (no toggle button)
  const isDark =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;
  const inkColor = isDark ? "#f2ead8" : "#161616";
  // grid colors, verified ≥3:1 against the canvas bg in both modes
  const baselineColor = isDark ? "rgba(230,80,60,0.8)" : "rgba(200,50,35,0.9)";
  const boundaryColor = isDark
    ? "rgba(220,210,190,0.45)"
    : "rgba(58,58,58,0.6)";
  const centerColor = isDark ? "rgba(120,170,255,0.6)" : "rgba(30,79,192,0.7)";
  const ascColor = isDark ? "rgba(120,220,150,0.65)" : "rgba(20,140,70,0.75)";
  const descColor = isDark ? "rgba(235,175,95,0.65)" : "rgba(180,90,10,0.75)";

  const fs = params.fontSize;

  // opentype.js bakes a CFF glyph's outline on first `.path` access using the
  // font-wide variation state, while getTransform() cannot see any variation
  // data until that first parse defines getBlendPath. Sync the font-wide
  // state every render so newly seen glyphs instance correctly on their
  // first paint, too (getTransform below still handles later coord changes,
  // when the baked path would otherwise go stale).
  for (const [font, coords] of [
    [monoFont, input.monoCoords],
    [cjkFont, input.cjkCoords],
  ] as const) {
    if (!font || !coords || Object.keys(coords).length === 0) continue;
    try {
      (
        font.font as unknown as {
          variation?: { set(c: Record<string, number>): void };
        }
      ).variation?.set({ ...coords });
    } catch {
      /* keep the default instance */
    }
  }

  /** Apply a variable font's instance location to a glyph (opentype.js variation). */
  function varied(font: LoadedFont, glyph: Glyph): Glyph {
    const coords = font === cjkFont ? input.cjkCoords : input.monoCoords;
    const manager = (
      font.font as unknown as {
        variation?: {
          getTransform(g: Glyph, c?: Record<string, number>): Glyph;
        };
      }
    ).variation;
    if (!manager || !coords || Object.keys(coords).length === 0) return glyph;
    try {
      return manager.getTransform(glyph, coords);
    } catch {
      return glyph;
    }
  }

  // Vertical metrics, mirroring merge_font.py: the generated ascent/descent come
  // from both fonts' declared hhea ascender/descender (times lineHeight).
  const metricTop = Math.max(
    monoFont
      ? monoFont.meta.ascender * (fs / monoFont.meta.unitsPerEm)
      : -Infinity,
    cjkFont
      ? cjkFont.meta.ascender * (fs / cjkFont.meta.unitsPerEm) +
          params.cjkBaselineOffset
      : -Infinity,
  );
  const metricBot = Math.min(
    monoFont
      ? monoFont.meta.descender * (fs / monoFont.meta.unitsPerEm)
      : Infinity,
    cjkFont
      ? cjkFont.meta.descender * (fs / cjkFont.meta.unitsPerEm) +
          params.cjkBaselineOffset
      : Infinity,
  );
  const hasInk = Number.isFinite(metricTop) && Number.isFinite(metricBot);
  const glyphH = hasInk ? metricTop - metricBot : 0;
  const lineH = hasInk ? glyphH * LINE_HEIGHT : fs * 1.7;
  const extra = hasInk ? lineH - glyphH : 0;
  const ascender = hasInk ? metricTop + extra * 0.6 : 0;
  const descender = hasInk ? metricBot - (extra - extra * 0.6) : 0;

  // advance in pixels
  const u2pxMono = monoFont ? fs / monoFont.meta.unitsPerEm : 0;
  // mono half-width reference (advance of "n", fallback 0.5em)
  let monoHalf = 0;
  if (monoFont) {
    const g = monoFont.font.charToGlyph("n");
    const aw =
      g && g.advanceWidth > 0 ? g.advanceWidth : monoFont.meta.unitsPerEm / 2;
    monoHalf = aw * u2pxMono * params.monoAdvMul;
  }

  const plainChar = (ch: string, slot: Slot): CharItem => {
    const font = slot === "cjk" ? cjkFont! : monoFont!;
    let advPx: number;
    let natAdvPx: number;
    if (!font) {
      advPx = fs / 2;
      natAdvPx = advPx;
    } else {
      const raw = font.font.charToGlyph(ch);
      const g = raw ? varied(font, raw) : raw;
      const aw =
        g && g.advanceWidth > 0 ? g.advanceWidth : font.meta.unitsPerEm / 2;
      natAdvPx = aw * (fs / font.meta.unitsPerEm);
      if (slot === "cjk" && params.lock2to1 && monoHalf > 0) {
        // locked: CJK half width = mono half width
        advPx = monoHalf * 2;
      } else {
        const mult = slot === "cjk" ? params.cjkAdvMul : params.monoAdvMul;
        advPx = natAdvPx * mult;
      }
    }
    return { kind: "char", ch, slot, ov: overrides[ch], advPx, natAdvPx };
  };

  const lines = params.text.split("\n");
  const drawItems: DrawItem[][] = lines.map((ln) => {
    const chars = [...ln];
    const subset =
      input.subsetUnicodes && input.subsetUnicodes.length > 0
        ? new Set(input.subsetUnicodes)
        : null;
    const slots: Slot[] = chars.map((ch) => {
      if (!cjkFont || !isCJK(ch)) return "mono";
      const cp = ch.codePointAt(0);
      // a subset-excluded character is absent from the merge output
      if (subset && (cp === undefined || !subset.has(cp))) return "mono";
      return cjkFont.font.charToGlyphIndex(ch) > 0 ? "cjk" : "mono";
    });
    const out: DrawItem[] = [];
    let i = 0;
    while (i < chars.length) {
      if (slots[i] === "mono" && monoFont && input.shapeMono) {
        let j = i;
        while (j < chars.length && slots[j] === "mono") j++;
        const runText = chars.slice(i, j).join("");
        const shaped = input.shapeMono(monoFont, runText);
        if (shaped && shaped.length > 0) {
          const u = fs / monoFont.meta.unitsPerEm;
          // UTF-16 start offset of each char inside the run
          const starts: number[] = [];
          let off = 0;
          for (let k = i; k < j; k++) {
            starts.push(off);
            off += chars[k]!.length;
          }
          for (const g of shaped) {
            const ch = charAtCluster(chars, starts, i, g.cluster);
            const ov = overrides[ch];
            const mult = params.monoAdvMul * (ov?.advMul ?? 1);
            out.push({
              kind: "shaped",
              gid: g.gid,
              dxPx: g.xOffset * u * params.monoAdvMul,
              dyPx: g.yOffset * u,
              slot: "mono",
              ov,
              advPx: g.xAdvance * u * mult,
              natAdvPx: g.xAdvance * u,
            });
          }
          i = j;
          continue;
        }
        for (let k = i; k < j; k++) out.push(plainChar(chars[k]!, "mono"));
        i = j;
      } else {
        out.push(plainChar(chars[i]!, slots[i]!));
        i++;
      }
    }
    return out;
  });

  const margin = 24;
  const top = 30;

  // size the canvas to fit the content; the scroll container handles overflow
  let contentW = 0;
  for (const items of drawItems) {
    let rowW = 0;
    for (const info of items) rowW += info.advPx;
    if (rowW > contentW) contentW = rowW;
  }
  const W = Math.max(viewW, margin + contentW + margin + fs);
  // height is on-demand: exactly what the lines need, plus top/bottom padding
  const H = top + lines.length * lineH + 24;
  canvas.width = Math.max(1, Math.round(W * dpr));
  canvas.height = Math.max(1, Math.round(H * dpr));
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = isDark ? "#232019" : "#fdf6e3";
  ctx.fillRect(0, 0, W, H);

  if (!monoFont && !cjkFont) {
    ctx.fillStyle = isDark ? "#9a958a" : "#8a8a8a";
    ctx.font = "14px ui-monospace, monospace";
    ctx.fillText(opts.hint ?? "← 先加载 mono 字体和 CJK 字体", 20, 44);
    return;
  }

  ctx.fillStyle = inkColor;

  drawItems.forEach((items, li) => {
    const baseY = top + (li + 0.9) * lineH;
    let penX = margin;

    if (opts.showGrid) {
      // row baseline
      refLine(ctx, 0, baseY, W, baseY, baselineColor);
      // generated-font ascent / descent (computed from lineHeight).
      // Drawn once: consecutive rows' asc/desc guides land on the same y.
      if (hasInk && li === 0) {
        const ascY = baseY - ascender;
        const descY = baseY - descender;
        refLine(ctx, 0, ascY, W, ascY, ascColor, [6, 4], 1);
        refLine(ctx, 0, descY, W, descY, descColor, [6, 4], 1);
        ctx.fillStyle = ascColor;
        ctx.font = "10px ui-monospace, monospace";
        ctx.fillText("asc", 4, ascY - 3);
        ctx.fillStyle = descColor;
        ctx.fillText("desc", 4, descY - 3);
      }
      // vertical grid: advance boundary of every char
      if (items.length > 0) {
        const lineTop = baseY - fs * 1.1;
        const lineBottom = baseY + fs * 0.3;
        for (const info of items) {
          refLine(ctx, penX, lineTop, penX, lineBottom, boundaryColor, [2, 4]);
          if (info.slot === "cjk") {
            // center line: at 1/2
            refLine(
              ctx,
              penX + info.advPx / 2,
              lineTop,
              penX + info.advPx / 2,
              lineBottom,
              centerColor,
              [3, 4],
              1,
            );
          }
          penX += info.advPx;
        }
        refLine(ctx, penX, lineTop, penX, lineBottom, boundaryColor, [2, 4]);
      }
    } else {
      for (const info of items) penX += info.advPx;
    }

    // redraw glyphs
    penX = margin;
    for (const info of items) {
      const font = info.slot === "cjk" ? cjkFont! : monoFont!;
      const gsxBase =
        info.slot === "cjk" ? params.cjkGlyphScale : params.monoGlyphScale;
      const gsyBase =
        info.slot === "cjk" ? params.cjkGlyphScaleY : params.monoGlyphScaleY;
      const gsx = gsxBase * (info.ov?.gsx ?? 1);
      const gsy = gsyBase * (info.ov?.gsy ?? 1);
      // center the glyph's (scaled) em box within the slot, so a slot wider than
      // the glyph's own advance (e.g. 2:1-locked CJK in a 1.2em cell) stays centered
      const center = (info.advPx - info.natAdvPx * gsx) / 2;
      if (info.kind === "shaped" && font) {
        const raw = font.font.glyphs.get(info.gid);
        const glyph = raw ? varied(font, raw) : raw;
        if (glyph) {
          const scale = fs / font.meta.unitsPerEm;
          drawGlyph(
            ctx,
            glyph,
            penX + center + info.dxPx,
            baseY + params.monoBaselineOffset - info.dyPx,
            scale,
            gsx,
            gsy,
          );
        }
      } else if (info.kind === "char") {
        const raw = font ? font.font.charToGlyph(info.ch) : undefined;
        const glyph = raw && font ? varied(font, raw) : undefined;
        if (glyph) {
          const scale = fs / font.meta.unitsPerEm;
          const bl =
            info.slot === "cjk"
              ? params.cjkBaselineOffset
              : params.monoBaselineOffset;
          drawGlyph(ctx, glyph, penX + center, baseY + bl, scale, gsx, gsy);
        }
      }
      penX += info.advPx;
    }
  });
}
