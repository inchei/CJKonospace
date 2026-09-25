import type { LoadedFont } from "./fontLoader";
import type { Glyph } from "opentype.js";
import type { Override, Params } from "./params";
import type { ShapedGlyph } from "./shaper";
import type { Slot } from "./types";

export interface RenderInput {
  cjkFont: LoadedFont | null;
  monoFont: LoadedFont | null;
  params: Params;
  overrides: Record<string, Override>;
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

  const fs = params.fontSize;
  const lineH = fs * 1.7;

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
      const g = font.font.charToGlyph(ch);
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
    const slots: Slot[] = chars.map((ch) =>
      cjkFont && isCJK(ch) && cjkFont.font.charToGlyphIndex(ch) > 0
        ? "cjk"
        : "mono",
    );
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
        const glyph = font.font.glyphs.get(info.gid);
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
        const glyph = font ? font.font.charToGlyph(info.ch) : undefined;
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
