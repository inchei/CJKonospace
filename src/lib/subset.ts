import type { LoadedFont } from "@/fontLoader";

export type SubsetPresetId =
  "gbk" | "big5" | "jis0208" | "euckr" | "gsc3500" | "gsc6500" | "gsc8105";

export const SUBSET_PRESETS: SubsetPresetId[] = [
  "gbk",
  "big5",
  "jis0208",
  "euckr",
  "gsc3500",
  "gsc6500",
  "gsc8105",
];

export interface SubsetState {
  /** checked presets, unioned together (empty = keep all) */
  presets: SubsetPresetId[];
  /** extra characters, always unioned with the presets */
  text: string;
}

export const SUBSET_DEFAULT: SubsetState = { presets: [], text: "" };

interface CharsetFile {
  sources: Record<string, { name: string; url: string; license: string }>;
  presets: Record<string, { count: number; ranges: [number, number][] }>;
}

let cache: CharsetFile | null = null;

/** Lazily load the vendored charset ranges (kept out of the initial bundle). */
export async function loadCharsets(): Promise<CharsetFile> {
  if (!cache) {
    const mod = (await import("./charsets.json")) as unknown as {
      default: CharsetFile;
    };
    cache = mod.default;
  }
  return cache;
}

/** Expand a preset + custom text into a sorted unique codepoint list. */
export function resolveUnicodes(
  charsets: CharsetFile,
  state: SubsetState,
): number[] {
  const set = new Set<number>();
  for (const id of state.presets) {
    const preset = charsets.presets[id];
    if (preset) {
      for (const [start, end] of preset.ranges) {
        for (let cp = start; cp <= end; cp++) set.add(cp);
      }
    }
  }
  for (const ch of state.text) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined) set.add(cp);
  }
  return [...set].sort((a, b) => a - b);
}

/** Count how many of the unicodes exist in the loaded font. */
export function estimateKept(font: LoadedFont, unicodes: number[]): number {
  let n = 0;
  for (const cp of unicodes) {
    if (font.font.charToGlyphIndex(String.fromCodePoint(cp)) > 0) n++;
  }
  return n;
}
