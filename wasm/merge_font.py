# /// script
# requires-python = ">=3.10"
# dependencies = ["fonttools", "brotli"]
# ///
"""Merge a monospace font (base) with a CJK font.

Mono is the base font so its GSUB/GPOS/GDEF and glyph IDs stay intact; scaled
CJK glyphs are appended at the end of the glyph order and exposed through cmap.
fontTools only, no numpy -- runs inside pyodide (see src/exporter.ts).

Kept deliberately as one self-contained module: src/lib/mergeScript.ts slices
it above the __main__ guard to emit a standalone build.py, and the pyodide
worker writes/imports it as a single file. Steps are separated into helpers
rather than modules to keep both packagings working unchanged.

CLI:
    python merge_font.py mono.ttf cjk.ttf out.ttf params.json
"""

import copy
import json
import re
import sys
from types import SimpleNamespace

from fontTools.misc.roundTools import otRound
from fontTools.misc.transform import Transform
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont
from fontTools.ttLib.tables._g_l_y_f import Glyph

# Style-name keywords -> OS/2 usWeightClass. Compound forms are listed before
# the plain ones so "ExtraBold"/"SemiBold" are not captured as "Bold"; matched
# against a lowercased, whitespace-normalized style name (word boundaries keep
# e.g. "highlight" from matching "light").
_WEIGHT_PATTERNS = (
    (r"\bextra\s*black\b|\bultra\s*black\b", 950),
    (r"\bextra\s*bold\b|\bultra\s*bold\b", 800),
    (r"\bextra\s*light\b|\bultra\s*light\b", 200),
    (r"\bsemi\s*bold\b|\bdemi\s*bold\b", 600),
    (r"\bsemi\s*light\b|\bdemi\s*light\b", 350),
    (r"\bhairline\b|\bthin\b", 100),
    (r"\blight\b", 300),
    (r"\bbook\b|\bregular\b|\bnormal\b", 400),
    (r"\bmedium\b", 500),
    (r"\bbold\b", 700),
    (r"\bblack\b|\bheavy\b", 900),
)


def _weight_from_style(style):
    """Infer an OS/2 usWeightClass from a freely-typed style name.

    Recognizes the common CSS/OpenType weight keywords (compound forms like
    "ExtraBold" or "Extra Bold" included) and, failing that, a bare numeric
    weight (e.g. "700"). Returns None when nothing recognizable is present so
    the caller can keep the source font's value.
    """
    normalized = re.sub(r"[^0-9a-z]+", " ", style.lower()).strip()
    if not normalized:
        return None
    for pattern, weight in _WEIGHT_PATTERNS:
        if re.search(pattern, normalized):
            return weight
    found = re.search(r"\b(?:[1-9][0-9]{2}|1000)\b", normalized)
    return int(found.group(0)) if found else None


def _pen_glyph(src_glyph_set, name, sx, sy, dx, dy, upem, reverse=False):
    """Redraw a glyph with a pen (used for CFF sources and composites).

    reverse=True flips contour direction, which is needed for CFF (PostScript)
    sources: CFF is counter-clockwise, TrueType conventionally clockwise.
    """
    pen = TTGlyphPen(None)
    cu2qu = Cu2QuPen(pen, max_err=upem * 0.001, reverse_direction=reverse)
    tpen = TransformPen(cu2qu, Transform(sx, 0, 0, sy, dx, dy))
    src_glyph_set[name].draw(tpen)
    return pen.glyph()


def _to_glyf(font, upem):
    """Convert a CFF/OTF base font to TrueType outlines in place.

    This is the canonical fontTools cu2qu recipe (there is no first-party
    otf2ttf API, only the cu2quPen/ttGlyphPen building blocks). Glyph order is
    preserved so GSUB/GPOS/GDEF stay valid. Vertical metrics (vmtx/vhea) are
    kept by the caller, which must extend them for appended glyphs.
    """
    from fontTools.ttLib import newTable

    glyph_order = font.getGlyphOrder()
    glyph_set = font.getGlyphSet()
    font["loca"] = newTable("loca")
    glyf = newTable("glyf")
    glyf.glyphOrder = glyph_order
    glyf.glyphs = {}
    for name in glyph_order:
        pen = TTGlyphPen(glyf.glyphs)
        # CFF is counter-clockwise; TrueType wants clockwise
        cu2qu = Cu2QuPen(pen, max_err=upem * 0.001, reverse_direction=True)
        glyph_set[name].draw(cu2qu)
        glyf.glyphs[name] = pen.glyph()
    font["glyf"] = glyf
    for tag in ("CFF ", "CFF2", "VORG"):
        if tag in font:
            del font[tag]
    maxp = font["maxp"]
    maxp.tableVersion = 0x00010000
    # instruction counters absent from the CFF maxp; outlines here carry none
    maxp.maxZones = 1
    for attr in (
        "maxTwilightPoints",
        "maxStorage",
        "maxFunctionDefs",
        "maxInstructionDefs",
        "maxStackElements",
        "maxSizeOfInstructions",
    ):
        setattr(maxp, attr, 0)
    font["head"].glyphDataFormat = 0
    font.sfntVersion = "\x00\x01\x00\x00"


