import ot from "opentype.js";
import type { Font } from "opentype.js";
import type { FontMeta } from "./types";
import { inspectTTC, isTTC, unwrapTTC, type TTCFace } from "./ttc.ts";

export interface LoadedFont {
  buffer: ArrayBuffer;
  font: Font;
  meta: FontMeta;
  /** present when the source file was a TTC (multiple faces) */
  ttc?: { faces: TTCFace[]; index: number };
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
  const meta: FontMeta = {
    fileName,
    familyName: names.family || fileName,
    styleName: names.style || "",
    unitsPerEm: font.unitsPerEm || 1000,
    ascender: font.ascender || 0,
    descender: font.descender || 0,
    isVariable: "fvar" in font.tables,
  };
  return { buffer: buffer2, font, meta, ttc };
}
