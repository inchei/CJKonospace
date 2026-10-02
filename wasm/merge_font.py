# /// script
# requires-python = ">=3.10"
# dependencies = ["fonttools", "brotli", "numpy"]
# ///
"""Merge a monospace font (base) with a CJK font.

Mono is the base font so its GSUB/GPOS/GDEF and glyph IDs stay intact; scaled
CJK glyphs are appended at the end of the glyph order and exposed through cmap.

fontTools only. numpy is optional: when importable it accelerates the per-glyph
glyf decode/scale step (local CLI and the exported build.py); inside pyodide
(see src/exporter.ts) numpy is not loaded, so the pure-Python fallback runs.

Pass "mergeWght": true in params to merge the shared wght axis instead of
pinning both fonts to a static instance: both inputs must be variable
glyf/gvar fonts with a wght axis, and the output is a variable font over the
mono wght range. "weightMap" ([[mono, cjk], ...] anchors, mono user values)
pairs the two fonts' masters; without it the fvar min/default/max are aligned.

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
import struct
import sys
from math import ceil
from types import SimpleNamespace

from fontTools.misc.roundTools import otRound
from fontTools.misc.transform import Transform
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont
from fontTools.ttLib.tables._g_l_y_f import Glyph, GlyphCoordinates

try:  # optional; absent in the pyodide worker, present for local builds
    import numpy as _numpy
except ImportError:
    _numpy = None

# Style-name keywords -> OS/2 usWeightClass. Compound forms first so
# "ExtraBold"/"SemiBold" are not matched as "Bold".
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

# Style-name keywords -> OS/2 usWidthClass (1 = Ultra-condensed ... 9 =
# Ultra-expanded). Compound forms first.
_WIDTH_PATTERNS = (
    (r"\bultra\s*condensed\b", 1),
    (r"\bextra\s*condensed\b", 2),
    (r"\bsemi\s*condensed\b", 4),
    (r"\bcondensed\b|\bnarrow\b", 3),
    (r"\bsemi\s*expanded\b", 6),
    (r"\bextra\s*expanded\b", 8),
    (r"\bultra\s*expanded\b", 9),
    (r"\bexpanded\b|\bwide\b", 7),
)


def _normalize_style(style):
    """Lowercase a style name and reduce separators to single spaces."""
    return re.sub(r"[^0-9a-z]+", " ", style.lower()).strip()


def _weight_from_style(style):
    """Infer an OS/2 usWeightClass from a freely-typed style name, or None."""
    normalized = _normalize_style(style)
    if not normalized:
        return None
    for pattern, weight in _WEIGHT_PATTERNS:
        if re.search(pattern, normalized):
            return weight
    found = re.search(r"\b(?:[1-9][0-9]{2}|1000)\b", normalized)
    return int(found.group(0)) if found else None


def _width_from_style(style):
    """Infer an OS/2 usWidthClass from a freely-typed style name, or None."""
    normalized = _normalize_style(style)
    for pattern, width in _WIDTH_PATTERNS:
        if re.search(pattern, normalized):
            return width
    return None


def _sync_subfamily_style(base, style):
    """Sync usWeightClass/usWidthClass, fsSelection and head.macStyle from the
    freely-typed subfamily; an empty or unrecognized name keeps the base
    values. Style-bit rules follow the OpenType name examples:
    https://learn.microsoft.com/en-us/typography/opentype/spec/namesmp
    """
    normalized = _normalize_style(style)
    weight = _weight_from_style(style)
    width = _width_from_style(style)
    italic = bool(re.search(r"\bitalic\b", normalized))
    oblique = bool(re.search(r"\boblique\b", normalized))
    # unset (empty) or unrecognized: keep the mono base's style metadata
    if weight is None and width is None and not italic and not oblique:
        return

    bold = weight is not None and weight >= 700
    regular = weight == 400 and not italic and not oblique

    if "OS/2" in base:
        os2 = base["OS/2"]
        if weight is not None:
            os2.usWeightClass = weight
        if width is not None:
            os2.usWidthClass = width
        # only the bits the subfamily expresses; keep effect/TYPO/WWS bits
        selection = os2.fsSelection & ~((1 << 0) | (1 << 5) | (1 << 6) | (1 << 9))
        if italic or oblique:
            selection |= 1 << 0
        if oblique:
            selection |= 1 << 9
        if bold:
            selection |= 1 << 5
        if regular:
            selection |= 1 << 6
        os2.fsSelection = selection

    if "head" in base:
        head = base["head"]
        # bold(0)/italic(1) always; Condensed(5)/Extended(6) only with a width
        clear = (1 << 0) | (1 << 1)
        if width is not None:
            clear |= (1 << 5) | (1 << 6)
        mac_style = head.macStyle & ~clear
        if bold:
            mac_style |= 1 << 0
        if italic or oblique:
            mac_style |= 1 << 1
        if width is not None and width < 5:
            mac_style |= 1 << 5
        elif width is not None and width > 5:
            mac_style |= 1 << 6
        head.macStyle = mac_style


def _pen_glyph(src_glyph_set, name, sx, sy, dx, dy, upem, reverse=False):
    """Redraw a glyph with a pen (used for CFF sources and composites).

    reverse=True flips contour direction, which is needed for CFF (PostScript)
    sources: CFF is counter-clockwise, TrueType conventionally clockwise.
    The real glyph set (not None) is required: composite sources keep their
    components, which _finalize_composites rebases onto the merged names
    (a None set crashes on the first component).
    """
    pen = TTGlyphPen(src_glyph_set)
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


def _expand_flags(data, pos, npts):
    """Expand a glyf flag run-length stream; (bytearray, next_pos) or None.

    A byte is a repeat-flag when bit 3 is set, and the byte right after a
    repeat-flag (not itself a flag) is its count: the flag then repeats
    count + 1 times. Pure Python beats a vectorized decode here because the
    stream is only ~npts bytes and CJK glyphs have a few hundred points, so
    byte indexing plus slice assignment avoids NumPy's per-call dispatch
    overhead. Validated byte-for-byte against Glyph.decompileCoordinates on a
    31k-glyph CJK font. Returns None on a malformed stream.
    """
    out = bytearray(npts)
    end = len(data)
    i = 0
    p = pos
    while i < npts:
        if p >= end:
            return None
        flag = data[p]
        p += 1
        out[i] = flag
        i += 1
        if flag & 8:  # flagRepeat
            if p >= end:
                return None
            count = data[p]
            p += 1
            j = i + count
            if j > npts:
                return None
            out[i:j] = bytes((flag,)) * count
            i = j
    return out, p


def _numpy_deltas(np, buf, flags, pos, short_bit, same_bit):
    """Decode one coordinate delta stream (x or y) at C speed.

    `short_bit`/`same_bit` select the flag bits for this axis. Returns the
    per-point delta array and the stream's end offset. Mirrors the per-flag
    sign handling in Glyph.decompileCoordinates: a short delta is unsigned with
    the sign taken from the "same" bit, a long one is a signed big-endian int16.
    The buffer is read with a one-point gather (at/at+1) rather than boolean
    indexing, which is much cheaper for the ~200-point glyphs CJK fonts have.
    """
    short = (flags & short_bit) != 0
    same = (flags & same_bit) != 0
    size = np.where(short, 1, np.where(same, 0, 2))
    offset = np.empty(flags.shape[0], dtype=np.int64)
    offset[0] = 0
    np.cumsum(size[:-1], out=offset[1:])
    at = pos + offset
    hi = buf[at].astype(np.int64)
    lo = buf[at + 1].astype(np.int64)
    long_value = (hi << 8) | lo
    long_value = np.where(long_value >= 0x8000, long_value - 0x10000, long_value)
    value = np.where(short, np.where(same, hi, -hi), np.where(same, 0, long_value))
    return value, pos + int(size.sum())


class _NumpyGlyph(Glyph):
    """Keep fractional outlines until save; vectorize only serialization prep."""

    def compileCoordinates(self, *, optimizeSize=True):
        if _numpy is None or not optimizeSize:
            return super().compileCoordinates(optimizeSize=optimizeSize)
        np = _numpy
        coords = np.frombuffer(self.coordinates._a, dtype=np.float64)
        # Keep fontTools' behavior for exceptional coordinates. The bounded
        # range also makes the integer conversion and subtraction exact.
        if not np.all(np.isfinite(coords)) or np.any(np.abs(coords) > 2**31):
            return super().compileCoordinates(optimizeSize=optimizeSize)
        assert len(self.coordinates) == len(self.flags)
        rounded = np.floor(coords + 0.5).astype(np.int64).reshape(-1, 2)
        rounded[1:] -= rounded[:-1].copy()
        # Python ints avoid GlyphCoordinates.__getitem__ and its per-point
        # float checks. Retain the original greedy encoder byte-for-byte.
        deltas = zip(rounded[:, 0].tolist(), rounded[:, 1].tolist(), strict=True)
        packed = self.compileDeltasGreedy(self.flags, deltas)
        endpoints = np.asarray(self.endPtsOfContours, dtype=">u2").tobytes()
        instructions = self.program.getBytecode()
        return b"".join(
            (endpoints, struct.pack(">h", len(instructions)), instructions, *packed)
        )


def _numpy_move_simple(data, ncont, sx, sy, dx, dy):
    """Vectorized decode + scale/translate of one simple glyf glyph.

    Mirrors Glyph.decompileCoordinates + GlyphCoordinates.relativeToAbsolute,
    replacing the per-point Python loop with numpy array ops. Returns a filled
    Glyph, or None so the caller can fall back to the pure-Python path. Only
    reached when numpy is importable (local CLI / exported build.py).
    """
    np = _numpy
    from fontTools.ttLib.tables import ttProgram

    end_pts = np.frombuffer(data, dtype=">u2", count=ncont, offset=10)
    npts = int(end_pts[-1]) + 1
    pos = 10 + 2 * ncont
    (instruction_length,) = struct.unpack_from(">h", data, pos)
    if instruction_length < 0:
        return None
    pos += 2
    program = ttProgram.Program()
    program.fromBytecode(data[pos : pos + instruction_length])
    pos += instruction_length

    # pad so the delta look-ahead reads always have bytes available past `pos`
    # (the real streams sit at the data tail)
    buf = np.frombuffer(data + b"\x00" * 512, dtype=np.uint8)
    expanded = _expand_flags(data, pos, npts)
    if expanded is None:  # malformed; let fontTools report it
        return None
    flag_bytes, pos = expanded
    flags = np.frombuffer(flag_bytes, dtype=np.uint8)

    xd, pos = _numpy_deltas(np, buf, flags, pos, 2, 16)
    yd, _ = _numpy_deltas(np, buf, flags, pos, 4, 32)
    xs = np.cumsum(xd)
    ys = np.cumsum(yd)
    tx = xs * sx + dx
    ty = ys * sy + dy

    coords = GlyphCoordinates()
    flat = np.empty(2 * npts, dtype=np.float64)
    flat[0::2] = tx
    flat[1::2] = ty
    coords._a.frombytes(memoryview(flat).cast("B"))

    new = _NumpyGlyph()
    new.numberOfContours = ncont
    new.endPtsOfContours = end_pts.tolist()
    new.program = program
    new.flags = bytearray((flags & 193).tobytes())  # keepFlags
    new.coordinates = coords
    new.xMin = otRound(tx.min())
    new.yMin = otRound(ty.min())
    new.xMax = otRound(tx.max())
    new.yMax = otRound(ty.max())
    return new


def _numpy_move_loaded(g, sx, sy, dx, dy):
    """Vectorized scale/translate of an already-expanded simple glyph.

    The variable-font path instances each source before merging, so its glyphs
    carry coordinates but no raw bytes. This mirrors the pure-Python loop at the
    end of _move_glyf_glyph without the per-point cost. Returns None for an
    empty coordinate array so the caller can fall back.
    """
    np = _numpy
    flat = np.frombuffer(g.coordinates._a, dtype=np.float64).copy()
    if not flat.size:
        return None
    flat[0::2] *= sx
    flat[0::2] += dx
    flat[1::2] *= sy
    flat[1::2] += dy
    new = _NumpyGlyph()
    new.numberOfContours = g.numberOfContours
    new.endPtsOfContours = list(g.endPtsOfContours)
    new.flags = list(g.flags)
    if hasattr(g, "program"):
        new.program = g.program
    new.coordinates = GlyphCoordinates()
    new.coordinates._a.frombytes(memoryview(flat).cast("B"))
    new.xMin = otRound(flat[0::2].min())
    new.yMin = otRound(flat[1::2].min())
    new.xMax = otRound(flat[0::2].max())
    new.yMax = otRound(flat[1::2].max())
    return new


def _move_glyf_glyph(src_glyf, name, sx, sy, dx, dy):
    """Build a transformed copy of a glyf glyph.

    The source glyph must not be mutated: several codepoints can share one
    glyph, and mutating it in place would scale it once per codepoint. Only the
    fields compile() reads are copied (no deepcopy of the raw data), and scale +
    translate are done in a single pass. Returns None for composites, which the
    caller redraws with a pen.
    """
    # Simple glyphs still holding their raw glyf bytes go through the numpy
    # decoder without ever expanding them; already-expanded simple glyphs
    # (e.g. instanced variable sources) go through the numpy transform. Only
    # composites and the no-numpy worker use the pure-Python path below.
    raw = src_glyf.glyphs.get(name)
    data = getattr(raw, "data", None) if raw is not None else None
    if _numpy is not None and data and len(data) >= 12:
        ncont = int.from_bytes(data[:2], "big", signed=True)
        if ncont > 0 and len(data) >= 12 + 2 * ncont:
            moved = _numpy_move_simple(data, ncont, sx, sy, dx, dy)
            if moved is not None:
                return moved
    g = src_glyf[name]
    g.expand(src_glyf)
    if g.isComposite():
        if sx != sy:
            # a non-uniform scale cannot preserve the component structure
            return None
        if sx != 1 and not all(hasattr(comp, "x") for comp in g.components):
            # anchor-attached components carry point numbers, not offsets.
            # (decompiled components never carry ARGS_ARE_XY_VALUES in flags;
            # presence of x/y is the real discriminator.)
            return None
        # Structure is preserved but transforms are applied later by
        # _finalize_composites: the component bases are appended with their
        # own transforms, so the composite must be rebased onto the renamed
        # bases (see the formula there) instead of transformed here.
        new = copy.deepcopy(g)
        new.recalcBounds(src_glyf)
        return new
    if not hasattr(g, "coordinates"):
        empty = Glyph()  # empty glyph (no contours)
        empty.numberOfContours = 0
        return empty
    if _numpy is not None:
        moved = _numpy_move_loaded(g, sx, sy, dx, dy)
        if moved is not None:
            return moved
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
        merge_wght=bool(params.get("mergeWght", False)),
        # [[mono, cjk], ...] wght anchors (user values) pairing the two fonts;
        # only read when merge_wght is on
        weight_map=params.get("weightMap") or [],
        # {"min": ..., "max": ...} output wght range override (user values);
        # defaults to the full mono range when absent or invalid
        axis_range=params.get("axisRange") or {},
        family=params.get("familyName", "CJKonospace"),
        # empty means "unset": follow the mono base's own subfamily
        style=str(params.get("styleName") or "").strip(),
        line_height=float(params.get("lineHeight", 1.0)),
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


def _default_location(font):
    """Axis defaults of a variable font (tag -> user value)."""
    fvar = font.get("fvar")
    if fvar is None:
        return {}
    return {axis.axisTag: axis.defaultValue for axis in fvar.axes}


def _instance_variable_fonts(base, cjk, p, report):
    """Pin variable fonts to a static instance (no axis merging).

    An empty location means "use the axis defaults". Axes missing from the
    location are pinned at their defaults too: leaving any axis variable
    would carry fvar/gvar/HVAR into the static pipeline, which cannot
    rebase them for appended glyphs (stale HVAR maps crash the save).
    """
    if "fvar" not in base and "fvar" not in cjk:
        return
    from fontTools.varLib.instancer import instantiateVariableFont

    report("instance")
    for tag, font in (("mono", base), ("cjk", cjk)):
        if "fvar" in font:
            loc = _default_location(font)
            loc.update(p.variations.get(tag) or {})
            instantiateVariableFont(font, loc, inplace=True)


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


def _finalize_composites(
    base, p, units_per_px, src_to_out, dx_map, tmap, appended, cjk_names
):
    """Rebase preserved CJK composites onto the merged glyph names.

    Appended base glyphs already carry the merge transform, so a preserved
    composite keeps its original component transform and only gets a
    corrective offset. With uniform scale S, composite shift d and base
    shift d_base, rendering M_new*(S*B + d_base) + o_new must equal the
    directly transformed outlines S*(M_old*B + o_old) + d, i.e. M_new = M_old
    and o_new = S*o_old + d - M_old*d_base. Components drawn by the pen
    already carry the composite transform; for those the scale is stripped
    back out first. Either way the result renders exactly the transformed
    outlines while keeping the component structure (and cross-master point
    compatibility).

    Returns the codepoints to drop: composites whose references cannot be
    rebased exactly (unencoded bases, or mono bases whose outlines were
    redrawn) are left out so the cmap falls through instead of writing a
    broken composite.
    """
    glyf = base["glyf"]
    hmtx = base["hmtx"]
    mono_redrawn = not (p.mono_gsx == 1 and p.mono_gsy == 1 and p.mono_bl == 0)
    dy_const = -p.cjk_bl * units_per_px
    base_order = set(base.getGlyphOrder())
    dropped = {}
    for gname, cpnt in appended:
        g = glyf[gname]
        g.expand(glyf)
        if not g.isComposite():
            continue
        sx, sy, dx, dy, from_pen = tmap[gname]
        ok = True
        for comp in g.components:
            out_base = src_to_out.get(comp.glyphName)
            if out_base is None or out_base not in base_order:
                ok = False
                break
            if comp.glyphName in dx_map and out_base in cjk_names:
                dbx, dby = dx_map[comp.glyphName], dy_const
            elif mono_redrawn:
                ok = False
                break
            else:
                # untouched mono-base glyph: outlines carry no merge shift
                dbx, dby = 0, 0
            raw = comp.transform if hasattr(comp, "transform") else [[1, 0], [0, 1]]
            if from_pen:
                # components already carry the composite transform (offsets
                # included): strip the scale back out, no extra shift
                if sx == 0 or sy == 0:
                    ok = False
                    break
                mxx, mxy, myx, myy = (
                    raw[0][0] / sx,
                    raw[0][1] / sx,
                    raw[1][0] / sy,
                    raw[1][1] / sy,
                )
                comp.transform = [[mxx, mxy], [myx, myy]]
                ox, oy, ex, ey = comp.x, comp.y, 0, 0
            else:
                mxx, mxy, myx, myy = raw[0][0], raw[0][1], raw[1][0], raw[1][1]
                ox, oy, ex, ey = sx * comp.x, sy * comp.y, dx, dy
            comp.glyphName = out_base
            comp.x = otRound(ox + ex - (mxx * dbx + mxy * dby))
            comp.y = otRound(oy + ey - (myx * dbx + myy * dby))
        if not ok:
            dropped[gname] = cpnt
            continue
        g.recalcBounds(glyf)
        hmtx[gname] = (hmtx[gname][0], getattr(g, "xMin", 0))
    for gname in dropped:
        # leave an empty glyph behind (unmapped) so the cmap falls through
        # to the mono base instead of referencing a broken composite
        empty = Glyph()
        empty.numberOfContours = 0
        glyf[gname] = empty
    return list(dropped.values())


def _composite_depth(glyph, glyf, seen):
    """Nesting depth of a composite (0 for simple glyphs, 1 for flat ones)."""
    if not glyph.isComposite():
        return 0
    depth = 0
    for comp in glyph.components:
        if comp.glyphName in seen or comp.glyphName not in glyf.glyphs:
            continue
        child = glyf[comp.glyphName]
        child.expand(glyf)
        depth = max(depth, 1 + _composite_depth(child, glyf, seen | {comp.glyphName}))
    return depth


def _decompose_nested_composites(base):
    """Flatten composites whose components are themselves composites.

    Nested components have known rendering and printing bugs, and variable
    fonts make them worse (the Windows rasterizer is the strictest here).
    Decomposition keeps the point structure identical across masters because
    the component set is shared, so the rebuilt gvar stays compatible.
    Returns the number of glyphs decomposed.
    """
    glyf = base.get("glyf")
    if glyf is None:
        return 0
    from fontTools.pens.recordingPen import DecomposingRecordingPen
    from fontTools.pens.ttGlyphPen import TTGlyphPen

    nested = []
    for name in base.getGlyphOrder():
        glyph = glyf[name]
        glyph.expand(glyf)
        if glyph.isComposite() and _composite_depth(glyph, glyf, {name}) > 1:
            nested.append(name)
    if not nested:
        return 0
    hmtx = base.get("hmtx")
    glyph_set = base.getGlyphSet()
    for name in nested:
        glyph = glyf[name]
        glyph.expand(glyf)
        # glyphSet.draw shifts the top-level glyph by (lsb - xMin); undo it
        offset = (hmtx[name][1] - glyph.xMin) if hmtx is not None else 0
        recorder = DecomposingRecordingPen(glyph_set)
        glyph_set[name].draw(recorder)
        pen = TTGlyphPen(None)
        recorder.replay(pen)
        new = pen.glyph()
        if offset:
            coords = new.coordinates
            for i in range(len(coords)):
                x, y = coords[i]
                coords[i] = (x - offset, y)
        new.recalcBounds(glyf)
        glyf[name] = new
        if hmtx is not None:
            hmtx[name] = (hmtx[name][0], getattr(new, "xMin", 0))
    return len(nested)


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
    # CJK glyph name -> merged glyph name, for rebasing preserved composites:
    # a component may reference a glyph appended later in cmap order (or one
    # the base already covers), so the map is built up front. Appended names
    # are unique per codepoint, hence only the initial base order matters.
    src_to_out = {
        cname: base_cmap.get(cpnt, f"cjk.{cpnt:04X}")
        for cpnt, cname in cjk_cmap.items()
    }
    glyf = base["glyf"]
    hmtx = base["hmtx"]
    glyphs = cjk.getGlyphSet()
    cjk_glyf = cjk.get("glyf")
    cjk_is_cff = "CFF " in cjk or "CFF2" in cjk
    cjk_vmtx = cjk.get("vmtx")
    vmtx = base.get("vmtx")
    added = 0
    added_cmap = {}
    # per-glyph merge transform, for the composite post-pass and its
    # exactness formula: dx varies per glyph (advance centering)
    dx_map = {}
    # preserved composites: (sx, sy, dx, dy, from_pen) per merged name
    tmap = {}
    appended = []
    # every CJK-appended glyph name (simple or composite): component bases
    # resolving here were transformed with a tracked dx
    cjk_names = set()
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
        dx_map[cname] = dx
        g = None
        from_pen = False
        if cjk_glyf is not None:
            g = _move_glyf_glyph(cjk_glyf, cname, sx, sy, dx, dy)
        if g is None:
            g = _pen_glyph(glyphs, cname, sx, sy, dx, dy, upem, cjk_is_cff)
            from_pen = True
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
        cjk_names.add(gname)
        added_cmap[cpnt] = gname
        added += 1
        if g.isComposite():
            appended.append((gname, cpnt))
            tmap[gname] = (sx, sy, dx, dy, from_pen)
        if total and added % 2000 == 0:
            report("cjk", min(99, int(added * 100 / total)))
    dropped = _finalize_composites(
        base, p, units_per_px, src_to_out, dx_map, tmap, appended, cjk_names
    )
    for cpnt in dropped:
        del added_cmap[cpnt]
        added -= 1
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


def _name_string(font, name_id):
    """Best available name-table string for name_id, or ""."""
    if "name" not in font:
        return ""
    return font["name"].getDebugName(name_id) or ""


def _synthesize_names(base, cjk, p):
    """Overwrite the output name records, keeping both inputs' attribution."""
    # An unset subfamily follows the mono base's own subfamily (prefer the
    # typographic ID 17, else the RIBBI ID 2).
    style = p.style or _name_string(base, 17) or _name_string(base, 2) or "Regular"
    fam = p.family
    full = f"{fam} {style}"
    ps = full.replace(" ", "")
    nt = base["name"]
    tool_url = "https://github.com/inchei/CJKonospace"
    synth = f"Synthesized with CJKonospace ({tool_url})"

    def original_texts(name_id):
        """Name record texts from the input fonts having this record."""
        return [
            t for t in (_name_string(base, name_id), _name_string(cjk, name_id)) if t
        ]

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
    # drop records that are stale or meaningless in the merged output, plus
    # every Macintosh-platform record: modern Windows/macOS read the Windows
    # records, and Mac strings are Pascal-length-limited (255 bytes) so long
    # licenses/copyrights would be malformed. reserved (15), Mac-only legacy
    # names (18), the mono font's sample text (19), the CID findfont name
    # (20, the output is never CID-keyed), color palettes (23, 24, no COLR
    # table is carried over), and the variable-font PostScript prefix (25,
    # inherited prefixes name the wrong family)
    drop_ids = {15, 18, 19, 20, 23, 24, 25}
    nt.names = [
        rec
        for rec in nt.names
        if rec.nameID not in drop_ids
        and rec.platformID != 1
        and (
            rec.nameID not in managed
            or (rec.platformID, rec.platEncID, rec.langID) == (3, 1, 0x409)
        )
    ]
    if "head" in base:
        # name ID 5 above is always "Version 1.000"; keep head in sync
        base["head"].fontRevision = 1.0