def _move_glyf_glyph(src_glyf, name, sx, sy, dx, dy):
    """Build a transformed copy of a glyf glyph.

    The source glyph must not be mutated: several codepoints can share one
    glyph, and mutating it in place would scale it once per codepoint. Only the
    fields compile() reads are copied (no deepcopy of the raw data), and scale +
    translate are done in a single pass. Returns None for composites, which the
    caller redraws with a pen.
    """
    g = src_glyf[name]
    g.expand(src_glyf)
    if not hasattr(g, "coordinates"):
        empty = Glyph()  # empty glyph (no contours)
        empty.numberOfContours = 0
        return empty
    if g.isComposite():
        if sx == 1 and sy == 1:
            new = copy.deepcopy(g)
            for comp in new.components:
                comp.x += dx
                comp.y += dy
            new.recalcBounds(src_glyf)
            return new
        return None
    new = Glyph()
    new.numberOfContours = g.numberOfContours
    new.endPtsOfContours = list(g.endPtsOfContours)
    new.flags = list(g.flags)
    new.coordinates = g.coordinates.copy()
    if hasattr(g, "program"):
        new.program = g.program
    a = new.coordinates._a
    xmin = 1e30
    for i in range(0, len(a), 2):
        x = a[i] * sx + dx
        a[i] = x
        a[i + 1] = a[i + 1] * sy + dy
        if x < xmin:
            xmin = x
    new.xMin = otRound(xmin)
    return new


def _read_params(params):
    """Flatten the merge parameters into a single namespace."""
    mp = params.get("mono", {})
    cp = params.get("cjk", {})
    return SimpleNamespace(
        fs=float(params.get("fs", 48)),
        lock=bool(params.get("lock2to1", True)),
        mono_ttc_index=int(mp.get("ttcIndex", 0)),
        cjk_ttc_index=int(cp.get("ttcIndex", 0)),
        mono_adv_mul=float(mp.get("advMul", 1)),
        mono_gsx=float(mp.get("gsx", 1)),
        mono_gsy=float(mp.get("gsy", 1)),
        mono_bl=float(mp.get("baseline", 0)),
        cjk_adv_mul=float(cp.get("advMul", 1)),
        cjk_gsx=float(cp.get("gsx", 1)),
        cjk_gsy=float(cp.get("gsy", 1)),
        cjk_bl=float(cp.get("baseline", 0)),
        subset_unicodes=(cp.get("subset") or {}).get("unicodes") or [],
        variations=params.get("variations") or {},
        family=params.get("familyName", "CJKonospace"),
        style=params.get("styleName", "Regular"),
        line_height=float(params.get("lineHeight", 1.3)),
        fmt=str(params.get("format", "ttf")).lower(),
    )


def _subset_cjk(cjk, p, report):
    """Subset the CJK input before merging: fewer glyphs downstream.

    The caller passes explicit codepoints; an empty list means "keep all".
    Returns the kept glyph count, or None when no subset was applied.
    """
    if not p.subset_unicodes:
        return None
    from fontTools import subset as ft_subset

    report("subset")
    opts = ft_subset.Options()
    opts.name_IDs = ["*"]  # keep copyright/license records for name synthesis
    opts.layout_features = ["*"]
    subsetter = ft_subset.Subsetter(opts)
    subsetter.populate(unicodes=p.subset_unicodes)
    subsetter.subset(cjk)
    return len(cjk.getGlyphOrder())


def _instance_variable_fonts(base, cjk, p, report):
    """Pin variable fonts to a static instance (no axis merging).

    An empty location means "use the axis defaults".
    """
    if "fvar" not in base and "fvar" not in cjk:
        return
    from fontTools.varLib.instancer import instantiateVariableFont

    report("instance")
    for tag, font in (("mono", base), ("cjk", cjk)):
        if "fvar" in font:
            instantiateVariableFont(font, p.variations.get(tag) or {}, inplace=True)


