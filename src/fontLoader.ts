import ot from "opentype.js";
import type { Font } from "opentype.js";
import type { FontMeta } from "./types";
import { inspectTTC, isTTC, unwrapTTC, type TTCFace } from "./ttc.ts";

interface VariationAxis {
  tag: string;
  name: string;
  min: number;
  default: number;
  max: number;
}

interface VariationInstance {
  name: string;
  coords: Record<string, number>;
}

export interface LoadedFont {
  buffer: ArrayBuffer;
  font: Font;
  meta: FontMeta;
  /** present when the source file was a TTC (multiple faces) */
  ttc?: { faces: TTCFace[]; index: number };
  /** present when the font has an fvar table (variable font) */
  variation?: { axes: VariationAxis[]; instances: VariationInstance[] };
}

/** fvar names are localized maps; prefer English, else the first available. */
function enName(names?: Record<string, string>): string {
  if (!names) return "";
  return names.en ?? Object.values(names)[0] ?? "";
}

/** Read fvar axes/instances into a browser-friendly shape, or undefined. */
function readVariation(font: Font): LoadedFont["variation"] {
  const fvar = (
    font.tables as unknown as {
      fvar?: {
        axes?: {
          tag: string;
          minValue: number;
          defaultValue: number;
          maxValue: number;
          name?: Record<string, string>;
        }[];
        instances?: {
          name?: Record<string, string>;
          coordinates: Record<string, number>;
        }[];
      };
    }
  ).fvar;
  if (!fvar?.axes?.length) return undefined;
  return {
    axes: fvar.axes.map((a) => ({
      tag: a.tag,
      name: enName(a.name) || a.tag,
      min: a.minValue,
      default: a.defaultValue,
      max: a.maxValue,
    })),
    instances: (fvar.instances ?? []).map((inst) => ({
      name: enName(inst.name),
      coords: { ...inst.coordinates },
    })),
  };
}

function readNames(font: Font): { family: string; style: string } {
  const names = (
    font as unknown as {
      names?: Record<string, Record<string, Record<string, string>>>;
    }
  ).names;
  const plat = names?.windows ?? names?.macintosh;
  if (plat) {
    return {
      family: plat.fontFamily?.en ?? "",
      style: plat.fontSubfamily?.en ?? "",
    };
  }
  return { family: "", style: "" };
}

export function loadFont(
  buffer: ArrayBuffer,
  fileName: string,
  ttcIndex = 0,
): LoadedFont {
  let buffer2 = buffer;
  const sig = new DataView(buffer).getUint32(0);
  let ttc: LoadedFont["ttc"];
  if (isTTC(buffer)) {
    try {
      ttc = { faces: inspectTTC(buffer), index: ttcIndex };
      buffer2 = unwrapTTC(buffer, ttcIndex).sfnt;
    } catch (e) {
      throw new Error(`"${fileName}" TTC 解包失败`, { cause: e });
    }
  } else if (sig === 0x77384632) {
    // 'wOF2' -- normally decompressed by src/woff2.ts before reaching here
    throw new Error(`"${fileName}" WOFF2 解压失败`);
  } else if (
    sig !== 0x00010000 &&
    sig !== 0x4f54544f && // 'OTTO'
    sig !== 0x774f4646 // 'wOFF'
  ) {
    throw new Error(
      `"${fileName}" 不是有效的 TTF/OTF/WOFF（签名 0x${sig.toString(16)}）`,
    );
  }

  let font: Font;
  try {
    font = ot.parse(buffer2);
  } catch (e) {
    throw new Error(`"${fileName}" 解析失败：${(e as Error).message}`, {
      cause: e,
    });
  }
  const names = readNames(font);
  const variation = readVariation(font);
  const meta: FontMeta = {
    fileName,
    familyName: names.family || fileName,
    styleName: names.style || "",
    unitsPerEm: font.unitsPerEm || 1000,
    ascender: font.ascender || 0,
    descender: font.descender || 0,
    isVariable: Boolean(variation),
  };
  return { buffer: buffer2, font, meta, ttc, variation };
}

/**
 * True when the font's printable-ASCII glyphs all share one advance width.
 * CJK is full-width (2x) by design and is intentionally not considered; a font
 * with no measurable ASCII glyph counts as not monospace.
 */
export function isMonospace(font: Font): boolean {
  const widths = new Set<number>();
  for (let cp = 0x20; cp <= 0x7e; cp++) {
    const ch = String.fromCharCode(cp);
    if (font.charToGlyphIndex(ch) === 0) continue;
    const aw = font.charToGlyph(ch)?.advanceWidth ?? 0;
    if (aw > 0) widths.add(aw);
    if (widths.size > 1) return false;
  }
  return widths.size === 1;
}