def _is_monospace(font, cmap):
    """True when the font's printable-ASCII glyphs all share one advance.

    Only ASCII is considered: CJK is full-width (2x) by design and would not be
    uniform. A base with no measurable ASCII glyph is not monospace (nothing
    verifies it).
    """
    hmtx = font["hmtx"]
    widths = {
        hmtx[g][0]
        for cp, g in cmap.items()
        if 0x20 <= cp <= 0x7E and g in hmtx.metrics and hmtx[g][0] > 0
    }
    return len(widths) == 1


def _update_metrics(base, p, mono_ref_adv, report):
    """Set monospace/coverage flags; returns whether the mono flags were applied.

    The "font is monospace" flags (post.isFixedPitch, panose.bProportion) are
    only set when the base actually is monospace, so a proportional base is not
    mislabelled.
    """
    report("metrics")
    mono = _is_monospace(base, base.getBestCmap())
    if "post" in base and mono:
        base["post"].isFixedPitch = 1
    if "OS/2" in base:
        os2 = base["OS/2"]
        if mono:
            os2.panose.bProportion = 9  # monospace
        os2.xAvgCharWidth = round(mono_ref_adv * p.mono_adv_mul)
        # Recompute the coverage flags from the merged cmap: the mono base's
        # values no longer describe the appended CJK glyphs. fontTools helpers
        # (>= 4.44) keep the base's ranges and add the CJK ones.
        os2.recalcUnicodeRanges(base)
        os2.recalcCodePageRanges(base)
        os2.updateFirstAndLastCharIndex(base)
    return mono