def _mono_reference_advance(base, base_cmap, upem):
    """Advance of the mono reference glyph ("n", else "0", else half em)."""
    n_name = base_cmap.get(ord("n")) or base_cmap.get(ord("0"))
    return base["hmtx"][n_name][0] if n_name else upem // 2


def _adjust_mono_advances(base, p, upem, units_per_px, report):
    """Scale mono advances, and redraw outlines only when scale/baseline moved."""
    if p.mono_adv_mul == 1 and p.mono_gsx == 1 and p.mono_gsy == 1 and p.mono_bl == 0:
        return
    report("mono")
    hmtx = base["hmtx"]
    glyf = base["glyf"]
    glyphs = base.getGlyphSet()
    for name in base.getGlyphOrder():
        nat_adv = hmtx[name][0]
        new_adv = round(nat_adv * p.mono_adv_mul)
        if p.mono_gsx != 1 or p.mono_gsy != 1 or p.mono_bl != 0:
            dx = (new_adv - nat_adv * p.mono_gsx) / 2
            dy = -p.mono_bl * units_per_px
            new_glyph = _pen_glyph(glyphs, name, p.mono_gsx, p.mono_gsy, dx, dy, upem)
            glyf[name] = new_glyph
            new_glyph.recalcBounds(glyf)
            lsb = new_glyph.xMin
        else:
            lsb = hmtx[name][1]
        hmtx[name] = (new_adv, lsb)


def _append_cjk(
    base,
    cjk,
    p,
    cjk_cmap,
    base_cmap,
    upem,
    cjk_adv_locked,
    cjk_scale,
    units_per_px,
    report,
):
    """Append scaled CJK glyphs for codepoints the mono base doesn't cover.

    Returns (added_count, added_cmap); added_cmap maps codepoint -> glyph name
    so the cmap step can reuse it instead of re-scanning the glyph order.
    """
    report("cjk", 0)
    existing = set(base.getGlyphOrder())
    glyf = base["glyf"]
    hmtx = base["hmtx"]
    glyphs = cjk.getGlyphSet()
    cjk_glyf = cjk.get("glyf")
    cjk_is_cff = "CFF " in cjk or "CFF2" in cjk
    cjk_vmtx = cjk.get("vmtx")
    vmtx = base.get("vmtx")
    added = 0
    added_cmap = {}
    total = sum(1 for c in cjk_cmap if c not in base_cmap)
    for cpnt, cname in cjk_cmap.items():
        if cpnt in base_cmap:
            continue
        gname = f"cjk.{cpnt:04X}"
        if gname in existing:
            # Name collision with a pre-existing glyph: keep it mapped, as the
            # cmap union below used to (without counting it as newly added).
            added_cmap[cpnt] = gname
            continue
        nat_adv = glyphs[cname].width
        scaled_nat = nat_adv * cjk_scale
        new_adv = cjk_adv_locked if p.lock else round(scaled_nat * p.cjk_adv_mul)
        dx = (new_adv - scaled_nat * p.cjk_gsx) / 2
        dy = -p.cjk_bl * units_per_px
        sx = cjk_scale * p.cjk_gsx
        sy = cjk_scale * p.cjk_gsy
        g = None
        if cjk_glyf is not None:
            g = _move_glyf_glyph(cjk_glyf, cname, sx, sy, dx, dy)
        if g is None:
            g = _pen_glyph(glyphs, cname, sx, sy, dx, dy, upem, cjk_is_cff)
        # glyf.__setitem__ appends to glyphOrder itself (O(1) via its reverse map);
        # appending again here would force a rebuild every iteration (O(n^2)).
        glyf[gname] = g
        hmtx[gname] = (new_adv, getattr(g, "xMin", 0))
        if vmtx is not None:
            v_adv = upem
            if cjk_vmtx is not None and cname in cjk_vmtx.metrics:
                v_adv = round(cjk_vmtx[cname][0] * cjk_scale)
            vmtx[gname] = (v_adv, 0)
        existing.add(gname)
        added_cmap[cpnt] = gname
        added += 1
        if total and added % 2000 == 0:
            report("cjk", min(99, int(added * 100 / total)))
    report("cjk", 100)
    return added, added_cmap


