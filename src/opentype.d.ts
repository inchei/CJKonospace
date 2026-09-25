declare module "opentype.js" {
  export interface PathCommand {
    type: "M" | "L" | "C" | "Q" | "Z";
    x?: number;
    y?: number;
    x1?: number;
    y1?: number;
    x2?: number;
    y2?: number;
  }

  export interface Path {
    commands: PathCommand[];
    bbox: { x1: number; y1: number; x2: number; y2: number };
  }

  export interface Glyph {
    path: Path;
    advanceWidth: number;
    leftSideBearing?: number;
    name: string;
    unicode?: number;
    unicodes: number[];
    index: number;
    getPath(x?: number, y?: number, fontSize?: number): Path;
  }

  export interface Font {
    familyName: string;
    styleName: string;
    fullName: string;
    postScriptName: string;
    unitsPerEm: number;
    ascender: number;
    descender: number;
    glyphs: {
      get(i: number): Glyph;
      length: number;
    };
    charToGlyph(char: string): Glyph | undefined;
    charToGlyphIndex(char: string): number;
    tables: Record<string, unknown>;
    variationCoords?: Record<string, number>;
  }

  export function parse(buffer: ArrayBuffer): Font;
  const _default: {
    parse: typeof parse;
  };
  export default _default;
}
