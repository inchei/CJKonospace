#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["fonttools"]
# ///
"""Generate the CJKonospace logo.

字 (CJK) in its natural proportions, drawn as a hollow outline, split down the
middle by a vertical dashed line, on a neobrutalist yellow tile (thick black
border + hard offset shadow). The dashed seam marks the CJK : mono = 2 : 1
column split.

Font: Noto Sans CJK Bold (SIL OFL 1.1), auto-detected from common system paths.

Requires only fontTools:  pip install fonttools

Usage:
    python scripts/gen_logo.py [--cjk PATH] [--out PATH]
"""

import argparse
import os
import sys

from fontTools.misc.transform import Transform
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

CJK_CANDIDATES = [
    "/usr/share/fonts/noto-cjk/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
    "/System/Library/Fonts/NotoSansCJK-Bold.ttc",
]

INK = "#111111"
TILE = "#FDC500"
TILE_X, TILE_Y, TILE_SIZE, TILE_RING = 14.0, 14.0, 204.0, 10.0
SHADOW_X, SHADOW_Y = 26.0, 26.0
STROKE = 7.0
# dashed seam that divides the whole tile, not just the glyph
SEAM_W = 13.0
SEAM_DASH = "24 16"
SEAM_Y0, SEAM_Y1 = 27.0, 205.0


def find_cjk() -> str:
    for path in CJK_CANDIDATES:
        if os.path.exists(path):
            return path
    sys.exit(
        "Noto Sans CJK Bold not found; pass --cjk PATH (e.g. NotoSansCJK-Bold.ttc)"
    )


def glyph(font, ch):
    name = font.getBestCmap()[ord(ch)]
    gset = font.getGlyphSet()
    bp = BoundsPen(gset)
    gset[name].draw(bp)
    return gset, name, bp.bounds


def build(cjk_path: str) -> str:
    font = TTFont(cjk_path, fontNumber=0)
    gset, name, b = glyph(font, "字")
    box = 152.0
    gcx, gcy = 116.0, 114.0
    s = min(box / (b[2] - b[0]), box / (b[3] - b[1]))
    bcx, bcy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
    t = Transform(s, 0, 0, -s, gcx - bcx * s, gcy + bcy * s)

    pen = SVGPathPen(gset)
    gset[name].draw(TransformPen(pen, t))

    # tight viewBox around tile + shadow so the mark fills tab icons / <img> boxes
    pad = 1.0
    x0 = min(TILE_X - TILE_RING / 2, SHADOW_X) - pad
    y0 = min(TILE_Y - TILE_RING / 2, SHADOW_Y) - pad
    x1 = max(TILE_X + TILE_SIZE + TILE_RING / 2, SHADOW_X + TILE_SIZE) + pad
    y1 = max(TILE_Y + TILE_SIZE + TILE_RING / 2, SHADOW_Y + TILE_SIZE) + pad
    vw, vh = x1 - x0, y1 - y0

    return f"""<svg xmlns="http://www.w3.org/2000/svg"
  viewBox="{x0:.1f} {y0:.1f} {vw:.1f} {vh:.1f}"
  width="{vw:.0f}" height="{vh:.0f}" role="img" aria-label="CJKonospace">
  <title>CJKonospace</title>

  <rect x="{SHADOW_X}" y="{SHADOW_Y}" width="{TILE_SIZE}"
    height="{TILE_SIZE}" rx="12" fill="{INK}"/>
  <rect x="{TILE_X}" y="{TILE_Y}" width="{TILE_SIZE}"
    height="{TILE_SIZE}" rx="12" fill="{TILE}" stroke="{INK}"
    stroke-width="{TILE_RING}"/>

  <path
    d="{pen.getCommands()}"
    fill="none"
    stroke="{INK}"
    stroke-width="{STROKE}"
    stroke-linejoin="round"
  />
  <line
    x1="{gcx}" y1="{SEAM_Y0}" x2="{gcx}" y2="{SEAM_Y1}"
    stroke="{INK}" stroke-width="{SEAM_W}" stroke-dasharray="{SEAM_DASH}"
  />
</svg>
"""


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    parser = argparse.ArgumentParser(description="Generate the CJKonospace logo")
    parser.add_argument("--cjk", help="Noto Sans CJK Bold (.ttc/.otf)")
    parser.add_argument(
        "--out",
        default=os.path.join(root, "public", "logo.svg"),
        help="output SVG path",
    )
    args = parser.parse_args()

    with open(args.out, "w") as fh:
        fh.write(build(args.cjk or find_cjk()))
    print("wrote", args.out)


if __name__ == "__main__":
    main()