def _scan_glyf(glyf):
    """Outline bounds and maxp profile over the whole glyph set.

    Returns ((yMin, yMax), profile) with profile holding maxima for
    maxPoints/maxContours/maxCompositePoints/maxCompositeContours/
    maxComponentElements/maxComponentDepth; (None, None) bounds when every
    glyph is empty. Composites resolve through recalculated bounds and
    recurse with a cycle guard; shared bases count per use (conservative).
    """
    bot = top = None
    profile = {
        "maxPoints": 0,
        "maxContours": 0,
        "maxCompositePoints": 0,
        "maxCompositeContours": 0,
        "maxComponentElements": 0,
        "maxComponentDepth": 0,
    }

    def bounds(name):
        """(lo, hi) outline extent of one glyph, composites included."""
        g = glyf[name]
        g.expand(glyf)
        if hasattr(g, "coordinates") and len(g.coordinates):
            # calcBounds slices the backing array at C speed; the equivalent
            # Python loop over coordinates is this function's hot path
            _, lo, _, hi = g.coordinates.calcBounds()
            return lo, hi
        if all(hasattr(g, attr) for attr in ("yMin", "yMax")):
            return g.yMin, g.yMax
        return None

    def walk(name, seen):
        """(points, contours, elements, depth), nested-composite aware."""
        if name in seen or name not in glyf.glyphs:
            return 0, 0, 0, 0
        g = glyf[name]
        g.expand(glyf)
        if not g.isComposite():
            if not hasattr(g, "coordinates"):
                return 0, 0, 0, 0
            return len(g.coordinates), g.numberOfContours, 0, 0
        points = contours = elements = depth = 0
        for comp in g.components:
            p, c, _, d = walk(comp.glyphName, seen | {name})
            points += p
            contours += c
            elements += 1
            depth = max(depth, d + 1)
        return points, contours, elements, depth

    for name in glyf.glyphOrder:
        extent = bounds(name)
        if extent is not None:
            lo, hi = extent
            bot = lo if bot is None else min(bot, lo)
            top = hi if top is None else max(top, hi)
        g = glyf[name]
        g.expand(glyf)
        if not g.isComposite():
            continue
        points, contours, elements, depth = walk(name, set())
        profile["maxCompositePoints"] = max(profile["maxCompositePoints"], points)
        profile["maxCompositeContours"] = max(profile["maxCompositeContours"], contours)
        profile["maxComponentElements"] = max(profile["maxComponentElements"], elements)
        profile["maxComponentDepth"] = max(profile["maxComponentDepth"], depth)
    for name in glyf.glyphOrder:
        g = glyf[name]
        g.expand(glyf)
        if g.isComposite() or not hasattr(g, "coordinates"):
            continue
        profile["maxPoints"] = max(profile["maxPoints"], len(g.coordinates))
        profile["maxContours"] = max(profile["maxContours"], g.numberOfContours)
    return (bot, top), profile


