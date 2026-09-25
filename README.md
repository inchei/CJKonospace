<p align="center"><img src="public/logo.svg" width="128" height="128" alt="CJKonospace"></p>

# CJKonospace

A CJK × Monospace blending workbench: feed in two fonts (one for CJK, one for monospace), preview them mixed live in the browser, and tune character width vs. glyph width until CJK : mono hits a visually balanced 1 : 2 ratio (Maple Mono style).

Live app: <https://inchei.github.io/CJKonospace/>

## Quick start

```bash
pnpm install
pnpm dev      # dev server
pnpm build    # production build (dist/)
```

## How it works

- **Parsing & preview** — [opentype.js](https://opentype.js.org/) parses both fonts and the Canvas renderer lays out the mixed lines; [harfbuzzjs](https://github.com/harfbuzz/harfbuzzjs) (WASM) runs real GSUB shaping so mono ligatures show up in the preview.
- **WOFF2 I/O** — WOFF2 input is decompressed and WOFF2 output is compressed with [woff2-encoder](https://github.com/itskyedo/woff2-encoder) (WASM).
- **Generation** — the same `wasm/merge_font.py` runs in the browser inside [pyodide](https://pyodide.org/) (WASM), with [fontTools](https://fonttools.readthedocs.io/) loaded from a CDN, so no server round-trip is needed.

Three WASM modules, all lazy-loaded (only fetched when first used): harfbuzzjs (~0.4 MB) for shaping, woff2-encoder (~0.27 MB) for WOFF2 input, and pyodide + fontTools (~10 MB) for font generation. Python at runtime has no dependency on the WASM path — see the command line section below.

## Command line

```bash
uv run wasm/merge_font.py mono.ttf cjk.ttf out.ttf params.json
```

`mono.ttf` is the base font (its glyph IDs, GSUB/GPOS/GDEF and Latin coverage are kept), `cjk.ttf` supplies the glyphs to append. `params.json`:

```json
{
  "fs": 48,
  "lock2to1": true,
  "familyName": "MyMono",
  "styleName": "Regular",
  "lineHeight": 1.3,
  "format": "ttf",
  "variations": { "mono": {}, "cjk": {} },
  "mono": { "advMul": 1, "gsx": 1, "gsy": 1, "baseline": 0, "ttcIndex": 0 },
  "cjk": { "advMul": 1, "gsx": 1, "gsy": 1, "baseline": 0, "ttcIndex": 0 }
}
```

| Key                        | Meaning                                                                                   |
| -------------------------- | ----------------------------------------------------------------------------------------- |
| `fs`                       | reference font size in px; only used to convert `baseline` offsets from px to font units  |
| `lock2to1`                 | lock CJK advance to 2 × mono advance (the whole point of the tool)                        |
| `lineHeight`               | multiplier for the recomputed ascent/descent (default `1.3`; use `1.0` for tight metrics) |
| `format`                   | output packaging: `ttf` (default) or `woff2`                                              |
| `mono` / `cjk.advMul`      | advance multiplier                                                                        |
| `mono` / `cjk.gsx`, `gsy`  | outline scale (glyph width / height), advance untouched                                   |
| `mono` / `cjk.baseline`    | baseline offset in px (see `fs`)                                                          |
| `mono` / `cjk.ttcIndex`    | face index when the input is a `.ttc` collection (default `0`)                            |
| `variations.mono` / `.cjk` | variable-font instance location (axis tag → value), e.g. `{ "wght": 700 }`                |

Notes:

- Inputs may be TTF, OTF or WOFF2 (WOFF2 is decompressed first; the CLI declares the `brotli` dependency for this).
- TTC collections are supported: pick a face with `ttcIndex` (default `0`). The web UI shows a face selector for multi-face collections and defaults to the face matching the UI language (e.g. `TC` for `zh-Hant`).
- Variable-font inputs are pinned to a static instance via `variations.mono` / `variations.cjk` (fontTools `varLib.instancer`); axes are not merged into a variable output. The web UI exposes per-axis sliders and the font's named instances.
- Output outlines are always TrueType (`glyf`); set `format: "woff2"` to get a WOFF2 package of the same font. A CFF/OTF mono base is converted (cu2qu; CFF hinting is dropped).
- The tool does not touch hinting, so scaled CJK glyphs keep their original instructions.
- Vertical metrics (`hhea` ascent/descent, `OS/2` typo + win metrics) are recomputed to cover every glyph, so tall CJK glyphs are not clipped.
- The result is flagged monospace: `post.isFixedPitch = 1`, `OS/2.panose.bProportion = 9`, `OS/2.xAvgCharWidth` = half-width; a `gasp` table is added when missing.

## License

GPL-3.0-only