def _merge_cmap(base, base_cmap, added_cmap, report):
    """Union the CJK codepoints into the base cmap (format 4 = BMP, 12 = all)."""
    report("cmap")
    bmp = {c: g for c, g in added_cmap.items() if c <= 0xFFFF}
    has_fmt12 = False
    for table in base["cmap"].tables:
        if not table.isUnicode():
            continue
        if table.format == 12:
            has_fmt12 = True
            table.cmap.update(added_cmap)
        else:
            table.cmap.update(bmp)

    if not has_fmt12 and any(c > 0xFFFF for c in added_cmap):
        from fontTools.ttLib.tables._c_m_a_p import CmapSubtable

        sub = CmapSubtable.newSubtable(12)
        sub.platformID = 3
        sub.platEncID = 10
        sub.language = 0
        sub.cmap = dict(base_cmap)
        sub.cmap.update(added_cmap)
        base["cmap"].tables.append(sub)


def _synthesize_names(base, cjk, p):
    """Overwrite the output name records, keeping both inputs' attribution."""
    fam = p.family
    style = p.style
    full = f"{fam} {style}"
    ps = full.replace(" ", "")
    nt = base["name"]
    tool_url = "https://github.com/inchei/CJKonospace"
    synth = f"Synthesized with CJKonospace ({tool_url})"

    def original_texts(name_id):
        """Name record texts from the input fonts having this record."""
        out = []
        for font in (base, cjk):
            text = font["name"].getDebugName(name_id) if "name" in font else None
            if text:
                out.append(text)
        return out

    def original_notices(name_id):
        """Synthesis statement first, then both input fonts' own name records."""
        return "\n\n".join([synth, *original_texts(name_id)])

    # read originals before overwriting; copyright keeps both source notices
    copyright_notice = original_notices(0)
    license_notice = original_notices(13)
    # trademark/manufacturer/designer/description/URLs: keep both sides'
    # attribution instead of silently dropping the CJK font's; skip IDs
    # neither font provides (so no record is fabricated)
    carried = [
        (nid, original_notices(nid))
        for nid in (7, 8, 9, 10, 11, 12, 14)
        if original_texts(nid)
    ]
    managed = (0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 21, 22)
    for nid, val in (
        (0, copyright_notice),
        (1, fam),
        (2, style),
        (3, full),
        (4, full),
        (5, "Version 1.000"),
        (6, ps),
        *carried,
        (13, license_notice),
        (16, fam),  # typographic family, kept in sync with ID 1
        (17, style),  # typographic subfamily, kept in sync with ID 2
        (21, fam),  # WWS family
        (22, style),  # WWS subfamily
    ):
        nt.setName(val, nid, 3, 1, 0x409)
        try:
            val.encode("mac_roman")
        except UnicodeEncodeError:
            # Mac Roman cannot represent this text (e.g. CJK names); drop
            # any stale Mac record so it cannot contradict the Windows one
            nt.names = [
                rec
                for rec in nt.names
                if not (
                    rec.nameID == nid
                    and (rec.platformID, rec.platEncID, rec.langID) == (1, 0, 0)
                )
            ]
        else:
            nt.setName(val, nid, 1, 0, 0)
    # drop records that are stale or meaningless in the merged output:
    # reserved (15), Mac-only legacy names (18), the mono font's sample text
    # (19) and CID findfont name (20, the output is never CID-keyed), color
    # palettes (23, 24, no COLR table is carried over), and the variable-font
    # PostScript prefix (25, the output is always a static instance)
    drop_ids = {15, 18, 19, 20, 23, 24, 25}
    nt.names = [
        rec
        for rec in nt.names
        if rec.nameID not in drop_ids
        and (
            rec.nameID not in managed
            or (rec.platformID, rec.platEncID, rec.langID) in ((3, 1, 0x409), (1, 0, 0))
        )
    ]


def _update_metrics(base, p, mono_ref_adv, report):
    """Set monospace/coverage flags that depend on the final merged font."""
    report("metrics")
    if "post" in base:
        base["post"].isFixedPitch = 1
    if "OS/2" in base:
        os2 = base["OS/2"]
        os2.panose.bProportion = 9  # monospace
        os2.xAvgCharWidth = round(mono_ref_adv * p.mono_adv_mul)
        # The style name is freely typed; reflect a recognized weight word or
        # number in usWeightClass (leave the base's value when unrecognized).
        weight = _weight_from_style(p.style)
        if weight is not None:
            os2.usWeightClass = weight
        # Recompute the coverage flags from the merged cmap: the mono base's
        # values no longer describe the appended CJK glyphs. fontTools helpers
        # (>= 4.44) keep the base's ranges and add the CJK ones.
        os2.recalcUnicodeRanges(base)
        os2.recalcCodePageRanges(base)
        os2.updateFirstAndLastCharIndex(base)