def _update_vertical_metrics(base, cjk, p, upem, cjk_scale, units_per_px):
    """Derive asc/desc from both fonts' hhea, times lineHeight.

    lineGap is forced to 0 (terminals interpret a positive gap inconsistently:
    ignored, split 50/50, or added above/below), so the line box comes only
    from ascender/descender. The web preview mirrors this.
    See:
    - https://github.com/arrowtype/vertical-metrics
    - https://github.com/githubnext/monaspace/pull/227

    Returns the actual outline (yMin, yMax) for win-metrics coverage (below).
    """
    multiplier = p.line_height
    # same sign as the outline shift in _append_cjk (dy = -bl * units):
    # a positive baseline offset moves glyphs down, so declared metrics
    # must move down too (the preview applies the offset in the same direction)
    bl_units = -p.cjk_bl * units_per_px
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
        base["hhea"].lineGap = 0
    if "OS/2" in base:
        os2 = base["OS/2"]
        os2.sTypoAscender = ascender
        os2.sTypoDescender = descender
        os2.sTypoLineGap = 0
        os2.usWinAscent = ascender
        os2.usWinDescent = -descender
        # win metrics are clipping guards, not design metrics: cover the
        # actual outlines. Declared hhea can understate deep/tall glyphs
        # (e.g. a base Arabic tail), and our own scaling/baseline shifts
        # move bounds around. Windows clips anything outside these.
        # maxp profile maxima are recomputed for the same reason:
        # appended glyphs can exceed the mono base's maxima, and strict
        # rasterizers size buffers from them.
        if "glyf" in base:
            (ymin, ymax), profile = _scan_glyf(base["glyf"])
            if ymax is not None:
                os2.usWinAscent = max(ascender, ceil(ymax))
            if ymin is not None:
                os2.usWinDescent = max(-descender, ceil(-ymin))
            if "maxp" in base and base["maxp"].tableVersion == 0x00010000:
                maxp = base["maxp"]
                for attr, value in profile.items():
                    setattr(maxp, attr, max(getattr(maxp, attr), value))
        else:
            ymin = ymax = None
    else:
        ymin = ymax = None
    return ymin, ymax


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


