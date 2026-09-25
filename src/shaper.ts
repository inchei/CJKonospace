import type { Font as HbFont } from "harfbuzzjs";
import type { LoadedFont } from "./fontLoader";

/** One shaped glyph; advances/offsets are in font units (hb default scale = upem). */
export interface ShapedGlyph {
  gid: number;
  xAdvance: number;
  xOffset: number;
  yOffset: number;
  /** UTF-16 offset into the shaped run text. */
  cluster: number;
}

type HbModule = typeof import("harfbuzzjs");

let hbMod: HbModule | null = null;
let loadAttempt: Promise<void> | null = null;
const fontCache = new WeakMap<object, HbFont>();

/**
 * Lazily load harfbuzzjs (keeps the wasm out of the initial bundle).
 * Resolves when shaping is usable; never rejects.
 */
export function ensureShaping(): Promise<boolean> {
  if (!loadAttempt) {
    loadAttempt = import("harfbuzzjs")
      .then((m) => {
        hbMod = m;
      })
      .catch(() => {
        hbMod = null;
        loadAttempt = null;
      })
      .then(() => undefined);
  }
  return loadAttempt.then(() => hbMod !== null);
}

function getHbFont(font: LoadedFont): HbFont | null {
  if (!hbMod) return null;
  const cached = fontCache.get(font);
  if (cached) return cached;
  try {
    const blob = new hbMod.Blob(font.buffer);
    const face = new hbMod.Face(blob);
    const hbFont = new hbMod.Font(face);
    fontCache.set(font, hbFont);
    return hbFont;
  } catch {
    return null;
  }
}

/**
 * Shape one same-font run. Returns null when harfbuzz isn't ready
 * or shaping fails — callers must fall back to per-char layout.
 */
export function shapeMonoRun(
  font: LoadedFont,
  text: string,
): ShapedGlyph[] | null {
  const hbFont = getHbFont(font);
  if (!hbFont || !hbMod || text.length === 0) return null;
  try {
    const buffer = new hbMod.Buffer();
    buffer.addText(text);
    buffer.guessSegmentProperties();
    hbMod.shape(hbFont, buffer);
    const infos = buffer.getGlyphInfos();
    const pos = buffer.getGlyphPositions();
    if (infos.length !== pos.length || infos.length === 0) return null;
    return infos.map((g, i) => {
      const p = pos[i]!;
      return {
        gid: g.codepoint,
        xAdvance: p.xAdvance,
        xOffset: p.xOffset,
        yOffset: p.yOffset,
        cluster: g.cluster,
      };
    });
  } catch {
    return null;
  }
}
