export interface Params {
  /** pixel height of one mono em */
  fontSize: number;
  /** scale outlines only, advance untouched */
  monoGlyphScale: number;
  monoGlyphScaleY: number;
  /** advance multiplier */
  monoAdvMul: number;
  monoBaselineOffset: number;
  cjkGlyphScale: number;
  cjkGlyphScaleY: number;
  /** keep CJK glyph X/Y scales equal, preserving the font's original aspect */
  cjkAspectLock: boolean;
  cjkAdvMul: number;
  cjkBaselineOffset: number;
  /** lock CJK advance to 2 × mono advance */
  lock2to1: boolean;
  /** line-height multiplier applied to the recomputed ascent/descent */
  lineHeight: number;
  text: string;
}

export const DEFAULT_PARAMS: Params = {
  fontSize: 48,
  monoGlyphScale: 1,
  monoGlyphScaleY: 1,
  monoAdvMul: 1,
  monoBaselineOffset: 0,
  cjkGlyphScale: 1,
  cjkGlyphScaleY: 1,
  cjkAspectLock: true,
  cjkAdvMul: 1,
  cjkBaselineOffset: 0,
  lock2to1: true,
  lineHeight: 1.3,
  text: "中文 abc 中文 ABC 中文 123 汉字\nCJK 与 monospace 1:2 对齐测试\n-> => == != ===",
};

export interface Override {
  /** advance multiplier (relative to the font's natural advance) */
  advMul?: number;
  /** outline X scale */
  gsx?: number;
  /** outline Y scale */
  gsy?: number;
}