# One full CJK merge per wght master; beyond this the browser worker runs
# out of steam (use the standalone build.py locally for huge master counts).
_MAX_VARIABLE_MASTERS = 16

# meta["warnings"] codes (the web UI maps them to localized messages; the CLI
# maps them to English in _VARIABLE_WARNING_TEXTS).
_WARN_NO_WGHT_AXIS = "no-wght-axis"
_WARN_CFF_VARIABLE = "cff-variable"
_WARN_MONO_OUTLINE_IGNORED = "mono-outline-ignored"

_VARIABLE_WARNING_TEXTS = {
    _WARN_NO_WGHT_AXIS: (
        "mergeWght requested but a side has no wght axis; static output"
    ),
    _WARN_CFF_VARIABLE: (
        "mergeWght requested but a variable input uses CFF outlines; static output"
    ),
    _WARN_MONO_OUTLINE_IGNORED: (
        "mergeWght ignores mono gsx/gsy/baseline (they break master "
        "compatibility); advances still vary"
    ),
}


def _fvar_axis(font, tag):
    """(min, default, max) user values of an fvar axis, or None."""
    fvar = font.get("fvar")
    if fvar is None:
        return None
    for axis in fvar.axes:
        if axis.axisTag == tag:
            return (axis.minValue, axis.defaultValue, axis.maxValue)
    return None


def _fvar_axis_index(font, tag):
    """Index of an fvar axis (the VarStore region axis order), or None."""
    fvar = font.get("fvar")
    if fvar is None:
        return None
    for i, axis in enumerate(fvar.axes):
        if axis.axisTag == tag:
            return i
    return None


def _instance_name(name_table, subfamily_id):
    """English subfamily name of an fvar instance, or ""."""
    if name_table is None:
        return ""
    rec = name_table.getName(subfamily_id, 3, 1, 0x409)
    if rec is None:
        rec = name_table.getName(subfamily_id, 1, 0, 0)
    if rec is None:
        for candidate in name_table.names:
            if candidate.nameID == subfamily_id:
                rec = candidate
                break
    if rec is None:
        return ""
    try:
        return rec.toUnicode().strip()
    except (UnicodeDecodeError, ValueError):
        return ""


def _mono_instances(base, out_min, out_max):
    """[(wght_user, subfamily_name)] from the mono base's fvar instances.

    Only instances expressible on the single-axis output survive: every
    non-wght axis must sit at its default, and wght must fall inside the
    (possibly narrowed) output range.
    """
    fvar = base.get("fvar")
    if fvar is None:
        return []
    name_table = base.get("name")
    found = []
    for inst in fvar.instances:
        coords = dict(inst.coordinates or {})
        wght = None
        representable = True
        for axis in fvar.axes:
            value = coords.get(axis.axisTag, axis.defaultValue)
            if axis.axisTag == "wght":
                wght = value
            elif value != axis.defaultValue:
                representable = False
                break
        if not representable or wght is None:
            continue
        if not (out_min - 1e-6 <= wght <= out_max + 1e-6):
            continue
        name = _instance_name(name_table, inst.subfamilyNameID)
        if name:
            found.append((wght, name))
    return sorted(found)


def _design_to_user_table(font, tag):
    """[(design_n, user_value)] covering [-1, 1] for an fvar axis.

    Folds the font's avar segment map (avar segments are
    normalized-user -> normalized-design); without avar this is the inverse
    of the plain fvar normalization. avar v2 (VarStore) is vanishingly rare
    for wght and treated as identity.
    """
    axis = _fvar_axis(font, tag)
    lo, de, hi = axis
    points = [(-1.0, -1.0), (0.0, 0.0), (1.0, 1.0)]
    avar = font.get("avar")
    segments = getattr(avar, "segments", None) if avar is not None else None
    if segments:
        points += [(float(t), float(n)) for t, n in segments.get(tag, {}).items()]
    table = []
    for t, n in sorted(set(points), key=lambda p: (p[1], p[0])):
        user = de + t * (de - lo) if t <= 0 else de + t * (hi - de)
        table.append((n, user))
    return table


def _design_to_user(table, n):
    """Piecewise-linear lookup in a _design_to_user_table."""
    if n <= table[0][0]:
        return table[0][1]
    if n >= table[-1][0]:
        return table[-1][1]
    for (n0, u0), (n1, u1) in zip(table, table[1:], strict=False):
        if n0 <= n <= n1:
            span = n1 - n0
            t = 0 if span == 0 else (n - n0) / span
            return u0 + t * (u1 - u0)
    return table[-1][1]


def _user_to_design(font, tag, user):
    """User-space axis value -> design-normalized coordinate (folds avar)."""
    axis = _fvar_axis(font, tag)
    if axis is None:
        return 0.0
    lo, de, hi = axis
    if user <= de:
        t = 0.0 if de == lo else -((de - user) / (de - lo))
    else:
        t = 0.0 if hi == de else (user - de) / (hi - de)
    avar = font.get("avar")
    segments = getattr(avar, "segments", None) if avar is not None else None
    points = [(-1.0, -1.0), (0.0, 0.0), (1.0, 1.0)]
    if segments:
        points += [(float(k), float(v)) for k, v in segments.get(tag, {}).items()]
    points = sorted(set(points))
    if t <= points[0][0]:
        return points[0][1]
    if t >= points[-1][0]:
        return points[-1][1]
    for (t0, n0), (t1, n1) in zip(points, points[1:], strict=False):
        if t0 <= t <= t1:
            span = t1 - t0
            u = 0 if span == 0 else (t - t0) / span
            return n0 + u * (n1 - n0)
    return points[-1][1]


def _normalize_linear(value, triple):
    """User-space value -> normalized coordinate on a linear (avar-less) axis."""
    lo, de, hi = triple
    if value <= de:
        return 0.0 if de == lo else -((de - value) / (de - lo))
    return 0.0 if hi == de else (value - de) / (hi - de)


def _denormalize_linear(n, triple):
    """Normalized coordinate -> user-space value on a linear axis."""
    lo, de, hi = triple
    if n <= 0:
        return de + n * (de - lo)
    return de + n * (hi - de)


def _avar_segments(base, out_triple):
    """The mono base's wght avar segments, or None when not carryable.

    Only meaningful when the output keeps the mono base's full user range:
    narrowing re-normalizes the design space, so a straight copy would
    misplace the curve. avar v2 (VarStore) is left to the linear fallback.
    """
    mono_axis = _fvar_axis(base, "wght")
    if mono_axis is None or any(
        abs(a - b) > 1e-6 for a, b in zip(mono_axis, out_triple, strict=False)
    ):
        return None
    avar = base.get("avar")
    segments = getattr(avar, "segments", None) if avar is not None else None
    if not segments or getattr(avar, "majorVersion", 1) >= 2:
        return None
    seg = segments.get("wght")
    return {"wght": dict(seg)} if seg else None


def _condition_range(cond):
    """(axis_index, min, max) of a Format-1 FeatureVariations condition."""
    if getattr(cond, "Format", 1) != 1:
        return None
    axis = getattr(cond, "AxisIndex", None)
    lo = getattr(cond, "FilterRangeMinValue", None)
    if lo is None:
        lo = getattr(cond, "ConditionMinValue", None)
    hi = getattr(cond, "FilterRangeMaxValue", None)
    if hi is None:
        hi = getattr(cond, "ConditionMaxValue", None)
    if axis is None or lo is None or hi is None:
        return None
    return axis, float(lo), float(hi)