def _update_vertical_metrics(base, cjk, p, upem, cjk_scale, units_per_px):
    """Derive asc/desc from both fonts' hhea, times lineHeight.

    Mirrored exactly by the web preview, which reads ascender/descender via
    opentype.js; the mono base's own metrics may not fit the scaled CJK.
    """
    multiplier = p.line_height
    bl_units = p.cjk_bl * units_per_px
    if "hhea" in cjk:
        cjk_asc = cjk["hhea"].ascent * cjk_scale + bl_units
        cjk_desc = cjk["hhea"].descent * cjk_scale + bl_units
    else:
        cjk_asc, cjk_desc = upem * 0.88 + bl_units, -upem * 0.12 + bl_units
    base_asc = base["hhea"].ascent if "hhea" in base else upem
    base_desc = base["hhea"].descent if "hhea" in base else 0
    top = otRound(max(base_asc, cjk_asc))
    bot = otRound(min(base_desc, cjk_desc))
    glyph_h = top - bot
    extra = round(glyph_h * multiplier) - glyph_h
    above = round(extra * 0.6)
    ascender = top + above
    descender = bot - (extra - above)
    if "hhea" in base:
        base["hhea"].ascent = ascender
        base["hhea"].descent = descender
    if "OS/2" in base:
        os2 = base["OS/2"]
        os2.sTypoAscender = ascender
        os2.sTypoDescender = descender
        os2.usWinAscent = ascender
        os2.usWinDescent = -descender


def _ensure_gasp(base):
    """Let Windows grid-fit/antialias mixed hinted/unhinted glyphs."""
    if "gasp" in base:
        return
    from fontTools.ttLib import newTable
    from fontTools.ttLib.tables._g_a_s_p import (
        GASP_DOGRAY,
        GASP_GRIDFIT,
        GASP_SYMMETRIC_GRIDFIT,
        GASP_SYMMETRIC_SMOOTHING,
    )

    gasp = newTable("gasp")
    gasp.version = 1
    gasp.gaspRange = {
        0xFFFF: GASP_SYMMETRIC_GRIDFIT
        | GASP_SYMMETRIC_SMOOTHING
        | GASP_DOGRAY
        | GASP_GRIDFIT
    }
    base["gasp"] = gasp


def merge(mono_path, cjk_path, out_path, params, progress=None):
    def report(stage, value=None):
        if progress:
            progress(stage, value)

    p = _read_params(params)

    report("load")
    # ttcIndex picks a face when the input is a TrueType Collection (ignored otherwise)
    base = TTFont(mono_path, fontNumber=p.mono_ttc_index)
    cjk = TTFont(cjk_path, fontNumber=p.cjk_ttc_index)

    subset_kept = _subset_cjk(cjk, p, report)
    _instance_variable_fonts(base, cjk, p, report)

    upem = base["head"].unitsPerEm
    if "glyf" not in base:
        # OTF / CFF (incl. CFF-based TTC) base: convert outlines to glyph
        report("convert")
        _to_glyf(base, upem)
    cjk_upem = cjk["head"].unitsPerEm
    units_per_px = upem / p.fs
    cjk_scale = upem / cjk_upem

    base_cmap = base.getBestCmap()
    cjk_cmap = cjk.getBestCmap()
    mono_ref_adv = _mono_reference_advance(base, base_cmap, upem)
    cjk_adv_locked = round(2 * mono_ref_adv * p.mono_adv_mul)

    _adjust_mono_advances(base, p, upem, units_per_px, report)
    added, added_cmap = _append_cjk(
        base,
        cjk,
        p,
        cjk_cmap,
        base_cmap,
        upem,
        cjk_adv_locked,
        cjk_scale,
        units_per_px,
        report,
    )
    _merge_cmap(base, base_cmap, added_cmap, report)
    _synthesize_names(base, cjk, p)
    _update_metrics(base, p, mono_ref_adv, report)
    _update_vertical_metrics(base, cjk, p, upem, cjk_scale, units_per_px)
    _ensure_gasp(base)

    report("save")
    if p.fmt == "woff2":
        base.flavor = "woff2"  # brotli-compressed packaging of the same TTF
    # skip the table-reordering pass (it rewrites the whole file once more)
    base.save(out_path, reorderTables=None)
    return {"added": added, "upem": upem, "format": p.fmt, "subset_kept": subset_kept}


if __name__ == "__main__":
    mono_path, cjk_path, out_path, params_path = sys.argv[1:5]
    with open(params_path) as fp:
        params = json.load(fp)
    print(json.dumps(merge(mono_path, cjk_path, out_path, params)))