def _layout_rules(base, p, out_triple):
    """GSUB FeatureVariations rebuild plan: {featureTag: [(region, subs)]}.

    Variable fonts swap glyphs by design region (e.g. Cascadia Code's rvrn
    rule using dollar.BRACKET.600 at heavy weights), but instancing bakes
    the matching rules into each static master and drops the table, so the
    merged output would lose every such swap. Re-express the mono base's
    wght-conditioned SingleSubst rules on the output's linear wght axis
    (regions in output-normalized coordinates, user-space switch points
    preserved); the builder recreates them with fresh lookups.
    """
    table = base.get("GSUB")
    store = getattr(getattr(table, "table", None), "FeatureVariations", None)
    if store is None:
        return {}
    fvar = base.get("fvar")
    if fvar is None:
        return {}
    axis_tags = [axis.axisTag for axis in fvar.axes]
    pinned = _default_location(base)
    pinned.update(p.variations.get("mono") or {})
    features = table.table.FeatureList.FeatureRecord
    lookups = table.table.LookupList.Lookup
    to_user = _design_to_user_table(base, "wght")
    rules = {}
    for record in store.FeatureVariationRecord or []:
        ranges = []
        usable = True
        for cond in getattr(record.ConditionSet, "ConditionTable", None) or []:
            parsed = _condition_range(cond)
            if parsed is None:
                usable = False
                break
            axis_index, cmin, cmax = parsed
            if axis_index >= len(axis_tags):
                usable = False
                break
            tag = axis_tags[axis_index]
            if tag != "wght":
                # other axes are pinned in the output: keep the record only
                # when the pinned value satisfies the condition
                axis = _fvar_axis(base, tag)
                user = pinned.get(tag, axis[1] if axis else 0)
                design = _user_to_design(base, tag, user)
                if not (cmin - 1e-6 <= design <= cmax + 1e-6):
                    usable = False
                    break
                continue
            ranges.append((cmin, cmax))
        if not usable or not ranges:
            # no wght condition: uniformly baked-or-dropped across masters
            # already, nothing to rebuild
            continue
        nmin = max(r[0] for r in ranges)
        nmax = min(r[1] for r in ranges)
        subs = {}
        for subst in (
            getattr(record.FeatureTableSubstitution, "SubstitutionRecord", None) or []
        ):
            feature_index = getattr(subst, "FeatureIndex", None)
            feature = getattr(subst, "Feature", None)
            if feature_index is None or feature is None:
                continue
            if not (0 <= feature_index < len(features)):
                continue
            feature_tag = features[feature_index].FeatureTag
            for lookup_index in feature.LookupListIndex or []:
                if not (0 <= lookup_index < len(lookups)):
                    continue
                lookup = lookups[lookup_index]
                if lookup.LookupType != 1:  # SingleSubst only
                    continue
                for subtable in lookup.SubTable:
                    mapping = getattr(subtable, "mapping", None) or {}
                    for orig, repl in mapping.items():
                        if isinstance(orig, str) and isinstance(repl, str):
                            subs.setdefault((feature_tag, orig), repl)
        by_feature = {}
        for (feature_tag, orig), repl in subs.items():
            by_feature.setdefault(feature_tag, {})[orig] = repl
        for feature_tag, mapping in by_feature.items():
            # design endpoints -> mono user -> output-normalized, clamped
            omin = max(
                -1.0,
                _normalize_linear(_design_to_user(to_user, nmin), out_triple),
            )
            omax = min(
                1.0, _normalize_linear(_design_to_user(to_user, nmax), out_triple)
            )
            if omax - omin < 1e-6:
                continue
            rules.setdefault(feature_tag, []).append(
                ([{"wght": (omin, omax)}], mapping)
            )
    return rules


def _wght_peaks(font):
    """Unique design-normalized wght master positions; always includes 0.

    Masters come from gvar/HVAR/MVAR regions only. avar is a normalization
    curve, not a set of masters, and its segment points would multiply the
    sampled masters (and the output gvar) many times over.
    """
    peaks = {0.0}
    gvar = font.get("gvar")
    if gvar is not None:
        for variations in gvar.variations.values():
            for var in variations:
                region = (var.axes or {}).get("wght")
                if region is not None:
                    peaks.add(round(float(region[1]), 4))
    index = _fvar_axis_index(font, "wght")
    if index is not None:
        for tag in ("HVAR", "MVAR"):
            table = font.get(tag)
            store = getattr(getattr(table, "table", None), "VarStore", None)
            regions = getattr(getattr(store, "VarRegionList", None), "Region", None)
            for region in regions or []:
                axes = getattr(region, "VarRegionAxis", [])
                if index >= len(axes):
                    continue
                # field is PeakCoord since forever; accept Peak just in case
                peak = getattr(axes[index], "PeakCoord", None)
                if peak is None:
                    peak = getattr(axes[index], "Peak", None)
                if peak is not None:
                    peaks.add(round(float(peak), 4))
    return sorted(peaks)


def _clean_weight_map(raw):
    """Validated [[mono, cjk]] anchors, or None when unusable."""
    pairs = []
    if isinstance(raw, (list, tuple)):
        for item in raw:
            try:
                pairs.append([float(item[0]), float(item[1])])
            except (TypeError, IndexError, ValueError):
                continue
    return pairs if len(pairs) >= 2 else None


def _apply_weight_map(anchors, mono_value):
    """Piecewise-linear mono -> CJK through [mono, cjk] anchors (mirrors UI)."""
    pts = sorted(anchors, key=lambda a: a[0])
    if mono_value <= pts[0][0]:
        return pts[0][1]
    if mono_value >= pts[-1][0]:
        return pts[-1][1]
    for (m0, c0), (m1, c1) in zip(pts, pts[1:], strict=False):
        if m0 <= mono_value <= m1:
            span = m1 - m0
            t = 0 if span == 0 else (mono_value - m0) / span
            return c0 + t * (c1 - c0)
    return pts[-1][1]


def _invert_weight_map(anchors, cjk_value):
    """Mono value whose mapped CJK value equals cjk_value."""
    pts = sorted(anchors, key=lambda a: a[1])
    if cjk_value <= pts[0][1]:
        return pts[0][0]
    if cjk_value >= pts[-1][1]:
        return pts[-1][0]
    for (m0, c0), (m1, c1) in zip(pts, pts[1:], strict=False):
        if (c0 <= cjk_value <= c1) or (c1 <= cjk_value <= c0):
            span = c1 - c0
            t = 0 if span == 0 else (cjk_value - c0) / span
            return m0 + t * (m1 - m0)
    return pts[-1][0]


def _variable_plan(base, cjk, p):
    """Plan a wght merge: (plan, warnings), plan None on static fallback.

    plan = {"axis": output user triple, "locations": [{"internal", "mono",
    "cjk"}, ...], "instances": [...], "layout_rules": {...}, "avar": ...}.

    Masters are keyed by their output-internal (mono design-normalized)
    position. The mono base keeps its own avar curve (carried into the
    output, so few masters reproduce it exactly); CJK masters are placed via
    the weight-map anchors so uneven ranges/speeds stay aligned.
    """
    for font in (base, cjk):
        if "fvar" not in font or _fvar_axis(font, "wght") is None:
            return None, [_WARN_NO_WGHT_AXIS]
        if "CFF " in font or "CFF2" in font:
            return None, [_WARN_CFF_VARIABLE]
    mono_axis = _fvar_axis(base, "wght")
    cjk_axis = _fvar_axis(cjk, "wght")
    if mono_axis[0] >= mono_axis[2]:
        return None, [_WARN_NO_WGHT_AXIS]
    anchors = _clean_weight_map(p.weight_map) or [
        [mono_axis[0], cjk_axis[0]],
        [mono_axis[1], cjk_axis[1]],
        [mono_axis[2], cjk_axis[2]],
    ]
    to_mono = _design_to_user_table(base, "wght")
    to_cjk = _design_to_user_table(cjk, "wght")
    lo, de, hi = mono_axis
    # narrowed output range (e.g. drop mono's thin end when the CJK minimum
    # looks heavier); invalid overrides fall back to the full mono range
    axis_range = p.axis_range or {}
    try:
        out_min = float(axis_range.get("min", lo))
        out_max = float(axis_range.get("max", hi))
    except (TypeError, ValueError):
        out_min, out_max = lo, hi
    if not (lo <= out_min < de < out_max <= hi):
        out_min, out_max = lo, hi
    out_triple = (out_min, de, out_max)

    def cjk_for(mono_user):
        return min(cjk_axis[2], max(cjk_axis[0], _apply_weight_map(anchors, mono_user)))

    # masters keyed by output-internal position; first writer wins so the
    # denser mono peaks take precedence over CJK-mapped duplicates
    masters = {}

    def add(internal, mono_user, cjk_user):
        key = round(min(1.0, max(-1.0, internal)), 6)
        masters.setdefault(key, (mono_user, cjk_user))

    for n in _wght_peaks(base):
        mono_user = _design_to_user(to_mono, n)
        if out_min - 1e-6 <= mono_user <= out_max + 1e-6:
            add(n, mono_user, cjk_for(mono_user))
    for n in _wght_peaks(cjk):
        cjk_user = _design_to_user(to_cjk, n)
        mono_user = _invert_weight_map(anchors, cjk_user)
        mono_user = min(out_max, max(out_min, mono_user))
        add(_user_to_design(base, "wght", mono_user), mono_user, cjk_user)
    # pin the output endpoints and default: nothing extrapolates past them
    add(-1.0, out_min, cjk_for(out_min))
    add(0.0, de, cjk_for(de))
    add(1.0, out_max, cjk_for(out_max))
    items = sorted(masters.items())
    if len(items) > _MAX_VARIABLE_MASTERS:
        # pathological case: pin the default and the endpoints, thin the rest
        pinned = [0.0, -1.0, 1.0]
        rest = [internal for internal, _ in items if internal not in pinned]
        keep = _MAX_VARIABLE_MASTERS - len(pinned)
        idx = sorted({round(i * (len(rest) - 1) / (keep - 1)) for i in range(keep)})
        keys = sorted(set(pinned) | {rest[i] for i in idx})
        items = [(k, masters[k]) for k in keys]
    locations = [
        {"internal": internal, "mono": mono_user, "cjk": cjk_user}
        for internal, (mono_user, cjk_user) in items
    ]
    instances = _mono_instances(base, out_min, out_max)
    layout_rules = _layout_rules(base, p, out_triple)
    return {
        "axis": out_triple,
        "locations": locations,
        "instances": instances,
        "layout_rules": layout_rules,
        "avar": _avar_segments(base, out_triple),
    }, []


def _master_params(params, mono_wght, cjk_wght, ignore_mono_outline):
    """Per-master params: pin wght per side, keep other axes as chosen."""
    mp = copy.deepcopy(params)
    variations = mp.setdefault("variations", {})
    mono_loc = dict(variations.get("mono") or {})
    mono_loc["wght"] = mono_wght
    variations["mono"] = mono_loc
    cjk_loc = dict(variations.get("cjk") or {})
    cjk_loc["wght"] = cjk_wght
    variations["cjk"] = cjk_loc
    if ignore_mono_outline:
        mono = mp.setdefault("mono", {})
        mono["gsx"] = 1
        mono["gsy"] = 1
        mono["baseline"] = 0
    return mp


def _build_variable(masters, plan):
    """Rebuild a wght variable font from static merged masters.

    masters = [(output_internal_position, TTFont), ...]. Sources are placed
    so varLib's linear normalization puts them at those internal positions
    (the mono design-normalized space); the mono base's avar is then carried
    into the output so users reach those positions exactly as in the base.
    The CJK curve follows the base avar, aligned through weight-map anchors.
    """
    from fontTools import varLib
    from fontTools.designspaceLib import (
        AxisDescriptor,
        DesignSpaceDocument,
        SourceDescriptor,
    )
    from fontTools.ttLib import newTable
    from fontTools.ttLib.tables._f_v_a_r import NamedInstance

    axis = plan["axis"]
    doc = DesignSpaceDocument()
    ax = AxisDescriptor()
    ax.name = "weight"
    ax.tag = "wght"
    ax.minimum, ax.default, ax.maximum = axis
    doc.addAxis(ax)
    for internal, font in masters:
        src = SourceDescriptor()
        src.name = f"master.{internal:g}"
        src.location = {"weight": _denormalize_linear(internal, axis)}
        src.font = font
        doc.addSource(src)
    base = min(masters, key=lambda m: abs(m[0]))[1]
    # Layout tables are kept from the mono base and identical across masters;
    # restore the default master's copy instead of merging them per master
    # (varLib.build deletes excluded tables from the output).
    saved = {
        tag: base[tag]
        for tag in ("GSUB", "GPOS", "GDEF", "BASE", "COLR")
        if tag in base
    }
    vf, _, _ = varLib.build(
        doc, exclude=["GSUB", "GPOS", "GDEF", "BASE", "COLR", "CFF2"]
    )
    for tag, table in saved.items():
        if tag not in vf:
            vf[tag] = table
    segments = plan.get("avar")
    if segments:
        avar = newTable("avar")
        avar.segments = {tag: dict(points) for tag, points in segments.items()}
        vf["avar"] = avar
    seen = set()
    name_table = vf["name"]
    used_ids = {rec.nameID for rec in name_table.names}
    family_ps = re.sub(r"[^A-Za-z0-9]", "", _name_string(vf, 1) or "Font") or "Font"

    def alloc_id():
        candidate = 256
        while candidate in used_ids:
            candidate += 1
        used_ids.add(candidate)
        return candidate

    def add_instance(wght, label):
        subfamily_id = alloc_id()
        name_table.setName(label, subfamily_id, 3, 1, 0x409)
        if abs(wght - axis[1]) < 1e-6:
            # the default instance must reuse the font's PostScript name
            ps_name = _name_string(vf, 6) or family_ps
            ps_id = next(
                (
                    rec.nameID
                    for rec in name_table.names
                    if rec.nameID == 6 and rec.platformID == 3
                ),
                None,
            )
            if ps_id is None:
                ps_id = alloc_id()
                name_table.setName(ps_name, ps_id, 3, 1, 0x409)
        else:
            ps_label = re.sub(r"[^A-Za-z0-9]", "", label) or "Regular"
            ps_id = alloc_id()
            name_table.setName(f"{family_ps}-{ps_label}"[:63], ps_id, 3, 1, 0x409)
        inst = NamedInstance()
        inst.subfamilyNameID = subfamily_id
        inst.postscriptNameID = ps_id
        inst.coordinates = {"wght": wght}
        vf["fvar"].instances.append(inst)

    pending = []
    if (_name_string(base, 17) or "").lower() == "regular":
        # every shipping variable font names its default instance: Windows
        # style matching/preview leans on it, and an instance-less fvar is
        # the most exotic shape for older Windows code paths
        pending.append((axis[1], "Regular"))
        seen.add(("regular", round(axis[1], 3)))
    for wght, name in plan.get("instances", []):
        key = (name.lower(), round(wght, 3))
        if key in seen:
            continue
        seen.add(key)
        pending.append((wght, name))
    # fvar instances must be in ascending weight order for legacy consumers
    for wght, label in sorted(pending, key=lambda p: p[0]):
        add_instance(wght, label)
    _drop_degenerate_hvar(vf)
    _add_stat_axis_values(vf, axis)
    return vf


def _drop_degenerate_hvar(vf):
    """Remove a HVAR that carries no variation.

    With no regions varLib writes a HVAR whose advance-width map is omitted
    (AdvWidthMap=None; fontTools #3797), i.e. glyph IDs are used as implicit
    delta-set indices, as the HVAR spec allows:
    https://learn.microsoft.com/en-us/typography/opentype/spec/hvar
    Windows resolves that implicit mapping with a signed 16-bit glyph index,
    so any font with 32768+ glyphs reads out of bounds (unstable installs).
    The spec only *recommends* the explicit advance-width map; our region-less
    HVAR encodes nothing, so dropping it is loss-free (advances still vary
    through gvar phantom points when they actually do).
    """
    hvar = vf.get("HVAR")
    if hvar is None:
        return
    store = getattr(hvar.table, "VarStore", None)
    regions = getattr(getattr(store, "VarRegionList", None), "RegionCount", 0)
    if not regions:
        del vf["HVAR"]


def _add_stat_axis_values(vf, axis):
    """Give every fvar named instance a matching STAT AxisValue.

    varLib's minimal STAT carries the wght axis but no values; once named
    instances exist that is an fvar/STAT inconsistency (fontbakery fails it,
    and apps that group styles via STAT may misbehave). One AxisValue per
    distinct instance weight, named after the instance, ELIDABLE on the
    default.
    """
    from fontTools.ttLib.tables import otTables as ot

    stat_table = vf.get("STAT")
    if stat_table is None:
        return
    stat = stat_table.table
    axis_index = next(
        (
            i
            for i, record in enumerate(stat.DesignAxisRecord.Axis)
            if record.AxisTag == "wght"
        ),
        None,
    )
    if axis_index is None:
        return
    # STAT value name IDs must be 256..32767 (only the elided fallback may
    # reuse a low ID). The default instance typically reuses name ID 17, so
    # copy such labels onto fresh high IDs first.
    name_table = vf.get("name")
    used = {rec.nameID for rec in name_table.names} if name_table else set()

    def high_name_id(name_id):
        if name_id >= 256 or name_table is None:
            return name_id
        text = _instance_name(name_table, name_id)
        if not text:
            return name_id
        new_id = 256
        while new_id in used:
            new_id += 1
        used.add(new_id)
        name_table.setName(text, new_id, 3, 1, 0x409)
        return new_id

    by_value = {}
    for inst in vf["fvar"].instances:
        value = inst.coordinates.get("wght")
        if value is not None:
            by_value.setdefault(round(value, 4), high_name_id(inst.subfamilyNameID))
    values = []
    for value, name_id in sorted(by_value.items()):
        entry = ot.AxisValue()
        entry.Format = 1
        entry.AxisIndex = axis_index
        entry.Flags = 0x2 if abs(value - axis[1]) < 1e-6 else 0  # ELIDABLE
        entry.ValueNameID = name_id
        entry.Value = value
        values.append(entry)
    if not values:
        return
    array = ot.AxisValueArray()
    array.AxisValue = values
    stat.AxisValueArray = array
    stat.AxisValueCount = len(values)


def _quiet(_stage, _value=None):
    """Progress sink for the per-master merges (only masters/varlib report)."""


def _merge_variable(mono_path, cjk_path, params, p, report):
    """Merge into a variable font; fall back to the static pipeline."""
    base = TTFont(mono_path, fontNumber=p.mono_ttc_index)
    cjk = TTFont(cjk_path, fontNumber=p.cjk_ttc_index)
    plan, warnings = _variable_plan(base, cjk, p)
    if plan is None:
        del base, cjk
        merged, meta = _merge_to_font(mono_path, cjk_path, params, _quiet)
        meta["variable"] = False
        meta["warnings"] = warnings
        return merged, meta
    # Subset once and hand every master its own deep copy: the subsetter (and a
    # save/reload round-trip) costs several seconds per run, while copying the
    # already-subset font is cheap and keeps its glyphs lazy. The cached copy is
    # consumed by the instancer, hence the per-master copy.
    subset_font = None
    if p.subset_unicodes:
        _subset_cjk(cjk, p, report)
        subset_font = cjk
    del base, cjk  # reloaded fresh per master below
    # mono outline transforms redraw per master through cu2qu (not
    # variation-aware) and would break point compatibility: ignore them.
    # Advance multipliers stay variable through HVAR.
    ignore_outline = p.mono_gsx != 1 or p.mono_gsy != 1 or p.mono_bl != 0
    if ignore_outline:
        warnings.append(_WARN_MONO_OUTLINE_IGNORED)
    masters = []
    master_meta = None
    ymin_all = ymax_all = None
    total = len(plan["locations"])
    for i, loc in enumerate(plan["locations"]):
        report("masters", int(i * 100 / total))
        mp = _master_params(params, loc["mono"], loc["cjk"], ignore_outline)
        master_cjk = copy.deepcopy(subset_font) if subset_font is not None else None
        merged, meta = _merge_to_font(mono_path, cjk_path, mp, _quiet, master_cjk)
        if "STAT" in merged:
            # drop the inherited STAT so varLib builds a fresh one
            del merged["STAT"]
        for tag in ("GSUB", "GPOS"):
            # drop statically pruned FeatureVariations: the rules are rebuilt
            # on the output axis below instead
            table = merged.get(tag)
            inner = getattr(table, "table", None) if table is not None else None
            if (
                inner is not None
                and getattr(inner, "FeatureVariations", None) is not None
            ):
                del inner.FeatureVariations
                inner.Version = 0x00010000
        masters.append((loc["internal"], merged))
        if meta.get("ymin") is not None:
            ymin_all = meta["ymin"] if ymin_all is None else min(ymin_all, meta["ymin"])
        if meta.get("ymax") is not None:
            ymax_all = meta["ymax"] if ymax_all is None else max(ymax_all, meta["ymax"])
        if master_meta is None or abs(loc["internal"]) < 1e-6:
            master_meta = meta
    report("masters", 100)
    report("varlib")
    out = _build_variable(masters, plan)
    from fontTools.varLib.featureVars import addFeatureVariations

    for feature_tag in sorted(plan.get("layout_rules", {})):
        region_subs = []
        order = set(out.getGlyphOrder())
        for region, subs in plan["layout_rules"][feature_tag]:
            # the builder raises on missing glyphs; inapplicable rules are
            # skipped instead of failing the whole merge
            if set(subs) | set(subs.values()) <= order:
                region_subs.append((region, subs))
        if region_subs:
            addFeatureVariations(out, region_subs, feature_tag)
    if "OS/2" in out:
        # usWin metrics are per-font constants (not interpolatable): cover
        # the union of all masters' bounds so no weight clips on Windows
        os2 = out["OS/2"]
        if ymax_all is not None:
            os2.usWinAscent = max(os2.usWinAscent, ceil(ymax_all))
        if ymin_all is not None:
            os2.usWinDescent = max(os2.usWinDescent, ceil(-ymin_all))
    meta = dict(master_meta or {})
    meta["variable"] = True
    meta["warnings"] = warnings
    meta["masters"] = total
    return out, meta


def _merge_to_font(mono_path, cjk_path, params, report, cjk_font=None):
    """Run the static merge pipeline; returns (font, meta) without saving.

    `cjk_font` hands in an already-loaded CJK font (used by the variable merge,
    which subsets once and deep-copies it per master); when given, cjk_path is
    ignored and no subsetting is applied here.
    """
    p = _read_params(params)

    report("load")
    # ttcIndex picks a face when the input is a TrueType Collection (ignored otherwise)
    base = TTFont(mono_path, fontNumber=p.mono_ttc_index)
    if cjk_font is None:
        cjk = TTFont(cjk_path, fontNumber=p.cjk_ttc_index)
        subset_kept = _subset_cjk(cjk, p, report)
    else:
        cjk = cjk_font
        subset_kept = None
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
    _decompose_nested_composites(base)
    mono = _update_metrics(base, p, mono_ref_adv, report)
    _sync_subfamily_style(base, p.style)
    ymin, ymax = _update_vertical_metrics(base, cjk, p, upem, cjk_scale, units_per_px)
    _ensure_gasp(base)

    return base, {
        "added": added,
        "upem": upem,
        "format": p.fmt,
        "subset_kept": subset_kept,
        "mono": mono,
        "ymin": ymin,
        "ymax": ymax,
    }


def merge(mono_path, cjk_path, out_path, params, progress=None):
    def report(stage, value=None):
        if progress:
            progress(stage, value)

    p = _read_params(params)
    if p.merge_wght:
        base, meta = _merge_variable(mono_path, cjk_path, params, p, report)
    else:
        base, meta = _merge_to_font(mono_path, cjk_path, params, report)

    report("save")
    if p.fmt == "woff2":
        base.flavor = "woff2"  # brotli-compressed packaging of the same TTF
    # skip the table-reordering pass (it rewrites the whole file once more)
    base.save(out_path, reorderTables=None)
    return meta


if __name__ == "__main__":
    mono_path, cjk_path, out_path, params_path = sys.argv[1:5]
    with open(params_path) as fp:
        params = json.load(fp)
    meta = merge(mono_path, cjk_path, out_path, params)
    if not meta["mono"]:
        print(
            "warning: mono base is not monospace; the output will not be "
            "flagged as monospace",
            file=sys.stderr,
        )
    for code in meta.get("warnings", []):
        print(f"warning: {_VARIABLE_WARNING_TEXTS.get(code, code)}", file=sys.stderr)
    print(json.dumps(meta))
